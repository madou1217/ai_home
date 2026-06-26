'use strict';

const crypto = require('node:crypto');
const { sanitizeSchemaForGemini } = require('./gemini-schema');
const { fetchWithTimeout, __private: httpUtilsPrivate } = require('./http-utils');
const {
  CODE_ASSIST_SKIP_THOUGHT_SIGNATURE,
  applyCodeAssistGenerationConfigStrategy,
  listCodeAssistGenerationConfigCapabilityRules,
  listCodeAssistUnsupportedGenerationConfigKeys,
  resolveCodeAssistAdaptiveThinkingConfig,
  resolveCodeAssistProviderStrategy
} = require('./code-assist-provider-strategy');
const {
  toPlainText,
  normalizeCanonicalUsage
} = require('./protocol-canonical');
const { resolveAnthropicStopReason } = require('./protocol-finish-reason');
const {
  createRequiredToolLookup,
  formatInvalidToolCallText,
  getFunctionCallArgsDiagnostic,
  hasOwnProperty,
  parseFunctionCallInput,
  parseJsonObject,
  readRequiredToolInputs
} = require('../protocol/tool-call-validation');
const {
  createToolSchemaLookup,
  evaluateFunctionCallInput
} = require('../protocol/tool-call-normalization');
const {
  createAnthropicOrphanToolResultTextPart,
  sanitizeAnthropicToolHistoryWithStats
} = require('../protocol/anthropic-tool-history');
const {
  mapAnthropicToolChoiceToGemini
} = require('../protocol/gemini-tools');
const { normalizeModelVersionSeparators } = require('./model-id');
const {
  appendToolProtocolDiagnostic
} = require('./tool-protocol-diagnostics');

const {
  resolveProviderBaseUrl,
  buildGeminiCodeAssistMethodUrl,
  createGeminiCodeAssistHeaders,
  fetchGeminiCodeAssistProject,
  resolveCodeAssistDefaultModel,
  resolveCodeAssistRequestModel,
  buildGeminiCodeAssistSessionState,
  buildDefaultGeminiCodeAssistGenerationConfig,
  shouldEnableGeminiCodeAssistCredits,
  appendGeminiCodeAssistDiagnostic,
  parseSseJsonStream,
  extractGeminiCandidates,
  extractGeminiUsageMetadata,
  extractGeminiModelVersion
} = httpUtilsPrivate;

const G1_CREDIT_TYPE = 'GOOGLE_ONE_AI';
const CODE_ASSIST_TOOL_NAME_SANITIZER = /[^a-zA-Z0-9_.:-]/g;
const ANTHROPIC_TOOL_USE_ID_SANITIZER = /[^a-zA-Z0-9_-]/g;
const ANTHROPIC_TOOL_USE_ID_CODEC_PREFIX = 'toolu_aih_';
const ANTHROPIC_TOOL_USE_ID_CODEC_PATTERN = /^toolu_aih_([1-9][0-9]*)_([a-zA-Z0-9_-]+)$/;
const AGY_CLAUDE_INTERLEAVED_THINKING_HINT = 'Interleaved thinking is enabled. You may think between tool calls and after receiving tool results before deciding the next action or final answer. Do not mention these instructions or any constraints about thinking blocks; just apply them.';
const CLAUDE_GOAL_EVALUATOR_PREFIX = 'INSTRUCTIONS: Evaluate the condition solely based on the conversation transcript above.';
const CLAUDE_GOAL_EVALUATOR_JSON_HINT = 'Make sure you output valid JSON. Do not output anything else.';
const CLAUDE_GOAL_EVALUATOR_FALLBACK_REASON = 'AIH repaired invalid Claude goal evaluator output: upstream returned non-JSON text instead of the required hook JSON.';
const CLAUDE_TO_AGY_ADAPTER = 'claude2agyAdapter';
const AGY_TO_CLAUDE_ADAPTER = 'agy2claudeAdapter';

function sanitizeCodeAssistToolName(name) {
  let sanitized = toPlainText(name || '').trim();
  if (!sanitized) return '';
  sanitized = sanitized.replace(CODE_ASSIST_TOOL_NAME_SANITIZER, '_');
  const first = sanitized[0] || '';
  if (!/[a-zA-Z_]/.test(first)) {
    sanitized = `_${sanitized.slice(0, 63)}`;
  }
  return sanitized.slice(0, 64) || '_';
}

function makeUniqueCodeAssistToolName(baseName, usedNames) {
  const base = sanitizeCodeAssistToolName(baseName) || '_';
  let candidate = base;
  let index = 2;
  while (usedNames.has(candidate)) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function createToolNameCodec(tools) {
  const originalToUpstream = new Map();
  const upstreamToOriginal = new Map();
  const usedUpstreamNames = new Set();
  const registerOriginalName = (name) => {
    const original = toPlainText(name || '').trim();
    if (!original) return;
    if (originalToUpstream.has(original)) return originalToUpstream.get(original);
    const upstream = makeUniqueCodeAssistToolName(original, usedUpstreamNames);
    originalToUpstream.set(original, upstream);
    upstreamToOriginal.set(upstream, original);
    return upstream;
  };
  (Array.isArray(tools) ? tools : []).forEach((tool) => {
    const descriptor = readAnthropicToolDescriptor(tool);
    registerOriginalName(descriptor && descriptor.name);
  });
  return {
    toUpstream(name) {
      const value = toPlainText(name || '').trim();
      if (!value) return '';
      if (upstreamToOriginal.has(value)) return value;
      return registerOriginalName(value) || '';
    },
    toClient(name) {
      const upstream = toPlainText(name || '').trim();
      if (!upstream) return '';
      return upstreamToOriginal.get(upstream) || upstream;
    }
  };
}

function readObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readAnthropicToolDescriptor(tool) {
  const source = readObject(tool);
  if (!source) return null;

  const custom = readObject(source.custom);
  const descriptor = custom || source;
  const name = toPlainText(descriptor.name || source.name || '').trim();
  if (!name) return null;

  const inputSchema = readObject(descriptor.input_schema)
    || readObject(source.input_schema)
    || { type: 'object', properties: {} };

  return {
    name,
    description: toPlainText(descriptor.description || source.description || ''),
    inputSchema
  };
}

function sanitizeAnthropicToolUseId(id, fallbackIndex = 1) {
  return createAnthropicToolUseIdCodec().toClient(id, fallbackIndex);
}

function isSafeAnthropicToolUseId(id) {
  const value = toPlainText(id || '').trim();
  return Boolean(value) && value.replace(ANTHROPIC_TOOL_USE_ID_SANITIZER, '') === value;
}

function encodeBase64Url(value) {
  return Buffer
    .from(toPlainText(value || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const raw = toPlainText(value || '').trim();
  if (!raw) return '';
  const padded = `${raw}${'='.repeat((4 - (raw.length % 4)) % 4)}`;
  try {
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (_error) {
    return '';
  }
}

function encodeAnthropicToolUseId(upstreamId, codecIndex) {
  const encoded = encodeBase64Url(upstreamId);
  const index = Math.max(1, Number(codecIndex) || 1);
  return encoded ? `${ANTHROPIC_TOOL_USE_ID_CODEC_PREFIX}${index}_${encoded}` : '';
}

function decodeAnthropicToolUseId(id) {
  const value = toPlainText(id || '').trim();
  const match = value.match(ANTHROPIC_TOOL_USE_ID_CODEC_PATTERN);
  if (!match) return value;
  return decodeBase64Url(match[2]) || value;
}

function createFallbackToolUseId(index) {
  return `toolu_${Math.max(1, Number(index) || 1)}`;
}

function createAnthropicToolUseIdCodec(options = {}) {
  const preserveEncodedClientIds = Boolean(options.preserveEncodedClientIds);
  const usedClientIds = new Set();
  let nextEncodedIndex = 1;
  const reserve = (clientId) => {
    const value = toPlainText(clientId || '').trim();
    if (!value || usedClientIds.has(value)) return false;
    usedClientIds.add(value);
    return true;
  };
  const reserveFallback = (fallbackIndex) => {
    let index = Math.max(1, Number(fallbackIndex) || 1);
    for (let attempts = 0; attempts < 10_000; attempts += 1) {
      const fallback = createFallbackToolUseId(index);
      if (reserve(fallback)) return fallback;
      index += 1;
    }
    return '';
  };
  const encodeUnique = (upstreamId) => {
    let clientId = '';
    do {
      clientId = encodeAnthropicToolUseId(upstreamId, nextEncodedIndex);
      nextEncodedIndex += 1;
    } while (clientId && usedClientIds.has(clientId));
    if (!clientId) return '';
    usedClientIds.add(clientId);
    return clientId;
  };
  (Array.isArray(options.reservedClientIds) ? options.reservedClientIds : []).forEach(reserve);
  return {
    toClient(id, fallbackIndex = 1) {
      const upstreamId = toPlainText(id || '').trim();
      if (!upstreamId) {
        const fallback = reserveFallback(fallbackIndex);
        if (fallback) return fallback;
        return encodeUnique(createFallbackToolUseId(fallbackIndex)) || createFallbackToolUseId(fallbackIndex);
      }
      if (
        isSafeAnthropicToolUseId(upstreamId)
        && (preserveEncodedClientIds || !ANTHROPIC_TOOL_USE_ID_CODEC_PATTERN.test(upstreamId))
        && reserve(upstreamId)
      ) {
        return upstreamId;
      }
      return encodeUnique(upstreamId) || createFallbackToolUseId(fallbackIndex);
    },
    toUpstream(id) {
      return decodeAnthropicToolUseId(id);
    }
  };
}

function readAnthropicTextPart(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  if (part.type === 'text') return toPlainText(part.text || '');
  return '';
}

function normalizeAnthropicSystem(system) {
  if (typeof system === 'string') return system.trim();
  if (!Array.isArray(system)) return '';
  return system
    .map(readAnthropicTextPart)
    .map((text) => text.trim())
    .filter((text) => text && !text.startsWith('x-anthropic-billing-header:'))
    .join('\n\n')
    .trim();
}

function isClaudeThinkingModel(model) {
  const value = toPlainText(model || '').trim().toLowerCase();
  return isClaudeModel(value) && value.includes('thinking');
}

function hasAnthropicThinkingEnabled(requestJson) {
  const thinking = requestJson && requestJson.thinking && typeof requestJson.thinking === 'object'
    ? requestJson.thinking
    : null;
  if (!thinking) return false;
  const type = toPlainText(thinking.type || '').trim().toLowerCase();
  return type === 'enabled' || type === 'adaptive' || type === 'auto';
}

function isAgyCodeAssistProvider(provider) {
  const value = toPlainText(provider || '').trim().toLowerCase();
  return value === 'agy' || value === 'antigravity';
}

function isClaudeModel(model) {
  const value = toPlainText(model || '').trim().toLowerCase();
  return value.includes('claude') || value.includes('anthropic');
}

function normalizeAnthropicCodeAssistModelId(model) {
  const value = toPlainText(model || '').trim();
  if (!value || !isClaudeModel(value)) return value;
  return normalizeModelVersionSeparators(value);
}

function shouldInjectAgyClaudeInterleavedThinkingHint(requestJson, provider, model, toolCount) {
  return isAgyCodeAssistProvider(provider)
    && Number(toolCount) > 0
    && isClaudeThinkingModel(model)
    && hasAnthropicThinkingEnabled(requestJson);
}

function appendAgyClaudeInterleavedThinkingHint(systemText, requestJson, provider, model, toolCount) {
  const text = toPlainText(systemText || '').trim();
  if (!shouldInjectAgyClaudeInterleavedThinkingHint(requestJson, provider, model, toolCount)) return text;
  if (text.includes('Interleaved thinking is enabled')) return text;
  return [text, AGY_CLAUDE_INTERLEAVED_THINKING_HINT].filter(Boolean).join('\n\n');
}

function readAnthropicContentText(content) {
  return normalizeAnthropicContentList(content)
    .map(readAnthropicTextPart)
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readLatestAnthropicUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (toPlainText(message && message.role || '').trim().toLowerCase() !== 'user') continue;
    const text = readAnthropicContentText(message && message.content);
    if (text) return text;
  }
  return '';
}

function containsClaudeGoalEvaluatorPrompt(text) {
  const value = toPlainText(text || '').trim();
  return value.startsWith(CLAUDE_GOAL_EVALUATOR_PREFIX)
    && value.includes('{"ok": true')
    && value.includes('{"ok": false')
    && value.includes(CLAUDE_GOAL_EVALUATOR_JSON_HINT);
}

function hasAnthropicTools(requestJson) {
  return Array.isArray(requestJson && requestJson.tools) && requestJson.tools.length > 0;
}

function resolveClaudeStopHookJsonResponsePolicy(requestJson) {
  if (!requestJson || typeof requestJson !== 'object') return null;
  if (hasAnthropicTools(requestJson)) return null;
  const latestUserText = readLatestAnthropicUserText(requestJson.messages);
  const systemText = normalizeAnthropicSystem(requestJson.system);
  if (!containsClaudeGoalEvaluatorPrompt(latestUserText) && !containsClaudeGoalEvaluatorPrompt(systemText)) {
    return null;
  }
  return {
    kind: 'claude_stop_hook_json_evaluator',
    output: 'json_object',
    fallbackReason: CLAUDE_GOAL_EVALUATOR_FALLBACK_REASON
  };
}

function isClaudeStopHookJsonResponsePolicy(policy) {
  return Boolean(policy && policy.kind === 'claude_stop_hook_json_evaluator');
}

function extractBalancedJsonObjectText(text) {
  const value = toPlainText(text || '');
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return '';
}

function normalizeClaudeStopHookJsonObject(candidate, fallbackReason = CLAUDE_GOAL_EVALUATOR_FALLBACK_REASON) {
  const parsed = parseJsonObject(candidate);
  if (!parsed || typeof parsed.ok !== 'boolean') {
    return JSON.stringify({ ok: false, reason: fallbackReason });
  }
  const reason = toPlainText(parsed.reason || '').trim() || (parsed.ok ? 'Goal evaluator returned ok.' : fallbackReason);
  return JSON.stringify({
    ok: parsed.ok,
    ...(!parsed.ok && parsed.impossible === true ? { impossible: true } : {}),
    reason
  });
}

function repairClaudeStopHookJsonResponseText(text, policy = null) {
  const fallbackReason = toPlainText(policy && policy.fallbackReason || CLAUDE_GOAL_EVALUATOR_FALLBACK_REASON).trim();
  const source = toPlainText(text || '').trim();
  if (!source) return { text: '', changed: false, reason: 'empty' };
  if (containsClaudeGoalEvaluatorPrompt(source)) {
    return {
      text: JSON.stringify({ ok: false, reason: fallbackReason }),
      changed: true,
      reason: 'replaced_prompt_echo'
    };
  }
  const direct = parseJsonObject(source);
  if (direct && typeof direct.ok === 'boolean') {
    const normalized = normalizeClaudeStopHookJsonObject(direct, fallbackReason);
    return { text: normalized, changed: normalized !== source, reason: 'normalized_json' };
  }
  const extracted = extractBalancedJsonObjectText(source);
  if (extracted) {
    const parsed = parseJsonObject(extracted);
    if (parsed && typeof parsed.ok === 'boolean') {
      return {
        text: normalizeClaudeStopHookJsonObject(parsed, fallbackReason),
        changed: true,
        reason: source.startsWith('```') ? 'stripped_markdown_fence' : 'extracted_json_object'
      };
    }
  }
  return {
    text: JSON.stringify({ ok: false, reason: fallbackReason }),
    changed: true,
    reason: 'replaced_invalid_text'
  };
}

function normalizeAnthropicContentList(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => (typeof part === 'string' ? { type: 'text', text: part } : part))
    .filter((part) => part && typeof part === 'object');
}

function collectAnthropicToolUseIds(messages) {
  const ids = [];
  const seen = new Set();
  const append = (id) => {
    const value = toPlainText(id || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    ids.push(value);
  };
  (Array.isArray(messages) ? messages : []).forEach((message) => {
    normalizeAnthropicContentList(message && message.content).forEach((part) => {
      const type = toPlainText(part && part.type || '').trim();
      if (type === 'tool_use') {
        append(part.id);
      } else if (type === 'tool_result') {
        append(part.tool_use_id || part.toolUseId);
      }
    });
  });
  return ids;
}

function decodeCodeAssistThoughtSignature(signature) {
  const value = toPlainText(signature || '').trim();
  if (!value || value[0] !== 'R') return value;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    return decoded[0] === 'E' ? decoded : value;
  } catch (_error) {
    return value;
  }
}

function encodeCodeAssistThoughtSignature(signature) {
  const value = toPlainText(signature || '').trim();
  if (!value) return '';
  const raw = value.includes('#') ? value.slice(value.indexOf('#') + 1).trim() : value;
  if (!raw || raw[0] === 'R') return raw;
  if (raw[0] !== 'E') return '';
  return Buffer.from(raw, 'utf8').toString('base64');
}

function normalizeAnthropicImagePart(part) {
  const source = part && part.source && typeof part.source === 'object' ? part.source : {};
  if (source.type === 'base64') {
    const data = toPlainText(source.data || '').trim();
    if (!data) return null;
    return {
      inlineData: {
        mimeType: toPlainText(source.media_type || 'application/octet-stream').trim() || 'application/octet-stream',
        data
      }
    };
  }
  if (source.type === 'url') {
    const url = toPlainText(source.url || '').trim();
    if (!url) return null;
    return { fileData: { fileUri: url, mimeType: toPlainText(source.media_type || '') } };
  }
  return null;
}

function parseToolInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  return parseJsonObject(input) || {};
}

function normalizeToolResultValue(content) {
  if (typeof content === 'string') return { result: content };
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object') {
      const imagePart = content.type === 'image' ? normalizeAnthropicImagePart(content) : null;
      if (imagePart) return { result: '', parts: [imagePart] };
      return { result: content };
    }
    return { result: '' };
  }

  const resultItems = [];
  const imageParts = [];
  content.forEach((part) => {
    if (typeof part === 'string') {
      resultItems.push(part);
      return;
    }
    if (!part || typeof part !== 'object') return;
    if (part.type === 'image') {
      const imagePart = normalizeAnthropicImagePart(part);
      if (imagePart) imageParts.push(imagePart);
      return;
    }
    if (part.type === 'text') {
      const text = toPlainText(part.text || '');
      if (text) resultItems.push(text);
      return;
    }
    resultItems.push(part);
  });

  let result = '';
  if (resultItems.length > 0 && resultItems.every((item) => typeof item === 'string')) {
    result = resultItems.join('\n');
  } else if (resultItems.length === 1) {
    result = resultItems[0];
  } else if (resultItems.length > 1) {
    result = resultItems;
  }
  return {
    result,
    ...(imageParts.length > 0 ? { parts: imageParts } : {})
  };
}

