// The drug-sentencing search fields of the Z-G site (offence, drugs, punishment, court, years, city, judge), offered
// in the search-setup form when the case is a drug case. The field list comes from the same shared filter config as
// the yes/no flags, and a choice is turned into TAG-IT clauses the same way the Z-G site does it
// (userFilterClauses / drugQuantityClauses in its src/app/api/rulings/route.ts).
import { DRUG_SLUGS } from './tagit.js';

const KEY_RE = /^meta\.[a-z0-9_]{1,60}$/;
const CONTROLS = new Set(['text', 'select', 'multiselect', 'number', 'yearrange']);
// Searching by a case's own name finds that case, not comparable ones.
const SKIPPED = new Set(['meta.case_name']);
// The drug-quantity field of the config: with drug types chosen it becomes a per-drug total (the Z-G semantics),
// otherwise a range on the case's largest quantity of any drug.
export const QUANTITY_KEY = 'meta.drug_max_grams';
export const DRUG_TYPES_KEY = 'meta.drug_types';
export const COURT_KEY = 'meta.court_instance';

const str = (value, max) => String(value ?? '').trim().slice(0, max);

// Used only when the filter config cannot be reached and nothing was fetched before: the fields as of 2026-09-26.
export const FALLBACK_FIELDS = [
  { key: 'meta.court_instance', label: 'ערכאה', control: 'select', options: ['שלום', 'מחוזי', 'עליון', 'תעבורה', 'נוער'] },
  { key: 'meta.court_city', label: 'חיפוש לפי עיר', control: 'text' },
  { key: 'meta.judges', label: 'חיפוש לפי שם השופט (שם מלא, ללא תואר)', control: 'text' },
  { key: 'meta.document_date', label: 'טווח שנים', control: 'yearrange' },
  { key: 'meta.drug_ordinance_sections', group: 'עבירה', label: 'סעיף בפקודת הסמים', control: 'multiselect', options: ['7', '13', '19א', '6', '10', '3', '9', '2', '31', '12', '25', '1', '9א', '21', '36', '19', '10א', '36א', '14', '4'] },
  { key: 'meta.offense_laws', group: 'עבירה', label: 'חוק העבירה (שאינו פקודת הסמים)', control: 'select', matchOp: 'contains', options: ['חוק העונשין', 'חוק הכניסה לישראל', 'חוק כלי הירייה', 'פקודת התעבורה'] },
  { key: 'meta.offense_sections', group: 'עבירה', label: 'סעיף עבירה (כל חוק)', control: 'text' },
  { key: 'meta.drug_types', group: 'סמים', label: 'סוג הסם', control: 'multiselect', options: Object.keys(DRUG_SLUGS) },
  { key: 'meta.drug_max_grams', group: 'סמים', label: 'כמות הסם שנבחר', control: 'number', units: [{ label: 'גרם', value: 'g' }, { label: 'יחידות ספירה', value: 'n' }] },
  { key: 'meta.primary_punishment_type', group: 'ענישה', label: 'רכיב הענישה החמור ביותר בתיק', control: 'select', options: ['מאסר בפועל', 'מאסר בעבודות שירות', 'מאסר על תנאי', 'קנס', 'פיצוי', 'התחייבות'] },
  { key: 'meta.prison_actual_months', group: 'ענישה', label: 'מאסר בפועל (חודשים)', control: 'number' },
  { key: 'meta.prison_suspended_months', group: 'ענישה', label: 'מאסר על תנאי (חודשים)', control: 'number' },
  { key: 'meta.community_service_hours', group: 'ענישה', label: 'של"צ (שעות)', control: 'number' },
  { key: 'meta.fine_shekels', group: 'ענישה', label: 'קנס (₪)', control: 'number' },
  { key: 'meta.compensation_shekels', group: 'ענישה', label: 'פיצוי (₪)', control: 'number' },
];

// The remote config is another system's data: only the known control types on plain meta.* keys that TAG-IT's
// schema knows are kept, with their labels and options trimmed.
export function parseFields(rawFields, knownKeys) {
  const out = [];
  for (const f of Array.isArray(rawFields) ? rawFields : []) {
    if (!f || !CONTROLS.has(f.control) || !KEY_RE.test(f.key ?? '') || SKIPPED.has(f.key)) continue;
    // The quantity is applied through the per-drug total fields whenever drugs are chosen.
    if (knownKeys && !knownKeys.has(f.key) && f.key !== QUANTITY_KEY) continue;
    const field = { key: f.key, label: str(f.label || f.key, 80), control: f.control };
    if (f.group) field.group = str(f.group, 40);
    if (f.matchOp === 'contains' || f.matchOp === 'eq') field.matchOp = f.matchOp;
    if (Array.isArray(f.options)) field.options = f.options.map((o) => str(o, 80)).filter(Boolean).slice(0, 60);
    if (f.optionLabels && typeof f.optionLabels === 'object') {
      field.optionLabels = Object.fromEntries(Object.entries(f.optionLabels)
        .filter(([k]) => field.options?.includes(k)).map(([k, v]) => [k, str(v, 120)]));
    }
    if (Array.isArray(f.units)) {
      field.units = f.units.filter((u) => u?.value === 'g' || u?.value === 'n').map((u) => ({ value: u.value, label: str(u.label, 40) }));
    }
    if ((field.control === 'select' || field.control === 'multiselect') && !field.options?.length) continue;
    out.push(field);
  }
  return out;
}

