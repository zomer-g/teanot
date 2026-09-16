// OpenAI Responses API, used statelessly (store: false): every call sends the whole conversation.
// Reasoning models return encrypted reasoning items that must be sent back with the calls they led to,
// so the raw output of each response is kept as provider_state and replayed verbatim.
import OpenAI from 'openai';
import { documentAsText, parseArguments, providerState, toolResultText } from './format.js';

const clients = new Map();
const client = (apiKey) => {
  if (!clients.has(apiKey)) clients.set(apiKey, new OpenAI({ apiKey, maxRetries: 2 }));
  return clients.get(apiKey);
};

// Models that reject include: ['reasoning.encrypted_content'] (non-reasoning models), learned on first refusal.
const noReasoningInclude = new Set();

function userItems(blocks) {
  const outputs = [];
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      outputs.push({ type: 'function_call_output', call_id: block.tool_use_id, output: toolResultText(block) });
    } else if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text });
    } else if (block.type === 'document' && block.source?.type === 'base64') {
      parts.push({ type: 'input_file', filename: block.title || 'document.pdf', file_data: `data:${block.source.media_type};base64,${block.source.data}` });
    } else if (block.type === 'document') {
      parts.push({ type: 'input_text', text: documentAsText(block) });
    }
  }
  // Tool outputs answer the previous assistant turn, so they come before anything new the user added.
  return [...outputs, ...(parts.length ? [{ role: 'user', content: parts }] : [])];
}

function assistantItems(blocks) {
  const state = providerState(blocks, 'openai');
  if (state) return state.output;
  const items = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) items.push({ role: 'assistant', content: block.text });
    else if (block.type === 'tool_use') {
      items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return items;
}

export function toOpenAIInput(messages) {
  return messages.flatMap((message) => (message.role === 'user' ? userItems(message.content) : assistantItems(message.content)));
}

function fromOutput(response) {
  const content = [];
  let refused = false;
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      const text = (item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text).join('');
      if (text) content.push({ type: 'text', text });
      if ((item.content ?? []).some((part) => part.type === 'refusal')) refused = true;
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
    }
  }
  content.push({ type: 'provider_state', provider: 'openai', output: response.output ?? [] });
  return { content, refused };
}

async function createStream(apiKey, body, signal) {
  const withInclude = !noReasoningInclude.has(body.model);
  try {
    return await client(apiKey).responses.create({ ...body, ...(withInclude ? { include: ['reasoning.encrypted_content'] } : {}) }, { signal });
  } catch (err) {
    if (withInclude && err?.status === 400 && /reasoning|encrypted|include/i.test(err.message)) {
      noReasoningInclude.add(body.model);
      return client(apiKey).responses.create(body, { signal });
    }
    throw err;
  }
}

export async function streamOpenAI({ apiKey, model, system, tools, messages, signal, onText }) {
  const stream = await createStream(apiKey, {
    model,
    instructions: system,
    input: toOpenAIInput(messages),
    ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false })) } : {}),
    store: false,
    stream: true,
  }, signal);

  let final = null;
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') onText(event.delta);
    else if (event.type === 'response.completed' || event.type === 'response.incomplete') final = event.response;
    else if (event.type === 'response.failed') {
      throw Object.assign(new Error(event.response?.error?.message || 'OpenAI response failed'), { status: 502 });
    } else if (event.type === 'error') {
      throw Object.assign(new Error(event.message || 'OpenAI stream error'), { status: 502 });
    }
  }
  if (!final) throw Object.assign(new Error('OpenAI stream ended without a response'), { status: 502 });

  const { content, refused } = fromOutput(final);
  const reason = final.incomplete_details?.reason;
  const stopReason = refused || reason === 'content_filter' ? 'refusal'
    : reason === 'max_output_tokens' ? 'max_tokens'
      : content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const usage = final.usage ?? {};
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return {
    model: final.model || model,
    content,
    stopReason,
    usage: { input: Math.max(0, (usage.input_tokens ?? 0) - cached), output: usage.output_tokens ?? 0, cacheWrite: 0, cacheRead: cached },
  };
}

const NOT_TEXT_MODEL = /embedding|whisper|tts|dall-e|image|moderation|transcribe|audio|realtime|search|davinci|babbage|sora/i;

export async function listOpenAIModels(apiKey) {
  const ids = [];
  for await (const model of client(apiKey).models.list()) if (!NOT_TEXT_MODEL.test(model.id)) ids.push(model.id);
  return ids.sort();
}