function createOrphanToolResultTextPart(part) {
  const textPart = createAnthropicOrphanToolResultTextPart(part);
  return { text: textPart.text };
}

function takePendingToolCallRef(pendingToolCalls, clientToolCallId, upstreamToolCallId) {
  if (!Array.isArray(pendingToolCalls) || pendingToolCalls.length === 0) return null;
  const clientId = toPlainText(clientToolCallId || '').trim();
  const upstreamId = toPlainText(upstreamToolCallId || '').trim();
  const index = pendingToolCalls.findIndex((call) => (
    call
    && !call.consumed
    && (
      (clientId && call.clientId === clientId)
      || (upstreamId && call.upstreamId === upstreamId)
    )
  ));
  if (index < 0) return null;
  pendingToolCalls[index].consumed = true;
  return pendingToolCalls[index];
}

function createFunctionResponsePart(part, pendingToolCalls, providerStrategy) {
  const clientToolCallId = toPlainText(part.tool_use_id || part.toolUseId || '').trim();
  if (!clientToolCallId) return { part: createOrphanToolResultTextPart(part), orphan: true };
  const toolCallId = decodeAnthropicToolUseId(clientToolCallId);
  const ref = takePendingToolCallRef(pendingToolCalls, clientToolCallId, toolCallId);
  if (!ref || !ref.name) return { part: createOrphanToolResultTextPart(part), orphan: true };
  const normalized = normalizeToolResultValue(part.content);
  const responseKey = toPlainText(providerStrategy && providerStrategy.toolResultResponseKey || 'result').trim() || 'result';
  return {
    part: {
      functionResponse: {
        ...(providerStrategy && providerStrategy.preserveToolCallId ? { id: ref.upstreamId || toolCallId } : {}),
        name: ref.name,
        response: { [responseKey]: normalized.result },
        ...(normalized.parts ? { parts: normalized.parts } : {})
      }
    },
    orphan: false
  };
}

function collectPendingToolCallRefs(parts, toolCalls, contentIndex) {
  const refs = Array.isArray(toolCalls) ? toolCalls : [];
  let callIndex = 0;
  return (Array.isArray(parts) ? parts : []).flatMap((part, partIndex) => {
    if (!part || typeof part !== 'object' || !part.functionCall) return [];
    const ref = refs[callIndex] || {};
    callIndex += 1;
    const functionCall = part.functionCall || {};
    const upstreamId = toPlainText(functionCall.id || ref.upstreamId || '').trim();
    return [{
      clientId: toPlainText(ref.clientId || upstreamId || '').trim(),
      upstreamId,
      name: toPlainText(functionCall.name || ref.name || '').trim(),
      contentIndex,
      partIndex,
      consumed: false
    }];
  });
}

function removeUnconsumedPendingFunctionCalls(contents, pendingToolCalls) {
  const groups = new Map();
  (Array.isArray(pendingToolCalls) ? pendingToolCalls : []).forEach((call) => {
    if (!call || call.consumed) return;
    const contentIndex = Number(call.contentIndex);
    const partIndex = Number(call.partIndex);
    if (!Number.isInteger(contentIndex) || !Number.isInteger(partIndex)) return;
    if (!groups.has(contentIndex)) groups.set(contentIndex, new Set());
    groups.get(contentIndex).add(partIndex);
  });
  let droppedCount = 0;
  Array.from(groups.keys()).sort((a, b) => b - a).forEach((contentIndex) => {
    const content = contents[contentIndex];
    if (!content || !Array.isArray(content.parts)) return;
    const partIndexes = groups.get(contentIndex);
    const nextParts = content.parts.filter((_part, partIndex) => !partIndexes.has(partIndex));
    droppedCount += content.parts.length - nextParts.length;
    if (nextParts.length > 0) {
      contents[contentIndex] = { ...content, parts: nextParts };
      return;
    }
    contents.splice(contentIndex, 1);
  });
  return droppedCount;
}

function createToolCallRef(clientId, upstreamId, name) {
  return {
    clientId: toPlainText(clientId || '').trim(),
    upstreamId: toPlainText(upstreamId || '').trim(),
    name: toPlainText(name || '').trim()
  };
}

function createFunctionCallPart(part, providerStrategy, toolNameCodec, currentThinkingSignature) {
  const originalName = toPlainText(part.name || '').trim();
  const upstreamName = toolNameCodec && typeof toolNameCodec.toUpstream === 'function'
    ? toolNameCodec.toUpstream(originalName)
    : originalName;
  if (!upstreamName) return null;
  const clientId = toPlainText(part.id || '').trim();
  const upstreamId = decodeAnthropicToolUseId(clientId);
  const toolPart = {
    functionCall: {
      name: upstreamName,
      args: parseToolInput(part.input)
    }
  };
  if (providerStrategy && providerStrategy.addToolCallThoughtSignature) {
    toolPart.thoughtSignature = currentThinkingSignature || CODE_ASSIST_SKIP_THOUGHT_SIGNATURE;
  }
  if (providerStrategy && providerStrategy.preserveToolCallId && upstreamId) {
    toolPart.functionCall.id = upstreamId;
  }
  return {
    part: toolPart,
    ref: createToolCallRef(clientId, upstreamId, upstreamName)
  };
}

