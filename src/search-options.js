// What the search-setup form offers: the sentencing flags (defined once, on the Z-G site's drug-sentencing page,
// so both products filter the same way), the guideline sources (from TAG-IT), and the stored per-conversation choice.
import { z } from 'zod';
import { query } from './db.js';
import * as tagit from './tagit.js';

const ZG_CONFIG_URL = process.env.ZG_FILTER_CONFIG_URL || 'https://www.z-g.co.il/api/rulings?category=drug-sentencing&meta=1';
const FLAG_GROUP = 'גזירת העונש';
const FLAG_KEY_RE = /^meta\.[a-z0-9_]{1,60}$/;
const TTL_MS = 60 * 60 * 1000;

// Used only when Z-G cannot be reached and nothing was fetched before: the same ten flags as of 2026-09-17.
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
async function fetchZgFlags() {
  const res = await fetch(ZG_CONFIG_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Z-G config HTTP ${res.status}`);
  const body = await res.json();
  const fields = Array.isArray(body?.filterFields) ? body.filterFields : [];
  const schema = await tagit.getSentencingSchema();
  const known = new Set((schema.fields ?? []).map((f) => f.key));
  const flags = fields
    .filter((f) => f?.group === FLAG_GROUP && f.control === 'boolean' && FLAG_KEY_RE.test(f.key ?? '') && known.has(f.key))
    .map((f) => ({ key: f.key, label: String(f.label ?? f.key).slice(0, 80) }));
  if (!flags.length) throw new Error('Z-G config has no usable sentencing flags');
  return flags;
}

export async function getSentencingFlags() {
  if (flagsCache.flags && Date.now() - flagsCache.at < TTL_MS) return flagsCache;
  try {
    flagsCache = { at: Date.now(), flags: await fetchZgFlags(), source: 'z-g' };
  } catch (err) {
    console.warn(`[search-options] sentencing flags from Z-G unavailable: ${err.message}`);
    // Keep the last good list; retry in five minutes rather than on every request.
    flagsCache = { at: Date.now() - TTL_MS + 5 * 60 * 1000, flags: flagsCache.flags ?? FALLBACK_FLAGS, source: flagsCache.source ?? 'fallback' };
  }
  return flagsCache;
}

export async function getGuidelineSources() {
  try {
    return (await tagit.getGuidelinesFacets()).sources;
  } catch (err) {
    console.warn(`[search-options] guideline sources unavailable: ${err.message}`);
    return [];
  }
}

export const searchSetupSchema = z.object({
  mode: z.enum(['sentencing', 'guidelines', 'both']),
  sentencing: z.object({
    flags: z.record(z.string().regex(FLAG_KEY_RE), z.boolean()).refine((f) => Object.keys(f).length <= 30),
    sort_direction: z.enum(['asc', 'desc']),
  }).strict().optional(),
  guidelines: z.object({
    sources: z.array(z.string().trim().min(1).max(200)).max(50),
  }).strict().optional(),
}).strict();

// Keeps only flags the form currently offers, then stores the choice for the rest of the conversation.
export async function saveSearchSetup(conversationId, setup) {
  const { flags } = await getSentencingFlags();
  const offered = new Set(flags.map((f) => f.key));
  const clean = {
    mode: setup.mode,
    ...(setup.mode !== 'guidelines' ? {
      sentencing: {
        flags: Object.fromEntries(Object.entries(setup.sentencing?.flags ?? {}).filter(([key]) => offered.has(key))),
        sort_direction: setup.sentencing?.sort_direction ?? 'asc',
      },
    } : {}),
    ...(setup.mode !== 'sentencing' ? { guidelines: { sources: [...new Set(setup.guidelines?.sources ?? [])] } } : {}),
  };
  await query('UPDATE conversations SET search_setup = $2::jsonb WHERE id = $1', [conversationId, JSON.stringify(clean)]);
  return clean;
}

export async function loadSearchSetup(conversationId) {
  const { rows } = await query('SELECT search_setup FROM conversations WHERE id = $1', [conversationId]);
  return rows[0]?.search_setup ?? null;
}