const number = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null;
};
const year = (value) => (/^\d{4}$/.test(String(value ?? '').trim()) ? String(value).trim() : null);

// Keeps only what the offered fields allow, in one shape per control.
export function sanitizeFilters(filters, fields) {
  const clean = {};
  for (const field of fields) {
    const value = filters?.[field.key];
    if (value == null) continue;
    if (field.control === 'text') {
      const text = str(value, 100);
      if (text) clean[field.key] = text;
    } else if (field.control === 'select') {
      const text = str(value, 80);
      if (text && field.options.includes(text)) clean[field.key] = text;
    } else if (field.control === 'multiselect') {
      const chosen = [...new Set((Array.isArray(value) ? value : []).map((v) => str(v, 80)))].filter((v) => field.options.includes(v));
      if (chosen.length) clean[field.key] = chosen;
    } else if (field.control === 'number') {
      const min = number(value.min);
      const max = number(value.max);
      if (min == null && max == null) continue;
      const range = { ...(min != null ? { min } : {}), ...(max != null ? { max } : {}) };
      if (field.units?.length) range.unit = value.unit === 'n' && field.units.some((u) => u.value === 'n') ? 'n' : 'g';
      clean[field.key] = range;
    } else if (field.control === 'yearrange') {
      const from = year(value.from);
      const to = year(value.to);
      if (from || to) clean[field.key] = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
  }
  return clean;
}

// Per-drug totals, so "cocaine 20–40 g" means the same drug for both halves; several drugs are any of them.
function drugQuantityClauses(drugs, range) {
  const perDrug = [];
  for (const drug of drugs) {
    const slug = DRUG_SLUGS[drug];
    if (!slug) return null;
    const field = `meta.drug_total_${range.unit === 'n' ? 'n' : 'g'}_${slug}`;
    const bounds = [];
    if (range.min != null) bounds.push({ field, op: 'ge', value: range.min });
    if (range.max != null) bounds.push({ field, op: 'le', value: range.max });
    perDrug.push(bounds.length === 1 ? bounds[0] : { op: 'and', clauses: bounds });
  }
  return perDrug.length === 1 ? [perDrug[0]] : [{ op: 'or', clauses: perDrug }];
}

// Clauses for sanitized filters, per field key, so a search can leave out the fields it replaces or that its corpus
// lacks. The court instance is left out: it goes through the search's court_instances, which knows how to apply it
// together with a free-text query. A per-drug quantity is filed under the quantity key.
export function filterClauses(filters, fields) {
  const byKey = {};
  const add = (key, clause) => { (byKey[key] ??= []).push(clause); };
  const drugs = filters[DRUG_TYPES_KEY] ?? [];
  const quantity = filters[QUANTITY_KEY];
  const perDrug = drugs.length && quantity ? drugQuantityClauses(drugs, quantity) : null;
  for (const field of fields) {
    const value = filters[field.key];
    if (value == null || field.key === COURT_KEY) continue;
    if (field.key === QUANTITY_KEY && perDrug) continue;
    const key = field.key;
    if (field.control === 'text') {
      add(key, { field: key, op: field.matchOp === 'eq' ? 'eq' : 'contains', value });
    } else if (field.control === 'select') {
      add(key, { field: key, op: field.matchOp === 'contains' ? 'contains' : 'eq', value });
    } else if (field.control === 'multiselect') {
      add(key, { field: key, op: 'in', value });
    } else if (field.control === 'number') {
      if (value.min != null) add(key, { field: key, op: 'ge', value: value.min });
      if (value.max != null) add(key, { field: key, op: 'le', value: value.max });
    } else if (field.control === 'yearrange') {
      if (value.from) add(key, { field: key, op: 'ge', value: `${value.from}-01-01` });
      if (value.to) add(key, { field: key, op: 'le', value: `${value.to}-12-31` });
    }
  }
  if (perDrug) for (const clause of perDrug) add(QUANTITY_KEY, clause);
  return byKey;
}

// Every field a clause (or a nested and/or of clauses) filters on.
export function clauseFields(clause) {
  if (clause?.op === 'and' || clause?.op === 'or') return (clause.clauses ?? []).flatMap(clauseFields);
  return clause?.field ? [clause.field] : [];
}

// Fields of a drug case that describe the offence rather than the sentence, and so also narrow conditional
// arrangements (when that corpus has the field).
export const OFFENCE_KEYS = new Set([
  'meta.drug_types', 'meta.drug_max_grams', 'meta.drug_ordinance_sections', 'meta.offense_laws', 'meta.offense_sections',
  'meta.document_date',
]);

// The model's own parameters that a field chosen in the form replaces, so the two never contradict each other.
export const REPLACED_PARAMS = {
  'meta.drug_types': ['drug_types'],
  'meta.drug_max_grams': ['drug_quantity'],
  'meta.drug_ordinance_sections': ['drug_ordinance_sections'],
  'meta.offense_sections': ['offense_sections'],
  'meta.court_instance': ['court_instances'],
  'meta.document_date': ['date_from', 'date_to'],
  'meta.prison_actual_months': ['prison_months_min', 'prison_months_max'],
};
