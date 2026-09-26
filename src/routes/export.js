// PDF / DOCX exports of sentencing decisions, conditional arrangements and guidelines: one item, all of one kind,
// or everything in a conversation. Full texts come from TAG-IT, so a large export can outlast xhostd's ~58s proxy
// cut: the POST starts a job and the browser polls GET /export/:id until the file is ready.
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireActive } from '../auth.js';
import { rateLimit } from '../security.js';
import { recordTagitCall } from '../usage.js';
import * as tagit from '../tagit.js';
import {
  canEmbedPdf, heading, meta, originalPdf, pageBreak, paragraph, paragraphs, renderDocx, renderPdf, subheading, title,
} from '../export.js';

export const exportRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 150;
// At most this many sentencing decisions (and as many arrangements) go into one export: the first ones, in the order
// the conversation showed them.
export const MAX_RULINGS = 30;
// Original PDFs put into one export, in total (a decision's PDF is usually 0.1–3MB).
const MAX_ORIGINAL_BYTES = 150 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;
const JOB_TTL_MS = 15 * 60_000;
const MAX_JOBS_PER_USER = 2;

const exportSchema = z.object({
  conversationId: z.string().regex(UUID_RE),
  format: z.enum(['pdf', 'docx']),
  scope: z.enum(['ruling', 'arrangement', 'guideline', 'rulings', 'arrangements', 'guidelines', 'all']),
  includeSource: z.boolean().default(false),
  // PDF only: after each decision or guideline, its original document from TAG-IT, as it is.
  includeRaw: z.boolean().default(false),
  items: z.array(z.object({
    kind: z.enum(['ruling', 'arrangement', 'guideline']),
    id: z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,15}$/.test(v)),
    // The card data the browser already shows (from our own search results); read defensively below.
    data: z.record(z.string(), z.unknown()).default({}),
  })).min(1).max(MAX_ITEMS),
});

// ---------- Reading the card data ----------

const str = (v, max = 4000) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max).trim() : '');
const list = (v, max = 50) => (Array.isArray(v) ? v.slice(0, max) : []);
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const fmtNumber = (n) => Number(n).toLocaleString('he-IL', { maximumFractionDigits: 1 });
const fmtDate = (value) => {
  const text = str(value, 40);
  if (!text) return '';
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? text : d.toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });
};
const join = (parts, sep = ' · ') => parts.filter(Boolean).join(sep);

function sentenceLine(r) {
  const parts = [];
  const prison = num(r.prisonMonths);
  if (prison) parts.push(`${fmtNumber(prison)} חודשי מאסר בפועל`);
  else if (str(r.primaryPunishment)) parts.push(str(r.primaryPunishment, 200));
  if (num(r.serviceWorkMonths)) parts.push(`${fmtNumber(r.serviceWorkMonths)} חודשי עבודות שירות`);
  if (num(r.suspendedMonths)) parts.push(`${fmtNumber(r.suspendedMonths)} חודשי מאסר על תנאי`);
  if (num(r.communityServiceHours)) parts.push(`${fmtNumber(r.communityServiceHours)} שעות של"צ`);
  if (num(r.fine)) parts.push(`קנס ₪${fmtNumber(r.fine)}`);
  if (num(r.compensation)) parts.push(`פיצוי ₪${fmtNumber(r.compensation)}`);
  for (const d of list(r.drugTotals)) {
    if (d && str(d.drug) && num(d.amount) != null) parts.push(join([str(d.drug, 60), fmtNumber(d.amount), str(d.unit, 20)], ' '));
  }
  if (r.confessed === true) parts.push('הודה');
  if (r.agreedSentence === true) parts.push('עונש מוסכם');
  return join(parts);
}

