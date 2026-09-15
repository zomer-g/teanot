// Admin API: who may use the system, their token limits, and the full usage log.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { requireAdmin } from '../auth.js';
import { getSettings, setSetting } from '../usage.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const ROLES = ['user', 'admin'];
const STATUSES = ['active', 'pending', 'blocked'];
const PERIODS = ['monthly', 'total'];

const tokenLimit = z.union([z.number().int().min(0).max(2_000_000_000), z.null()]);

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
      (SELECT COALESCE(SUM(total_tokens), 0) FROM usage_events WHERE created_at >= date_trunc('month', now()))::float8 AS tokens_month,
      (SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE created_at >= date_trunc('month', now()))::float8 AS cost_month,
      (SELECT COUNT(*) FROM usage_events WHERE kind = 'tagit' AND created_at >= date_trunc('month', now()))::int AS tagit_calls_month
  `);
  res.json({ overview: rows[0], settings: await getSettings() });
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

adminRouter.get('/usage', async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.user_id) add('e.user_id = ?', Number(req.query.user_id));
  if (req.query.kind) add('e.kind = ?', String(req.query.kind));
  if (req.query.from) add('e.created_at >= ?::date', String(req.query.from));
  if (req.query.to) add("e.created_at < (?::date + interval '1 day')", String(req.query.to));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const [events, totals] = await Promise.all([
    query(
      `SELECT e.id, e.user_id, e.user_email, e.conversation_id, c.title AS conversation_title, e.kind, e.model,
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

adminRouter.get('/conversations/:id', async (req, res) => {
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
