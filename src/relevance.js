// Relevance of each search result to the user's case, scored by TypeSafe's Jev evaluation model on Cloudflare
// Workers AI (typesafe/jev, zero data retention). The admin chooses the mode in the admin panel: off, scores shown
// to admins only (for calibration), or filter (results under the threshold are hidden from users, from the model's
// summary and from exports). Scoring never blocks a search: a failed or missing score keeps the result.
import { query } from './db.js';
import { getSettings, setSetting } from './usage.js';

const MODEL = process.env.CLOUDFLARE_AI_MODEL || 'typesafe/jev';
const API_BASE = (process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/$/, ''); // local mocks only
const PRICE_PER_M_INPUT = 0.042; // USD per million input tokens; output is free
const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;
const MAX_TEXT = 1800;

// The scale Jev answers on: 0 … 3.
export const LEVELS = [
  'לא קשור: עבירה אחרת או נסיבות שונות לגמרי',
  'קשור בעקיפין: אותו תחום כללי, אבל עבירה או נסיבות שונות במהותן',
  'דומה: אותה עבירה או עבירה קרובה, עם הבדלים ממשיים בנסיבות',
  'דומה מאוד: אותה עבירה ונסיבות דומות (סוג וכמות הסם, תפקיד, היקף)',
];

const DEFAULT_SETTINGS = { mode: 'off', threshold: 1.5 };
export const MODES = ['off', 'admin', 'filter'];

export const isConfigured = () => Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN);

export async function relevanceSettings() {
  const stored = (await getSettings()).relevance ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveRelevanceSettings({ mode, threshold }) {
  await setSetting('relevance', { mode, threshold });
  return relevanceSettings();
}

class JevError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function runJev(state, questions, { signal } = {}) {
  // Third-party models run through /ai/run with the model named in the body (not in the path).
  const url = `${API_BASE}/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/run`;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_AI_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: { state, questions } }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.success === false) {
    const message = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new JevError(res.status, message.slice(0, 300));
  }
  // The model's answer, wherever the REST envelope puts it ({ result: {...} }, { result: { output } }, or bare).
  const candidates = [body?.result?.output, body?.result?.response, body?.result, body?.output, body];
  const answer = candidates.find((c) => c && typeof c === 'object' && c.answers) ?? body?.result ?? body;
  return Object.assign(answer, { raw: body });
}

// A short picture of a reply's structure (keys and types, no content), for when no score could be read from it.
function shapeOf(value, depth = 0) {
  if (value == null || typeof value !== 'object') return typeof value;
  if (depth > 3) return '…';
  if (Array.isArray(value)) return [value.length ? shapeOf(value[0], depth + 1) : 'empty'];
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'raw').slice(0, 12).map(([k, v]) => [k, shapeOf(v, depth + 1)]));
}

const RELEVANCE_QUESTION = {
  relevance: {
    type: 'score',
    instructions: 'עורך דין פלילי מחפש פסיקה להשוואה לתיק המקור. עד כמה תוצאת החיפוש רלוונטית להשוואה לתיק המקור? השווה את העבירות, הסעיפים, סוג הסם וכמותו והנסיבות העובדתיות. אל תתחשב בחומרת העונש שהוטל.',
    criteria: LEVELS,
  },
};

const clip = (text, max = MAX_TEXT) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

