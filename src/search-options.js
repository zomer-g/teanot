// What the search-setup form offers: the sentencing flags (read from a shared filter config, the drug-sentencing page
// config on z-g.co.il by default), the guideline sources (from TAG-IT), and the stored per-conversation choice.
import { z } from 'zod';
import { query } from './db.js';
import * as tagit from './tagit.js';

const FILTER_CONFIG_URL = process.env.SENTENCING_FILTER_CONFIG_URL || process.env.ZG_FILTER_CONFIG_URL
  || 'https://www.z-g.co.il/api/rulings?category=drug-sentencing&meta=1';
const FLAG_GROUP = 'גזירת העונש';
const FLAG_KEY_RE = /^meta\.[a-z0-9_]{1,60}$/;
const TTL_MS = 60 * 60 * 1000;

// Used only when the filter config cannot be reached and nothing was fetched before: the same ten flags as of 2026-09-17.
const FALLBACK_FLAGS = [
  ['meta.confessed', 'הודה באשמה'],
  ['meta.agreed_sentence', 'עונש מוסכם'],
  ['meta.conviction_annulled', 'ביטול הרשעה'],
  ['meta.rehab_deviation', 'סטייה משיקולי שיקום'],
  ['meta.priors_mentioned', 'עבר פלילי'],
  ['meta.prior_suspended_activated', 'הופעל עונש על תנאי קודם'],
  ['meta.defense_requested_deviation', 'ההגנה ביקשה חריגה ממתחם'],
  ['meta.court_deviated_from_range', 'ביהמ"ש חרג ממתחם'],
  ['meta.actual_prison_imposed', 'הוטל מאסר בפועל'],
  ['meta.community_service_imposed', 'הוטל מאסר בעבודות שירות'],
].map(([key, label]) => ({ key, label }));

let flagsCache = { at: 0, flags: null, source: null };

// The remote config is another system's data: only boolean flags on plain meta.* keys that TAG-IT's schema knows
// are accepted, so it can never inject another kind of filter.
async function fetchConfigFlags() {
  const res = await fetch(FILTER_CONFIG_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`filter config HTTP ${res.status}`);
  const body = await res.json();
  const fields = Array.isArray(body?.filterFields) ? body.filterFields : [];
  const schema = await tagit.getSentencingSchema();
  const known = new Set((schema.fields ?? []).map((f) => f.key));
  const flags = fields
    .filter((f) => f?.group === FLAG_GROUP && f.control === 'boolean' && FLAG_KEY_RE.test(f.key ?? '') && known.has(f.key))
    .map((f) => ({ key: f.key, label: String(f.label ?? f.key).slice(0, 80) }));
  if (!flags.length) throw new Error('filter config has no usable sentencing flags');
  return flags;
}

export async function getSentencingFlags() {
  if (flagsCache.flags && Date.now() - flagsCache.at < TTL_MS) return flagsCache;
  try {
    flagsCache = { at: Date.now(), flags: await fetchConfigFlags(), source: 'config' };
  } catch (err) {
    console.warn(`[search-options] sentencing flags from the filter config unavailable: ${err.message}`);
    // Keep the last good list; retry in five minutes rather than on every request.
    flagsCache = { at: Date.now() - TTL_MS + 5 * 60 * 1000, flags: flagsCache.flags ?? FALLBACK_FLAGS, source: flagsCache.source ?? 'fallback' };
  }
  return flagsCache;
}

// The punishments an arrangement can carry, read from the live catalogue of that corpus rather than fixed here.
// Values that are not a punishment (the catalogue samples carry a "json_object" placeholder) are dropped.
const PUNISHMENT_FIELD = 'meta.punishment_types';
let punishmentsCache = { at: 0, values: null };

