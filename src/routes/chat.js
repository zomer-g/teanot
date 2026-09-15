// End-user API: identity, conversations, the streaming chat turn, and TAG-IT passthroughs.
import { Readable } from 'node:stream';
import { Router } from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { loginUrl, logoutUrl, requireActive } from '../auth.js';
import { documentBlock, documentFromText, extractDocument, MAX_UPLOAD_BYTES, UserFacingError } from '../extract.js';
import { QuotaExceededError, assertQuota, getQuota, recordTagitCall } from '../usage.js';
import { runTurn } from '../agent.js';
import { sentencingParamsSchema } from '../tools.js';
import * as tagit from '../tagit.js';

export const chatRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASTED_DOCUMENT_CHARS = 1500;
const activeTurns = new Set();

async function ownConversation(account, id) {
  if (!UUID_RE.test(id ?? '')) return null;
  const { rows } = await query(
    'SELECT id, title, doc_name, analysis FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [id, account.id],
  );
  return rows[0] ?? null;
}

chatRouter.get('/me', async (req, res) => {
  if (!req.identity) return res.json({ authenticated: false, loginUrl: loginUrl('/') });
  const { email, name, role, status } = req.account;
  res.json({
    authenticated: true,
    user: { email, name, role, status },
    quota: status === 'active' ? await getQuota(req.account) : null,
    logoutUrl,
  });
});

chatRouter.get('/conversations', requireActive, async (req, res) => {
  const { rows } = await query(
    `SELECT id, title, doc_name, updated_at FROM conversations
     WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 200`,
    [req.account.id],
  );
  res.json({ conversations: rows });
});

