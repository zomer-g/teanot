// Admin API: who may use the system, their token limits, and the full usage log.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAdmin } from '../auth.js';
import { getSettings, repriceUnpricedUsage, setSetting } from '../usage.js';
import { encryptionAvailable } from '../secrets.js';
import { adminAlerts, budgetStatus, dismissProviderAlert, saveBudget } from '../llm/alerts.js';
import { describeSearch } from '../../public/search-describe.js';
import { deleteKey, keyStatus, listModels, MODEL_ID_RE, modelSettings, PROVIDER_IDS, PROVIDERS, resolveKey, saveKey, saveModelSettings } from '../llm/index.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const ROLES = ['user', 'admin'];
const STATUSES = ['active', 'pending', 'blocked'];
const PERIODS = ['monthly', 'total'];

const tokenLimit = z.union([z.number().int().min(0).max(2_000_000_000), z.null()]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const intParam = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

function parse(schema, body, res) {
  const result = schema.safeParse(body);
  if (!result.success) {
    res.status(400).json({ error: 'invalid_input', issues: result.error.issues });
    return null;
  }
  return result.data;
}

adminRouter.get('/overview', async (_req, res) => {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE status = 'active')::int AS active_users,
      (SELECT COUNT(*) FROM users WHERE status = 'pending')::int AS pending_users,
      (SELECT COUNT(*) FROM conversations WHERE created_at >= date_trunc('month', now()))::int AS conversations_month,
      (SELECT COUNT(*) FROM turns WHERE request_kind <> 'more' AND started_at >= date_trunc('month', now()))::int AS turns_month,
      (SELECT COALESCE(SUM(total_tokens), 0) FROM usage_events WHERE created_at >= date_trunc('month', now()))::float8 AS tokens_month,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE created_at >= date_trunc('month', now()))::float8 AS cost_month,
      (SELECT COUNT(*) FROM usage_events WHERE kind = 'tagit' AND created_at >= date_trunc('month', now()))::int AS tagit_calls_month
  `);
  res.json({ overview: rows[0], settings: await getSettings(), alerts: await adminAlerts((await modelSettings()).provider) });
});

adminRouter.get('/users', async (_req, res) => {
  const { rows } = await query(`
    SELECT u.id, u.email, u.name, u.role, u.status, u.token_limit, u.limit_period, u.note,
           u.created_at, u.last_seen_at,
           COALESCE(SUM(e.total_tokens) FILTER (WHERE e.created_at >= date_trunc('month', now())), 0)::float8 AS tokens_month,
           COALESCE(SUM(e.total_tokens), 0)::float8 AS tokens_total,
           COALESCE(SUM(e.cost_usd), 0)::float8 AS cost_total,
           COUNT(DISTINCT e.conversation_id)::int AS conversations,
           MAX(e.created_at) AS last_used_at
    FROM users u
    LEFT JOIN usage_events e ON e.user_id = u.id
    GROUP BY u.id
    ORDER BY (u.status = 'pending') DESC, u.last_seen_at DESC NULLS LAST, u.id DESC
  `);
  res.json({ users: rows, settings: await getSettings() });
});

const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(200).optional().nullable(),
  role: z.enum(ROLES).default('user'),
  status: z.enum(STATUSES).default('active'),
  token_limit: tokenLimit.optional(),
  limit_period: z.enum(PERIODS).nullable().optional(),
  note: z.string().max(1000).optional().nullable(),
});

// Pre-authorise someone by email before they ever sign in (or re-activate an existing row).
adminRouter.post('/users', async (req, res) => {
  const data = parse(createUserSchema, req.body, res);
  if (!data) return;
  const { rows } = await query(
    `INSERT INTO users (email, name, role, status, token_limit, limit_period, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (email) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, users.name), role = EXCLUDED.role, status = EXCLUDED.status,
       token_limit = EXCLUDED.token_limit, limit_period = EXCLUDED.limit_period, note = EXCLUDED.note
     RETURNING *`,
    [data.email, data.name ?? null, data.role, data.status, data.token_limit ?? null, data.limit_period ?? null, data.note ?? null],
  );
  res.json({ user: rows[0] });
});

const updateUserSchema = z.object({
  name: z.string().trim().max(200).nullable().optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(STATUSES).optional(),
  token_limit: tokenLimit.optional(),
  limit_period: z.enum(PERIODS).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
}).strict();

adminRouter.patch('/users/:id', async (req, res) => {
  const data = parse(updateUserSchema, req.body, res);
  if (!data) return;
  const id = Number(req.params.id);
  if (id === req.account.id && (data.role === 'user' || (data.status && data.status !== 'active'))) {
    return res.status(400).json({ error: 'cannot_demote_self' });
  }
  const fields = Object.keys(data);
  if (!fields.length) return res.status(400).json({ error: 'nothing_to_update' });
  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  const { rows } = await query(
    `UPDATE users SET ${sets} WHERE id = $1 RETURNING *`,
    [id, ...fields.map((f) => data[f])],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json({ user: rows[0] });
});

const settingsSchema = z.object({
  default_token_limit: tokenLimit,
  default_limit_period: z.enum(PERIODS),
  apply_to_all: z.boolean().optional(),
});

adminRouter.put('/settings', async (req, res) => {
  const data = parse(settingsSchema, req.body, res);
  if (!data) return;
  await setSetting('default_token_limit', data.default_token_limit);
  await setSetting('default_limit_period', data.default_limit_period);
  if (data.apply_to_all) {
    // Remove per-user overrides so every user falls back to the new default.
    await query('UPDATE users SET token_limit = NULL, limit_period = NULL');
  }
  res.json({ settings: await getSettings() });
});

// ---------- Language model: provider, model, keys and prices ----------

async function modelsPayload() {
  const [config, keys, settings] = await Promise.all([modelSettings(), keyStatus(), getSettings()]);
  return {
    ...config,
    budgets: await budgetStatus(settings),
    providers: PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label, key: keys[id] })),
    encryptionAvailable: encryptionAvailable(),
  };
}

adminRouter.get('/models', async (_req, res) => {
  res.json(await modelsPayload());
});

const usdPerMillion = z.number().min(0).max(10_000);
const priceSchema = z.union([
  z.object({ input: usdPerMillion, output: usdPerMillion, cacheRead: usdPerMillion.optional(), cacheWrite: usdPerMillion.optional() }).strict(),
  z.null(), // clears a price
]);
const modelId = z.string().trim().regex(MODEL_ID_RE);
const modelsSchema = z.object({
  provider: z.enum(PROVIDER_IDS).optional(),
  models: z.object(Object.fromEntries(PROVIDER_IDS.map((id) => [id, modelId.optional()]))).strict().optional(),
  prices: z.record(modelId, priceSchema).refine((p) => Object.keys(p).length <= 50).optional(),
}).strict();

adminRouter.put('/models', async (req, res) => {
  const data = parse(modelsSchema, req.body, res);
  if (!data) return;
  if (data.provider) {
    const next = { ...(await modelSettings()).models, ...data.models };
    // The key comes first: without it the model list cannot be loaded either.
    if (!(await resolveKey(data.provider))) return res.status(400).json({ error: 'no_key', message: 'יש להגדיר מפתח API עבור הספק לפני שמפעילים אותו.' });
    if (!next[data.provider]) return res.status(400).json({ error: 'no_model', message: 'יש לבחור מודל עבור הספק לפני שמפעילים אותו.' });
  }
  await saveModelSettings(data);
  if (data.prices) await repriceUnpricedUsage(); // a newly entered price also fixes calls logged without one
  console.log(`[admin] model settings changed by ${req.account.email}: ${JSON.stringify({ provider: data.provider, models: data.models, prices: data.prices ? Object.keys(data.prices) : undefined })}`);
  res.json(await modelsPayload());
});

const providerParam = (req, res) => {
  if (PROVIDER_IDS.includes(req.params.provider)) return req.params.provider;
  res.status(404).json({ error: 'unknown_provider' });
  return null;
};
// Printable ASCII without spaces: every provider's keys look like this, and it keeps stray whitespace out.
const keySchema = z.object({ apiKey: z.string().trim().min(16).max(512).regex(/^[!-~]+$/) }).strict();

function providerError(err) {
  const status = Number(err?.status);
  if (status === 401 || status === 403) return { status: 400, error: 'invalid_key', message: 'הספק דחה את המפתח. בדקו שהועתק במלואו ושיש לו הרשאה.' };
  if (status === 429) return { status: 502, error: 'rate_limited', message: 'הספק הגביל את קצב הבקשות. נסו שוב בעוד דקה.' };
  return { status: 502, error: 'provider_error', message: 'לא ניתן היה לפנות לספק כרגע.' };
}

// The key is checked by listing the provider's models before it is stored, so a typo is caught here
// rather than in a user's conversation.
adminRouter.put('/models/:provider/key', async (req, res) => {
  const provider = providerParam(req, res);
  if (!provider) return;
  if (!encryptionAvailable()) return res.status(409).json({ error: 'encryption_unavailable', message: 'כדי לשמור מפתחות בממשק יש להגדיר בשרת את SETTINGS_ENCRYPTION_KEY (לפחות 32 תווים).' });
  const data = parse(keySchema, req.body, res);
  if (!data) return;
  let available;
  try {
    available = await listModels(provider, data.apiKey);
  } catch (err) {
    const mapped = providerError(err);
    console.warn(`[admin] key check failed for ${provider}: status ${err.status ?? 'none'}`); // provider messages can quote the key
    return res.status(mapped.status).json(mapped);
  }
  await saveKey(provider, data.apiKey, req.account.email);
  console.log(`[admin] ${provider} API key set by ${req.account.email}`);
  res.json({ ...(await modelsPayload()), available });
});

adminRouter.delete('/models/:provider/key', async (req, res) => {
  const provider = providerParam(req, res);
  if (!provider) return;
  const { provider: active } = await modelSettings();
  await deleteKey(provider);
  console.log(`[admin] ${provider} API key removed by ${req.account.email}`);
  const payload = await modelsPayload();
  // Removing the active provider's only key would stop every conversation: say so.
  const stranded = active === provider && !(await resolveKey(provider));
  res.json({ ...payload, warning: stranded ? 'הספק הפעיל נשאר ללא מפתח, ולכן שיחות ייכשלו עד שיוגדר מפתח או ייבחר ספק אחר.' : null });
});

// The credit the admin loaded at a provider, so the panel can warn before it runs out.
const budgetSchema = z.union([
  z.object({
    amountUsd: z.number().min(0).max(1_000_000),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d))),
    warnBelowUsd: z.number().min(0).max(1_000_000),
  }).strict(),
  z.null(), // stops tracking
]);

adminRouter.put('/models/:provider/budget', async (req, res) => {
  const provider = providerParam(req, res);
  if (!provider) return;
  // parse() answers null for invalid input, and null is a valid budget here, so check directly.
  const result = budgetSchema.safeParse(req.body?.budget ?? null);
  if (!result.success) return res.status(400).json({ error: 'invalid_input', issues: result.error.issues });
  const data = result.data;
  await saveBudget(provider, data);
  console.log(`[admin] ${provider} credit tracking ${data ? 'set' : 'cleared'} by ${req.account.email}`);
  res.json(await modelsPayload());
});

adminRouter.delete('/alert', async (req, res) => {
  await dismissProviderAlert();
  console.log(`[admin] model alert dismissed by ${req.account.email}`);
  res.json({ alerts: await adminAlerts((await modelSettings()).provider) });
});

adminRouter.get('/models/:provider/available', async (req, res) => {
  const provider = providerParam(req, res);
  if (!provider) return;
  const apiKey = await resolveKey(provider);
  if (!apiKey) return res.status(400).json({ error: 'no_key', message: 'לא הוגדר מפתח API לספק הזה.' });
  try {
    res.json({ available: await listModels(provider, apiKey) });
  } catch (err) {
    const mapped = providerError(err);
    res.status(mapped.status).json(mapped);
  }
});

adminRouter.get('/usage', async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.user_id) add('e.user_id = ?', Number(req.query.user_id));
  if (req.query.kind === 'llm') where.push("e.kind IN ('llm', 'claude')");
  else if (req.query.kind) add('e.kind = ?', String(req.query.kind));
  if (req.query.from) add('e.created_at >= ?::date', String(req.query.from));
  if (req.query.to) add("e.created_at < (?::date + interval '1 day')", String(req.query.to));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = intParam(req.query.limit, 100, 1, 500);
  const offset = intParam(req.query.offset, 0, 0, 10_000_000);

  const [events, totals] = await Promise.all([
    query(
      `SELECT e.id, e.user_id, e.user_email, e.conversation_id, c.title AS conversation_title, e.kind, e.provider, e.model,
              e.input_tokens, e.output_tokens, e.cache_creation_tokens, e.cache_read_tokens, e.total_tokens,
              e.cost_usd, e.detail, e.created_at
       FROM usage_events e LEFT JOIN conversations c ON c.id = e.conversation_id
       ${whereSql}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    query(
      `SELECT COUNT(*)::int AS events,
              COALESCE(SUM(e.total_tokens), 0)::float8 AS tokens,
              COALESCE(SUM(e.cost_usd), 0)::float8 AS cost,
              COUNT(*) FILTER (WHERE e.kind = 'tagit')::int AS tagit_calls
       FROM usage_events e ${whereSql}`,
      params,
    ),
  ]);
  res.json({ events: events.rows, totals: totals.rows[0], limit, offset });
});