export async function getArrangementPunishments() {
  if (punishmentsCache.values && Date.now() - punishmentsCache.at < TTL_MS) return punishmentsCache.values;
  try {
    const schema = await tagit.getSentencingSchema({ scope: tagit.ARRANGEMENTS_SCOPE });
    const field = (schema.fields ?? []).find((f) => f.key === PUNISHMENT_FIELD);
    const values = (field?.enum_values_sample ?? [])
      .filter((value) => typeof value === 'string' && /^[\u0590-\u05FF][\u0590-\u05FF\s"'()\-]{1,58}$/.test(value));
    if (!values.length) throw new Error('no punishment values in the arrangements catalogue');
    punishmentsCache = { at: Date.now(), values };
  } catch (err) {
    console.warn(`[search-options] arrangement punishments unavailable: ${err.message}`);
    // Keep the last good list; retry in five minutes rather than on every request.
    punishmentsCache = { at: Date.now() - TTL_MS + 5 * 60 * 1000, values: punishmentsCache.values ?? [] };
  }
  return punishmentsCache.values;
}

export async function getGuidelineSources() {
  try {
    return (await tagit.getGuidelinesFacets()).sources;
  } catch (err) {
    console.warn(`[search-options] guideline sources unavailable: ${err.message}`);
    return [];
  }
}

// What a search may cover. Conditional arrangements are catalogued in TAG-IT in the same shape as sentencing
// decisions, so they are searched with the same filters and the same flags.
export const CORPUS_KINDS = ['sentencing', 'guidelines', 'arrangements'];

// The arrangements corpus is filtered by what an arrangement actually contains: the kind of punishment agreed.
const arrangementsSetup = z.object({
  punishment_types: z.array(z.string().trim().min(1).max(60)).max(10),
  sort_direction: z.enum(['asc', 'desc']),
}).strict();

const documentSetup = z.object({
  flags: z.record(z.string().regex(FLAG_KEY_RE), z.boolean()).refine((f) => Object.keys(f).length <= 30),
  sort_direction: z.enum(['asc', 'desc']),
}).strict();

export const searchSetupSchema = z.object({
  kinds: z.array(z.enum(CORPUS_KINDS)).min(1).max(CORPUS_KINDS.length),
  sentencing: documentSetup.optional(),
  arrangements: arrangementsSetup.optional(),
  guidelines: z.object({
    sources: z.array(z.string().trim().min(1).max(200)).max(50),
  }).strict().optional(),
}).strict();

// Setups saved before conditional arrangements existed carry mode: sentencing | guidelines | both.
export function normalizeSetup(setup) {
  if (!setup || typeof setup !== 'object') return null;
  // Arrangements were briefly stored with the sentencing flags, which do not apply to them.
  if (setup.arrangements?.flags) {
    const { flags, ...rest } = setup.arrangements;
    setup = { ...setup, arrangements: rest };
  }
  if (Array.isArray(setup.kinds)) return setup;
  const kinds = setup.mode === 'guidelines' ? ['guidelines']
    : setup.mode === 'sentencing' ? ['sentencing'] : ['sentencing', 'guidelines'];
  const { mode, ...rest } = setup;
  return { ...rest, kinds };
}

// Keeps only flags the form currently offers, then stores the choice for the rest of the conversation.
export async function saveSearchSetup(conversationId, setup) {
  const { flags } = await getSentencingFlags();
  const offered = new Set(flags.map((f) => f.key));
  const documents = (chosen) => ({
    flags: Object.fromEntries(Object.entries(chosen?.flags ?? {}).filter(([key]) => offered.has(key))),
    sort_direction: chosen?.sort_direction ?? 'asc',
  });
  const kinds = setup.kinds ?? [];
  // An empty list means the catalogue could not be read, not that nothing is on offer: the choice is then kept
  // as the form sent it rather than silently dropped.
  const offeredPunishments = new Set(await getArrangementPunishments());
  const arrangements = (chosen) => ({
    punishment_types: [...new Set(chosen?.punishment_types ?? [])]
      .filter((value) => !offeredPunishments.size || offeredPunishments.has(value)),
    sort_direction: chosen?.sort_direction ?? 'asc',
  });
  const clean = {
    kinds,
    ...(kinds.includes('sentencing') ? { sentencing: documents(setup.sentencing) } : {}),
    ...(kinds.includes('arrangements') ? { arrangements: arrangements(setup.arrangements) } : {}),
    ...(kinds.includes('guidelines') ? { guidelines: { sources: [...new Set(setup.guidelines?.sources ?? [])] } } : {}),
  };
  await query('UPDATE conversations SET search_setup = $2::jsonb WHERE id = $1', [conversationId, JSON.stringify(clean)]);
  return clean;
}

export async function loadSearchSetup(conversationId) {
  const { rows } = await query('SELECT search_setup FROM conversations WHERE id = $1', [conversationId]);
  return normalizeSetup(rows[0]?.search_setup ?? null);
}
