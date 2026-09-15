// End-user API: identity, conversations, the streaming chat turn, and TAG-IT passthroughs.
import { Readable } from 'node:stream';
import { Router } from 'express';
import multer from 'multer';
import Anthropic from '@anthropic-ai/sdk';
import { query } from '../db.js';
import { loginUrl, logoutUrl, requireActive } from '../auth.js';
import { documentBlock, documentFromText, extractDocument, MAX_UPLOAD_BYTES, UserFacingError } from '../extract.js';
import { QuotaExceededError, assertQuota, getQuota, recordTagitCall } from '../usage.js';
import { finishTurn, lastTurn, startTurn } from '../turns.js';
import { runTurn } from '../agent.js';
import { sentencingParamsSchema } from '../tools.js';
import * as tagit from '../tagit.js';

export const chatRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASTED_DOCUMENT_CHARS = 1500;

// conversationId → { controller, turnId, emit }. A turn keeps running when the browser disconnects
// (proxy cut, network blip, closed tab) and is saved as usual; only an explicit stop aborts it.
const activeTurns = new Map();

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
  res.json({
    conversation,
    turns: rows,
    running: activeTurns.has(conversation.id),
    lastRequest: await lastTurn(conversation.id),
  });
});

// Soft delete: the usage log keeps referring to the conversation.
chatRouter.delete('/conversations/:id', requireActive, async (req, res) => {
  const conversation = await ownConversation(req.account, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  await query('UPDATE conversations SET deleted_at = now() WHERE id = $1', [conversation.id]);
  res.json({ ok: true });
});

chatRouter.post('/conversations/:id/stop', requireActive, async (req, res) => {
  const conversation = await ownConversation(req.account, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const active = activeTurns.get(conversation.id);
  if (active) active.controller.abort();
  res.json({ stopped: Boolean(active) });
});

function errorMessage(err) {
  if (err instanceof Anthropic.RateLimitError) return 'שירות הבינה המלאכותית עמוס כרגע. נסו שוב בעוד דקה.';
  if (err instanceof Anthropic.AuthenticationError) return 'מפתח ה-API של Anthropic אינו תקין. יש לפנות למנהל המערכת.';
  if (err instanceof Anthropic.BadRequestError) return `הבקשה נדחתה על ידי שירות הבינה המלאכותית: ${err.message}`;
  if (err instanceof Anthropic.APIError) return 'שירות הבינה המלאכותית החזיר שגיאה. נסו שוב.';
  if (err instanceof Anthropic.AnthropicError && /authentication/i.test(err.message)) return 'מפתח ה-API של Anthropic לא הוגדר בשרת. יש לפנות למנהל המערכת.';
  return 'אירעה שגיאה בעיבוד הבקשה. נסו שוב.';
}

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
  let request;
  if (req.file) {
    const doc = await extractDocument(req.file);
    docName = doc.name;
    userBlocks.push(documentBlock(doc), { type: 'text', text: text || 'מצורף מסמך. נתח אותו.' });
    userUi = { type: 'user', text, fileName: doc.name };
    request = { kind: 'document', text: text || null, fileName: doc.name };
  } else if (text.length > PASTED_DOCUMENT_CHARS && !answers) {
    const doc = documentFromText(text);
    docName = doc.name;
    userBlocks.push(documentBlock(doc), { type: 'text', text: 'המסמך הודבק כטקסט. נתח אותו.' });
    userUi = { type: 'user', text: `${text.slice(0, 400)}…`, fileName: 'טקסט שהודבק', pasted: true };
    request = { kind: 'document', text: text.slice(0, 500), fileName: 'טקסט שהודבק' };
  } else if (text) {
    userBlocks.push({ type: 'text', text });
    userUi = { type: 'user', text, answers: answers ?? undefined };
    request = { kind: answers ? 'answers' : 'text', text, answers };
  } else if (answers) {
    userUi = { type: 'user', text: '', answers };
    request = { kind: 'answers', answers };
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

  const controller = new AbortController();
  // Every event is numbered and kept for the life of the turn, so a browser whose connection was
  // cut can rejoin with GET /conversations/:id/stream?after=<last seq> and miss nothing.
  const entry = { controller, turnId: null, events: [], listeners: new Set(), reconnects: 0 };
  entry.emit = (event) => {
    const stamped = { ...event, seq: entry.events.length + 1 };
    entry.events.push(stamped);
    for (const listener of [...entry.listeners]) listener(stamped);
  };
  const { emit } = entry;
  activeTurns.set(conversation.id, entry);
  let turnId;
  try {
    turnId = await startTurn({ account, conversationId: conversation.id, ...request });
  } catch (err) {
    activeTurns.delete(conversation.id);
    throw err;
  }
  entry.turnId = turnId;
  attachStream(entry, res, 0);

  const started = Date.now();
  console.log(`[turn] start id=${turnId} user=${account.id} conversation=${conversation.id} kind=${request.kind}`);
  emit({ type: 'conversation', id: conversation.id, title: conversation.title });

  let status = 'error';
  let errorText = null;
  try {
    status = await runTurn({ account, conversationId: conversation.id, turnId, userBlocks, userUi, answers, emit, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      status = 'aborted';
    } else {
      console.error(`[turn] id=${turnId} failed`, err);
      errorText = err.message;
      emit({ type: 'error', message: errorMessage(err) });
    }
  } finally {
    await finishTurn(turnId, status, errorText).catch((err) => console.error('[turn] finish failed', err));
    try {
      emit({ type: 'quota', quota: await getQuota(account) });
    } catch (err) {
      console.error('[turn] quota read failed', err);
    }
    const connectedAtEnd = entry.listeners.size > 0;
    emit({ type: 'done' }); // ends every attached stream
    activeTurns.delete(conversation.id);
    console.log(`[turn] end id=${turnId} status=${status} ms=${Date.now() - started} reconnects=${entry.reconnects} client=${connectedAtEnd ? 'connected' : 'disconnected'}`);
  }
});

// Streams a turn's events to one HTTP response: replays everything after `after`, then follows live
// until "done". xhostd's proxy ends a response after about a minute, which is why browsers rejoin.
function attachStream(entry, res, after) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  const end = () => {
    clearInterval(heartbeat);
    entry.listeners.delete(listener);
    if (!res.writableEnded) res.end();
  };
  const listener = (event) => {
    if (res.writableEnded) return;
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'done') end();
  };
  res.on('close', end);
  for (const event of entry.events) if (event.seq > after) listener(event);
  if (!res.writableEnded) entry.listeners.add(listener);
}

