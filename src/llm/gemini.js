// Google Gemini (generateContent, streamed). Gemini 3 returns thought signatures on its parts and rejects a
// follow-up request whose function calls lack them, so the model's parts are kept as provider_state and replayed
// exactly. Function calls that came from another provider get Google's documented placeholder signature.
import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { documentAsText, providerState, toolNamesById, toolResultText } from './format.js';

// Documented by Google for function calls not produced by Gemini (e.g. history from another model).
const PLACEHOLDER_SIGNATURE = 'skip_thought_signature_validator';
// Gemini may omit call ids; ours then carry this prefix and are not sent back as ids.
const LOCAL_ID = 'gemini-local-';

const clients = new Map();
const client = (apiKey) => {
  if (!clients.has(apiKey)) {
    const baseUrl = process.env.GEMINI_BASE_URL; // local mocks only
    clients.set(apiKey, new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) }));
  }
  return clients.get(apiKey);
};

function userParts(blocks, names) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const id = block.tool_use_id?.startsWith(LOCAL_ID) ? undefined : block.tool_use_id;
      const key = block.is_error ? 'error' : 'output';
      parts.push({ functionResponse: { ...(id ? { id } : {}), name: names.get(block.tool_use_id) ?? 'unknown_tool', response: { [key]: toolResultText(block) } } });
    } else if (block.type === 'text') {
      parts.push({ text: block.text });
    } else if (block.type === 'document' && block.source?.type === 'base64') {
      parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
    } else if (block.type === 'document') {
      parts.push({ text: documentAsText(block) });
    }
  }
  return parts;
}

function modelParts(blocks) {
  const state = providerState(blocks, 'gemini');
  if (state) return state.parts;
  const parts = [];
  let signed = false;
  for (const block of blocks) {
    if (block.type === 'text' && block.text) parts.push({ text: block.text });
    else if (block.type === 'tool_use') {
      const id = block.id.startsWith(LOCAL_ID) ? undefined : block.id;
      parts.push({ functionCall: { ...(id ? { id } : {}), name: block.name, args: block.input ?? {} }, ...(signed ? {} : { thoughtSignature: PLACEHOLDER_SIGNATURE }) });
      signed = true; // the signature belongs on the first call of the step
    }
  }
  return parts;
}

export function toGeminiContents(messages) {
  const names = toolNamesById(messages);
  return messages
    .map((message) => ({ role: message.role === 'user' ? 'user' : 'model', parts: message.role === 'user' ? userParts(message.content, names) : modelParts(message.content) }))
    .filter((content) => content.parts.length);
}

// Streamed text arrives in many small parts; keep them merged unless a part carries a signature or is a thought.
function appendPart(parts, part) {
  const last = parts.at(-1);
  const plainText = (p) => typeof p?.text === 'string' && !p.thought && !p.thoughtSignature && !p.functionCall;
  if (plainText(part) && plainText(last)) last.text += part.text;
  else parts.push({ ...part });
}

const REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export async function streamGemini({ apiKey, model, system, tools, messages, signal, onText }) {
  const stream = await client(apiKey).models.generateContentStream({
    model,
    contents: toGeminiContents(messages),
    config: {
      systemInstruction: system,
      ...(tools.length ? { tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema })) }] } : {}),
      abortSignal: signal,
    },
  });

  const parts = [];
  let finishReason = null;
  let blocked = false;
  let usage = {};
  let modelVersion = null;
  for await (const chunk of stream) {
    if (chunk.promptFeedback?.blockReason) blocked = true;
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.modelVersion) modelVersion = chunk.modelVersion;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text && !part.thought) onText(part.text);
      appendPart(parts, part);
    }
  }

  const content = [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (text) content.push({ type: 'text', text });
  for (const part of parts) {
    if (!part.functionCall) continue;
    // The part is replayed as Gemini returned it; a generated local id lives only in our tool_use block.
    content.push({ type: 'tool_use', id: part.functionCall.id ?? `${LOCAL_ID}${randomUUID()}`, name: part.functionCall.name, input: part.functionCall.args ?? {} });
  }
  content.push({ type: 'provider_state', provider: 'gemini', parts });

  const stopReason = blocked || REFUSALS.has(finishReason) ? 'refusal'
    : finishReason === 'MAX_TOKENS' ? 'max_tokens'
      : content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const cached = usage.cachedContentTokenCount ?? 0;
  return {
    model: modelVersion || model,
    content,
    stopReason,
    usage: {
      input: Math.max(0, (usage.promptTokenCount ?? 0) - cached) + (usage.toolUsePromptTokenCount ?? 0),
      output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cacheWrite: 0,
      cacheRead: cached,
    },
  };
}

export async function listGeminiModels(apiKey) {
  const ids = [];
  const pager = await client(apiKey).models.list({ config: { pageSize: 100 } });
  for await (const model of pager) {
    const actions = model.supportedActions ?? [];
    if (actions.length && !actions.includes('generateContent')) continue;
    ids.push(String(model.name).replace(/^models\//, ''));
  }
  return ids.sort();
}