function rulingBlocks(r) {
  const blocks = [title(str(r.title, 500) || 'גזר דין')];
  const where = join([str(r.court, 200), fmtDate(r.date), str(r.caseNumber, 100)]);
  if (where) blocks.push(meta(where));
  const sentence = sentenceLine(r);
  if (sentence) blocks.push(meta(sentence));
  if (str(r.summary)) blocks.push(subheading('תקציר'), ...paragraphs(str(r.summary, 20000)));
  const defendants = list(r.defendants).filter((d) => d && typeof d === 'object');
  const ranges = list(r.ranges).filter((x) => x && (str(x.min) || str(x.max)));
  if (defendants.length || ranges.length) {
    blocks.push(subheading('נאשמים ומתחמים'));
    defendants.forEach((d, i) => {
      const punishments = list(d.punishments).map((p) => join([str(p?.type, 100), str(p?.value, 50), str(p?.unit, 50)], ' ')).filter(Boolean);
      blocks.push(paragraph(`${str(d.name, 200) || `נאשם ${i + 1}`}: ${punishments.join(' · ') || '—'}`));
    });
    for (const x of ranges) blocks.push(paragraph(`מתחם${str(x.group) ? ` (${str(x.group, 200)})` : ''}: ${str(x.min, 200) || '?'} – ${str(x.max, 200) || '?'}`));
  }
  const judges = list(r.judges).map((j) => str(j, 100)).filter(Boolean);
  if (judges.length) blocks.push(meta(`שופטים: ${judges.join(', ')}`));
  return blocks;
}

function guidelineBlocks(g) {
  const blocks = [title(str(g.title, 500) || 'הנחיה')];
  const where = join([str(g.number) ? `הנחיה ${str(g.number, 50)}` : '', str(g.source, 200), fmtDate(g.date)]);
  if (where) blocks.push(meta(where));
  const extra = join([
    str(g.topic, 200),
    str(g.effectiveDate) ? `בתוקף מ-${fmtDate(g.effectiveDate)}` : '',
    str(g.supersedes) ? `מחליפה: ${str(g.supersedes, 200)}` : '',
  ]);
  if (extra) blocks.push(meta(extra));
  if (str(g.summary)) blocks.push(subheading('תקציר'), ...paragraphs(str(g.summary, 20000)));
  return blocks;
}

// ---------- The written summary, as the site shows it ----------

// Markdown the model wrote. Inline marks are dropped (the block model has no inline formatting) and the refs it
// writes instead of case numbers ([[ruling:ID]]) become the document's title, exactly as the site renders them.
const stripMarks = (text) => String(text)
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_]($|[\s).,:;])/g, '$1$2$3')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  .trim();

function summaryBlocks(markdown, items) {
  const titles = new Map(items.map((i) => [`${i.kind}:${i.id}`, str(i.data.title, 300)]));
  const fallback = { ruling: 'גזר דין', arrangement: 'הסדר מותנה', guideline: 'הנחיה' };
  const text = String(markdown).replace(/\[\[(ruling|arrangement|guideline):(\d{1,12})\]\]/g,
    (_, kind, id) => titles.get(`${kind}:${id}`) || fallback[kind]);
  const blocks = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { blocks.push(paragraph('')); continue; }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) { blocks.push((head[1].length <= 2 ? heading : subheading)(stripMarks(head[2]))); continue; }
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) { blocks.push(paragraph(`• ${stripMarks(bullet[1])}`)); continue; }
    const numbered = line.match(/^(\d{1,3})[.)]\s+(.*)$/);
    if (numbered) { blocks.push(paragraph(`${numbered[1]}. ${stripMarks(numbered[2])}`)); continue; }
    if (line.startsWith('|')) { // a Markdown table: one line per row, cells separated by ·
      const cells = line.split('|').map((c) => stripMarks(c.trim())).filter(Boolean);
      if (!cells.length || cells.every((c) => /^:?-+:?$/.test(c))) continue;
      blocks.push(paragraph(cells.join(' · ')));
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line)) continue; // horizontal rule
    blocks.push(paragraph(stripMarks(line)));
  }
  return blocks;
}