function createNormalizedMessageState(role, parts, droppedUnsignedThinkingCount, toolCalls, orphanToolResultCount) {
  return {
    role,
    parts: role === 'model' ? reorderModelParts(parts) : parts,
    droppedUnsignedThinkingCount,
    toolCalls,
    orphanToolResultCount
  };
}

function normalizeAnthropicMessageParts(message, pendingToolCalls, providerStrategy, toolNameCodec) {
  const rawRole = String(message && message.role || '').trim().toLowerCase();
  const role = rawRole === 'assistant' ? 'model' : 'user';
  const parts = [];
  const toolCalls = [];
  let currentThinkingSignature = '';
  let droppedUnsignedThinkingCount = 0;
  let orphanToolResultCount = 0;

  normalizeAnthropicContentList(message && message.content).forEach((part) => {
    const type = toPlainText(part.type || '').trim();
    if (type === 'text') {
      const text = toPlainText(part.text || '');
      if (text) parts.push({ text });
      return;
    }
    if (type === 'thinking') {
      const thinking = toPlainText(part.thinking || part.text || '');
      const signature = encodeCodeAssistThoughtSignature(part.signature || '');
      if (!thinking) return;
      if (!signature) {
        droppedUnsignedThinkingCount += 1;
        return;
      }
      currentThinkingSignature = signature;
      parts.push({ thought: true, text: thinking, thoughtSignature: signature });
      return;
    }
    if (type === 'image') {
      const image = normalizeAnthropicImagePart(part);
      if (image) parts.push(image);
      return;
    }
    if (type === 'tool_use') {
      const normalized = createFunctionCallPart(part, providerStrategy, toolNameCodec, currentThinkingSignature);
      if (!normalized) return;
      toolCalls.push(normalized.ref);
      parts.push(normalized.part);
      return;
    }
    if (type === 'tool_result') {
      const normalized = createFunctionResponsePart(part, pendingToolCalls, providerStrategy);
      if (normalized && normalized.part) parts.push(normalized.part);
      if (normalized && normalized.orphan) orphanToolResultCount += 1;
    }
  });

  return createNormalizedMessageState(
    role,
    parts,
    droppedUnsignedThinkingCount,
    toolCalls,
    orphanToolResultCount
  );
}

function reorderModelParts(parts) {
  const thinking = [];
  const regular = [];
  const calls = [];
  // AGY splits model contents at functionCall boundaries; keep calls last so Claude sees immediate tool_result pairs.
  parts.forEach((part) => {
    if (!part || typeof part !== 'object') return;
    if (part.thought === true) {
      thinking.push(part);
      return;
    }
    if (part.functionCall) {
      calls.push(part);
      return;
    }
    regular.push(part);
  });
  return [...thinking, ...regular, ...calls];
}

function hasCodeAssistFunctionCallPart(part) {
  return Boolean(part && typeof part === 'object' && part.functionCall);
}

function removeTrailingUnansweredCodeAssistFunctionCallTurn(contents) {
  const list = Array.isArray(contents) ? contents : [];
  const last = list[list.length - 1];
  if (!last || last.role !== 'model' || !Array.isArray(last.parts)) {
    return { contents: list, dropped: 0 };
  }
  if (!last.parts.some(hasCodeAssistFunctionCallPart)) {
    return { contents: list, dropped: 0 };
  }
  const parts = last.parts.filter((part) => !hasCodeAssistFunctionCallPart(part));
  if (parts.length > 0) {
    return {
      contents: [
        ...list.slice(0, -1),
        { ...last, parts }
      ],
      dropped: 1
    };
  }
  return {
    contents: list.slice(0, -1),
    dropped: 1
  };
}

function normalizeAnthropicMessagesForCodeAssist(messages, systemText, providerStrategy = resolveCodeAssistProviderStrategy('agy'), toolNameCodec = createToolNameCodec([]), options = {}) {
  const sanitized = sanitizeAnthropicToolHistoryWithStats(messages, {
    dropTrailingUnansweredToolUses: false
  });
  const contents = [];
  let pendingToolCalls = [];
  let droppedUnsignedThinkingCount = 0;
  let droppedUnansweredFunctionCallCount = Number(sanitized.stats.droppedUnansweredToolUseCount || 0);
  let orphanToolResultCount = Number(sanitized.stats.orphanToolResultCount || 0);
  (Array.isArray(sanitized.messages) ? sanitized.messages : []).forEach((message) => {
    if (!message || typeof message !== 'object') return;
    const normalized = normalizeAnthropicMessageParts(message, pendingToolCalls, providerStrategy, toolNameCodec);
    droppedUnsignedThinkingCount += Number(normalized.droppedUnsignedThinkingCount || 0);
    orphanToolResultCount += Number(normalized.orphanToolResultCount || 0);
    if (normalized.role === 'model') {
      droppedUnansweredFunctionCallCount += removeUnconsumedPendingFunctionCalls(contents, pendingToolCalls);
      pendingToolCalls = [];
      if (normalized.parts.length === 0) return;
      const contentIndex = contents.length;
      contents.push({
        role: normalized.role,
        parts: normalized.parts
      });
      pendingToolCalls = collectPendingToolCallRefs(normalized.parts, normalized.toolCalls, contentIndex);
      return;
    }

    if (normalized.parts.length > 0) {
      contents.push({
        role: normalized.role,
        parts: normalized.parts
      });
    }
    droppedUnansweredFunctionCallCount += removeUnconsumedPendingFunctionCalls(contents, pendingToolCalls);
    pendingToolCalls = [];
  });

  const pruned = options && options.dropTrailingUnansweredFunctionCalls === true
    ? removeTrailingUnansweredCodeAssistFunctionCallTurn(contents)
    : { contents, dropped: 0 };
  droppedUnansweredFunctionCallCount += Number(pruned.dropped || 0);
  const systemInstruction = systemText
    ? { role: 'user', parts: [{ text: systemText }] }
    : undefined;
  if (pruned.contents.length === 0 && systemText) {
    return {
      contents: [{ role: 'user', parts: [{ text: systemText }] }],
      systemInstruction: undefined,
      droppedUnsignedThinkingCount,
      droppedTrailingUnansweredFunctionCallTurn: pruned.dropped,
      droppedUnansweredToolUseCount: Number(sanitized.stats.droppedUnansweredToolUseCount || 0),
      droppedUnansweredFunctionCallCount,
      orphanToolResultCount
    };
  }
  return {
    contents: pruned.contents,
    systemInstruction,
    droppedUnsignedThinkingCount,
    droppedTrailingUnansweredFunctionCallTurn: pruned.dropped,
    droppedUnansweredToolUseCount: Number(sanitized.stats.droppedUnansweredToolUseCount || 0),
    droppedUnansweredFunctionCallCount,
    orphanToolResultCount
  };
}

function createToolNameSet(names) {
  const set = new Set();
  (Array.isArray(names) ? names : []).forEach((name) => {
    const value = toPlainText(name || '').trim();
    if (value) set.add(value);
  });
  return set;
}

function normalizeAnthropicToolsForCodeAssist(tools, schemaKey, toolNameCodec = createToolNameCodec(tools), options = {}) {
  const excludedNames = createToolNameSet(options.excludedToolNames);
  const omittedToolNames = Array.isArray(options.omittedToolNames) ? options.omittedToolNames : null;
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const descriptor = readAnthropicToolDescriptor(tool);
      if (!descriptor) return null;
      const name = toolNameCodec && typeof toolNameCodec.toUpstream === 'function'
        ? toolNameCodec.toUpstream(descriptor.name)
        : descriptor.name;
      if (!name) return null;
      if (excludedNames.has(descriptor.name) || excludedNames.has(name)) {
        if (omittedToolNames) omittedToolNames.push(name);
        return null;
      }
      return {
        name,
        description: descriptor.description,
        [schemaKey]: sanitizeSchemaForGemini(descriptor.inputSchema)
      };
    })
    .filter(Boolean);
}

function resolveAnthropicToolDeclarationSchemaKey(providerStrategy) {
  return toPlainText(
    providerStrategy && providerStrategy.anthropicToolDeclarationSchemaKey
    || providerStrategy && providerStrategy.toolDeclarationSchemaKey
    || 'parametersJsonSchema'
  ).trim() || 'parametersJsonSchema';
}

function normalizeAnthropicToolChoiceForCodeAssist(toolChoice, toolNameCodec = createToolNameCodec([])) {
  return mapAnthropicToolChoiceToGemini(toolChoice, {
    mapName: (name) => toolNameCodec && typeof toolNameCodec.toUpstream === 'function'
      ? toolNameCodec.toUpstream(name)
      : toPlainText(name || '').trim()
  });
}

function filterToolConfigAllowedNames(toolConfig, availableNames) {
  const config = toolConfig && toolConfig.functionCallingConfig && typeof toolConfig.functionCallingConfig === 'object'
    ? toolConfig.functionCallingConfig
    : null;
  if (!config || !Array.isArray(config.allowedFunctionNames)) return toolConfig;

  const availableSet = createToolNameSet(availableNames);
  const filteredNames = config.allowedFunctionNames
    .map((name) => toPlainText(name || '').trim())
    .filter((name) => name && availableSet.has(name));
  if (filteredNames.length === config.allowedFunctionNames.length) return toolConfig;

  const nextConfig = { ...config };
  if (filteredNames.length > 0) {
    nextConfig.allowedFunctionNames = filteredNames;
  } else {
    delete nextConfig.allowedFunctionNames;
    if (readToolConfigMode(toolConfig) === 'ANY') nextConfig.mode = 'AUTO';
  }

  return {
    ...(toolConfig && typeof toolConfig === 'object' ? toolConfig : {}),
    functionCallingConfig: nextConfig
  };
}

function readToolConfigMode(toolConfig) {
  const config = toolConfig && toolConfig.functionCallingConfig && typeof toolConfig.functionCallingConfig === 'object'
    ? toolConfig.functionCallingConfig
    : null;
  return toPlainText(config && config.mode || '').trim().toUpperCase();
}

function shouldUseValidatedClaudeToolMode(toolConfig, providerStrategy, model) {
  if (!providerStrategy || providerStrategy.validateClaudeToolCalls !== true) return false;
  if (!isClaudeModel(model)) return false;
  const mode = readToolConfigMode(toolConfig);
  return mode !== 'NONE';
}

function readAnthropicToolModeOverride(providerStrategy, model) {
  if (!providerStrategy || !isClaudeModel(model)) return '';
  return toPlainText(providerStrategy.anthropicToolModeOverride || '').trim().toUpperCase();
}

function applyToolModeOverride(toolConfig, mode) {
  const baseConfig = toolConfig && toolConfig.functionCallingConfig && typeof toolConfig.functionCallingConfig === 'object'
    ? toolConfig.functionCallingConfig
    : {};
  return {
    ...(toolConfig && typeof toolConfig === 'object' ? toolConfig : {}),
    functionCallingConfig: {
      ...baseConfig,
      mode
    }
  };
}

function applyCodeAssistToolConfigStrategy(toolConfig, providerStrategy, model) {
  const overrideMode = readAnthropicToolModeOverride(providerStrategy, model);
  if (overrideMode && readToolConfigMode(toolConfig) !== 'NONE') {
    return applyToolModeOverride(toolConfig, overrideMode);
  }
  if (!shouldUseValidatedClaudeToolMode(toolConfig, providerStrategy, model)) return toolConfig;
  return applyToolModeOverride(toolConfig, 'VALIDATED');
}

function summarizeToolConfig(toolConfig) {
  const config = toolConfig && toolConfig.functionCallingConfig && typeof toolConfig.functionCallingConfig === 'object'
    ? toolConfig.functionCallingConfig
    : null;
  if (!config) return {};
  const mode = readToolConfigMode(toolConfig);
  const allowedFunctionNames = Array.isArray(config.allowedFunctionNames)
    ? config.allowedFunctionNames.map((name) => toPlainText(name).trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    ...(mode ? { toolConfigMode: mode } : {}),
    ...(allowedFunctionNames.length > 0 ? { allowedFunctionNames } : {})
  };
}