// Rejoin a running turn. 204 = no turn is running any more (reload the conversation instead).
chatRouter.get('/conversations/:id/stream', requireActive, async (req, res) => {
  const conversation = await ownConversation(req.account, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const entry = activeTurns.get(conversation.id);
  if (!entry) return res.status(204).end();
  entry.reconnects++;
  attachStream(entry, res, Math.max(0, Number(req.query.after) || 0));
});

// Called on shutdown: warn connected users, give running turns a short grace period,
// and record whatever is still running as interrupted. Returns how many were interrupted.
export async function drainActiveTurns(timeoutMs) {
  for (const turn of activeTurns.values()) {
    turn.emit({ type: 'notice', text: 'השרת מתעדכן כעת. אם התשובה לא תושלם, אפשר ללחוץ על "המשך".' });
  }
  const deadline = Date.now() + timeoutMs;
  while (activeTurns.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  const remaining = [...activeTurns.values()].filter((turn) => turn.turnId);
  await Promise.allSettled(remaining.map((turn) => finishTurn(turn.turnId, 'interrupted', 'השרת הופעל מחדש במהלך העיבוד')));
  return remaining.length;
}

// "Show more" on a result card: fetches the next page without spending Claude tokens.
chatRouter.post('/tagit/sentencing/more', requireActive, async (req, res) => {
  const conversation = await ownConversation(req.account, req.body?.conversationId);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const parsed = sentencingParamsSchema.safeParse(req.body?.params);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const page = Math.max(1, Math.min(Number(req.body?.page) || 2, 50));
  const turnId = await startTurn({
    account: req.account, conversationId: conversation.id, kind: 'more', text: `${parsed.data.label} · עמוד ${page}`,
  });
  try {
    const result = await tagit.searchSentencing(parsed.data, { page });
    await recordTagitCall({ account: req.account, conversationId: conversation.id, turnId, detail: { action: 'more_sentencing', label: parsed.data.label, page, total: result.total, returned: result.items.length } });
    await finishTurn(turnId, 'completed');
    res.json({ page: result.page, total: result.total, items: result.items });
  } catch (err) {
    console.error('[tagit] more failed', err);
    await recordTagitCall({ account: req.account, conversationId: conversation.id, turnId, detail: { action: 'more_sentencing', label: parsed.data.label, page, error: err.message } });
    await finishTurn(turnId, 'error', err.message);
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