// The last answer of the conversation that carries written text: what the site shows under the result cards.
async function loadSummary(conversationId) {
  const { rows } = await query(
    `SELECT ui FROM messages WHERE conversation_id = $1 AND role = 'assistant' ORDER BY id DESC LIMIT 20`,
    [conversationId],
  );
  for (const row of rows) {
    const texts = (row.ui?.items ?? [])
      .filter((i) => i?.type === 'text' && typeof i.text === 'string' && i.text.trim())
      .map((i) => i.text.trim());
    if (texts.length) return texts.join('\n\n');
  }
  return null;
}

// ---------- Source document (PDF only) ----------

// The most recent document the user gave in this conversation: the original PDF when one was uploaded, otherwise
// the text that was extracted from it or pasted.
async function loadSource(conversationId) {
  const { rows } = await query(
    `SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY id DESC`,
    [conversationId],
  );
  for (const { content } of rows) {
    const block = (Array.isArray(content) ? content : []).find((b) => b?.type === 'document');
    if (!block) continue;
    const name = str(block.title, 300) || 'מסמך המקור';
    if (block.source?.type === 'base64' && block.source.media_type === 'application/pdf') {
      return { kind: 'pdf', name, bytes: Buffer.from(block.source.data, 'base64') };
    }
    const file = await query(
      'SELECT data FROM source_files WHERE conversation_id = $1 AND name = $2 ORDER BY id DESC LIMIT 1',
      [conversationId, name],
    );
    if (file.rows[0]?.data) return { kind: 'pdf', name, bytes: Buffer.from(file.rows[0].data) };
    return { kind: 'text', name, text: String(block.source?.data ?? '') };
  }
  return null;
}

// ---------- Jobs ----------

const jobs = new Map(); // id → { userId, status, done, total, file, error, at }
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.at > JOB_TTL_MS) jobs.delete(id);
}, 60_000).unref();

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

// The original document as TAG-IT stores it (always a PDF so far), not the text extracted from it: that text is
// Markdown made for the language model, and laid out again it loses the document's own formatting.
async function originalDocument(item) {
  try {
    const res = await tagit.fetchFile(item.kind === 'guideline' ? 'guideline' : 'ruling', item.id);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-') || !await canEmbedPdf(bytes)) {
      console.warn(`[export] original of ${item.kind} ${item.id} is not a usable PDF (${res.headers.get('content-type')})`);
      return null;
    }
    return bytes;
  } catch (err) {
    console.warn(`[export] original of ${item.kind} ${item.id} unavailable: ${err.message}`);
    return null;
  }
}

const SCOPE_NAMES = {
  ruling: 'גזר דין',
  arrangement: 'הסדר מותנה',
  guideline: 'הנחיה',
  rulings: 'גזרי דין',
  arrangements: 'הסדרים מותנים',
  guidelines: 'הנחיות',
  all: 'גזרי דין, הסדרים מותנים והנחיות',
};
// Sentencing decisions and conditional arrangements are described by the same card fields.
const DOCUMENT_KINDS = new Set(['ruling', 'arrangement']);

function fileName(scope, format, items, conversationTitle) {
  const single = ['ruling', 'arrangement', 'guideline'].includes(scope) ? str(items[0].data.title, 80) : str(conversationTitle, 60);
  const base = join([SCOPE_NAMES[scope], single], ' - ').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `${base || 'export'}.${format}`;
}