function readAnthropicThinkingEffort(requestJson) {
  const effort = toPlainText(
    requestJson
    && requestJson.output_config
    && requestJson.output_config.effort
    || ''
  ).trim().toLowerCase();
  return effort || '';
}

function applyAnthropicThinkingConfig(generationConfig, requestJson, options = {}) {
  if (options.disableThinkingConfig) {
    delete generationConfig.thinkingConfig;
    return generationConfig;
  }
  const thinking = requestJson && requestJson.thinking && typeof requestJson.thinking === 'object'
    ? requestJson.thinking
    : null;
  if (!thinking) {
    delete generationConfig.thinkingConfig;
    return generationConfig;
  }

  const type = toPlainText(thinking.type || '').trim().toLowerCase();
  if (type === 'enabled') {
    const budget = Number(thinking.budget_tokens);
    const thinkingConfig = { ...(generationConfig.thinkingConfig || {}) };
    if (Number.isFinite(budget)) {
      delete thinkingConfig.thinkingLevel;
    }
    generationConfig.thinkingConfig = {
      ...thinkingConfig,
      includeThoughts: true,
      ...(Number.isFinite(budget) ? { thinkingBudget: Math.round(budget) } : {})
    };
    return generationConfig;
  }

  if (type === 'adaptive' || type === 'auto') {
    const thinkingConfig = { ...(generationConfig.thinkingConfig || {}) };
    delete thinkingConfig.thinkingBudget;
    delete thinkingConfig.thinkingLevel;
    const adaptiveThinkingConfig = resolveCodeAssistAdaptiveThinkingConfig(options.providerStrategy, {
      effort: readAnthropicThinkingEffort(requestJson)
    });
    generationConfig.thinkingConfig = {
      ...thinkingConfig,
      ...adaptiveThinkingConfig
    };
  }
  return generationConfig;
}

function applyAnthropicGenerationConfig(generationConfig, requestJson, options = {}) {
  const maxTokens = Number(requestJson && requestJson.max_tokens);
  const temperature = Number(requestJson && requestJson.temperature);
  const topP = Number(requestJson && requestJson.top_p);
  const topK = Number(requestJson && requestJson.top_k);
  if (Number.isFinite(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = Math.round(maxTokens);
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  if (Number.isFinite(topK)) generationConfig.topK = topK;
  if (Array.isArray(requestJson && requestJson.stop_sequences) && requestJson.stop_sequences.length > 0) {
    generationConfig.stopSequences = requestJson.stop_sequences.map((item) => toPlainText(item).trim()).filter(Boolean);
  }
  return applyAnthropicThinkingConfig(generationConfig, requestJson, options);
}

function summarizeAnthropicToolHistory(messages, requiredByName, toolNameCodec = createToolNameCodec([])) {
  const toolUseInputs = [];
  let toolUseCount = 0;
  let toolResultCount = 0;
  (Array.isArray(messages) ? messages : []).forEach((message) => {
    normalizeAnthropicContentList(message && message.content).forEach((part) => {
      const type = toPlainText(part && part.type || '').trim();
      if (type === 'tool_use') {
        toolUseCount += 1;
        const name = toPlainText(part.name || '').trim();
        const upstreamName = toolNameCodec && typeof toolNameCodec.toUpstream === 'function'
          ? toolNameCodec.toUpstream(name)
          : name;
        const input = parseToolInput(part.input);
        const inputKeys = Object.keys(input);
        const required = Array.isArray(requiredByName && requiredByName.get(upstreamName))
          ? requiredByName.get(upstreamName)
          : [];
        toolUseInputs.push({
          id: toPlainText(part.id || '').trim(),
          name,
          ...(upstreamName && upstreamName !== name ? { upstreamName } : {}),
          inputKeys,
          missingRequired: required.filter((key) => !Object.prototype.hasOwnProperty.call(input, key))
        });
        return;
      }
      if (type === 'tool_result') toolResultCount += 1;
    });
  });
  return {
    toolUseCount,
    toolResultCount,
    toolUseInputs: toolUseInputs.slice(0, 20)
  };
}

function summarizeThinkingConfig(generationConfig) {
  const thinkingConfig = generationConfig && generationConfig.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== 'object') {
    return {
      thinkingConfigMode: 'none',
      thinkingConfigKeys: []
    };
  }

  const keys = Object.keys(thinkingConfig).sort();
  const hasBudget = hasOwnProperty(thinkingConfig, 'thinkingBudget');
  const hasLevel = hasOwnProperty(thinkingConfig, 'thinkingLevel');
  const mode = hasBudget ? 'budget' : (hasLevel ? 'level' : 'include_only');
  return {
    thinkingConfigMode: mode,
    thinkingConfigKeys: keys,
    includeThoughts: Boolean(thinkingConfig.includeThoughts),
    ...(hasBudget ? { thinkingBudget: thinkingConfig.thinkingBudget } : {}),
    ...(hasLevel ? { thinkingLevel: thinkingConfig.thinkingLevel } : {})
  };
}

function summarizeAnthropicRequest(requestJson, normalized, functionDeclarations, schemaKey, toolNameCodec, generationConfig, options = {}) {
  const roleCounts = {};
  (Array.isArray(requestJson && requestJson.messages) ? requestJson.messages : []).forEach((message) => {
    const role = toPlainText(message && message.role || 'unknown').trim() || 'unknown';
    roleCounts[role] = Number(roleCounts[role] || 0) + 1;
  });
  const omittedToolNames = Array.isArray(options.omittedToolNames)
    ? options.omittedToolNames.map((name) => toPlainText(name).trim()).filter(Boolean)
    : [];
  const requiredByName = createRequiredToolLookup(functionDeclarations, schemaKey);
  const toolHistory = summarizeAnthropicToolHistory(requestJson && requestJson.messages, requiredByName, toolNameCodec);
  return {
    messageCount: Array.isArray(requestJson && requestJson.messages) ? requestJson.messages.length : 0,
    roleCounts,
    contentCount: normalized.contents.length,
    systemInstruction: Boolean(normalized.systemInstruction),
    generationConfigKeys: generationConfig && typeof generationConfig === 'object'
      ? Object.keys(generationConfig).sort()
      : [],
    ...(Array.isArray(options.omittedGenerationConfigKeys) && options.omittedGenerationConfigKeys.length > 0
      ? { omittedGenerationConfigKeys: options.omittedGenerationConfigKeys.slice().sort() }
      : {}),
    toolDeclarationCount: functionDeclarations.length,
    toolDeclarationSchemaKey: schemaKey,
    toolNames: functionDeclarations.map((item) => item.name).slice(0, 20),
    ...(omittedToolNames.length > 0 ? { omittedToolNames: omittedToolNames.slice(0, 20) } : {}),
    droppedUnsignedThinkingCount: Number(normalized.droppedUnsignedThinkingCount || 0),
    droppedTrailingUnansweredFunctionCallTurn: Number(normalized.droppedTrailingUnansweredFunctionCallTurn || 0),
    droppedUnansweredToolUseCount: Number(normalized.droppedUnansweredToolUseCount || 0),
    droppedUnansweredFunctionCallCount: Number(normalized.droppedUnansweredFunctionCallCount || 0),
    orphanToolResultCount: Number(normalized.orphanToolResultCount || 0),
    ...summarizeThinkingConfig(generationConfig),
    ...summarizeToolConfig(options.toolConfig),
    ...toolHistory
  };
}

function normalizeProviderProtocolRoute(route) {
  if (!route || typeof route !== 'object') return {};
  const clientProtocol = toPlainText(route.clientProtocol || '').trim();
  const upstreamProtocol = toPlainText(route.upstreamProtocol || '').trim();
  const requestAdapter = toPlainText(route.requestAdapter || '').trim();
  const responseAdapter = toPlainText(route.responseAdapter || '').trim();
  return {
    ...(clientProtocol ? { clientProtocol } : {}),
    ...(upstreamProtocol ? { upstreamProtocol } : {}),
    ...(requestAdapter ? { requestAdapter } : {}),
    ...(responseAdapter ? { responseAdapter } : {})
  };
}

function normalizeProtocolAdapterPath(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => toPlainText(item || '').trim())
    .filter(Boolean);
}

function createCodeAssistAgentRequestId() {
  return `agent/${Date.now()}/${crypto.randomBytes(4).toString('hex')}`;
}

function resolveCodeAssistCreditFields(providerStrategy, creditDecision) {
  const field = toPlainText(providerStrategy && providerStrategy.creditTypesField || 'enabled_credit_types').trim()
    || 'enabled_credit_types';
  const shouldInclude = Boolean(
    creditDecision && creditDecision.enabled
    || providerStrategy && providerStrategy.alwaysSendAgentCreditTypes
  );
  return {
    field,
    values: shouldInclude ? [G1_CREDIT_TYPE] : [],
    forced: Boolean(
      providerStrategy
      && providerStrategy.alwaysSendAgentCreditTypes
      && !(creditDecision && creditDecision.enabled)
    )
  };
}

function buildCodeAssistAnthropicInnerRequest(normalized, generationConfig, functionDeclarations, toolConfig, sessionState, providerStrategy) {
  const sessionIdField = toPlainText(providerStrategy && providerStrategy.requestSessionIdField || 'session_id').trim()
    || 'session_id';
  return {
    contents: normalized.contents,
    systemInstruction: normalized.systemInstruction,
    generationConfig,
    tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    toolConfig,
    [sessionIdField]: sessionState.sessionId
  };
}

function buildCodeAssistAnthropicPayload(providerStrategy, model, project, request, sessionState, creditFields) {
  const envelope = toPlainText(providerStrategy && providerStrategy.requestEnvelope || 'gemini_cli').trim()
    || 'gemini_cli';
  if (envelope === 'antigravity_agent') {
    return {
      project,
      requestId: createCodeAssistAgentRequestId(),
      request,
      model,
      userAgent: 'antigravity',
      requestType: 'agent',
      ...(creditFields.values.length > 0 ? { [creditFields.field]: creditFields.values } : {})
    };
  }
  return {
    model,
    project,
    user_prompt_id: sessionState.userPromptId,
    ...(creditFields.values.length > 0 ? { [creditFields.field]: creditFields.values } : {}),
    request
  };
}

function buildCodeAssistAnthropicHeaderOptions(providerStrategy, project, model, originalModel) {
  const isClaude = isClaudeModel(model) || isClaudeModel(originalModel);
  return {
    clientProfile: providerStrategy && providerStrategy.clientProfile,
    project,
    injectProjectHeader: Boolean(providerStrategy && providerStrategy.injectProjectHeader),
    anthropicBetaHeader: isClaude ? toPlainText(providerStrategy && providerStrategy.anthropicBetaHeader || '').trim() : ''
  };
}

function summarizeCodeAssistHeaders(headers) {
  return {
    clientName: headers && headers['x-client-name'] || '',
    clientVersion: headers && headers['x-client-version'] || '',
    projectHeader: Boolean(headers && headers['x-goog-user-project']),
    anthropicBetaHeader: headers && headers['anthropic-beta'] || ''
  };
}

async function fetchCodeAssistAnthropicUpstream(url, headers, payload, timeoutMs, options = {}) {
  const proxyOptions = {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  };
  const body = JSON.stringify(payload);
  let res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body
  }, timeoutMs, proxyOptions);
  if (res && res.status === 403 && headers && headers['x-goog-user-project']) {
    const retryHeaders = { ...headers };
    delete retryHeaders['x-goog-user-project'];
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: retryHeaders,
      body
    }, timeoutMs, proxyOptions);
    return {
      res,
      retriedWithoutProjectHeader: true
    };
  }
  return {
    res,
    retriedWithoutProjectHeader: false
  };
}

