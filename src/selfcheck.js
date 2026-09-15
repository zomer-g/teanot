// Boot-time diagnostics written to the runtime log (never secret values): are Claude and TAG-IT
// reachable with the configured keys, and does TAG-IT's live schema carry the fields the tools filter on?
import Anthropic from '@anthropic-ai/sdk';
import * as tagit from './tagit.js';

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
    env: Object.fromEntries(['ANTHROPIC_API_KEY', 'TAGIT_API_KEY', 'TAGIT_GUIDELINES_API_KEY', 'ADMIN_EMAILS', 'XHOST_AUTH_AUDIENCES']
      .map((key) => [key, Boolean(process.env[key])])),
    adminCount: (process.env.ADMIN_EMAILS ?? '').split(',').filter((s) => s.trim()).length,
  };

  const model = process.env.CLAUDE_MODEL || 'claude-opus-5';
  report.anthropic = await timed(async () => {
    try {
      const client = new Anthropic();
      await client.models.retrieve(model);
      const useFallbacks = process.env.CLAUDE_FALLBACKS !== 'off';
      const message = await client.beta.messages.create({
        model,
        max_tokens: 256,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      });
      return { ok: true, model: message.model, fallbacks: useFallbacks, stop_reason: message.stop_reason };
    } catch (err) {
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

  console.log('[selfcheck]', JSON.stringify(report));
}