async function runJob(job, { account, conversation, format, scope, items, includeSource, includeRaw }) {
  // Word holds the site's content only; the originals go into a PDF, and only when asked for.
  let originals = items.map(() => null);
  if (includeRaw) {
    originals = await mapLimited(items, FETCH_CONCURRENCY, async (item) => {
      const bytes = await originalDocument(item);
      job.done++;
      return bytes;
    });
    let total = 0;
    originals = originals.map((bytes) => {
      if (!bytes || total + bytes.length > MAX_ORIGINAL_BYTES) return bytes ? 'too_large' : null;
      total += bytes.length;
      return bytes;
    });
  }
  await recordTagitCall({
    account, conversationId: conversation.id,
    detail: {
      action: 'export', format, scope, includeRaw,
      rulings: items.filter((i) => i.kind === 'ruling').length,
      arrangements: items.filter((i) => i.kind === 'arrangement').length,
      guidelines: items.filter((i) => i.kind === 'guideline').length,
      missingOriginals: includeRaw ? originals.filter((o) => !Buffer.isBuffer(o)).length : undefined,
    },
  }).catch(() => {});

  const withOriginals = items.map((item, i) => ({ item, original: originals[i] }));
  const rulings = withOriginals.filter(({ item }) => item.kind === 'ruling');
  const arrangements = withOriginals.filter(({ item }) => item.kind === 'arrangement');
  const guidelines = withOriginals.filter(({ item }) => item.kind === 'guideline');
  const withOriginal = (kindLabel, original) => {
    if (!includeRaw) return [];
    if (Buffer.isBuffer(original)) return [originalPdf(original)];
    return [meta(original === 'too_large'
      ? `${kindLabel} המקורי לא צורף: הקובץ חורג מהגודל המרבי של ייצוא אחד. אפשר לייצא אותו בנפרד.`
      : `${kindLabel} המקורי אינו זמין כרגע במאגר.`)];
  };
  const blocks = [];
  const multi = items.length > 1;
  if (multi) {
    blocks.push(title(SCOPE_NAMES[scope]));
    if (str(conversation.title)) blocks.push(meta(str(conversation.title, 300)));
    blocks.push(meta(join([
      rulings.length ? `${rulings.length} גזרי דין` : '',
      arrangements.length ? `${arrangements.length} הסדרים מותנים` : '',
      guidelines.length ? `${guidelines.length} הנחיות` : '',
      `הופק ב-${new Date().toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })}`,
    ])));
    blocks.push(paragraph(''));
    if (rulings.length) {
      blocks.push(heading('גזרי דין'));
      rulings.forEach(({ item }, i) => blocks.push(paragraph(`${i + 1}. ${str(item.data.title, 300) || `גזר דין ${item.id}`}`)));
    }
    if (arrangements.length) {
      blocks.push(heading('הסדרים מותנים'));
      arrangements.forEach(({ item }, i) => blocks.push(paragraph(`${i + 1}. ${str(item.data.title, 300) || `הסדר מותנה ${item.id}`}`)));
    }
    if (guidelines.length) {
      blocks.push(heading('הנחיות'));
      guidelines.forEach(({ item }, i) => blocks.push(paragraph(`${i + 1}. ${str(item.data.title, 300) || `הנחיה ${item.id}`}`)));
    }
  }
  for (const { item, original } of rulings) {
    if (blocks.length) blocks.push(pageBreak());
    blocks.push(...rulingBlocks(item.data), ...withOriginal('גזר הדין', original));
  }
  for (const { item, original } of arrangements) {
    if (blocks.length) blocks.push(pageBreak());
    blocks.push(...rulingBlocks(item.data), ...withOriginal('ההסדר', original));
  }
  for (const { item, original } of guidelines) {
    if (blocks.length) blocks.push(pageBreak());
    blocks.push(...guidelineBlocks(item.data), ...withOriginal('מסמך ההנחיה', original));
  }

  // The summary the site shows at the end of the conversation, after all the decisions and guidelines.
  if (!['ruling', 'arrangement', 'guideline'].includes(scope)) {
    const summary = await loadSummary(conversation.id);
    if (summary) blocks.push(pageBreak(), title('סיכום'), ...summaryBlocks(summary, items));
  }

  const docTitle = fileName(scope, format, items, conversation.title).replace(/\.\w+$/, '');
  let buffer;
  if (format === 'docx') {
    buffer = await renderDocx(blocks, { docTitle });
  } else {
    let sourcePdf = null;
    if (includeSource) {
      const source = await loadSource(conversation.id);
      if (source?.kind === 'pdf' && await canEmbedPdf(source.bytes)) sourcePdf = source.bytes;
      else if (source) blocks.unshift(title(`מסמך המקור: ${source.name}`), ...paragraphs(source.text ?? ''), pageBreak());
      else blocks.unshift(meta('לא נמצא מסמך מקור בשיחה זו.'), pageBreak());
    }
    buffer = await renderPdf(blocks, { sourcePdf, docTitle });
  }
  job.file = {
    buffer,
    name: fileName(scope, format, items, conversation.title),
    type: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  job.status = 'ready';
}

exportRouter.post('/export', requireActive, rateLimit({ name: 'export', limit: 30, windowMs: 10 * 60_000 }), async (req, res) => {
  const parsed = exportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_export' });
  const { conversationId, format, scope, includeSource, includeRaw } = parsed.data;
  let items = parsed.data.items;
  if (scope === 'rulings' || scope === 'ruling') items = items.filter((i) => i.kind === 'ruling');
  if (scope === 'arrangements' || scope === 'arrangement') items = items.filter((i) => i.kind === 'arrangement');
  if (scope === 'guidelines' || scope === 'guideline') items = items.filter((i) => i.kind === 'guideline');
  if (scope === 'ruling' || scope === 'arrangement' || scope === 'guideline') items = items.slice(0, 1);
  // The same decision can appear in two searches of one conversation.
  // TAG-IT can also hold two documents of one decision; the same title and date count as one.
  const seen = new Set();
  const key = (i) => (DOCUMENT_KINDS.has(i.kind)
    ? `${i.kind}:${str(i.data.title, 500).replace(/\([^)]*\)/g, '').replace(/[\s()]/g, '')}|${str(i.data.date, 40)}`
    : `guideline:${i.id}`);
  items = items.filter((i) => !seen.has(`${i.kind}:${i.id}`) && !seen.has(key(i)) && seen.add(`${i.kind}:${i.id}`) && seen.add(key(i)));
  const perKind = { ruling: 0, arrangement: 0 };
  items = items.filter((i) => !DOCUMENT_KINDS.has(i.kind) || ++perKind[i.kind] <= MAX_RULINGS);
  if (!items.length) return res.status(400).json({ error: 'nothing_to_export' });

  const { rows } = await query(
    'SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [conversationId, req.account.id],
  );
  const conversation = rows[0];
  if (!conversation) return res.status(404).json({ error: 'not_found' });
  const running = [...jobs.values()].filter((j) => j.userId === req.account.id && j.status === 'running').length;
  if (running >= MAX_JOBS_PER_USER) return res.status(429).json({ error: 'too_many_exports', message: 'כבר מתבצעים ייצואים בחשבון שלך. המתינו לסיומם.' });

  const id = crypto.randomUUID();
  const raw = format === 'pdf' && includeRaw;
  const job = { userId: req.account.id, status: 'running', done: 0, total: raw ? items.length : 0, file: null, error: null, at: Date.now() };
  jobs.set(id, job);
  runJob(job, { account: req.account, conversation, format, scope, items, includeSource: format === 'pdf' && includeSource, includeRaw: raw })
    .catch((err) => {
      console.error('[export] failed', err);
      job.status = 'error';
      job.error = 'הייצוא נכשל. נסו שוב.';
    });
  res.status(202).json({ jobId: id, total: items.length });
});

exportRouter.get('/export/:id', requireActive, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.userId !== req.account.id) return res.status(404).json({ error: 'not_found' });
  job.at = Date.now();
  if (job.status === 'running') return res.status(202).json({ status: 'running', done: job.done, total: job.total });
  if (job.status === 'error') return res.status(500).json({ status: 'error', message: job.error });
  const { buffer, name, type } = job.file;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="export.${name.split('.').pop()}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
});