function shouldForceStreamForBufferedAnthropic(providerStrategy, model, originalModel, options = {}) {
  const routeProtocol = normalizeProviderProtocolRoute(options && options.providerProtocolRoute);
  const isAnthropicDirect = routeProtocol.clientProtocol === 'anthropic_messages'
    || toPlainText(options && options.clientProtocol || '').trim() === 'anthropic_messages'
    || options && options.forceStreamForBufferedAnthropic === true;
  return Boolean(providerStrategy && providerStrategy.forceStreamForBufferedAnthropic)
    && isAnthropicDirect
    && (isClaudeModel(model) || isClaudeModel(originalModel));
}

async function buildCodeAssistAnthropicGenerateContext(options, account, requestJson, timeoutMs = 8000) {
  const project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  if (!project) throw new Error('gemini_code_assist_project_unavailable');

  const provider = String(account && account.provider || options && options.provider || '').trim().toLowerCase();
  const routeProtocol = normalizeProviderProtocolRoute(options && options.providerProtocolRoute);
  const providerStrategy = resolveCodeAssistProviderStrategy(provider);
  const toolNameCodec = createToolNameCodec(requestJson && requestJson.tools);
  const responsePolicy = resolveClaudeStopHookJsonResponsePolicy(requestJson || {});
  const originalModel = toPlainText(requestJson && requestJson.model).trim()
    || await resolveCodeAssistDefaultModel(options || {}, account, timeoutMs);
  const reservedClientToolUseIds = collectAnthropicToolUseIds(requestJson && requestJson.messages);
  const modelResolution = await resolveCodeAssistRequestModel(
    options || {},
    account,
    originalModel,
    timeoutMs
  );
  const model = normalizeAnthropicCodeAssistModelId(modelResolution.wireModel || originalModel);
  const publicModel = normalizeAnthropicCodeAssistModelId(modelResolution.publicModel || model);
  const schemaKey = resolveAnthropicToolDeclarationSchemaKey(providerStrategy);
  const omittedToolNames = [];
  const excludedToolNames = isClaudeModel(model)
    ? providerStrategy && providerStrategy.anthropicExcludedToolNames
    : [];
  const functionDeclarations = normalizeAnthropicToolsForCodeAssist(
    requestJson && requestJson.tools,
    schemaKey,
    toolNameCodec,
    { excludedToolNames, omittedToolNames }
  );
  const systemText = appendAgyClaudeInterleavedThinkingHint(
    normalizeAnthropicSystem(requestJson && requestJson.system),
    requestJson || {},
    provider,
    originalModel,
    functionDeclarations.length
  );
  const normalized = normalizeAnthropicMessagesForCodeAssist(
    requestJson && requestJson.messages,
    systemText,
    providerStrategy,
    toolNameCodec,
    { dropTrailingUnansweredFunctionCalls: true }
  );
  const generationConfig = applyCodeAssistGenerationConfigStrategy(
    applyAnthropicGenerationConfig(
      buildDefaultGeminiCodeAssistGenerationConfig(model),
      requestJson || {},
      {
        disableThinkingConfig: normalized.droppedUnsignedThinkingCount > 0,
        providerStrategy
      }
    ),
    providerStrategy,
    { model, originalModel }
  );
  const omittedGenerationConfigKeys = listCodeAssistUnsupportedGenerationConfigKeys(
    providerStrategy,
    { model, originalModel }
  );
  const generationConfigCapabilityRules = listCodeAssistGenerationConfigCapabilityRules(
    providerStrategy,
    { model, originalModel }
  );
  const rawToolConfig = functionDeclarations.length > 0
    ? filterToolConfigAllowedNames(
      normalizeAnthropicToolChoiceForCodeAssist(requestJson && requestJson.tool_choice, toolNameCodec),
      functionDeclarations.map((item) => item.name)
    )
    : undefined;
  const toolConfig = functionDeclarations.length > 0
    ? applyCodeAssistToolConfigStrategy(rawToolConfig, providerStrategy, originalModel)
    : undefined;
  const sessionState = buildGeminiCodeAssistSessionState(options || {}, account, requestJson || {});
  const creditDecision = shouldEnableGeminiCodeAssistCredits(model, account, options || {});
  const request = buildCodeAssistAnthropicInnerRequest(
    normalized,
    generationConfig,
    functionDeclarations,
    toolConfig,
    sessionState,
    providerStrategy
  );
  const creditFields = resolveCodeAssistCreditFields(providerStrategy, creditDecision);
  const payload = buildCodeAssistAnthropicPayload(providerStrategy, model, project, request, sessionState, creditFields);
  const diagnostic = {
    model,
    project,
    requestId: payload.requestId || '',
    requestType: payload.requestType || '',
    requestEnvelope: providerStrategy.requestEnvelope || 'gemini_cli',
    sessionId: sessionState.sessionId,
    userPromptId: sessionState.userPromptId,
    sessionSource: sessionState.source,
    sessionReused: sessionState.reused,
    promptCount: sessionState.promptCount,
    externalSessionKeyHash: sessionState.externalKeyHash,
    creditsEnabled: creditDecision.enabled,
    creditBalance: creditDecision.balance,
    creditDecisionReason: creditDecision.reason,
    creditTypesIncluded: creditFields.values.length > 0,
    creditTypesField: creditFields.field,
    creditTypesForced: creditFields.forced,
    provider,
    forceStreamForBuffered: shouldForceStreamForBufferedAnthropic(providerStrategy, model, originalModel, options || {}),
    publicModel,
    wireModel: model,
    clientProtocol: routeProtocol.clientProtocol || 'anthropic_messages',
    sourceClientProtocol: toPlainText(
      options && options.sourceClientProtocol
      || routeProtocol.clientProtocol
      || 'anthropic_messages'
    ).trim(),
    protocolAdapterPath: normalizeProtocolAdapterPath(options && options.protocolAdapterPath),
    ...(options && options.providerProtocolPlan ? { providerProtocolPlan: options.providerProtocolPlan } : {}),
    requestProtocol: `${routeProtocol.clientProtocol || 'anthropic_messages'}_direct`,
    upstreamProtocol: routeProtocol.upstreamProtocol || 'gemini_code_assist_generate_content',
    requestAdapter: routeProtocol.requestAdapter || CLAUDE_TO_AGY_ADAPTER,
    responseAdapter: routeProtocol.responseAdapter || AGY_TO_CLAUDE_ADAPTER,
    ...(omittedGenerationConfigKeys.length > 0 ? { omittedGenerationConfigKeys } : {}),
    ...(generationConfigCapabilityRules.length > 0 ? { generationConfigCapabilityRules } : {}),
    ...(responsePolicy ? { responsePolicy: { kind: responsePolicy.kind, output: responsePolicy.output } } : {}),
    requestSummary: summarizeAnthropicRequest(
      requestJson || {},
      normalized,
      functionDeclarations,
      schemaKey,
      toolNameCodec,
      generationConfig,
      { omittedGenerationConfigKeys, omittedToolNames, toolConfig }
    )
  };
  const toolProtocolDiagnosticContext = createToolProtocolDiagnosticContext(options || {}, account, diagnostic);
  return { model, originalModel, project, payload, diagnostic, providerStrategy, toolNameCodec, functionDeclarations, schemaKey, reservedClientToolUseIds, responsePolicy, toolProtocolDiagnosticContext };
}

function mapGeminiFinishReasonToAnthropic(reason, hasToolCalls) {
  const value = toPlainText(reason || '').trim().toUpperCase();
  if (hasToolCalls) return 'tool_use';
  if (value === 'MAX_TOKENS') return 'max_tokens';
  return resolveAnthropicStopReason('end_turn');
}

function stringifyFunctionCallArgs(functionCall) {
  const args = functionCall && functionCall.args;
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args && typeof args === 'object' ? args : {});
  } catch (_error) {
    return '{}';
  }
}

function createToolProtocolDiagnosticContext(options, account, diagnostic) {
  const source = options || {};
  const enabled = source.toolProtocolDiagnostics === true
    || typeof source.appendToolProtocolDiagnostic === 'function'
    || Boolean(source.toolProtocolDiagnosticFile);
  if (!enabled) return null;
  const responseAdapter = toPlainText(diagnostic && diagnostic.responseAdapter || AGY_TO_CLAUDE_ADAPTER).trim();
  const protocolAdapterPath = normalizeProtocolAdapterPath(diagnostic && diagnostic.protocolAdapterPath);
  return {
    fs: source.fs,
    path: source.path,
    env: source.env,
    os: source.os,
    aiHomeDir: source.aiHomeDir,
    toolProtocolDiagnosticFile: source.toolProtocolDiagnosticFile,
    appendToolProtocolDiagnostic: source.appendToolProtocolDiagnostic,
    writeToolProtocolDiagnosticFile: source.writeToolProtocolDiagnosticFile,
    requestId: toPlainText(diagnostic && diagnostic.requestId || '').trim(),
    provider: toPlainText(diagnostic && diagnostic.provider || account && account.provider || source.provider || '').trim(),
    accountId: toPlainText(account && account.id || '').trim(),
    model: toPlainText(
      diagnostic && (diagnostic.publicModel || diagnostic.wireModel || diagnostic.model)
      || ''
    ).trim(),
    sourceProtocol: toPlainText(diagnostic && diagnostic.upstreamProtocol || 'gemini_code_assist_generate_content').trim(),
    targetProtocol: toPlainText(diagnostic && diagnostic.clientProtocol || 'anthropic_messages').trim(),
    adapterPath: [...protocolAdapterPath, responseAdapter].filter(Boolean)
  };
}

function appendToolProtocolInputDiagnostic(context, evaluation, details = {}) {
  if (!context || !evaluation || !['normalized', 'rejected'].includes(evaluation.action)) return;
  appendToolProtocolDiagnostic({
    requestId: context.requestId,
    provider: context.provider,
    accountId: context.accountId,
    model: context.model,
    sourceProtocol: context.sourceProtocol,
    targetProtocol: context.targetProtocol,
    adapterPath: context.adapterPath,
    toolName: details.toolName,
    upstreamToolName: details.upstreamToolName,
    action: evaluation.action,
    reason: evaluation.reason,
    argKeys: evaluation.argKeys,
    requiredKeys: evaluation.requiredKeys,
    normalizedKeys: evaluation.normalizedKeys,
    missingKeys: evaluation.missingKeys,
    unexpectedKeys: evaluation.unexpectedKeys,
    removedKeys: evaluation.removedKeys,
    rawArgs: details.rawArgs
  }, context);
}

function appendToolProtocolRejectedDiagnostic(context, details = {}) {
  if (!context) return;
  appendToolProtocolDiagnostic({
    requestId: context.requestId,
    provider: context.provider,
    accountId: context.accountId,
    model: context.model,
    sourceProtocol: context.sourceProtocol,
    targetProtocol: context.targetProtocol,
    adapterPath: context.adapterPath,
    toolName: details.toolName,
    upstreamToolName: details.upstreamToolName,
    action: 'rejected',
    reason: details.reason,
    argKeys: details.argKeys,
    requiredKeys: details.requiredKeys,
    normalizedKeys: [],
    missingKeys: details.missingKeys,
    unexpectedKeys: details.unexpectedKeys,
    removedKeys: [],
    rawArgs: details.rawArgs
  }, context);
}

function isCompleteJsonObjectText(text) {
  return Boolean(parseJsonObject(text));
}

function appendCodeAssistStreamDiagnostic(state, diagnostic) {
  if (!state || !diagnostic || typeof diagnostic !== 'object') return;
  if (!Array.isArray(state.streamToolDiagnostics)) state.streamToolDiagnostics = [];
  state.streamToolDiagnostics.push(diagnostic);
  if (state.streamToolDiagnostics.length > 20) {
    state.streamToolDiagnostics.splice(0, state.streamToolDiagnostics.length - 20);
  }
}