// ---------- Query log: one row per user request, with its searches and cost ----------

function turnFilters(q) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (q.user_id) add('t.user_id = ?', Number(q.user_id));
  if (q.status) add('t.status = ?', String(q.status));
  if (q.kind) add('t.request_kind = ?', String(q.kind));
  if (q.from) add('t.started_at >= ?::date', String(q.from));
  if (q.to) add("t.started_at < (?::date + interval '1 day')", String(q.to));
  if (q.q) add("(t.request_text ILIKE '%' || ? || '%' OR t.file_name ILIKE '%' || ? || '%')", String(q.q));
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function listTurns(q, limit, offset) {
  const { whereSql, params } = turnFilters(q);
  const [turns, totals] = await Promise.all([
    query(
      `SELECT t.id, t.user_id, t.user_email, t.conversation_id, c.title AS conversation_title,
              t.request_kind, t.request_text, t.file_name, t.answers, t.status, t.error, t.started_at, t.finished_at,
              EXTRACT(EPOCH FROM (COALESCE(t.finished_at, now()) - t.started_at))::float8 AS duration_seconds,
              COUNT(e.id) FILTER (WHERE e.kind IN ('llm', 'claude'))::int AS model_calls,
              COUNT(e.id) FILTER (WHERE e.kind = 'llm' AND e.detail->>'priced' = 'false')::int AS unpriced_calls,
              COUNT(e.id) FILTER (WHERE e.kind = 'tagit')::int AS tagit_calls,
              COALESCE(SUM(e.input_tokens), 0)::float8 AS input_tokens,
              COALESCE(SUM(e.output_tokens), 0)::float8 AS output_tokens,
              COALESCE(SUM(e.cache_creation_tokens), 0)::float8 AS cache_creation_tokens,
              COALESCE(SUM(e.cache_read_tokens), 0)::float8 AS cache_read_tokens,
              COALESCE(SUM(e.total_tokens), 0)::float8 AS total_tokens,
              COALESCE(SUM(e.cost_usd), 0)::float8 AS cost_usd,
              COALESCE(jsonb_agg(e.detail ORDER BY e.id) FILTER (WHERE e.kind = 'tagit'), '[]'::jsonb) AS searches
       FROM turns t
       LEFT JOIN usage_events e ON e.turn_id = t.id
       LEFT JOIN conversations c ON c.id = t.conversation_id
       ${whereSql}
       GROUP BY t.id, c.title
       ORDER BY t.started_at DESC, t.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    query(
      `SELECT COUNT(DISTINCT t.id)::int AS turns,
              COALESCE(SUM(e.total_tokens), 0)::float8 AS tokens,
              COALESCE(SUM(e.cost_usd), 0)::float8 AS cost,
              COUNT(e.id) FILTER (WHERE e.kind = 'tagit')::int AS tagit_calls
       FROM turns t LEFT JOIN usage_events e ON e.turn_id = t.id
       ${whereSql}`,
      params,
    ),
  ]);
  return { turns: turns.rows, totals: totals.rows[0] };
}

adminRouter.get('/turns', async (req, res) => {
  const limit = intParam(req.query.limit, 50, 1, 500);
  const offset = intParam(req.query.offset, 0, 0, 10_000_000);
  res.json({ ...(await listTurns(req.query, limit, offset)), limit, offset });
});

const REQUEST_KIND_LABELS = { document: 'מסמך', text: 'הודעה', answers: 'תשובה לשאלות', more: 'תוצאות נוספות' };

function requestDescription(t) {
  // Tolerates malformed stored answers so one bad row cannot break the export.
  const answers = Array.isArray(t.answers)
    ? t.answers.filter((a) => a && typeof a === 'object').map((a) => {
      const selected = Array.isArray(a.selected) ? a.selected.map((s) => s?.label) : [];
      const value = [...selected, a.free_text].filter((x) => typeof x === 'string' && x).join(', ') || 'ללא העדפה';
      return `${String(a.question ?? '')}: ${value}`;
    }).join(' | ')
    : '';
  if (answers) return [answers, t.request_text].filter(Boolean).join(' · ');
  return [t.file_name, t.request_text].filter(Boolean).join(' · ');
}

adminRouter.get('/turns.csv', async (req, res) => {
  const { turns } = await listTurns(req.query, 5000, 0);
  const header = ['זמן', 'משתמש', 'סוג בקשה', 'בקשה', 'חיפושים ב-TAG-IT', 'קריאות למודל', 'טוקני קלט', 'טוקני פלט',
    'כתיבה למטמון', 'קריאה ממטמון', 'סה"כ טוקנים', 'עלות משוערת (USD)', 'משך (שניות)', 'סטטוס', 'שגיאה', 'שיחה'];
  // Quote every cell and neutralise spreadsheet formulas in user-controlled text (CSV injection).
  const cell = (value) => {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = turns.map((t) => [
    new Date(t.started_at).toISOString(), t.user_email, REQUEST_KIND_LABELS[t.request_kind] || t.request_kind, requestDescription(t),
    t.searches.map((s) => { const d = describeSearch(s); return [s.action, d.title, ...d.parts].filter(Boolean).join(' · '); }).join(' | '),
    t.model_calls, t.input_tokens, t.output_tokens, t.cache_creation_tokens, t.cache_read_tokens, t.total_tokens,
    t.unpriced_calls ? `${t.cost_usd.toFixed(4)} (חלקי: ${t.unpriced_calls} קריאות ללא מחיר)` : t.cost_usd.toFixed(4), Math.round(t.duration_seconds), t.status, t.error, t.conversation_title,
  ].map(cell).join(','));
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="teanot-queries-${date}.csv"`);
  res.send(`﻿${[header.map(cell).join(','), ...lines].join('\r\n')}`);
});

adminRouter.get('/conversations/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const conv = await query(
    `SELECT c.id, c.title, c.doc_name, c.analysis, c.created_at, u.email
     FROM conversations c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
    [req.params.id],
  );
  if (!conv.rows.length) return res.status(404).json({ error: 'not_found' });
  const msgs = await query(
    'SELECT id, role, ui, created_at FROM messages WHERE conversation_id = $1 ORDER BY id',
    [req.params.id],
  );
  res.json({ conversation: conv.rows[0], messages: msgs.rows });
});
