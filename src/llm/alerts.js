// Tells the admin when the language model stops working for a reason only they can fix (credit ran out, key
// revoked, model withdrawn), and warns ahead of time when the credit they loaded is running low.
//
// No provider lets a plain API key read the account balance, so "running low" is our own estimate: the amount
// the admin says they loaded, minus what the usage log priced since then.
import { query } from '../db.js';
import { getSettings, setSetting } from '../usage.js';
import { ModelConfigError, modelSettings } from './index.js';

const ALERT_KEY = 'llm_alert';
const BUDGET_KEY = 'llm_budget';

const errorText = (err) => [err?.message, err?.error?.error?.message, err?.error?.message, err?.code, err?.error?.error?.type, err?.type]
  .filter((part) => typeof part === 'string').join(' ');

// billing: out of credit / quota exhausted · auth: key rejected · model: model missing · rate_limit · other.
export function classifyProviderError(err) {
  const status = Number(err?.status);
  const text = errorText(err);
  // Anthropic: 400 "Your credit balance is too low", or a billing_error. OpenAI: 429 insufficient_quota.
  // Gemini: 429 RESOURCE_EXHAUSTED "exceeded your current quota ... check your plan and billing details",
  // which it also sends for a per-minute limit, so a limit named per minute/second stays a rate limit.
  if (/billing_error|credit balance|insufficient_quota|prepa(id|yment)|billing (is )?(not enabled|disabled)|BILLING_DISABLED|out of credits?/i.test(text)) return 'billing';
  if (status === 402) return 'billing';
  // Gemini answers a bad key with 400 INVALID_ARGUMENT, not 401.
  if (/API key not valid|API_KEY_INVALID/i.test(text)) return 'auth';
  if (status === 429) {
    if (/per ?(minute|second)|PerMinute|PerSecond|rate limit|overloaded|try again/i.test(text)) return 'rate_limit';
    if (/quota|billing|RESOURCE_EXHAUSTED/i.test(text)) return 'billing';
    return 'rate_limit';
  }
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model';
  return 'other';
}

const ACTIONABLE = new Set(['billing', 'auth', 'model']);

// Provider messages can echo part of a key; keep the text short and mask anything key-shaped.
// SDKs put the provider's JSON body in err.message; show the admin just the sentence inside it.
function providerMessage(err) {
  const nested = err?.error?.error?.message ?? err?.error?.message;
  if (typeof nested === 'string') return nested;
  const raw = String(err?.message ?? '');
  const json = raw.slice(raw.indexOf('{'));
  try {
    const body = JSON.parse(json);
    return body?.error?.message ?? body?.message ?? raw;
  } catch {
    return raw;
  }
}
const safeMessage = (err) => providerMessage(err).replace(/[A-Za-z0-9_\-]{24,}/g, '…').slice(0, 400);

export async function recordProviderFailure({ provider, model, err }) {
  const kind = classifyProviderError(err);
  if (!ACTIONABLE.has(kind)) return kind;
  const now = new Date().toISOString();
  const previous = (await getSettings())[ALERT_KEY];
  const same = previous && previous.provider === provider && previous.kind === kind;
  await setSetting(ALERT_KEY, {
    kind,
    provider,
    model,
    status: Number(err?.status) || null,
    message: safeMessage(err),
    firstAt: same ? previous.firstAt : now,
    lastAt: now,
    count: same ? (previous.count ?? 1) + 1 : 1,
  });
  console.warn(`[llm-alert] ${kind} from ${provider} (${model}): status ${err?.status ?? 'none'}`);
  return kind;
}

// No active model or no key for it: nothing reaches a provider, but every question fails all the same.
export async function recordConfigFailure(err) {
  if (!(err instanceof ModelConfigError)) return;
  const { provider, models } = await modelSettings();
  const now = new Date().toISOString();
  const previous = (await getSettings())[ALERT_KEY];
  const same = previous?.kind === 'config' && previous.provider === provider;
  await setSetting(ALERT_KEY, {
    kind: 'config', provider, model: models[provider] ?? null, status: null, message: err.message,
    firstAt: same ? previous.firstAt : now, lastAt: now, count: same ? (previous.count ?? 1) + 1 : 1,
  });
}

// A successful call proves the problem is gone. One indexed delete, and nothing when there is no alert.
export async function clearProviderAlert(provider) {
  await query(`DELETE FROM settings WHERE key = $1 AND value->>'provider' = $2`, [ALERT_KEY, provider]);
}

export async function dismissProviderAlert() {
  await query('DELETE FROM settings WHERE key = $1', [ALERT_KEY]);
}

// budget = { [provider]: { amountUsd, since: 'YYYY-MM-DD', warnBelowUsd } }
export async function budgetStatus(settings) {
  const budgets = settings?.[BUDGET_KEY] ?? {};
  const out = {};
  for (const [provider, budget] of Object.entries(budgets)) {
    if (!budget || !Number.isFinite(budget.amountUsd)) continue;
    const { rows } = await query(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent,
              COUNT(*) FILTER (WHERE detail->>'priced' = 'false')::int AS unpriced
       FROM usage_events WHERE kind = 'llm' AND provider = $1 AND created_at >= $2::date`,
      [provider, budget.since],
    );
    const remaining = budget.amountUsd - rows[0].spent;
    out[provider] = {
      ...budget,
      spentUsd: rows[0].spent,
      unpricedCalls: rows[0].unpriced,
      remainingUsd: remaining,
      low: Number.isFinite(budget.warnBelowUsd) && remaining <= budget.warnBelowUsd,
    };
  }
  return out;
}

export async function saveBudget(provider, budget) {
  const current = (await getSettings())[BUDGET_KEY] ?? {};
  const next = { ...current };
  if (budget) next[provider] = budget;
  else delete next[provider];
  await setSetting(BUDGET_KEY, next);
}

// What an admin should see right now, in the chat and in the admin panel. Only the active provider's budget
// counts: a low balance on a provider nobody is using is not urgent.
export async function adminAlerts(activeProvider) {
  const settings = await getSettings();
  const alerts = [];
  const failure = settings[ALERT_KEY];
  if (failure) alerts.push({ type: 'provider_failure', ...failure, active: failure.provider === activeProvider });
  const budgets = await budgetStatus(settings);
  const budget = budgets[activeProvider];
  if (budget?.low) alerts.push({ type: 'low_budget', provider: activeProvider, ...budget });
  return alerts;
}