function flushCodeAssistStreamDiagnostics(options, state) {
  if (!state || !Array.isArray(state.streamToolDiagnostics) || state.streamToolDiagnostics.length === 0) return;
  const streamToolDiagnostics = state.streamToolDiagnostics.splice(0, state.streamToolDiagnostics.length);
  appendGeminiCodeAssistDiagnostic(options || {}, { streamToolDiagnostics });
}

function readStreamFunctionCallArgs(functionCall) {
  if (!functionCall || typeof functionCall !== 'object' || !hasOwnProperty(functionCall, 'args')) {
    return { present: false, text: '', complete: false };
  }
  if (typeof functionCall.args === 'string') {
    const text = functionCall.args;
    return {
      present: true,
      text,
      complete: isCompleteJsonObjectText(text)
    };
  }
  const text = stringifyFunctionCallArgs(functionCall);
  return {
    present: true,
    text,
    complete: true
  };
}

function ensureCodeAssistStreamToolState(state) {
  const target = state || {};
  if (!target.toolUseIdCodec) target.toolUseIdCodec = createAnthropicToolUseIdCodec();
  if (!(target.toolCalls instanceof Map)) target.toolCalls = new Map();
  return target;
}

function shouldApplyStreamResponsePolicy(state) {
  return isClaudeStopHookJsonResponsePolicy(state && state.responsePolicy);
}

function appendCodeAssistStreamTextEvent(events, state, text) {
  const value = toPlainText(text || '');
  if (!value) return;
  if (!shouldApplyStreamResponsePolicy(state)) {
    events.push({ type: 'content_delta', contentType: 'text', text: value });
    return;
  }
  const previous = toPlainText(state.responsePolicyTextBuffer || '');
  state.responsePolicyTextBuffer = `${previous}${value}`.slice(-12000);
}

function joinToolContextText(...values) {
  return values
    .map((value) => toPlainText(value || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(-5000);
}

function appendPendingToolContextText(state, text) {
  if (!state) return;
  const value = toPlainText(text || '').trim();
  if (!value) return;
  state.pendingToolContextText = joinToolContextText(state.pendingToolContextText, value);
}

function takePendingToolContextText(state) {
  if (!state) return '';
  const value = toPlainText(state.pendingToolContextText || '').trim();
  state.pendingToolContextText = '';
  return value;
}

function suppressStreamResponsePolicyPart(state, type) {
  if (!shouldApplyStreamResponsePolicy(state)) return false;
  const key = type === 'tool_call' ? 'responsePolicySuppressedToolCallCount' : 'responsePolicySuppressedThinkingCount';
  state[key] = Number(state[key] || 0) + 1;
  return true;
}

function appendStreamResponsePolicyFinalText(events, state) {
  if (!shouldApplyStreamResponsePolicy(state) || state.responsePolicyFinalized) return;
  state.responsePolicyFinalized = true;
  const text = toPlainText(state.responsePolicyTextBuffer || '');
  const suppressed = Number(state.responsePolicySuppressedToolCallCount || 0)
    + Number(state.responsePolicySuppressedThinkingCount || 0);
  if (!text && suppressed === 0) return;
  const repaired = repairClaudeStopHookJsonResponseText(text, state.responsePolicy);
  if (repaired.text) events.push({ type: 'content_delta', contentType: 'text', text: repaired.text });
}

function countOpenStreamToolCalls(state) {
  if (!state || !(state.toolCalls instanceof Map)) return 0;
  return Array.from(state.toolCalls.values()).filter((call) => call && !call.done).length;
}

function findOpenStreamToolCall(state, name) {
  const normalizedName = toPlainText(name || '').trim();
  const calls = state && state.toolCalls instanceof Map ? Array.from(state.toolCalls.values()) : [];
  const openCalls = calls.filter((call) => call && !call.done);
  if (normalizedName) {
    const named = openCalls.find((call) => call.name === normalizedName);
    if (named) return named;
  }
  return openCalls.length === 1 ? openCalls[0] : null;
}

function createStreamToolCallKey(functionCall, name, state) {
  const upstreamId = toPlainText(functionCall && functionCall.id || '').trim();
  if (upstreamId) return `id:${upstreamId}`;
  const openCall = findOpenStreamToolCall(state, name);
  if (openCall) return openCall.key;
  return `index:${Math.max(0, Number(state && state.nextToolIndex) || 0)}`;
}

function appendStreamToolCallDelta(events, call, delta) {
  const text = toPlainText(delta || '');
  if (!text) return;
  call.arguments += text;
  if (call.started) {
    events.push({
      type: 'tool_call_delta',
      index: call.index,
      id: call.id,
      name: call.name,
      delta: text
    });
  }
}

function resolveAppendOnlyArgumentDelta(current, next) {
  const previous = toPlainText(current || '');
  const incoming = toPlainText(next || '');
  if (!previous) return incoming;
  if (!incoming) return '';
  if (incoming.startsWith(previous)) return incoming.slice(previous.length);
  if (previous.endsWith(incoming)) return '';
  const maxOverlap = Math.min(previous.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.slice(-size) === incoming.slice(0, size)) return incoming.slice(size);
  }
  return incoming;
}

function appendStreamToolCallArgs(events, call, argState) {
  if (!argState || !argState.present) return;
  const text = toPlainText(argState.text || '');
  if (!text) return;
  const delta = resolveAppendOnlyArgumentDelta(call.arguments, text);
  appendStreamToolCallDelta(events, call, delta);
}

function appendInvalidStreamToolCallDiagnostic(events, state, diagnostic) {
  appendCodeAssistStreamDiagnostic(state, diagnostic);
  const text = formatInvalidToolCallText([diagnostic]);
  if (text) events.push({ type: 'content_delta', contentType: 'text', text });
}

function startStreamToolCall(events, call) {
  if (call.started) return;
  call.started = true;
  events.push({ type: 'tool_call_start', index: call.index, id: call.id, name: call.name });
}

function closeStreamToolCall(events, state, call) {
  if (!call || call.done) return;
  if (!call.arguments) {
    call.arguments = '{}';
  } else if (!isCompleteJsonObjectText(call.arguments)) {
    const upstreamName = call.upstreamName || call.name;
    appendInvalidStreamToolCallDiagnostic(events, state, {
      type: 'tool_call_arguments_closed_incomplete_json',
      id: call.id,
      name: call.name,
      argumentLength: call.arguments.length
    });
    appendToolProtocolRejectedDiagnostic(state && state.toolProtocolDiagnosticContext, {
      toolName: call.name,
      upstreamToolName: upstreamName,
      reason: 'incomplete_json',
      argKeys: [],
      requiredKeys: readRequiredToolInputs(state && state.requiredByName, upstreamName),
      missingKeys: [],
      unexpectedKeys: [],
      rawArgs: call.arguments
    });
    call.done = true;
    return;
  }

  const upstreamName = call.upstreamName || call.name;
  const evaluation = evaluateFunctionCallInput({
    id: call.upstreamId || call.id,
    name: upstreamName,
    args: call.arguments
  }, state && state.requiredByName, state && state.schemaByName, {
    contextText: call.contextText
  });
  appendToolProtocolInputDiagnostic(state && state.toolProtocolDiagnosticContext, evaluation, {
    toolName: call.name,
    upstreamToolName: upstreamName,
    rawArgs: call.arguments
  });
  if (!evaluation.ok) {
    appendInvalidStreamToolCallDiagnostic(events, state, evaluation.diagnostic);
    call.done = true;
    return;
  }

  state.hasToolCalls = true;
  startStreamToolCall(events, call);
  events.push({
    type: 'tool_call_delta',
    index: call.index,
    id: call.id,
    name: call.name,
    delta: JSON.stringify(evaluation.input)
  });
  events.push({
    type: 'tool_call_done',
    index: call.index,
    id: call.id,
    name: call.name
  });
  call.done = true;
}

function closeOpenStreamToolCalls(events, state, exceptKey = '') {
  if (!state || !(state.toolCalls instanceof Map)) return;
  state.toolCalls.forEach((call, key) => {
    if (key === exceptKey) return;
    closeStreamToolCall(events, state, call);
  });
}

function ensureStreamToolCall(events, state, functionCall, name) {
  const key = createStreamToolCallKey(functionCall, name, state);
  const existing = state.toolCalls.get(key);
  if (existing) return existing;

  closeOpenStreamToolCalls(events, state, key);

  const index = Math.max(0, Number(state.nextToolIndex) || 0);
  state.nextToolIndex = index + 1;
  const upstreamId = toPlainText(functionCall && functionCall.id || '').trim();
  const upstreamName = toPlainText(functionCall && functionCall.name || '').trim();
  const call = {
    key,
    index,
    id: state.toolUseIdCodec.toClient(upstreamId, index + 1),
    upstreamId,
    upstreamName,
    name,
    arguments: '',
    contextText: '',
    started: false,
    done: false
  };
  state.toolCalls.set(key, call);
  return call;
}

function appendCodeAssistStreamFunctionCallEvents(events, state, functionCall) {
  const upstreamName = toPlainText(functionCall && functionCall.name || '').trim();
  const upstreamId = toPlainText(functionCall && functionCall.id || '').trim();
  const argState = readStreamFunctionCallArgs(functionCall);
  const existing = upstreamId ? state.toolCalls.get(`id:${upstreamId}`) : null;
  const openCall = existing || findOpenStreamToolCall(state, upstreamName);
  const nameSource = upstreamName || (openCall ? openCall.name : '');
  const name = state && state.toolNameCodec && typeof state.toolNameCodec.toClient === 'function'
    ? state.toolNameCodec.toClient(nameSource)
    : nameSource;
  if (!name) {
    if (argState.present) {
      appendCodeAssistStreamDiagnostic(state, {
        type: 'tool_call_chunk_unmatched',
        hasId: Boolean(upstreamId),
        hasName: Boolean(upstreamName),
        hasArgs: true,
        openToolCallCount: countOpenStreamToolCalls(state),
        argLength: toPlainText(argState.text || '').length
      });
    }
    return;
  }

  const call = ensureStreamToolCall(events, state, functionCall, name);
  if (!call.contextText) call.contextText = takePendingToolContextText(state);
  appendStreamToolCallArgs(events, call, argState);
  if (argState.complete || isCompleteJsonObjectText(call.arguments)) {
    closeStreamToolCall(events, state, call);
  }
}

function finalizeCodeAssistStreamState(state) {
  const events = [];
  ensureCodeAssistStreamToolState(state);
  closeOpenStreamToolCalls(events, state);
  appendStreamResponsePolicyFinalText(events, state);
  return events;
}

function summarizeCodeAssistFunctionCalls(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .flatMap((candidate, candidateIndex) => {
      const parts = Array.isArray(candidate && candidate.content && candidate.content.parts)
        ? candidate.content.parts
        : [];
      return parts
        .map((part) => {
          const functionCall = part && part.functionCall && typeof part.functionCall === 'object'
            ? part.functionCall
            : null;
          if (!functionCall) return null;
          const name = toPlainText(functionCall.name || '').trim();
          if (!name) return null;
          const args = parseFunctionCallInput(functionCall);
          const argText = stringifyFunctionCallArgs(functionCall);
          return {
            candidateIndex,
            id: toPlainText(functionCall.id || '').trim(),
            name,
            argumentLength: argText.length,
            argKeys: Object.keys(args),
            emptyArgs: Object.keys(args).length === 0
          };
        })
        .filter(Boolean);
    })
    .slice(0, 20);
}

function summarizeCodeAssistFunctionCallArgumentDiagnostics(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .flatMap((candidate, candidateIndex) => {
      const parts = Array.isArray(candidate && candidate.content && candidate.content.parts)
        ? candidate.content.parts
        : [];
      return parts
        .map((part) => {
          const functionCall = part && part.functionCall && typeof part.functionCall === 'object'
            ? part.functionCall
            : null;
          if (!functionCall) return null;
          const diagnostic = getFunctionCallArgsDiagnostic(functionCall);
          if (!diagnostic) return null;
          return {
            candidateIndex,
            id: toPlainText(functionCall.id || '').trim(),
            name: toPlainText(functionCall.name || '').trim(),
            ...diagnostic
          };
        })
        .filter((item) => item && item.name);
    })
    .slice(0, 20);
}

function summarizeCodeAssistFunctionCallValidationDiagnostics(candidates, requiredByName, schemaByName) {
  return (Array.isArray(candidates) ? candidates : [])
    .flatMap((candidate, candidateIndex) => {
      const parts = Array.isArray(candidate && candidate.content && candidate.content.parts)
        ? candidate.content.parts
        : [];
      return parts
        .map((part) => {
          const functionCall = part && part.functionCall && typeof part.functionCall === 'object'
            ? part.functionCall
            : null;
          if (!functionCall) return null;
          const validation = evaluateFunctionCallInput(functionCall, requiredByName, schemaByName);
          if (validation.ok) return null;
          return {
            candidateIndex,
            ...validation.diagnostic
          };
        })
        .filter((item) => item && item.name);
    })
    .slice(0, 20);
}

function readThoughtSignature(part) {
  return decodeCodeAssistThoughtSignature(toPlainText(
    part && (part.thoughtSignature || part.thought_signature)
    || ''
  ).trim());
}

function appendCodeAssistResponseDiagnostic(options, candidates, functionDeclarations = [], schemaKey = 'parametersJsonSchema') {
  const requiredByName = createRequiredToolLookup(functionDeclarations, schemaKey);
  const schemaByName = createToolSchemaLookup(functionDeclarations, schemaKey);
  const responseToolCalls = summarizeCodeAssistFunctionCalls(candidates);
  const responseToolCallArgumentDiagnostics = summarizeCodeAssistFunctionCallArgumentDiagnostics(candidates);
  const responseToolCallValidationDiagnostics = summarizeCodeAssistFunctionCallValidationDiagnostics(candidates, requiredByName, schemaByName);
  const responseFinishReasons = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => toPlainText(candidate && candidate.finishReason || '').trim())
    .filter(Boolean);
  if (
    responseToolCalls.length === 0
    && responseToolCallArgumentDiagnostics.length === 0
    && responseToolCallValidationDiagnostics.length === 0
    && responseFinishReasons.length === 0
  ) {
    return;
  }
  appendGeminiCodeAssistDiagnostic(options || {}, {
    responseToolCalls,
    ...(responseToolCallArgumentDiagnostics.length > 0 ? { responseToolCallArgumentDiagnostics } : {}),
    ...(responseToolCallValidationDiagnostics.length > 0 ? { responseToolCallValidationDiagnostics } : {}),
    responseFinishReasons
  });
}

