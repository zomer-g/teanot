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

const SORTS = {
  severity: '-meta.severity_score',
  prison: '-meta.prison_actual_months',
  date: '-meta.document_date',
};

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

const COMPARATORS = {
  severity: (a, b) => (b.severity ?? -Infinity) - (a.severity ?? -Infinity) || (b.prisonMonths ?? -1) - (a.prisonMonths ?? -1),
  prison: (a, b) => (b.prisonMonths ?? -1) - (a.prisonMonths ?? -1) || (b.severity ?? -Infinity) - (a.severity ?? -Infinity),
  date: (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')),
};

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
  else base.sort = SORTS[p.sort ?? 'severity'];

  for (let attempt = 0; attempt < 6; attempt++) {
    const fields = RESULT_FIELDS.filter((f) => !rejectedFields.has(f));
    try {
      const data = await request('/api/public/rulings/documents', { ...base, fields: fields.join(',') }, rulingsKey(), { signal });
      const items = (data.items ?? []).map((item) => ({
        ...normalizeRuling(item),
        snippet: item.snippet_text ?? item.snippet ?? null,
      }));
      items.sort(COMPARATORS[p.sort ?? 'severity']);
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
      if (!(err instanceof TagitError) || err.status !== 401) throw err;
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

export async function searchGuidelines(p, { signal } = {}) {
  const queries = p.queries?.length ? p.queries : [null];
  const lists = await Promise.all(queries.map((q) =>
    guidelinesRequest('/api/public/over-guidelines/documents', {
      q, topic: p.topic, source: p.source, limit: p.limit ?? 15, skip: 0,
    }, { signal })));
  const byId = new Map();
  lists.forEach((list, i) => {
    for (const g of list.items ?? []) {
      const existing = byId.get(g.id);
      if (existing) existing.matchedQueries.push(queries[i]);
      else byId.set(g.id, { ...normalizeGuideline(g), matchedQueries: [queries[i]].filter(Boolean) });
    }
  });
  const items = [...byId.values()].sort((a, b) => b.matchedQueries.length - a.matchedQueries.length);
  return {
    totals: lists.map((list, i) => ({ query: queries[i], total: list.total ?? null })),
    items,
  };
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
