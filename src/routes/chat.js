// End-user API: identity, conversations, the streaming chat turn, and TAG-IT passthroughs.
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../db.js';
import { loginUrl, logoutUrl, requireActive } from '../auth.js';
import { documentBlock, documentFromText, extractDocument, MAX_UPLOAD_BYTES, UserFacingError } from '../extract.js';
import { modelSettings } from '../llm/index.js';
import { adminAlerts } from '../llm/alerts.js';
import { QuotaExceededError, assertQuota, getQuota, recordTagitCall } from '../usage.js';
import { finishTurn, lastTurn, startTurn } from '../turns.js';
import { rateLimit } from '../security.js';
import { runTurn } from '../agent.js';
import { sentencingParamsSchema, withSentencingSetup } from '../tools.js';
import { getGuidelineSources, getSentencingFlags, loadSearchSetup, saveSearchSetup, searchSetupSchema } from '../search-options.js';
import * as tagit from '../tagit.js';

export const chatRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // Caps every part of the multipart body, not only the file (busboy's own defaults are unlimited).
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, fieldSize: 1_400_000, parts: 6, headerPairs: 50 },
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASTED_DOCUMENT_CHARS = 1500;
const MAX_TURNS_PER_USER = 2;
const MAX_STREAMS_PER_TURN = 3;
const MAX_STREAM_BUFFER_BYTES = 2 * 1024 * 1024;
const TEN_MINUTES = 10 * 60_000;

const answersSchema = z.array(z.object({
  id: z.string().max(100),
  question: z.string().max(500),
  selected: z.array(z.object({ value: z.string().max(200), label: z.string().max(300) })).max(10).default([]),
  free_text: z.string().max(2000).nullable().optional(),
  setup: searchSetupSchema.optional(), // the search-setup form's structured answer to the "mode" question
})).min(1).max(4);

// conversationId → { controller, userId, turnId, events, listeners, reconnects, emit }. A turn keeps running
// when the browser disconnects (proxy cut, network blip, closed tab); only an explicit stop aborts it.
const activeTurns = new Map();

// Chat requests in flight per user, counted from arrival until the turn ends. Parallel turns would each
// pass the quota check before any usage is recorded, so they are capped.
const turnSlots = new Map();

function reserveTurnSlot(req, res, next) {
  const userId = req.account.id;
  const used = turnSlots.get(userId) ?? 0;
  if (used >= MAX_TURNS_PER_USER) {
    return res.status(429).json({ error: 'too_many_turns', message: 'כבר יש בקשות בעיבוד בחשבון שלך. המתינו לסיומן ונסו שוב.' });
  }
  turnSlots.set(userId, used + 1);
  let released = false;
  req.releaseTurnSlot = () => {
    if (released) return;
    released = true;
    const left = (turnSlots.get(userId) ?? 1) - 1;
    if (left > 0) turnSlots.set(userId, left);
    else turnSlots.delete(userId);
  };
  // Requests that end before a turn starts (validation errors, 409, quota) give the slot back.
  const releaseIfNoTurn = () => { if (!req.turnStarted) req.releaseTurnSlot(); };
  res.on('finish', releaseIfNoTurn);
  res.on('close', releaseIfNoTurn);
  next();
}