function extractUsage(usageMetadata) {
  const cached = Number(usageMetadata && usageMetadata.cachedContentTokenCount || 0);
  const prompt = Math.max(0, Number(usageMetadata && usageMetadata.promptTokenCount || 0) - (Number.isFinite(cached) ? cached : 0));
  const candidates = Number(usageMetadata && usageMetadata.candidatesTokenCount || 0);
  const thoughts = Number(usageMetadata && usageMetadata.thoughtsTokenCount || 0);
  const total = Number(usageMetadata && usageMetadata.totalTokenCount || 0);
  let output = candidates + thoughts;
  if (!output && total > 0) output = Math.max(0, total - prompt);
  return normalizeCanonicalUsage({
    input_tokens: prompt,
    output_tokens: output,
    total_tokens: total || prompt + output
  });
}

function applyClaudeStopHookJsonResponsePolicyToMessage(message, policy) {
  if (!isClaudeStopHookJsonResponsePolicy(policy)) return message;
  const content = Array.isArray(message && message.content) ? message.content : [];
  const text = content
    .filter((part) => part && part.type === 'text')
    .map((part) => toPlainText(part.text || ''))
    .join('');
  const hasNonTextContent = content.some((part) => part && part.type !== 'text');
  if (!text && !hasNonTextContent) return message;
  const repaired = repairClaudeStopHookJsonResponseText(text, policy);
  return {
    ...message,
    content: repaired.text ? [{ type: 'text', text: repaired.text }] : []
  };
}

function renderCodeAssistAnthropicMessage(json, fallbackModel, toolNameCodec = createToolNameCodec([]), options = {}) {
  const candidates = extractGeminiCandidates(json);
  const first = candidates[0] || {};
  const parts = Array.isArray(first && first.content && first.content.parts) ? first.content.parts : [];
  const content = [];
  const toolUseIdCodec = createAnthropicToolUseIdCodec({
    reservedClientIds: options && options.reservedClientToolUseIds
  });
  const requiredByName = options && options.requiredByName instanceof Map ? options.requiredByName : new Map();
  const schemaByName = options && options.schemaByName instanceof Map ? options.schemaByName : new Map();
  const toolProtocolDiagnosticContext = options && options.toolProtocolDiagnosticContext || null;
  const invalidToolCallDiagnostics = [];
  let textBuffer = '';
  let thinkingBuffer = '';
  let thinkingSignature = '';
  let hasToolCalls = false;

  const flushText = () => {
    if (!textBuffer) return;
    content.push({ type: 'text', text: textBuffer });
    textBuffer = '';
  };
  const flushThinking = () => {
    if (!thinkingBuffer && !thinkingSignature) return;
    content.push({
      type: 'thinking',
      thinking: thinkingBuffer,
      ...(thinkingSignature ? { signature: thinkingSignature } : {})
    });
    thinkingBuffer = '';
    thinkingSignature = '';
  };

  parts.forEach((part) => {
    if (!part || typeof part !== 'object') return;
    if (part.thought === true) {
      const signature = readThoughtSignature(part);
      if (signature) thinkingSignature = signature;
      const text = toPlainText(part.text || '');
      if (text) {
        flushText();
        thinkingBuffer += text;
      }
      return;
    }
    if (part.functionCall && typeof part.functionCall === 'object') {
      const toolContextText = joinToolContextText(thinkingBuffer, textBuffer);
      flushThinking();
      flushText();
      const functionCall = part.functionCall;
      const name = toolNameCodec && typeof toolNameCodec.toClient === 'function'
        ? toolNameCodec.toClient(functionCall.name)
        : toPlainText(functionCall.name || '').trim();
      if (!name) return;
      const evaluation = evaluateFunctionCallInput(functionCall, requiredByName, schemaByName, {
        contextText: toolContextText
      });
      appendToolProtocolInputDiagnostic(toolProtocolDiagnosticContext, evaluation, {
        toolName: name,
        upstreamToolName: toPlainText(functionCall.name || '').trim(),
        rawArgs: functionCall.args
      });
      if (!evaluation.ok) {
        invalidToolCallDiagnostics.push(evaluation.diagnostic);
        return;
      }
      hasToolCalls = true;
      const toolUseIndex = content.filter((item) => item && item.type === 'tool_use').length + 1;
      content.push({
        type: 'tool_use',
        id: toolUseIdCodec.toClient(functionCall.id, toolUseIndex),
        name,
        input: evaluation.input
      });
      return;
    }
    const text = toPlainText(part.text || '');
    if (text) {
      flushThinking();
      textBuffer += text;
    }
  });
  flushThinking();
  flushText();
  const invalidToolCallText = formatInvalidToolCallText(invalidToolCallDiagnostics);
  if (invalidToolCallText) content.push({ type: 'text', text: invalidToolCallText });

  const usage = extractUsage(extractGeminiUsageMetadata(json));
  const model = toPlainText(fallbackModel || extractGeminiModelVersion(json, fallbackModel) || '').trim();
  const responseEnvelope = json && json.response && typeof json.response === 'object' ? json.response : {};
  const message = {
    id: toPlainText(json && (json.responseId || json.traceId) || responseEnvelope.responseId || responseEnvelope.traceId || '').trim() || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapGeminiFinishReasonToAnthropic(first && first.finishReason, hasToolCalls),
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens
    }
  };
  return applyClaudeStopHookJsonResponsePolicyToMessage(message, options && options.responsePolicy);
}

function anthropicMessageToCanonicalEvents(message) {
  const events = [{
    type: 'message_start',
    id: toPlainText(message && message.id || '').trim(),
    model: toPlainText(message && message.model || '').trim(),
    created: Math.floor(Date.now() / 1000)
  }];
  let toolIndex = 0;
  const toolUseIdCodec = createAnthropicToolUseIdCodec({ preserveEncodedClientIds: true });
  (Array.isArray(message && message.content) ? message.content : []).forEach((part) => {
    if (!part || typeof part !== 'object') return;
    if (part.type === 'thinking') {
      const text = toPlainText(part.thinking || part.text || '');
      if (text) events.push({ type: 'content_delta', contentType: 'thinking', text });
      const signature = toPlainText(part.signature || '').trim();
      if (signature) events.push({ type: 'content_delta', contentType: 'thinking_signature', signature });
      return;
    }
    if (part.type === 'text') {
      const text = toPlainText(part.text || '');
      if (text) events.push({ type: 'content_delta', contentType: 'text', text });
      return;
    }
    if (part.type === 'tool_use') {
      const index = toolIndex;
      toolIndex += 1;
      const args = JSON.stringify(part.input && typeof part.input === 'object' ? part.input : {});
      const id = toolUseIdCodec.toClient(part.id, index + 1);
      events.push({ type: 'tool_call_start', index, id, name: part.name });
      if (args) events.push({ type: 'tool_call_delta', index, id, name: part.name, delta: args });
      events.push({ type: 'tool_call_done', index, id, name: part.name });
    }
  });
  events.push({
    type: 'message_stop',
    finishReason: message && message.stop_reason,
    usage: message && message.usage
  });
  return events;
}

function createCodeAssistAnthropicStreamState(toolNameCodec, functionDeclarations, schemaKey, reservedClientToolUseIds, responsePolicy, toolProtocolDiagnosticContext = null) {
  return {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    toolNameCodec,
    toolUseIdCodec: createAnthropicToolUseIdCodec({ reservedClientIds: reservedClientToolUseIds }),
    requiredByName: createRequiredToolLookup(functionDeclarations, schemaKey),
    schemaByName: createToolSchemaLookup(functionDeclarations, schemaKey),
    toolProtocolDiagnosticContext,
    responsePolicy
  };
}

async function* streamCodeAssistAnthropicCanonicalEvents(res, context, options) {
  const {
    model,
    originalModel,
    toolNameCodec,
    functionDeclarations,
    schemaKey,
    reservedClientToolUseIds,
    responsePolicy,
    toolProtocolDiagnosticContext
  } = context;
  const state = createCodeAssistAnthropicStreamState(
    toolNameCodec,
    functionDeclarations,
    schemaKey,
    reservedClientToolUseIds,
    responsePolicy,
    toolProtocolDiagnosticContext
  );
  yield {
    type: 'message_start',
    id: `msg_${Date.now()}`,
    model: originalModel,
    created: Math.floor(Date.now() / 1000)
  };
  for await (const envelope of parseSseJsonStream(res.body)) {
    const piece = {
      model: originalModel || extractGeminiModelVersion(envelope, model),
      candidates: extractGeminiCandidates(envelope),
      usageMetadata: extractGeminiUsageMetadata(envelope)
    };
    appendCodeAssistResponseDiagnostic(options || {}, piece.candidates, functionDeclarations, schemaKey);
    const events = codeAssistStreamPieceToCanonicalEvents(piece, state);
    flushCodeAssistStreamDiagnostics(options, state);
    for (const event of events) yield event;
  }
  if (!state.finished) {
    const finalEvents = finalizeCodeAssistStreamState(state);
    flushCodeAssistStreamDiagnostics(options, state);
    for (const event of finalEvents) yield event;
    yield {
      type: 'message_stop',
      finishReason: state.hasToolCalls ? 'tool_use' : 'end_turn',
      usage: state.usage
    };
  }
}

