// TAG-IT (tag-it.biz) public API client.
// Rulings: /api/public/rulings/* (scope 1 = criminal sentencing decisions).
// Guidelines: /api/public/over-guidelines/*.
// Filters and sorts are kept on indexed meta.* fields: ai.*/sql.* filters time out on scope 1.

const BASE = (process.env.TAGIT_API_URL || 'https://tag-it.biz').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.TAGIT_TIMEOUT_MS || 120_000);
const rulingsKey = () => process.env.TAGIT_API_KEY;
export const SENTENCING_SCOPE = Number(process.env.TAGIT_SENTENCING_SCOPE || 1);

// Canonical meta.drug_types name → slug used by meta.drug_total_g_<slug> / meta.drug_total_n_<slug>.
export const DRUG_SLUGS = {
  'קנאביס': 'cannabis',
  'קוקאין': 'cocaine',
  'חשיש': 'hashish',
  'הרואין': 'heroin',
  'MDMA': 'mdma',
  'קטמין': 'ketamine',
  'LSD': 'lsd',
  'מתאמפטמין': 'meth',
  'בופרנורפין': 'buprenorphine',
  'פסילוצין': 'psilocybin',
};

export const COURT_INSTANCES = ['שלום', 'מחוזי', 'עליון', 'תעבורה', 'נוער'];

