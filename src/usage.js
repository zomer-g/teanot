// Per-user usage log and token limits.
// "Tokens" for limit purposes = every token Claude processed: input + cache writes + cache reads + output.
import { query } from './db.js';

// USD per million tokens.
const PRICING = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

export class QuotaExceededError extends Error {
  constructor(quota) {
    super('quota_exceeded');
    this.quota = quota;
  }
}

export async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

export async function getQuota(account) {
  const settings = await getSettings();
  const limit = account.token_limit ?? settings.default_token_limit ?? null;
  const period = account.limit_period ?? settings.default_limit_period ?? 'monthly';
  const since = period === 'monthly' ? "date_trunc('month', now())" : "'-infinity'::timestamptz";
  const { rows } = await query(
    `SELECT COALESCE(SUM(total_tokens), 0)::float8 AS used, COALESCE(SUM(cost_usd), 0)::float8 AS cost
     FROM usage_events WHERE user_id = $1 AND created_at >= ${since}`,
    [account.id],
  );
  const used = rows[0].used;
  return {
    limit,
    period,
    used,
    costUsd: rows[0].cost,
    remaining: limit == null ? null : Math.max(0, limit - used),
    exceeded: limit != null && used >= limit,
  };
}

export async function assertQuota(account) {
  const quota = await getQuota(account);
  if (quota.exceeded) throw new QuotaExceededError(quota);
  return quota;
}

export async function recordClaudeUsage({ account, conversationId, model, usage, detail }) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const price = PRICING[model] ?? PRICING['claude-opus-5'];
  const cost = (input * price.input + output * price.output + cacheWrite * price.cacheWrite + cacheRead * price.cacheRead) / 1e6;
  await query(
    `INSERT INTO usage_events
       (user_id, user_email, conversation_id, kind, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, detail)
     VALUES ($1, $2, $3, 'claude', $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [account.id, account.email, conversationId, model, input, output, cacheWrite, cacheRead,
      input + output + cacheWrite + cacheRead, cost, JSON.stringify(detail ?? null)],
  );
}

export async function recordTagitCall({ account, conversationId, detail }) {
  await query(
    `INSERT INTO usage_events (user_id, user_email, conversation_id, kind, detail)
     VALUES ($1, $2, $3, 'tagit', $4::jsonb)`,
    [account.id, account.email, conversationId, JSON.stringify(detail ?? null)],
  );
}
