// Per-user usage log and token limits.
// "Tokens" for limit purposes = every token the language model processed: input + cache writes + cache reads + output.
import { query } from './db.js';

// USD per million tokens. Prices an admin enters (settings.model_prices) take precedence; a model with no price
// is logged with cost 0 and detail.priced = false, so the admin panel can say the cost is unknown.
const BUILTIN_PRICES = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

function priceFor(provider, model, adminPrices) {
  const entered = adminPrices?.[model];
  if (entered && Number.isFinite(entered.input) && Number.isFinite(entered.output)) {
    return { input: entered.input, output: entered.output, cacheRead: entered.cacheRead ?? entered.input, cacheWrite: entered.cacheWrite ?? entered.input };
  }
  if (BUILTIN_PRICES[model]) return BUILTIN_PRICES[model];
  // Server-side fallbacks can answer with another Claude model; bill it like the one requested rather than as free.
  if (provider === 'anthropic') return BUILTIN_PRICES['claude-opus-5'];
  return null;
}

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

// model is what the provider reports (often a dated snapshot, e.g. "...-2026-09-01"); requestedModel is the id
// the admin chose and priced, so it is the fallback for the price lookup.
export async function recordModelUsage({ account, conversationId, turnId = null, provider, model, requestedModel, usage, detail }) {
  const { input = 0, output = 0, cacheWrite = 0, cacheRead = 0 } = usage;
  const settings = await getSettings();
  const price = priceFor(provider, model, settings.model_prices) ?? (requestedModel ? priceFor(provider, requestedModel, settings.model_prices) : null);
  const cost = price ? (input * price.input + output * price.output + cacheWrite * price.cacheWrite + cacheRead * price.cacheRead) / 1e6 : 0;
  await query(
    `INSERT INTO usage_events
       (user_id, user_email, conversation_id, turn_id, kind, provider, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, total_tokens, cost_usd, detail)
     VALUES ($1, $2, $3, $4, 'llm', $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [account.id, account.email, conversationId, turnId, provider, model, input, output, cacheWrite, cacheRead,
      input + output + cacheWrite + cacheRead, cost, JSON.stringify({ ...detail, priced: Boolean(price) })],
  );
}

export async function recordTagitCall({ account, conversationId, turnId = null, detail }) {
  await query(
    `INSERT INTO usage_events (user_id, user_email, conversation_id, turn_id, kind, detail)
     VALUES ($1, $2, $3, $4, 'tagit', $5::jsonb)`,
    [account.id, account.email, conversationId, turnId, JSON.stringify(detail ?? null)],
  );
}