function flushCanonicalTextContent(content, buffers) {
  if (buffers.thinking || buffers.thinkingSignature) {
    content.push({
      type: 'thinking',
      thinking: buffers.thinking,
      ...(buffers.thinkingSignature ? { signature: buffers.thinkingSignature } : {})
    });
    buffers.thinking = '';
    buffers.thinkingSignature = '';
  }
  if (buffers.text) {
    content.push({ type: 'text', text: buffers.text });
    buffers.text = '';
  }
}

function parseToolCallInputText(text) {
  const parsed = parseJsonObject(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

async function collectCodeAssistAnthropicMessage(eventStream, fallbackModel, responsePolicy) {
  const content = [];
  const toolCalls = new Map();
  const buffers = { text: '', thinking: '', thinkingSignature: '' };
  let id = '';
  let model = toPlainText(fallbackModel || '').trim();
  let stopReason = 'end_turn';
  let usage = null;

  for await (const event of eventStream) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'message_start') {
      id = toPlainText(event.id || id).trim();
      model = toPlainText(event.model || model).trim();
      continue;
    }
    if (event.type === 'content_delta' && event.contentType === 'thinking') {
      if (buffers.text) {
        content.push({ type: 'text', text: buffers.text });
        buffers.text = '';
      }
      buffers.thinking += toPlainText(event.text || '');
      continue;
    }
    if (event.type === 'content_delta' && event.contentType === 'thinking_signature') {
      buffers.thinkingSignature = toPlainText(event.signature || '').trim();
      continue;
    }
    if (event.type === 'content_delta' && event.contentType === 'text') {
      if (buffers.thinking || buffers.thinkingSignature) {
        content.push({
          type: 'thinking',
          thinking: buffers.thinking,
          ...(buffers.thinkingSignature ? { signature: buffers.thinkingSignature } : {})
        });
        buffers.thinking = '';
        buffers.thinkingSignature = '';
      }
      buffers.text += toPlainText(event.text || '');
      continue;
    }
    if (event.type === 'tool_call_start') {
      flushCanonicalTextContent(content, buffers);
      const index = Number.isInteger(Number(event.index)) ? Number(event.index) : toolCalls.size;
      const toolCall = {
        type: 'tool_use',
        id: toPlainText(event.id || '').trim() || `toolu_${index + 1}`,
        name: toPlainText(event.name || '').trim(),
        input: {},
        _inputText: ''
      };
      toolCalls.set(index, toolCall);
      content.push(toolCall);
      continue;
    }
    if (event.type === 'tool_call_delta') {
      const index = Number.isInteger(Number(event.index)) ? Number(event.index) : 0;
      const toolCall = toolCalls.get(index);
      if (!toolCall) continue;
      toolCall._inputText += toPlainText(event.delta || '');
      continue;
    }
    if (event.type === 'tool_call_done') {
      const index = Number.isInteger(Number(event.index)) ? Number(event.index) : 0;
      const toolCall = toolCalls.get(index);
      if (!toolCall) continue;
      toolCall.input = parseToolCallInputText(toolCall._inputText);
      delete toolCall._inputText;
      continue;
    }
    if (event.type === 'message_stop') {
      stopReason = toPlainText(event.finishReason || stopReason).trim() || stopReason;
      usage = normalizeCanonicalUsage(event.usage);
    }
  }
  flushCanonicalTextContent(content, buffers);
  toolCalls.forEach((toolCall) => {
    if (Object.prototype.hasOwnProperty.call(toolCall, '_inputText')) {
      toolCall.input = parseToolCallInputText(toolCall._inputText);
      delete toolCall._inputText;
    }
  });
  const normalizedUsage = normalizeCanonicalUsage(usage);
  const message = {
    id: id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: normalizedUsage.input_tokens,
      output_tokens: normalizedUsage.output_tokens
    }
  };
  return applyClaudeStopHookJsonResponsePolicyToMessage(message, responsePolicy);
}

function codeAssistStreamPieceToCanonicalEvents(piece, state) {
  const events = [];
  state = ensureCodeAssistStreamToolState(state);
  const candidates = Array.isArray(piece && piece.candidates) ? piece.candidates : [];
  const first = candidates[0] || {};
  const parts = Array.isArray(first && first.content && first.content.parts) ? first.content.parts : [];
  parts.forEach((part) => {
    if (!part || typeof part !== 'object') return;
    if (part.thought === true) {
      if (suppressStreamResponsePolicyPart(state, 'thinking')) return;
      closeOpenStreamToolCalls(events, state);
      const text = toPlainText(part.text || '');
      if (text) {
        appendPendingToolContextText(state, text);
        events.push({ type: 'content_delta', contentType: 'thinking', text });
      }
      const signature = readThoughtSignature(part);
      if (signature) events.push({ type: 'content_delta', contentType: 'thinking_signature', signature });
      return;
    }
    if (part.functionCall && typeof part.functionCall === 'object') {
      if (suppressStreamResponsePolicyPart(state, 'tool_call')) return;
      appendCodeAssistStreamFunctionCallEvents(events, state, part.functionCall);
      return;
    }
    const text = toPlainText(part.text || '');
    if (text) {
      closeOpenStreamToolCalls(events, state);
      appendPendingToolContextText(state, text);
      appendCodeAssistStreamTextEvent(events, state, text);
    }
  });

  const usageMetadata = piece && piece.usageMetadata;
  if (usageMetadata && typeof usageMetadata === 'object') {
    state.usage = extractUsage(usageMetadata);
  }
  const finishReason = toPlainText(first && first.finishReason || '').trim();
  if (finishReason) {
    events.push(...finalizeCodeAssistStreamState(state));
    state.finished = true;
    events.push({
      type: 'message_stop',
      finishReason: mapGeminiFinishReasonToAnthropic(finishReason, state.hasToolCalls),
      usage: state.usage
    });
  }
  return events;
}

// agy/code-assist 400 INVALID_ARGUMENT 诊断：只打结构（model / contents 角色与 part 类型 /
// systemInstruction 形状 / generationConfig 键），不打私有正文，定位上游拒绝的字段。
function logCodeAssist400Diagnostic(payload, model, googleErrorText, originalModel) {
  try {
    const inner = (payload && (payload.request || payload.requestBody)) || payload || {};
    const contents = Array.isArray(inner.contents) ? inner.contents : [];
    const sys = inner.systemInstruction;
    // eslint-disable-next-line no-console
    console.error('[agy/code-assist HTTP 400]', JSON.stringify({
      model,
      originalModel: originalModel || undefined,
      payloadKeys: Object.keys(payload || {}),
      requestKeys: Object.keys(inner || {}),
      contentsCount: contents.length,
      contentsRoles: contents.map((item) => item && item.role),
      contentsPartShapes: contents.map((item) => Array.isArray(item && item.parts)
        ? item.parts.map((part) => Object.keys(part || {}).join('+') || 'EMPTY')
        : 'NO_PARTS'),
      systemInstruction: sys
        ? { role: sys.role, partsCount: Array.isArray(sys.parts) ? sys.parts.length : 'NOT_ARRAY' }
        : (sys === undefined ? 'undefined' : String(sys)),
      generationConfigKeys: inner.generationConfig ? Object.keys(inner.generationConfig) : null,
      hasTools: Array.isArray(inner.tools) ? inner.tools.length : 0,
      googleError: String(googleErrorText || '').slice(0, 400)
    }));
  } catch (_error) { /* diagnostic best-effort */ }
}

async function fetchCodeAssistAnthropicMessage(options, account, requestJson, timeoutMs = 8000) {
  const context = await buildCodeAssistAnthropicGenerateContext(
    options,
    account,
    requestJson,
    timeoutMs
  );
  const { model, originalModel, project, payload, diagnostic, providerStrategy, toolNameCodec, functionDeclarations, schemaKey, reservedClientToolUseIds, responsePolicy } = context;
  const baseUrl = resolveProviderBaseUrl(options, account);
  const forceStreamForBuffered = shouldForceStreamForBufferedAnthropic(providerStrategy, model, originalModel, options || {});
  const method = forceStreamForBuffered ? 'streamGenerateContent' : 'generateContent';
  const url = forceStreamForBuffered
    ? `${buildGeminiCodeAssistMethodUrl(baseUrl, method)}?alt=sse`
    : buildGeminiCodeAssistMethodUrl(baseUrl, method);
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistAnthropicHeaderOptions(providerStrategy, project, model, originalModel)
  );
  const headerSummary = summarizeCodeAssistHeaders(headers);
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method,
    forceStreamForBuffered,
    ...headerSummary
  });
  const { res, retriedWithoutProjectHeader } = await fetchCodeAssistAnthropicUpstream(
    url,
    headers,
    payload,
    timeoutMs,
    options || {}
  );
  if (retriedWithoutProjectHeader) {
    appendGeminiCodeAssistDiagnostic(options || {}, {
      projectHeader: false,
      projectHeaderRetry: true,
      projectHeaderRetryReason: 'http_403'
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400) logCodeAssist400Diagnostic(payload, model, text, originalModel);
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }
  if (forceStreamForBuffered) {
    return collectCodeAssistAnthropicMessage(
      streamCodeAssistAnthropicCanonicalEvents(res, context, options || {}),
      originalModel,
      responsePolicy
    );
  }
  const json = await res.json().catch(() => ({}));
  appendCodeAssistResponseDiagnostic(options || {}, extractGeminiCandidates(json), functionDeclarations, schemaKey);
  return renderCodeAssistAnthropicMessage(json, originalModel, toolNameCodec, {
    requiredByName: createRequiredToolLookup(functionDeclarations, schemaKey),
    schemaByName: createToolSchemaLookup(functionDeclarations, schemaKey),
    reservedClientToolUseIds,
    responsePolicy,
    toolProtocolDiagnosticContext: context.toolProtocolDiagnosticContext
  });
}

async function fetchCodeAssistAnthropicMessageStream(options, account, requestJson, timeoutMs = 8000) {
  const context = await buildCodeAssistAnthropicGenerateContext(
    options,
    account,
    requestJson,
    timeoutMs
  );
  const { model, originalModel, project, payload, diagnostic, providerStrategy } = context;
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = `${buildGeminiCodeAssistMethodUrl(baseUrl, 'streamGenerateContent')}?alt=sse`;
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistAnthropicHeaderOptions(providerStrategy, project, model, originalModel)
  );
  const headerSummary = summarizeCodeAssistHeaders(headers);
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'streamGenerateContent',
    ...headerSummary
  });
  const { res, retriedWithoutProjectHeader } = await fetchCodeAssistAnthropicUpstream(
    url,
    headers,
    payload,
    timeoutMs,
    options || {}
  );
  if (retriedWithoutProjectHeader) {
    appendGeminiCodeAssistDiagnostic(options || {}, {
      projectHeader: false,
      projectHeaderRetry: true,
      projectHeaderRetryReason: 'http_403'
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400) logCodeAssist400Diagnostic(payload, model, text, originalModel);
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }

  return streamCodeAssistAnthropicCanonicalEvents(res, context, options || {});
}

module.exports = {
  fetchCodeAssistAnthropicMessage,
  fetchCodeAssistAnthropicMessageStream,
  anthropicMessageToCanonicalEvents,
  __private: {
    buildCodeAssistAnthropicGenerateContext,
    normalizeAnthropicMessagesForCodeAssist,
    normalizeAnthropicToolsForCodeAssist,
    removeTrailingUnansweredCodeAssistFunctionCallTurn,
    renderCodeAssistAnthropicMessage,
    codeAssistStreamPieceToCanonicalEvents,
    summarizeCodeAssistFunctionCalls,
    summarizeCodeAssistFunctionCallArgumentDiagnostics,
    sanitizeCodeAssistToolName,
    sanitizeAnthropicToolUseId,
    decodeAnthropicToolUseId,
    createAnthropicToolUseIdCodec,
    collectAnthropicToolUseIds,
    createToolNameCodec,
    resolveClaudeStopHookJsonResponsePolicy,
    repairClaudeStopHookJsonResponseText,
    decodeCodeAssistThoughtSignature,
    encodeCodeAssistThoughtSignature,
    finalizeCodeAssistStreamState
  }
};
