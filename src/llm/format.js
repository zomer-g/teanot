// The stored conversation format, shared by every provider.
//
// Messages are { role: 'user' | 'assistant', content: blocks[] } in Anthropic's block shapes:
//   text, document (base64 PDF or plain text), tool_use { id, name, input }, tool_result { tool_use_id, content, is_error }.
// Anthropic may add thinking blocks; other providers ignore them.
//
// A provider that needs its own data replayed exactly (OpenAI reasoning items, Gemini thought signatures)
// stores it in one extra assistant block: { type: 'provider_state', provider, ... }. Only that provider reads it;
// the rest of the message stays usable by any provider, so the model can be switched mid-conversation.

export const withoutProviderState = (blocks) => blocks.filter((block) => block.type !== 'provider_state');

export const providerState = (blocks, provider) =>
  blocks.find((block) => block.type === 'provider_state' && block.provider === provider) ?? null;

export function toolResultText(block) {
  const body = typeof block.content === 'string'
    ? block.content
    : (block.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  return block.is_error ? `Error: ${body}` : body;
}

export function documentAsText(block) {
  return `<document title="${String(block.title ?? 'מסמך').replace(/"/g, '\'')}">\n${block.source.data}\n</document>`;
}

// tool_use id → name, for providers whose tool results are matched by name.
export function toolNamesById(messages) {
  const names = new Map();
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool_use') names.set(block.id, block.name);
  }
  return names;
}

export function parseArguments(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