// The user's case as the document analysis recorded it.
export function caseText(analysis) {
  if (!analysis) return '';
  const lines = [];
  for (const defendant of analysis.defendants ?? []) {
    lines.push(`${defendant.label ?? 'נאשם'}:`);
    for (const count of defendant.counts ?? []) {
      const parts = [count.offense, count.law, count.section].filter(Boolean).join(' · ');
      const drugs = (count.drugs ?? [])
        .map((d) => [d.name, d.amount != null ? `${d.amount} ${d.unit === 'units' ? (d.unit_label || 'יחידות') : 'גרם'}` : null].filter(Boolean).join(' '))
        .join(', ');
      const facts = (count.facts ?? []).map((f) => `${f.label}: ${f.value}`).join('; ');
      lines.push(`- ${[parts, drugs && `סמים: ${drugs}`, facts].filter(Boolean).join(' | ')}`);
    }
  }
  const text = lines.join('\n');
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function resultText(item, corpus) {
  const drugs = (item.drugTotals ?? []).map((d) => [d.drug, d.amount, d.unit].filter((x) => x != null).join(' ')).join(', ');
  return [
    `${corpus === 'arrangements' ? 'הסדר מותנה' : 'גזר דין'}: ${item.title ?? ''}`,
    item.court ? `ערכאה: ${item.court}` : null,
    drugs ? `סמים בתיק: ${drugs}` : null,
    item.summary ? `תקציר: ${clip(item.summary)}` : null,
    item.snippet ? `קטע: ${clip(item.snippet, 400)}` : null,
  ].filter(Boolean).join('\n');
}

async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// Scores every item against the case. Returns items with `relevance: { score, confidence }` (or null when the
// call failed) and the token usage.
export async function scoreItems(items, { caseDescription, searchLabel, corpus, signal }) {
  let inputTokens = 0;
  let failures = 0;
  let lastError = null;
  const scored = await mapLimited(items, CONCURRENCY, async (item) => {
    const state = `תיק המקור:\n${caseDescription}\n\nמה חיפשו: ${searchLabel ?? ''}\n\nתוצאת החיפוש:\n${resultText(item, corpus)}`;
    try {
      const result = await runJev(state, RELEVANCE_QUESTION, { signal });
      inputTokens += result?.usage?.input_tokens ?? 0;
      const answer = result?.answers?.relevance;
      const score = Number(answer?.score);
      if (!Number.isFinite(score)) throw new Error('no score in the answer');
      return { ...item, relevance: { score: Math.round(score * 100) / 100, confidence: answer.confidence ?? null } };
    } catch (err) {
      if (signal?.aborted) throw err;
      failures++;
      lastError = err.message;
      return { ...item, relevance: null };
    }
  });
  if (failures) console.warn(`[relevance] ${failures}/${items.length} scores failed: ${lastError}`);
  return { items: scored, inputTokens, failures, lastError };
}

async function recordUsage({ account, conversationId, turnId, inputTokens, detail }) {
  await query(
    `INSERT INTO usage_events (user_id, user_email, conversation_id, turn_id, kind, provider, model, input_tokens, cost_usd, detail)
     VALUES ($1, $2, $3, $4, 'relevance', 'cloudflare', $5, $6, $7, $8::jsonb)`,
    [account.id, account.email, conversationId, turnId ?? null, MODEL, inputTokens, (inputTokens * PRICE_PER_M_INPUT) / 1e6, JSON.stringify(detail)],
  );
}

// Applied to one page of results. Returns { items, hidden, mode, threshold } where items are what users see.
// Admins also get the hidden items back, to calibrate the threshold.
export async function applyRelevance(result, { account, conversationId, turnId, corpus, label, signal }) {
  const settings = await relevanceSettings();
  const none = { items: result.items, hidden: [], mode: 'off', threshold: null };
  if (settings.mode === 'off' || !isConfigured() || !result.items.length || !conversationId) return none;
  const { rows } = await query('SELECT analysis FROM conversations WHERE id = $1', [conversationId]);
  const caseDescription = caseText(rows[0]?.analysis);
  if (!caseDescription) return none; // nothing to compare with (the user described the case in words only)
  const scored = await scoreItems(result.items, { caseDescription, searchLabel: label, corpus, signal });
  await recordUsage({
    account, conversationId, turnId, inputTokens: scored.inputTokens,
    detail: { corpus, label, items: scored.items.length, failures: scored.failures || undefined, error: scored.lastError ?? undefined, mode: settings.mode, threshold: settings.threshold },
  }).catch((err) => console.warn('[relevance] usage not recorded', err.message));
  if (settings.mode !== 'filter') return { items: scored.items, hidden: [], mode: settings.mode, threshold: settings.threshold };
  const below = (item) => item.relevance && item.relevance.score < settings.threshold;
  return {
    items: scored.items.filter((item) => !below(item)),
    hidden: scored.items.filter(below),
    mode: 'filter',
    threshold: settings.threshold,
  };
}

// A single call on a fixed sample, for the admin panel's connection test.
export async function testConnection() {
  if (!isConfigured()) return { ok: false, error: 'CLOUDFLARE_ACCOUNT_ID או CLOUDFLARE_AI_TOKEN אינם מוגדרים.' };
  const started = Date.now();
  try {
    const result = await runJev(
      'תיק המקור:\nנאשם 1: החזקת סם שלא לצריכה עצמית · פקודת הסמים המסוכנים · סעיף 7(א)+(ג) רישא | סמים: קוקאין 30 גרם\n\nתוצאת החיפוש:\nגזר דין: ת"פ 1234-01-24 מדינת ישראל נ\' פלוני\nסמים בתיק: קוקאין 25 גרם\nתקציר: הנאשם הורשע בהחזקת 25 גרם קוקאין שלא לצריכה עצמית.',
      RELEVANCE_QUESTION,
    );
    const score = result?.answers?.relevance?.score ?? null;
    return {
      ok: score != null,
      model: result?.model ?? MODEL,
      score,
      ...(score == null ? { error: 'התשובה לא כללה ציון', shape: JSON.stringify(shapeOf(result.raw)).slice(0, 600) } : {}),
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, status: err.status ?? null, error: err.message, ms: Date.now() - started };
  }
}
