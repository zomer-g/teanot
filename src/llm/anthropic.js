// Anthropic Messages API. The stored conversation format is already Anthropic's content blocks, so this adapter
// only drops what other providers left behind (their private replay state).
import Anthropic from '@anthropic-ai/sdk';
import { withoutProviderState } from './format.js';

const EFFORT = process.env.CLAUDE_EFFORT || 'high';
// Server-side fallback was verified with this model only; other Claude models an admin picks run without it.
const useFallbacks = (model) => process.env.CLAUDE_FALLBACKS !== 'off' && model === 'claude-opus-5';

const clients = new Map();
const client = (apiKey) => {
  if (!clients.has(apiKey)) clients.set(apiKey, new Anthropic({ apiKey }));
  return clients.get(apiKey);
};

function toAnthropic(messages) {
  return messages.map((message) => {
    const content = withoutProviderState(message.content);
    // A turn that only held another provider's replay state still needs content to keep roles alternating.
    return { role: message.role, content: content.length ? content : [{ type: 'text', text: '…' }] };
  });
}

const STOP = { end_turn: 'end_turn', tool_use: 'tool_use', max_tokens: 'max_tokens', refusal: 'refusal', stop_sequence: 'end_turn', pause_turn: 'end_turn' };

export async function streamAnthropic({ apiKey, model, system, tools, messages, signal, onText }) {
  const stream = client(apiKey).beta.messages.stream({
    model,
    max_tokens: 32000,
    system,
    ...(tools.length ? { tools } : {}),
    messages: toAnthropic(messages),
    output_config: { effort: EFFORT },
    cache_control: { type: 'ephemeral' },
    ...(useFallbacks(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  }, { signal });
  stream.on('text', onText);
  const message = await stream.finalMessage();
  return {
    model: message.model,
    content: message.content,
    stopReason: STOP[message.stop_reason] ?? 'end_turn',
    usage: {
      input: message.usage.input_tokens ?? 0,
      output: message.usage.output_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}

export async function listAnthropicModels(apiKey) {
  const ids = [];
  for await (const model of client(apiKey).models.list({ limit: 100 })) ids.push(model.id);
  return ids;
}