export class TagitError extends Error {
  constructor(status, body) {
    super(`TAG-IT ${status || 'request failed'}: ${JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

async function request(path, params, key, { signal, raw = false, retries = 1 } = {}) {
  if (!key) throw new TagitError(0, { error: 'missing_api_key' });
  const url = new URL(BASE + path);
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'X-API-Key': key, Accept: raw ? '*/*' : 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) return raw ? res : await res.json();
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { detail: text.slice(0, 500) }; }
      lastError = new TagitError(res.status, body);
      if (res.status < 500) break; // only 5xx is worth retrying
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = new TagitError(0, { error: err.name === 'TimeoutError' ? 'timeout' : 'network', detail: err.message });
    }
  }
  throw lastError;
}

// ---------- Schema (field catalog) ----------

let schemaCache = { at: 0, data: null };

export async function getSentencingSchema({ signal } = {}) {
  if (schemaCache.data && Date.now() - schemaCache.at < 60 * 60 * 1000) return schemaCache.data;
  const data = await request('/api/public/rulings/schema', { scope: SENTENCING_SCOPE }, rulingsKey(), { signal });
  schemaCache = { at: Date.now(), data };
  return data;
}

// ---------- Sentencing decisions ----------

const RESULT_FIELDS = [
  'meta.id', 'meta.case_name', 'meta.case_number', 'meta.court_name', 'meta.court_instance', 'meta.document_date',
  'meta.judges', 'meta.severity_score', 'meta.prison_actual_months', 'meta.prison_suspended_months',
  'meta.service_work_months', 'meta.community_service_hours', 'meta.fine_shekels', 'meta.compensation_shekels',
  'meta.primary_punishment_type', 'meta.drug_totals', 'meta.confessed', 'meta.agreed_sentence',
  'ai.שם_התיק', 'ai.תקציר', 'sql.נאשמים', 'sql.מתחמי_ענישה',
];
// Fields the live schema rejected (unknown_field); skipped on later calls.
const rejectedFields = new Set();
export const rejectedResultFields = () => [...rejectedFields];

const SORT_FIELDS = {
  severity: 'meta.severity_score',
  prison: 'meta.prison_actual_months',
  date: 'meta.document_date',
};
// Severity and prison follow the chosen direction (default: most lenient first); dates are always newest first.
const sortDirection = (p) => (p.sort === 'date' ? 'desc' : p.sort_direction === 'desc' ? 'desc' : 'asc');
const FLAG_KEY_RE = /^meta\.[a-z0-9_]{1,60}$/;

export function buildSentencingFilter(p) {
  const clauses = [];
  for (const topic of p.topics ?? []) clauses.push({ field: 'meta.topics', op: 'contains', value: topic });
  if (p.drug_types?.length) clauses.push({ field: 'meta.drug_types', op: 'in', value: p.drug_types });
  if (p.drug_quantity) {
    const q = p.drug_quantity;
    const field = `meta.drug_total_${q.measure === 'units' ? 'n' : 'g'}_${q.slug}`;
    if (q.min != null) clauses.push({ field, op: 'ge', value: q.min });
    if (q.max != null) clauses.push({ field, op: 'le', value: q.max });
    if (q.min == null && q.max == null) clauses.push({ field, op: 'not_null' });
  }
  if (p.offense_sections?.length) clauses.push({ field: 'meta.offense_sections', op: 'in', value: p.offense_sections });
  if (p.offense_law_sections?.length) clauses.push({ field: 'meta.offense_law_sections', op: 'in', value: p.offense_law_sections });
  if (p.drug_ordinance_sections?.length) clauses.push({ field: 'meta.drug_ordinance_sections', op: 'in', value: p.drug_ordinance_sections });
  if (p.court_instances?.length) clauses.push({ field: 'meta.court_instance', op: 'in', value: p.court_instances });
  if (p.prison_months_min != null) clauses.push({ field: 'meta.prison_actual_months', op: 'ge', value: p.prison_months_min });
  if (p.prison_months_max != null) clauses.push({ field: 'meta.prison_actual_months', op: 'le', value: p.prison_months_max });
  if (p.confessed != null) clauses.push({ field: 'meta.confessed', op: 'eq', value: p.confessed });
  if (p.agreed_sentence != null) clauses.push({ field: 'meta.agreed_sentence', op: 'eq', value: p.agreed_sentence });
  // Yes/no sentencing flags chosen in the search setup (indexed meta.* booleans).
  for (const [key, value] of Object.entries(p.flags ?? {})) {
    if (FLAG_KEY_RE.test(key) && typeof value === 'boolean') clauses.push({ field: key, op: 'eq', value });
  }
  return clauses.length ? { op: 'and', clauses } : null;
}

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
// Upstream data is not trusted: links must be http(s), and file routes need a numeric id.
const httpUrl = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};
const numericId = (value) => (/^\d{1,15}$/.test(String(value ?? '')) ? String(value) : null);

function rangeText(bound) {
  if (bound == null) return null;
  if (typeof bound !== 'object') return String(bound);
  return bound['טקסט_מקור'] || [bound['ערך'], bound['יחידה']].filter((x) => x != null && x !== '').join(' ') || null;
}

function normalizeDefendant(d) {
  if (!d || typeof d !== 'object') return null;
  const nameKey = Object.keys(d).find((k) => k.includes('שם') && typeof d[k] === 'string');
  return {
    name: nameKey ? d[nameKey] : null,
    confessed: d['הודה_באשמה'] ?? null,
    agreedSentence: d['עונש_מוסכם'] ?? null,
    punishments: arr(d['פירוט_ענישה']).map((p) => ({ type: p?.['סוג_העונש'] ?? null, value: p?.['ערך'] ?? null, unit: p?.['יחידה'] ?? null })),
    convictions: arr(d['הרשעות']).map((c) => ({
      law: c?.['שם_חוק_רשמי'] || c?.['שם_החוק'] || null,
      section: c?.['סעיף_מהותי'] ?? null,
      description: c?.['תיאור_העבירה'] ?? null,
      count: c?.['מספר_עבירות'] ?? null,
    })),
  };
}

export function normalizeRuling(item) {
  const meta = item.meta ?? {};
  const ai = item.ai ?? {};
  const sql = item.sql ?? {};
  const id = meta.id ?? item.id;
  return {
    id,
    title: ai['שם_התיק'] || meta.case_name || meta.document_title || `מסמך ${id}`,
    caseNumber: meta.case_number ?? null,
    court: meta.court_name ?? null,
    courtInstance: meta.court_instance ?? null,
    date: meta.document_date ?? null,
    judges: arr(meta.judges),
    severity: num(meta.severity_score),
    prisonMonths: num(meta.prison_actual_months),
    suspendedMonths: num(meta.prison_suspended_months),
    serviceWorkMonths: num(meta.service_work_months),
    communityServiceHours: num(meta.community_service_hours),
    fine: num(meta.fine_shekels),
    compensation: num(meta.compensation_shekels),
    primaryPunishment: meta.primary_punishment_type ?? null,
    confessed: meta.confessed ?? null,
    agreedSentence: meta.agreed_sentence ?? null,
    drugTotals: arr(meta.drug_totals).map((d) => ({ drug: d?.['סוג_הסם'] ?? null, unit: d?.['יחידה'] ?? null, amount: num(d?.['כמות_כוללת']) })),
    summary: ai['תקציר'] ?? null,
    defendants: arr(sql['נאשמים']).flat().map(normalizeDefendant).filter(Boolean),
    ranges: arr(sql['מתחמי_ענישה']).flat().map((r) => ({
      group: r?.['קבוצת_עבירות'] ?? null,
      min: rangeText(r?.['מתחם_מינימום']),
      max: rangeText(r?.['מתחם_מקסימום']),
    })),
    sourceUrl: httpUrl(item.source_url),
    fileUrl: numericId(id) ? `/api/tagit/rulings/${numericId(id)}/file` : null,
  };
}

// Cases without the value sort last in either direction.
const byNumber = (field, dir) => (a, b) => {
  const x = a[field];
  const y = b[field];
  if (x == null || y == null) return (x == null) - (y == null);
  return dir === 'asc' ? x - y : y - x;
};

function comparator(p) {
  if (p.sort === 'date') return (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''));
  const dir = sortDirection(p);
  const [first, second] = p.sort === 'prison' ? ['prisonMonths', 'severity'] : ['severity', 'prisonMonths'];
  const primary = byNumber(first, dir);
  const secondary = byNumber(second, dir);
  return (a, b) => primary(a, b) || secondary(a, b);
}

export async function searchSentencing(p, { page = 1, signal } = {}) {
  const filter = buildSentencingFilter(p);
  const base = {
    scope: SENTENCING_SCOPE,
    page,
    size: p.size ?? 30,
    filter,
    date_from: p.date_from,
    date_to: p.date_to,
  };
  // A custom sort combined with text_query times out upstream; sort locally instead.
  if (p.text_query) Object.assign(base, { text_query: p.text_query, snippet_fragments: 1, snippet_chars: 240 });
  else base.sort = `${sortDirection(p) === 'desc' ? '-' : ''}${SORT_FIELDS[p.sort ?? 'severity']}`;

  for (let attempt = 0; attempt < 6; attempt++) {
    const fields = RESULT_FIELDS.filter((f) => !rejectedFields.has(f));
    try {
      const data = await request('/api/public/rulings/documents', { ...base, fields: fields.join(',') }, rulingsKey(), { signal });
      const items = (data.items ?? []).map((item) => ({
        ...normalizeRuling(item),
        snippet: item.snippet_text ?? item.snippet ?? null,
      }));
      items.sort(comparator(p));
      return {
        total: data.total ?? null,
        timedOut: Boolean(data.timed_out),
        page: data.page ?? page,
        size: data.size ?? base.size,
        filter,
        items,
      };
    } catch (err) {
      const field = err instanceof TagitError && err.status === 400 && err.body?.error === 'unknown_field' ? err.body.field : null;
      if (field && RESULT_FIELDS.includes(field) && !rejectedFields.has(field)) {
        rejectedFields.add(field);
        continue;
      }
      throw err;
    }
  }
  throw new TagitError(400, { error: 'too_many_unknown_fields' });
}

export async function readRulingText(id, { signal } = {}) {
  return request(`/api/public/rulings/documents/${encodeURIComponent(id)}/text`, {}, rulingsKey(), { signal });
}

// ---------- Guidelines ----------

// The guidelines API may need a different key than the rulings API.
// Try the dedicated guidelines key first, then the main key, and stick with whichever one works.
let guidelinesKeyInUse = null;
export const guidelinesKeySource = () => guidelinesKeyInUse;

async function guidelinesRequest(path, params, options) {
  const candidates = [['guidelines', process.env.TAGIT_GUIDELINES_API_KEY], ['main', process.env.TAGIT_API_KEY]]
    .filter(([, key], index, all) => key && all.findIndex(([, other]) => other === key) === index)
    .sort((a, b) => (b[0] === guidelinesKeyInUse) - (a[0] === guidelinesKeyInUse));
  let lastError = new TagitError(0, { error: 'missing_api_key' });
  for (const [name, key] of candidates) {
    try {
      const result = await request(path, params, key, options);
      guidelinesKeyInUse = name;
      return result;
    } catch (err) {
      // 401 = wrong key; 403 = the key lacks the scope. Either way another configured key may work.
      if (!(err instanceof TagitError) || ![401, 403].includes(err.status)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

export function normalizeGuideline(g) {
  // file_url / text_url embed the server's own api_key: never pass them on.
  return {
    id: g.id,
    title: g.document_title || g.filename || `הנחיה ${g.id}`,
    number: g.directive_number ?? null,
    source: g.source_label ?? null,
    topic: g.topic ?? null,
    date: g.document_date ?? null,
    effectiveDate: g.effective_date ?? null,
    supersedes: g.supersedes ?? null,
    summary: g.summary ?? null,
    hasText: g.has_text ?? null,
    fileUrl: numericId(g.id) ? `/api/tagit/guidelines/${numericId(g.id)}/file` : null,
  };
}

// The API filters by one source substring. A few chosen sources are fetched one request each; many are fetched
// unfiltered with a larger page. Either way only exact source matches are kept, since a substring such as
// "השירות המשפטי הציבורי" also matches "כללי, השירות המשפטי הציבורי".
const PER_SOURCE_REQUESTS_MAX = 4;

export async function searchGuidelines(p, { signal } = {}) {
  const queries = p.queries?.length ? p.queries : [null];
  const sources = [...new Set(p.sources ?? [])];
  const perSource = sources.length > 0 && sources.length <= PER_SOURCE_REQUESTS_MAX;
  const requests = queries.flatMap((q) => (perSource
    ? sources.map((source) => ({ q, source, limit: p.limit ?? 15 }))
    : [{ q, source: sources.length ? undefined : p.source, limit: sources.length ? 50 : p.limit ?? 15 }]));

  const lists = await Promise.all(requests.map((r) =>
    // total_mode=skip: the exact count costs a second full scan upstream and only cards are shown.
    guidelinesRequest('/api/public/over-guidelines/documents', {
      q: r.q, topic: p.topic, source: r.source, limit: r.limit, skip: 0,
      total_mode: p.totalMode === 'exact' ? 'exact' : 'skip', // exact only for the boot A/B measurement
    }, { signal })));

  const wanted = sources.length ? new Set(sources) : null;
  const byId = new Map();
  lists.forEach((list, i) => {
    const q = requests[i].q;
    for (const g of list.items ?? []) {
      const item = normalizeGuideline(g);
      if (wanted && !wanted.has(item.source)) continue;
      const existing = byId.get(item.id);
      if (existing) { if (q && !existing.matchedQueries.includes(q)) existing.matchedQueries.push(q); }
      else byId.set(item.id, { ...item, matchedQueries: [q].filter(Boolean) });
    }
  });
  // Substring matches in the body are weak evidence: rank title matches first, then by how many queries matched,
  // and keep single body-only matches only when there is too little else to show.
  const limit = p.limit ?? 15;
  const lower = (s) => String(s ?? '').toLowerCase();
  const ranked = [...byId.values()]
    .map((g) => ({ ...g, titleMatches: g.matchedQueries.filter((q) => lower(g.title).includes(lower(q))).length }))
    .sort((a, b) => b.titleMatches - a.titleMatches || b.matchedQueries.length - a.matchedQueries.length);
  const strong = ranked.filter((g) => g.titleMatches > 0 || g.matchedQueries.length > 1);
  const items = (strong.length >= Math.min(5, ranked.length) ? strong : ranked).slice(0, limit)
    .map(({ titleMatches, ...g }) => g);
  return {
    totals: queries.map((q) => ({ query: q, total: sources.length ? null : lists[requests.findIndex((r) => r.q === q)]?.total ?? null })),
    sources: sources.length ? sources : null,
    items,
  };
}

// Distinct topic / source_label values, so the model picks a stored value instead of guessing one.
// The endpoint is cached upstream and tells us for how long; mirror that rather than hammering it.
let facetsCache = { at: 0, ttlMs: 0, data: null };

export async function getGuidelinesFacets({ signal } = {}) {
  if (facetsCache.data && Date.now() - facetsCache.at < facetsCache.ttlMs) return facetsCache.data;
  const raw = await guidelinesRequest('/api/public/over-guidelines/facets', {}, { signal });
  const list = (values) => arr(values)
    .map((v) => (typeof v === 'string' ? { value: v, count: null } : { value: v?.value ?? null, count: num(v?.count) }))
    .filter((v) => typeof v.value === 'string' && v.value);
  const data = { sources: list(raw?.sources), topics: list(raw?.topics) };
  const ttlSeconds = num(raw?.cached_for_seconds) ?? 3600;
  facetsCache = { at: Date.now(), ttlMs: Math.min(Math.max(ttlSeconds, 60), 86_400) * 1000, data };
  return data;
}

export async function readGuideline(id, { signal } = {}) {
  return guidelinesRequest(`/api/public/over-guidelines/documents/${encodeURIComponent(id)}`, {}, { signal });
}

// ---------- Files (proxied so the API key never reaches the browser) ----------

export async function fetchFile(kind, id, { signal } = {}) {
  if (kind === 'guideline') {
    return guidelinesRequest(`/api/public/over-guidelines/documents/${encodeURIComponent(id)}/file`, {}, { signal, raw: true });
  }
  return request(`/api/public/rulings/documents/${encodeURIComponent(id)}/file`, {}, rulingsKey(), { signal, raw: true });
}