chatRouter.get('/conversations/:id', requireActive, async (req, res) => {
  const conversation = await ownConversation(req.account, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const { rows } = await query(
    'SELECT role, ui FROM messages WHERE conversation_id = $1 AND ui IS NOT NULL ORDER BY id',
    [conversation.id],
  );
  res.json({ conversation, turns: rows });
});

// Soft delete: the usage log keeps referring to the conversation.
chatRouter.delete('/conversations/:id', requireActive, async (req, res) => {
  const conversation = await ownConversation(req.account, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  await query('UPDATE conversations SET deleted_at = now() WHERE id = $1', [conversation.id]);
  res.json({ ok: true });
});

chatRouter.post('/chat', requireActive, upload.single('file'), async (req, res) => {
  const account = req.account;
  const text = String(req.body.text ?? '').trim();
  let answers = null;
  if (req.body.answers) {
    try { answers = JSON.parse(req.body.answers); } catch { return res.status(400).json({ error: 'invalid_answers' }); }
  }

  try {
    await assertQuota(account);
  } catch (err) {
    if (err instanceof QuotaExceededError) return res.status(429).json({ error: 'quota_exceeded', quota: err.quota });
    throw err;
  }

  // Build the user's content blocks before opening the stream, so extraction errors are plain JSON.
  const userBlocks = [];
  let userUi;
  let docName = null;
  if (req.file) {
    const doc = await extractDocument(req.file);
    docName = doc.name;
    userBlocks.push(documentBlock(doc), { type: 'text', text: text || 'מצורף מסמך. נתח אותו.' });
    userUi = { type: 'user', text, fileName: doc.name };
  } else if (text.length > PASTED_DOCUMENT_CHARS && !answers) {
    const doc = documentFromText(text);
    docName = doc.name;
    userBlocks.push(documentBlock(doc), { type: 'text', text: 'המסמך הודבק כטקסט. נתח אותו.' });
    userUi = { type: 'user', text: `${text.slice(0, 400)}…`, fileName: 'טקסט שהודבק', pasted: true };
  } else if (text) {
    userBlocks.push({ type: 'text', text });
    userUi = { type: 'user', text, answers: answers ?? undefined };
  } else if (answers) {
    userUi = { type: 'user', text: '', answers };
  } else {
    return res.status(400).json({ error: 'empty_message' });
  }

  let conversation;
  if (req.body.conversationId) {
    conversation = await ownConversation(account, req.body.conversationId);
    if (!conversation) return res.status(404).json({ error: 'not_found' });
  } else {
    const title = docName ?? text.slice(0, 60);
    const { rows } = await query(
      'INSERT INTO conversations (user_id, title, doc_name) VALUES ($1, $2, $3) RETURNING id, title',
      [account.id, title, docName],
    );
    conversation = rows[0];
  }
  if (activeTurns.has(conversation.id)) return res.status(409).json({ error: 'turn_in_progress' });
  activeTurns.add(conversation.id);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  emit({ type: 'conversation', id: conversation.id, title: conversation.title });
  try {
    await runTurn({ account, conversationId: conversation.id, userBlocks, userUi, answers, emit, signal: controller.signal });
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[chat] turn failed', err);
      let message = 'אירעה שגיאה בעיבוד הבקשה. נסו שוב.';
      if (err instanceof Anthropic.RateLimitError) message = 'שירות הבינה המלאכותית עמוס כרגע. נסו שוב בעוד דקה.';
      else if (err instanceof Anthropic.AuthenticationError) message = 'מפתח ה-API של Anthropic אינו תקין. יש לפנות למנהל המערכת.';
      else if (err instanceof Anthropic.BadRequestError) message = `הבקשה נדחתה על ידי שירות הבינה המלאכותית: ${err.message}`;
      else if (err instanceof Anthropic.APIError) message = 'שירות הבינה המלאכותית החזיר שגיאה. נסו שוב.';
      else if (err instanceof Anthropic.AnthropicError && /authentication/i.test(err.message)) message = 'מפתח ה-API של Anthropic לא הוגדר בשרת. יש לפנות למנהל המערכת.';
      emit({ type: 'error', message });
    }
  } finally {
    clearInterval(heartbeat);
    activeTurns.delete(conversation.id);
    emit({ type: 'quota', quota: await getQuota(account) });
    emit({ type: 'done' });
    res.end();
  }
});

// "Show more" on a result card: fetches the next page without spending Claude tokens.
chatRouter.post('/tagit/sentencing/more', requireActive, async (req, res) => {
  const conversation = await ownConversation(req.account, req.body?.conversationId);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const parsed = sentencingParamsSchema.safeParse(req.body?.params);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const page = Math.max(1, Math.min(Number(req.body?.page) || 2, 50));
  try {
    const result = await tagit.searchSentencing(parsed.data, { page });
    await recordTagitCall({ account: req.account, conversationId: conversation.id, detail: { action: 'more_sentencing', label: parsed.data.label, page, returned: result.items.length } });
    res.json({ page: result.page, total: result.total, items: result.items });
  } catch (err) {
    console.error('[tagit] more failed', err);
    res.status(502).json({ error: 'tagit_error' });
  }
});

async function proxyFile(kind, req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const upstream = await tagit.fetchFile(kind, id);
    await recordTagitCall({ account: req.account, conversationId: null, detail: { action: 'open_file', kind, id } });
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${kind}-${id}.pdf"`);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    const status = err instanceof tagit.TagitError && [404, 410].includes(err.status) ? err.status : 502;
    res.status(status).send(status === 502 ? 'לא ניתן היה לטעון את המסמך מ-TAG-IT.' : 'המסמך אינו זמין.');
  }
}

chatRouter.get('/tagit/rulings/:id/file', requireActive, (req, res) => proxyFile('ruling', req, res));
chatRouter.get('/tagit/guidelines/:id/file', requireActive, (req, res) => proxyFile('guideline', req, res));

export function chatErrorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof UserFacingError) return res.status(400).json({ error: 'user_error', message: err.message });
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'user_error', message: `הקובץ גדול מדי (עד ${MAX_UPLOAD_BYTES / 1024 / 1024}MB).` });
  }
  console.error('[http] unhandled', err);
  res.status(500).json({ error: 'server_error' });
}