async function ownConversation(account, id) {
  if (!UUID_RE.test(id ?? '')) return null;
  const { rows } = await query(
    'SELECT id, title, doc_name, analysis, search_setup FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
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
    // Admins see why the model stopped (or is about to) right in the chat, not only in the admin panel.
    alerts: role === 'admin' && status === 'active' ? await adminAlerts((await modelSettings()).provider) : undefined,
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

// User-facing messages stay generic; details go to the server log. Every provider SDK reports an HTTP status.
// Users get one generic message. The cause (out of credit, bad key, missing model, provider error) goes to
// the admin: the chat and admin-panel alert (src/llm/alerts.js) and the turn's error in the queries log.
const GENERIC_ERROR = 'אירעה תקלה בעיבוד הבקשה. אפשר לנסות שוב מאוחר יותר, ואם התקלה חוזרת, מוזמנים לפנות למנהל המערכת: guy@z-g.co.il.';

chatRouter.post('/chat', requireActive, rateLimit({ name: 'chat', limit: 30, windowMs: TEN_MINUTES }), reserveTurnSlot, upload.single('file'), async (req, res) => {
  const account = req.account;
  const text = String(req.body.text ?? '').trim();
  let answers = null;
  if (req.body.answers) {
    let raw;
    try { raw = JSON.parse(req.body.answers); } catch { return res.status(400).json({ error: 'invalid_answers' }); }
    const parsed = answersSchema.safeParse(raw);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_answers' });
    answers = parsed.data;
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
  const setupAnswer = answers?.find((a) => a.setup);
  if (setupAnswer) await saveSearchSetup(conversation.id, setupAnswer.setup);

  const controller = new AbortController();
  // Every event is numbered and kept for the life of the turn, so a browser whose connection was
  // cut can rejoin with GET /conversations/:id/stream?after=<last seq> and miss nothing.
  const entry = { controller, userId: account.id, turnId: null, events: [], listeners: new Set(), reconnects: 0 };
  entry.emit = (event) => {
    const stamped = { ...event, seq: entry.events.length + 1 };
    entry.events.push(stamped);
    for (const listener of [...entry.listeners]) listener(stamped);
  };
  const { emit } = entry;
  activeTurns.set(conversation.id, entry);
  req.turnStarted = true;
  let turnId;
  try {
    turnId = await startTurn({ account, conversationId: conversation.id, ...request });
  } catch (err) {
    activeTurns.delete(conversation.id);
    req.releaseTurnSlot();
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
      emit({ type: 'error', message: GENERIC_ERROR });
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
    req.releaseTurnSlot();
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
    // A reader that stops reading would make the server buffer the whole turn: drop it; it can rejoin.
    if (event.type === 'done' || res.writableLength > MAX_STREAM_BUFFER_BYTES) end();
  };
  res.on('close', end);
  for (const event of entry.events) if (event.seq > after) listener(event);
  if (!res.writableEnded) entry.listeners.add(listener);
}

// Rejoin a running turn. 204 = no turn is running any more (reload the conversation instead).
chatRouter.get('/conversations/:id/stream', requireActive, rateLimit({ name: 'stream', limit: 120, windowMs: TEN_MINUTES }), async (req, res) => {
  const conversation = await ownConversation(req.account, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const entry = activeTurns.get(conversation.id);
  if (!entry) return res.status(204).end();
  if (entry.listeners.size >= MAX_STREAMS_PER_TURN) return res.status(429).json({ error: 'too_many_streams' });
  entry.reconnects++;
  const after = Number.parseInt(req.query.after, 10);
  attachStream(entry, res, Number.isFinite(after) && after > 0 ? after : 0);
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

const tagitLimit = rateLimit({ name: 'tagit', limit: 120, windowMs: TEN_MINUTES });

// "Show more" on a result card: fetches the next page without spending model tokens.
// Options for the search-setup form: sentencing flags (from the Z-G site's config) and guideline sources.
chatRouter.get('/search-options', requireActive, async (_req, res) => {
  const [{ flags, source }, guidelineSources] = await Promise.all([getSentencingFlags(), getGuidelineSources()]);
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ sentencingFlags: flags, flagsSource: source, guidelineSources, defaults: { sortDirection: 'asc' } });
});

chatRouter.post('/tagit/sentencing/more', requireActive, tagitLimit, async (req, res) => {
  const conversation = await ownConversation(req.account, req.body?.conversationId);
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const parsed = sentencingParamsSchema.safeParse(req.body?.params);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const page = Math.max(1, Math.min(Number.parseInt(req.body?.page, 10) || 2, 50));
  const turnId = await startTurn({
    account: req.account, conversationId: conversation.id, kind: 'more', text: `${parsed.data.label} · עמוד ${page}`,
  });
  try {
    // The same user setup the first page was searched with, even if the browser sent older parameters.
    const result = await tagit.searchSentencing(withSentencingSetup(parsed.data, await loadSearchSetup(conversation.id)), { page });
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

// Serves a TAG-IT file from our origin without letting upstream decide how the browser treats it:
// only PDFs are shown inline; anything else is a download. Stream errors and client disconnects are handled.
async function proxyFile(kind, req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  let upstream;
  try {
    upstream = await tagit.fetchFile(kind, id, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) return;
    const status = err instanceof tagit.TagitError && [404, 410].includes(err.status) ? err.status : 502;
    return res.status(status).type('text/plain').send(status === 502 ? 'לא ניתן היה לטעון את המסמך מ-TAG-IT.' : 'המסמך אינו זמין.');
  }
  await recordTagitCall({ account: req.account, conversationId: null, detail: { action: 'open_file', kind, id } }).catch(() => {});
  const type = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const isPdf = type === 'application/pdf';
  res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${isPdf ? 'inline' : 'attachment'}; filename="${kind}-${id}.pdf"`);
  // The browser's PDF viewer needs a document without the page CSP; framing stays forbidden.
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (!controller.signal.aborted) console.warn('[tagit] file stream failed', err.message);
  }
}

chatRouter.get('/tagit/rulings/:id/file', requireActive, tagitLimit, (req, res) => proxyFile('ruling', req, res));
chatRouter.get('/tagit/guidelines/:id/file', requireActive, tagitLimit, (req, res) => proxyFile('guideline', req, res));

export function chatErrorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof UserFacingError) return res.status(400).json({ error: 'user_error', message: err.message });
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: 'user_error',
      message: tooLarge ? `הקובץ גדול מדי (עד ${MAX_UPLOAD_BYTES / 1024 / 1024}MB).` : 'הבקשה חורגת מהמגבלות (גודל או מספר השדות).',
    });
  }
  console.error('[http] unhandled', err);
  res.status(500).json({ error: 'server_error' });
}
