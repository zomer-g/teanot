// Readable text for what a logged TAG-IT search actually asked for (filters, terms, sources, order).
// Imported by the admin page and by the CSV export, so both say the same thing.

const FIELD_LABELS = {
  'meta.topics': 'נושא',
  'meta.drug_types': 'סוג סם',
  'meta.offense_sections': 'סעיף',
  'meta.offense_law_sections': 'חוק וסעיף',
  'meta.drug_ordinance_sections': 'סעיף בפקודת הסמים',
  'meta.court_instance': 'ערכאה',
  'meta.prison_actual_months': 'מאסר בפועל (חודשים)',
  'meta.confessed': 'הודה באשמה',
  'meta.agreed_sentence': 'עונש מוסכם',
  'meta.conviction_annulled': 'ביטול הרשעה',
  'meta.rehab_deviation': 'סטייה משיקולי שיקום',
  'meta.priors_mentioned': 'עבר פלילי',
  'meta.prior_suspended_activated': 'הופעל עונש על תנאי קודם',
  'meta.defense_requested_deviation': 'ההגנה ביקשה חריגה ממתחם',
  'meta.court_deviated_from_range': 'ביהמ"ש חרג ממתחם',
  'meta.actual_prison_imposed': 'הוטל מאסר בפועל',
  'meta.community_service_imposed': 'הוטל מאסר בעבודות שירות',
};
const OPS = { ge: '≥', le: '≤', gt: '>', lt: '<' };
const DRUG_NAMES = { cannabis: 'קנאביס', cocaine: 'קוקאין', hashish: 'חשיש', heroin: 'הרואין', mdma: 'MDMA', ketamine: 'קטמין', lsd: 'LSD', meth: 'מתאמפטמין', buprenorphine: 'בופרנורפין', psilocybin: 'פסילוצין' };

function fieldLabel(field) {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const drug = /^meta\.drug_total_(g|n)_(.+)$/.exec(field ?? '');
  if (drug) return `כמות ${DRUG_NAMES[drug[2]] ?? drug[2]} (${drug[1] === 'g' ? 'גרם' : 'יחידות'})`;
  return String(field ?? '').replace(/^meta\./, '');
}

function clauseText(c) {
  if (!c || typeof c !== 'object') return '';
  if (Array.isArray(c.clauses)) return c.clauses.map(clauseText).filter(Boolean).join(' · ');
  const label = fieldLabel(c.field);
  const value = Array.isArray(c.value) ? c.value.join(' / ') : c.value;
  if (typeof value === 'boolean') return `${label}: ${value ? 'כן' : 'לא'}`;
  if (c.op === 'not_null') return `${label}: קיים`;
  if (OPS[c.op]) return `${label} ${OPS[c.op]} ${value}`;
  return `${label}: ${value}`;
}

// Returns { title, parts[] }.
export function describeSearch(s) {
  const parts = [];
  if (s.action === 'search_sentencing' || s.action === 'more_sentencing') {
    if (s.filter) parts.push(clauseText(s.filter));
    if (s.text_query) parts.push(`טקסט חופשי: "${s.text_query}"`);
    if (s.sort) parts.push(`סדר: ${s.sort === 'date' ? 'מהחדש לישן' : s.sort_direction === 'desc' ? 'מהחמור לקל' : 'מהקל לחמור'}${s.sort === 'prison' ? ' (לפי מאסר)' : ''}`);
    if (s.page) parts.push(`עמוד ${s.page}`);
  } else if (s.action === 'search_guidelines') {
    if (Array.isArray(s.queries) && s.queries.length) parts.push(`מונחים: ${s.queries.map((q) => `"${q}"`).join(', ')}`);
    if (Array.isArray(s.sources) && s.sources.length) parts.push(`מקורות: ${s.sources.join(', ')}`);
    if (s.topic) parts.push(`תחום: ${s.topic}`);
  }
  const count = s.total != null ? `${s.total} תוצאות` : s.returned != null ? `${s.returned} הוחזרו` : null;
  if (count) parts.push(count);
  if (s.error) parts.push(`שגיאה: ${String(s.error).slice(0, 100)}`);
  return { title: s.label ?? '', parts: parts.filter(Boolean) };
}
