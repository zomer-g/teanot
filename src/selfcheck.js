// Boot-time diagnostics written to the runtime log (never secret values): are the language model and TAG-IT
// reachable with the configured keys, and does TAG-IT's live schema carry the fields the tools filter on?
import * as tagit from './tagit.js';
import { probePdfExtraction } from './extract.js';
import { activeModel, keyStatus, streamModel } from './llm/index.js';
import { clearProviderAlert, recordProviderFailure } from './llm/alerts.js';
import { encryptionAvailable } from './secrets.js';

const EXPECTED_FIELDS = [
  'meta.topics', 'meta.drug_types', 'meta.offense_sections', 'meta.offense_law_sections', 'meta.drug_ordinance_sections',
  'meta.court_instance', 'meta.prison_actual_months', 'meta.severity_score', 'meta.confessed', 'meta.agreed_sentence',
  ...Object.values(tagit.DRUG_SLUGS).flatMap((slug) => [`meta.drug_total_g_${slug}`, `meta.drug_total_n_${slug}`]),
];

const errorInfo = (err) => ({ ok: false, status: err.status ?? null, error: String(err.message).slice(0, 300) });

async function timed(fn) {
  const started = Date.now();
  const result = await fn();
  return { ...result, ms: Date.now() - started };
}

export async function runSelfCheck() {
  const report = {
    env: Object.fromEntries(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'SETTINGS_ENCRYPTION_KEY', 'TAGIT_API_KEY', 'TAGIT_GUIDELINES_API_KEY', 'ADMIN_EMAILS', 'XHOST_AUTH_AUDIENCES']
      .map((key) => [key, Boolean(process.env[key])])),
    adminCount: (process.env.ADMIN_EMAILS ?? '').split(',').filter((s) => s.trim()).length,
  };

  report.node = process.version;
  report.pdfExtraction = await timed(async () => {
    try {
      return { ok: true, ...(await probePdfExtraction()) };
    } catch (err) {
      return errorInfo(err);
    }
  });

  report.encryptionAvailable = encryptionAvailable();
  report.llm = await timed(async () => {
    let llm = null;
    try {
      const keys = await keyStatus();
      llm = await activeModel();
      let text = '';
      const answer = await streamModel(llm, {
        system: 'Reply with the single word OK.',
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
        onText: (delta) => { text += delta; },
      });
      await clearProviderAlert(llm.provider);
      return {
        ok: true,
        provider: llm.provider,
        requestedModel: llm.model,
        model: answer.model,
        stopReason: answer.stopReason,
        replied: Boolean(text.trim()),
        keySources: Object.fromEntries(Object.entries(keys).map(([id, k]) => [id, k.source])),
      };
    } catch (err) {
      // A boot after the credit ran out raises the admin alert even before anyone asks a question.
      if (llm) await recordProviderFailure({ provider: llm.provider, model: llm.model, err }).catch(() => {});
      return errorInfo(err);
    }
  });

  report.tagitSchema = await timed(async () => {
    try {
      const schema = await tagit.getSentencingSchema();
      const keys = new Set((schema.fields ?? []).map((f) => f.key));
      return {
        ok: true,
        scope: tagit.SENTENCING_SCOPE,
        scopeName: schema.scope_name ?? null,
        fieldCount: keys.size,
        missingExpected: EXPECTED_FIELDS.filter((k) => !keys.has(k)),
        topicsSample: ((schema.fields ?? []).find((f) => f.key === 'meta.topics')?.enum_values_sample ?? []).slice(0, 20),
      };
    } catch (err) {
      return errorInfo(err);
    }
  });

  report.tagitSentencing = await timed(async () => {
    try {
      const result = await tagit.searchSentencing({
        label: 'selfcheck', topics: ['סמים'], drug_types: ['קוקאין'],
        drug_quantity: { slug: 'cocaine', measure: 'grams', min: 20, max: 40 }, sort: 'severity', size: 3,
      });
      const first = result.items[0];
      return {
        ok: true,
        total: result.total,
        returned: result.items.length,
        rejectedFields: tagit.rejectedResultFields(),
        firstItem: first ? {
          hasTitle: Boolean(first.title), prisonMonths: first.prisonMonths, severity: first.severity,
          drugTotals: first.drugTotals.length, defendants: first.defendants.length, hasSummary: Boolean(first.summary),
        } : null,
      };
    } catch (err) {
      return errorInfo(err);
    }
  });

  report.tagitGuidelines = await timed(async () => {
    try {
      const result = await tagit.searchGuidelines({ queries: ['סמים'], limit: 3 });
      return { ok: true, keySource: tagit.guidelinesKeySource(), totals: result.totals, returned: result.items.length };
    } catch (err) {
      return errorInfo(err);
    }
  });

  report.tagitGuidelineFacets = await timed(async () => {
    try {
      const facets = await tagit.getGuidelinesFacets();
      return {
        ok: true,
        sources: facets.sources.length,
        topics: facets.topics.length,
        sourceSample: facets.sources.slice(0, 5).map((f) => f.value),
      };
    } catch (err) {
      return errorInfo(err);
    }
  });

  // Paired A/B of the guidelines list endpoint, for TAG-IT performance work (SELFCHECK_GUIDELINES_AB=1).
  // Order exact, skip, skip, exact cancels cache warming and slow drift, which single samples taken
  // hours apart cannot: the upstream database is shared with other heavy queries.
  if (process.env.SELFCHECK_GUIDELINES_AB === '1') {
    const runs = [];
    for (const totalMode of ['exact', 'skip', 'skip', 'exact']) {
      const started = Date.now();
      try {
        const result = await tagit.searchGuidelines({ queries: ['סמים'], limit: 3, totalMode });
        runs.push({ totalMode, ms: Date.now() - started, total: result.totals[0]?.total ?? null, returned: result.items.length });
      } catch (err) {
        runs.push({ totalMode, ms: Date.now() - started, error: String(err.message).slice(0, 120) });
      }
    }
    const average = (mode) => {
      const samples = runs.filter((r) => r.totalMode === mode && !r.error).map((r) => r.ms);
      return samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null;
    };
    report.guidelinesAb = { query: 'סמים', limit: 3, runs, exactAvgMs: average('exact'), skipAvgMs: average('skip') };
  }

  console.log('[selfcheck]', JSON.stringify(report));
}
