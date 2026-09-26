// Tools Claude can call, their input validation (zod, also used to generate the JSON schemas),
// and the executors. Each executor returns { block: tool_result, ui: item | null }.
import { z } from 'zod';
import { query } from './db.js';
import { recordTagitCall } from './usage.js';
import * as tagit from './tagit.js';
import { applyRelevance } from './relevance.js';
import { ARRANGEMENT_KEYS, COURT_KEY, REPLACED_PARAMS, clauseFields } from './case-filters.js';

const DRUG_SLUG_VALUES = Object.values(tagit.DRUG_SLUGS);
const text = z.string().trim();
const optText = z.string().trim().nullable().optional();

// In full-text search a bare section number ("329", "144(ב)") matches any decision that mentions that number
// anywhere, so ORing one in floods the results with unrelated cases. Sections belong in the offense filters.
const bareSectionTerm = (term) => /\d/.test(term)
  && term.replace(/\([^)]{0,4}\)/g, '').replace(/[\d\s.,/\-"'()[\]]/g, '').length <= 1;
const sentencingTextQuery = optText.refine(
  (q) => !q || !/\sOR\s/.test(q) || !q.split(/\s+OR\s+/).some((t) => bareSectionTerm(t.replace(/^-/, ''))),
  'A section number in text_query matches any decision that mentions that number. Filter sections with offense_sections or offense_law_sections, and use words or exact phrases here, e.g. "חבלה בכוונה מחמירה".',
);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable().optional();

// ---------- Schemas ----------

const drugSchema = z.object({
  name: text.describe('Drug name as in the document, e.g. "קוקאין"'),
  slug: z.enum(DRUG_SLUG_VALUES).nullable().optional().describe('Canonical slug when the drug is one of the tracked drugs'),
  amount: z.number().nullable().optional().describe('Quantity, converted to grams for mass units'),
  unit: z.enum(['grams', 'units']).nullable().optional().describe('grams for mass; units for pills, blotters, plants, doses'),
  unit_label: optText.describe('Unit as written when it is not grams, e.g. "כדורים", "בולים", "שתילים"'),
});

const countSchema = z.object({
  offense: text.describe('Offense description, e.g. "החזקת סם שלא לצריכה עצמית"'),
  law: optText.describe('Law name, e.g. "פקודת הסמים המסוכנים [נוסח חדש], תשל"ג-1973"'),
  section: optText.describe('Section as written, e.g. "7(א)+(ג) רישא"'),
  section_tokens: z.array(text).default([]).describe('Separate section tokens, full and bare, e.g. ["7(א)", "7(ג)", "7"]'),
  status: z.enum(['charged', 'convicted', 'acquitted']).default('charged'),
  occurrences: z.number().int().nullable().optional().describe('Number of offenses of this kind, if stated'),
  facts: z.array(z.object({ label: text, value: text })).default([])
    .describe('Sentencing-relevant facts, e.g. {label:"כמות", value:"30 גרם נטו"}, {label:"נשק", value:"סכין"}'),
  drugs: z.array(drugSchema).default([]),
});

export const analysisSchema = z.object({
  document_type: z.enum(['indictment', 'amended_indictment', 'verdict', 'sentencing_decision', 'other']),
  is_supported: z.boolean().describe('true only for an indictment (including amended) or a verdict (הכרעת דין)'),
  classification_reason: text.describe('One or two Hebrew sentences explaining the classification'),
  title: text.max(200).describe('Short Hebrew title for the conversation, e.g. "כתב אישום – החזקת קוקאין שלא לצריכה עצמית"'),
  court: optText,
  case_number: optText,
  document_date: isoDate,
  defendants: z.array(z.object({
    label: text.describe('e.g. "נאשם 1"'),
    name: optText,
    counts: z.array(countSchema).default([]),
  })).default([]),
  requested_mode: z.enum(['sentencing', 'guidelines', 'arrangements', 'both', 'unspecified']).default('unspecified')
    .describe('The result type the user already asked for in their message, if any'),
});

export const askUserSchema = z.object({
  intro: optText.describe('One short sentence shown above the questions'),
  questions: z.array(z.object({
    id: text.describe('Stable id, e.g. "mode", "defendant", "quantity_range"'),
    text: text,
    help: optText,
    multiple: z.boolean().default(false),
    style: z.enum(['chips', 'cards']).default('chips').describe('cards for the result-type choice, chips otherwise'),
    allow_free_text: z.boolean().default(true),
    options: z.array(z.object({
      value: text,
      label: text,
      description: optText,
      recommended: z.boolean().default(false),
    })).max(8).default([]),
  })).min(1).max(4),
});

export const sentencingParamsSchema = z.object({
  label: text.max(160).describe('Short Hebrew label shown above the results, e.g. "קוקאין 20–40 גרם · החזקה שלא לצריכה עצמית"'),
  defendant: optText.describe('Which defendant this search is for, e.g. "נאשם 1"'),
  topics: z.array(text).max(5).default([]).describe('meta.topics values that must ALL be present, e.g. ["סמים"]'),
  drug_types: z.array(text).max(10).default([]).describe('meta.drug_types canonical names, ANY of, e.g. ["קוקאין"]'),
  drug_quantity: z.object({
    slug: z.enum(DRUG_SLUG_VALUES),
    measure: z.enum(['grams', 'units']).default('grams')
      .describe('grams → meta.drug_total_g_<slug>; units (pills/blotters/plants) → meta.drug_total_n_<slug>'),
    min: z.number().min(0).nullable().optional(),
    max: z.number().min(0).nullable().optional(),
  }).nullable().optional().describe('Case-level TOTAL quantity range for one drug (summed across all defendants in the case)'),
  punishment_types: z.array(text).max(10).default([])
    .describe('meta.punishment_types values, ANY of. In conditional arrangements: התחייבות, פיצוי, קנס, שירות לתועלת הציבור, שלילה'),
  offense_sections: z.array(text).max(20).default([]).describe('meta.offense_sections tokens, ANY of; full "144(א)" or bare "144"'),
  offense_law_sections: z.array(text).max(20).default([]).describe('meta.offense_law_sections "law§section" pairs, ANY of'),
  drug_ordinance_sections: z.array(text).max(20).default([]).describe('meta.drug_ordinance_sections (Dangerous Drugs Ordinance), ANY of, e.g. ["7", "13", "19א"]'),
  court_instances: z.array(z.enum(tagit.COURT_INSTANCES)).default([]),
  date_from: isoDate,
  date_to: isoDate,
  prison_months_min: z.number().min(0).nullable().optional().describe('Actual imprisonment, months (most severe defendant)'),
  prison_months_max: z.number().min(0).nullable().optional(),
  confessed: z.boolean().nullable().optional(),
  agreed_sentence: z.boolean().nullable().optional(),
  text_query: sentencingTextQuery.describe('Optional full-text query over the decision text: space = AND, "exact phrase", -exclude, OR. Slower; use only when meta filters cannot express the need'),
  flags: z.record(z.string().regex(/^meta\.[a-z0-9_]{1,60}$/), z.boolean()).optional()
    .describe('Yes/no sentencing flags as meta.* key → true/false. The user\'s search setup already sets these; add one only if the user asks for it in conversation'),
  sort: z.enum(['severity', 'prison', 'date']).default('severity'),
  sort_direction: z.enum(['asc', 'desc']).default('asc').describe('asc = most lenient first (default), desc = most severe first. The user\'s search setup overrides this'),
  override_setup: z.boolean().default(false)
    .describe('true only when the user asked in the conversation, after the search-setup form, for a different drug, quantity, section, court, date range or imprisonment range than the form set: your values for those parameters then replace the form\'s. Otherwise the form\'s values win'),
  size: z.number().int().min(1).max(50).default(30),
});

// The guidelines API matches a query as a substring anywhere in the text, so a three-letter word ("ירי") or a bare
// section number ("329") matches hundreds of unrelated directives. Refuse those so the model picks a phrase.
const guidelineQuery = text
  .refine((q) => q.trim().length >= 4, 'Too short: substring search on a word under 4 letters matches unrelated directives. Use a distinctive phrase such as "עבירות נשק".')
  .refine((q) => !(/\d/.test(q) && q.replace(/[\d\s()[\].,/\-]/g, '').length <= 2), 'A bare section number matches any number in any directive. Search for the subject in words instead, e.g. "מדיניות ענישה בעבירות נשק".');

export const guidelinesParamsSchema = z.object({
  label: text.max(160).describe('Short Hebrew label shown above the results'),
  queries: z.array(guidelineQuery).min(1).max(4).describe('Distinctive Hebrew phrases searched as substrings in title and body, e.g. "עבירות נשק", "מדיניות ענישה", "צריכה עצמית"; results are merged, title matches first'),
  topic: optText.describe('Substring of the guideline topic field'),
  source: optText.describe('Substring of the issuing body, e.g. "פרקליט המדינה", "היועץ המשפטי לממשלה". Ignored when the user chose sources in the search setup'),
  sources: z.array(text).max(50).optional().describe('Exact source labels; normally set from the user\'s search setup'),
  limit: z.number().int().min(1).max(25).default(15),
});

// Guideline facets live behind the same tool: one discovery path for the model, two sources upstream.
const GUIDELINE_FACETS = { 'guidelines.topic': 'topics', 'guidelines.source': 'sources' };

const fieldValuesSchema = z.object({
  field: text.describe('A meta.* field key, e.g. "meta.topics", "meta.offense_laws", "meta.offense_law_sections"; or "guidelines.topic" / "guidelines.source" for the guideline fields'),
  corpus: z.enum(['sentencing', 'arrangements']).default('sentencing')
    .describe('Which catalogue the meta.* field belongs to: sentencing decisions, or conditional arrangements. The stored values differ between them'),
  contains: optText.describe('Only return values containing this substring'),
});

const readDocumentSchema = z.object({
  kind: z.enum(['ruling', 'arrangement', 'guideline']),
  id: z.number().int().describe('The number after "ruling:", "arrangement:" or "guideline:" in the ref'),
  max_chars: z.number().int().min(2000).max(80000).default(40000),
});

function inputSchema(schema) {
  const json = z.toJSONSchema(schema, { io: 'input' });
  delete json.$schema;
  return json;
}

// ---------- Tool definitions ----------

export const TOOLS = [
  {
    name: 'record_document_analysis',
    description: 'Record the classification of a document the user supplied and, per defendant, every count (charge or conviction) with its law, section and sentencing-relevant facts. Call exactly once per new document, before any other tool. It is shown to the user as an analysis card.',
    input_schema: inputSchema(analysisSchema),
  },
  {
    name: 'ask_user',
    description: 'Show the user 1–4 focused questions with clickable options and end your turn. The answers arrive as this tool\'s result on the next turn (or the user may type a free message instead). Use it to choose the result type (question id "mode", style "cards": sentencing / guidelines / arrangements / both), the defendant, or to narrow a search with concrete options such as quantity ranges. Mark the default you would pick as recommended.',
    input_schema: inputSchema(askUserSchema),
  },
  {
    name: 'search_sentencing_decisions',
    description: 'Search criminal sentencing decisions (גזרי דין) in TAG-IT. All filters are combined with AND. Results are shown to the user as cards, most severe first; you receive a compact list with imprisonment statistics. Quantity and punishment fields are case-level: quantities are summed across all defendants, and imprisonment is the most severe defendant\'s. Returns total matches so you can judge whether to narrow or broaden.',
    input_schema: inputSchema(sentencingParamsSchema),
  },
  {
    name: 'search_conditional_arrangements',
    description: 'Search conditional arrangements (הסדרים מותנים) in TAG-IT: cases closed by the police or the State Attorney without an indictment, in exchange for conditions. The corpus is catalogued exactly like sentencing decisions, so this tool takes the same filters (topics, offence sections, flags such as confessed, date range) and returns the same shape. Its punishments are fines, compensation, community service and undertakings rather than imprisonment: filter them with punishment_types (התחייבות, פיצוי, קנס, שירות לתועלת הציבור, שלילה). The corpus holds no imprisonment, criminal record, sentencing range or court instance, so those filters and the yes/no flags are ignored here. Use it when the user asks what happens in arrangements for an offence, or to compare an indictment with cases that were closed in an arrangement.',
    input_schema: inputSchema(sentencingParamsSchema),
  },
  {
    name: 'search_guidelines',
    description: 'Search prosecution and Attorney General guidelines (הנחיות) by short Hebrew substrings over title and body. Results are shown to the user as cards; you receive a compact list with summaries.',
    input_schema: inputSchema(guidelinesParamsSchema),
  },
  {
    name: 'get_field_values',
    description: 'Look up the exact stored values of a TAG-IT field (topics, drug types, law names, section tokens, punishment types) before filtering on it, in the sentencing catalogue or in the conditional-arrangements one. Without a valid field it lists the available fields.',
    input_schema: inputSchema(fieldValuesSchema),
  },
  {
    name: 'read_document',
    description: 'Read the full text of one sentencing decision (kind "ruling"), conditional arrangement (kind "arrangement") or guideline (kind "guideline") by id, to answer detailed follow-up questions.',
    input_schema: inputSchema(readDocumentSchema),
  },
];

// ---------- Helpers ----------

const toolResult = (toolUse, content, isError = false) => ({
  type: 'tool_result',
  tool_use_id: toolUse.id,
  content: typeof content === 'string' ? content : JSON.stringify(content),
  ...(isError ? { is_error: true } : {}),
});

const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s ?? null);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function tagitErrorMessage(err) {
  if (err instanceof tagit.TagitError) {
    if (err.body?.error === 'missing_api_key') return 'TAG-IT API key is not configured on the server.';
    if (err.status === 401) return 'TAG-IT rejected the API key (401).';
    return `TAG-IT error ${err.status || ''}: ${JSON.stringify(err.body)}`;
  }
  return `Unexpected error: ${err.message}`;
}

export function validationError(toolUse, issues) {
  return {
    block: toolResult(toolUse, { error: 'invalid_input', issues: issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, true),
    ui: null,
  };
}

export function sentencingForModel(result, params, corpus = 'sentencing') {
  const prison = result.items.map((i) => i.prisonMonths).filter((v) => v != null);
  return {
    label: params.label,
    total_matches: result.total,
    // total_matches counts documents; one decision can have several copies, which are removed from items.
    duplicate_copies_removed: result.duplicatesRemoved || undefined,
    total_timed_out: result.timedOut || undefined,
    // TAG-IT refused the free-text query together with these filters, so it was left out: nothing in these results
    // is restricted by it.
    text_query_dropped: result.textQueryDropped
      ? 'TAG-IT refused text_query together with these filters, so the search ran on the filters alone and the results are NOT narrowed by the text. If they look unrelated to the offence, search again with structured filters (topics, drug_types, drug_quantity, offense_sections, drug_ordinance_sections) and without text_query, and tell the user.'
      : undefined,
    page: result.page,
    returned: result.items.length,
    filter_sent: result.filter,
    actual_prison_months_in_page: prison.length
      ? { min: Math.min(...prison), median: median(prison), max: Math.max(...prison), with_value: prison.length }
      : null,
    items: result.items.map((item, index) => ({
      rank: index + 1,
      // Cite as [[ruling:ID]] / [[arrangement:ID]]; the app shows the verified case number, and the bare id is
      // not a case number.
      ref: `${corpus === 'arrangements' ? 'arrangement' : 'ruling'}:${item.id}`,
      title: item.title,
      court: item.court,
      date: item.date,
      prison_actual_months: item.prisonMonths,
      prison_suspended_months: item.suspendedMonths,
      service_work_months: item.serviceWorkMonths,
      fine_shekels: item.fine,
      primary_punishment: item.primaryPunishment,
      drugs: item.drugTotals.map((d) => [d.drug, d.amount, d.unit].filter((x) => x != null).join(' ')).join('; ') || undefined,
      confessed: item.confessed,
      agreed_sentence: item.agreedSentence,
      defendants: item.defendants.length || undefined,
      summary: truncate(item.summary, 320),
      relevance: item.relevance?.score ?? undefined,
    })),
  };
}

// ---------- Executors ----------

// The user's search setup wins over the model's parameters, so a choice made in the form cannot be dropped or
// contradicted by the model. Model-set confessed/agreed_sentence give way to the same flag chosen by the user.
// The user's setup as the model reads it: the clauses built from the drug-case fields are for TAG-IT only.
const forModel = (setup, corpus) => {
  const chosen = setup?.[corpus];
  if (!chosen) return null;
  const { clauses, ...rest } = chosen;
  return rest;
};

// What the result card needs to show relevance: the mode, the level the list opens at, and how many of the most
// relevant results it always shows.
export function relevanceUi(relevance) {
  if (relevance.mode === 'off') return {};
  return { relevance: { mode: relevance.mode, threshold: relevance.threshold, minShown: relevance.minShown } };
}

// Whether the model set a parameter at all (an empty list or null is "not set").
const isSet = (value) => (Array.isArray(value) ? value.length > 0 : value != null);

// The drug-case clauses of the setup for one search, per field key. When the model says the user asked for something
// else in the conversation, the fields it sets itself are taken from its parameters instead of the form's.
function caseClauses(params, chosen) {
  const byKey = chosen?.clauses ?? {};
  const replacedByModel = new Set();
  if (params.override_setup) {
    for (const [key, names] of Object.entries(REPLACED_PARAMS)) {
      if (names.some((name) => isSet(params[name]))) replacedByModel.add(key);
    }
    // A quantity from the model is for its own drug, so the form's drug types give way too.
    if (isSet(params.drug_quantity)) replacedByModel.add('meta.drug_types');
  }
  return Object.fromEntries(Object.entries(byKey).filter(([key]) => !replacedByModel.has(key)));
}

// The model's parameters that a field still applied from the form replaces, so the two never contradict each other.
function withoutReplaced(params, keys) {
  const replaced = {};
  for (const key of keys) {
    for (const name of REPLACED_PARAMS[key] ?? []) replaced[name] = Array.isArray(params[name]) ? [] : null;
  }
  return { ...params, ...replaced };
}

let arrangementFields = { at: 0, keys: null };
async function arrangementFieldKeys() {
  if (arrangementFields.keys && Date.now() - arrangementFields.at < 60 * 60 * 1000) return arrangementFields.keys;
  const schema = await tagit.getSentencingSchema({ scope: tagit.ARRANGEMENTS_SCOPE });
  arrangementFields = { at: Date.now(), keys: new Set((schema.fields ?? []).map((f) => f.key)) };
  return arrangementFields.keys;
}

export async function withSentencingSetup(params, setup, corpus = 'sentencing') {
  const chosen = setup?.[corpus];
  const clauses = caseClauses(params, chosen);
  if (corpus === 'arrangements') {
    // The fields that describe the offence (drug, quantity, sections) narrow arrangements as well, when that corpus
    // has them; the rest (court, punishment ranges) describe a sentence, which an arrangement does not have.
    let known = null;
    try { known = await arrangementFieldKeys(); } catch { /* without the catalogue, no drug-case field is applied */ }
    const usable = Object.entries(clauses)
      .filter(([key, list]) => ARRANGEMENT_KEYS.has(key) && known && list.flatMap(clauseFields).every((f) => known.has(f)));
    const base = withoutReplaced(params, usable.map(([key]) => key));
    const withTypes = chosen?.punishment_types?.length ? { ...base, punishment_types: chosen.punishment_types } : base;
    return forArrangements({
      ...withTypes,
      setup_clauses: usable.flatMap(([, list]) => list),
      ...(chosen?.sort_direction ? { sort_direction: chosen.sort_direction } : {}),
    });
  }
  const base = withoutReplaced(params, Object.keys(clauses));
  const court = chosen?.filters?.[COURT_KEY];
  const courtFromForm = court && !(params.override_setup && isSet(params.court_instances));
  const withCase = {
    ...base,
    ...(courtFromForm ? { court_instances: [court] } : {}),
    setup_clauses: Object.values(clauses).flat(),
  };
  if (!chosen) return withCase;
  const flags = { ...(params.flags ?? {}), ...chosen.flags };
  return {
    ...withCase,
    flags,
    confessed: 'meta.confessed' in flags ? null : params.confessed,
    agreed_sentence: 'meta.agreed_sentence' in flags ? null : params.agreed_sentence,
    sort_direction: chosen.sort_direction ?? params.sort_direction,
  };
}

// A conditional arrangement is closed by consent, without an indictment and without a court deciding anything:
// there is no imprisonment, no criminal record, no sentencing range and no court instance in this corpus. Those
// filters exist in the shared schema but would only empty the results, so they are dropped here.
function forArrangements(params) {
  return {
    ...params,
    flags: undefined,
    confessed: null,
    agreed_sentence: null,
    prison_months_min: null,
    prison_months_max: null,
    court_instances: [],
  };
}

export function withGuidelinesSetup(params, setup) {
  const sources = setup?.guidelines?.sources ?? [];
  return sources.length ? { ...params, sources, source: undefined } : params;
}

export async function executeTool(toolUse, ctx) {
  const { account, conversationId, turnId, emit, signal } = ctx;
  const activity = (label, state, extra = {}) => emit({ type: 'activity', id: toolUse.id, label, state, ...extra });

  switch (toolUse.name) {
    case 'record_document_analysis': {
      const parsed = analysisSchema.safeParse(toolUse.input);
      if (!parsed.success) return validationError(toolUse, parsed.error.issues);
      const analysis = parsed.data;
      await query(
        'UPDATE conversations SET analysis = $2::jsonb, title = $3, updated_at = now() WHERE id = $1',
        [conversationId, JSON.stringify(analysis), analysis.title],
      );
      emit({ type: 'analysis', data: analysis });
      emit({ type: 'conversation', id: conversationId, title: analysis.title });
      return {
        block: toolResult(toolUse, analysis.is_supported
          ? 'The analysis was saved and shown to the user.'
          : 'The analysis was saved and shown to the user. The document is not a supported type: explain briefly and do not search.'),
        ui: { type: 'analysis', data: analysis },
      };
    }

    case 'search_sentencing_decisions':
    case 'search_conditional_arrangements': {
      const arrangements = toolUse.name === 'search_conditional_arrangements';
      const corpus = arrangements ? 'arrangements' : 'sentencing';
      const parsed = sentencingParamsSchema.safeParse(toolUse.input);
      if (!parsed.success) return validationError(toolUse, parsed.error.issues);
      const params = await withSentencingSetup(parsed.data, ctx.searchSetup, corpus);
      const noun = arrangements ? 'הסדרים מותנים' : 'גזרי דין';
      const label = `מחפש ${noun}: ${params.label}`;
      const action = arrangements ? 'search_arrangements' : 'search_sentencing';
      const uiType = arrangements ? 'arrangements' : 'results';
      activity(label, 'running');
      try {
        let found = await tagit.searchSentencing(params, { signal, scope: tagit.corpusScope(corpus) });
        // The case fields come from the sentencing catalogue; in the arrangements one they can match nothing. Then
        // the arrangements are searched without them, and relevance scoring sorts out what is related.
        let caseFieldsDropped = false;
        if (arrangements && !found.items.length && params.setup_clauses?.length) {
          found = await tagit.searchSentencing({ ...params, setup_clauses: [] }, { signal, scope: tagit.corpusScope(corpus) });
          caseFieldsDropped = found.items.length > 0;
        }
        await recordTagitCall({ account, conversationId, turnId, detail: { action, label: params.label, filter: found.filter, sort: params.sort, sort_direction: params.sort_direction, text_query: params.text_query || undefined, total: found.total, returned: found.items.length } });
        // Each result scored for relevance to the case (when the admin turned it on); under the threshold, hidden.
        const relevance = await applyRelevance(found, { account, conversationId, turnId, corpus, label: params.label, signal });
        // The user gets every result (the list opens at the threshold); the model summarizes the ones shown.
        const result = { ...found, items: relevance.shown };
        const data = {
          label: params.label, params, total: found.total, page: found.page, size: found.size, items: relevance.items, corpus,
          textQueryDropped: found.textQueryDropped || undefined,
          caseFieldsDropped: caseFieldsDropped || undefined,
          ...relevanceUi(relevance),
        };
        activity(label, 'done', { summary: result.total != null ? `${result.total} תוצאות` : `${result.items.length} תוצאות` });
        emit({ type: uiType, toolUseId: toolUse.id, data });
        return {
          block: toolResult(toolUse, {
            ...sentencingForModel(result, params, corpus),
            case_fields_dropped: caseFieldsDropped
              ? 'No arrangement matched the drug/section fields from the search form, so arrangements were searched without them.'
              : undefined,
            less_relevant_not_listed: relevance.items.length > relevance.shown.length
              ? `${relevance.items.length - relevance.shown.length} results on this page scored as less relevant to the case; the user sees them only after expanding the list, and they are not in items.`
              : undefined,
            applied_user_setup: forModel(ctx.searchSetup, corpus),
          }),
          ui: { type: uiType, data },
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        await recordTagitCall({ account, conversationId, turnId, detail: { action, label: params.label, error: tagitErrorMessage(err) } });
        activity(label, 'error');
        return { block: toolResult(toolUse, tagitErrorMessage(err), true), ui: null };
      }
    }

    case 'search_guidelines': {
      const parsed = guidelinesParamsSchema.safeParse(toolUse.input);
      if (!parsed.success) return validationError(toolUse, parsed.error.issues);
      const params = withGuidelinesSetup(parsed.data, ctx.searchSetup);
      const label = `מחפש הנחיות: ${params.label}`;
      activity(label, 'running');
      try {
        const result = await tagit.searchGuidelines(params, { signal });
        await recordTagitCall({ account, conversationId, turnId, detail: { action: 'search_guidelines', label: params.label, queries: params.queries, sources: params.sources?.length ? params.sources : undefined, topic: params.topic || undefined, returned: result.items.length } });
        // Guidelines are matched as substrings, so a search catches unrelated directives too: each one is scored for
        // relevance to the case like the decisions, and the model reads the ones the list opens with.
        const relevance = await applyRelevance(result, { account, conversationId, turnId, corpus: 'guidelines', label: params.label, signal });
        const data = { label: params.label, params, totals: result.totals, items: relevance.items, ...relevanceUi(relevance) };
        activity(label, 'done', { summary: `${result.items.length} הנחיות` });
        emit({ type: 'guidelines', toolUseId: toolUse.id, data });
        return {
          block: toolResult(toolUse, {
            label: params.label,
            totals: result.totals,
            sources_filter: result.sources,
            items: relevance.shown.map((g) => ({
              ref: `guideline:${g.id}`, title: g.title, number: g.number, source: g.source, topic: g.topic, date: g.date,
              matched_queries: g.matchedQueries, summary: truncate(g.summary, 400), relevance: g.relevance?.score ?? undefined,
            })),
            less_relevant_not_listed: relevance.items.length > relevance.shown.length
              ? `${relevance.items.length - relevance.shown.length} guidelines scored as less relevant to the case; the user sees them only after expanding the list, and they are not in items.`
              : undefined,
          }),
          ui: { type: 'guidelines', data },
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        await recordTagitCall({ account, conversationId, turnId, detail: { action: 'search_guidelines', label: params.label, error: tagitErrorMessage(err) } });
        activity(label, 'error');
        return { block: toolResult(toolUse, tagitErrorMessage(err), true), ui: null };
      }
    }

    case 'get_field_values': {
      const parsed = fieldValuesSchema.safeParse(toolUse.input);
      if (!parsed.success) return validationError(toolUse, parsed.error.issues);
      const { field, contains } = parsed.data;
      const label = `בודק ערכים בשדה ${field}`;
      activity(label, 'running');
      try {
        const facetKey = GUIDELINE_FACETS[field];
        if (facetKey) {
          const facets = await tagit.getGuidelinesFacets({ signal });
          const matched = facets[facetKey].filter((v) => !contains || v.value.includes(contains));
          const values = matched.slice(0, 250);
          activity(label, 'done');
          return {
            block: toolResult(toolUse, {
              key: field,
              matched: matched.length,
              // Say so rather than letting the model infer a cut from where the list stops.
              truncated: matched.length > values.length,
              // The filter is a substring match while the count is exact, so the count is a floor.
              note: 'Copy a value exactly as written. count is how many documents hold that exact value; the filter matches substrings, so it can return more.',
              values,
            }),
            ui: null,
          };
        }
        const schema = await tagit.getSentencingSchema({ signal, scope: tagit.corpusScope(parsed.data.corpus) });
        const def = (schema.fields ?? []).find((f) => f.key === field);
        activity(label, 'done');
        if (!def) {
          return {
            block: toolResult(toolUse, {
              error: 'unknown_field',
              available_fields: [
                ...(schema.fields ?? []).filter((f) => f.key.startsWith('meta.')).map((f) => ({ key: f.key, label: f.label, type: f.type })),
                ...Object.keys(GUIDELINE_FACETS).map((key) => ({ key, label: 'שדה של הנחיות', type: 'string' })),
              ],
            }, true),
            ui: null,
          };
        }
        const values = (def.enum_values_sample ?? []).filter((v) => !contains || String(v).includes(contains)).slice(0, 80);
        return { block: toolResult(toolUse, { key: def.key, label: def.label, type: def.type, values }), ui: null };
      } catch (err) {
        if (signal?.aborted) throw err;
        activity(label, 'error');
        return { block: toolResult(toolUse, tagitErrorMessage(err), true), ui: null };
      }
    }

    case 'read_document': {
      const parsed = readDocumentSchema.safeParse(toolUse.input);
      if (!parsed.success) return validationError(toolUse, parsed.error.issues);
      const { kind, id, max_chars: maxChars } = parsed.data;
      const label = kind === 'ruling' ? `קורא את גזר הדין (${id})`
        : kind === 'arrangement' ? `קורא את ההסדר המותנה (${id})` : `קורא את ההנחיה (${id})`;
      activity(label, 'running');
      try {
        let payload;
        if (kind !== 'guideline') {
          const doc = await tagit.readRulingText(id, { signal });
          payload = { id, filename: doc.filename, text: truncate(doc.text, maxChars), truncated: (doc.text?.length ?? 0) > maxChars };
        } else {
          const doc = await tagit.readGuideline(id, { signal });
          payload = { ...tagit.normalizeGuideline(doc), text: truncate(doc.content_text, maxChars), truncated: (doc.content_text?.length ?? 0) > maxChars };
        }
        await recordTagitCall({ account, conversationId, turnId, detail: { action: 'read_document', kind, id } });
        activity(label, 'done');
        return { block: toolResult(toolUse, payload), ui: null };
      } catch (err) {
        if (signal?.aborted) throw err;
        activity(label, 'error');
        return { block: toolResult(toolUse, tagitErrorMessage(err), true), ui: null };
      }
    }

    default:
      return { block: toolResult(toolUse, `Unknown tool ${toolUse.name}`, true), ui: null };
  }
}
