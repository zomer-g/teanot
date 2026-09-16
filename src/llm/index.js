// Which language model answers, with which key. Chosen by an admin; keys come from the admin panel
// (stored encrypted) or, failing that, from the environment.
import { query } from '../db.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { getSettings, setSetting } from '../usage.js';
import { listAnthropicModels, streamAnthropic } from './anthropic.js';
import { listGeminiModels, streamGemini } from './gemini.js';
import { listOpenAIModels, streamOpenAI } from './openai.js';

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', envKey: 'ANTHROPIC_API_KEY', defaultModel: process.env.CLAUDE_MODEL || 'claude-opus-5', stream: streamAnthropic, list: listAnthropicModels },
  openai: { label: 'OpenAI', envKey: 'OPENAI_API_KEY', defaultModel: null, stream: streamOpenAI, list: listOpenAIModels },
  gemini: { label: 'Google Gemini', envKey: 'GEMINI_API_KEY', defaultModel: null, stream: streamGemini, list: listGeminiModels },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,119}$/;

export class ModelConfigError extends Error {}

async function storedKey(provider) {
  const { rows } = await query('SELECT ciphertext, iv, tag FROM provider_keys WHERE provider = $1', [provider]);
  return rows.length ? decryptSecret(rows[0]) : null;
}

export async function resolveKey(provider) {
  return (await storedKey(provider)) || process.env[PROVIDERS[provider].envKey] || null;
}

export async function modelSettings() {
  const settings = await getSettings();
  const provider = PROVIDER_IDS.includes(settings.llm_provider) ? settings.llm_provider : 'anthropic';
  const models = Object.fromEntries(PROVIDER_IDS.map((id) => [id, settings.llm_models?.[id] || PROVIDERS[id].defaultModel]));
  return { provider, models, prices: settings.model_prices ?? {} };
}

export async function activeModel() {
  const { provider, models } = await modelSettings();
  const model = models[provider];
  if (!model) throw new ModelConfigError(`no model selected for ${provider}`);
  const apiKey = await resolveKey(provider);
  if (!apiKey) throw new ModelConfigError(`no API key for ${provider}`);
  return { provider, model, apiKey };
}

export function streamModel({ provider, model, apiKey }, request) {
  return PROVIDERS[provider].stream({ apiKey, model, ...request });
}

export function listModels(provider, apiKey) {
  return PROVIDERS[provider].list(apiKey);
}

// What the admin panel may see: where each key comes from and its last characters, never the key.
export async function keyStatus() {
  const { rows } = await query('SELECT provider, ciphertext, iv, tag, last4, updated_by, updated_at FROM provider_keys');
  const stored = new Map(rows.map((row) => [row.provider, row]));
  return Object.fromEntries(PROVIDER_IDS.map((id) => {
    const row = stored.get(id);
    const readable = row ? decryptSecret(row) !== null : false;
    const env = Boolean(process.env[PROVIDERS[id].envKey]);
    return [id, {
      source: readable ? 'admin' : env ? 'env' : null,
      last4: readable ? row.last4 : null,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
      // Stored under a different master key: unusable until re-entered.
      unreadable: Boolean(row) && !readable,
      envKeyName: PROVIDERS[id].envKey,
      envAvailable: env,
    }];
  }));
}

export async function saveKey(provider, apiKey, adminEmail) {
  const box = encryptSecret(apiKey);
  await query(
    `INSERT INTO provider_keys (provider, ciphertext, iv, tag, last4, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (provider) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
       last4 = EXCLUDED.last4, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [provider, box.ciphertext, box.iv, box.tag, apiKey.slice(-4), adminEmail],
  );
}

export async function deleteKey(provider) {
  await query('DELETE FROM provider_keys WHERE provider = $1', [provider]);
}

export async function saveModelSettings({ provider, models, prices }) {
  const current = await modelSettings();
  if (provider) await setSetting('llm_provider', provider);
  if (models) await setSetting('llm_models', { ...current.models, ...models });
  if (prices) await setSetting('model_prices', { ...current.prices, ...prices });
}
