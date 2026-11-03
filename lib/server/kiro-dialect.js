'use strict';

// kiro（CodeWhisperer GenerateAssistantResponse）的**方言适配器**（Adapter）。
//
// 职责只有两件：
//   * encodeKiroConversation：OpenAI Chat 语义的请求（协议桥已把 Anthropic / Responses 统一成它）
//     → CodeWhisperer `conversationState`，包括 tools / toolUses / toolResults / images；
//   * createKiroFrameDecoder：AWS event-stream 帧 → 与 canonical 事件同名的语义事件
//     （text / thinking / tool_call_start|delta|done / metering / context_usage）。
// HTTP、超时、重试、SSE 输出都不在这里（见 kiro-chat-transport.js），因此方言规则可以单测穷举。
//
// 上游规则（2026-10-19 真机取证，Builder ID + Google social 两类账号，claude-haiku-4.5 /
// sonnet-4.5 / opus-5.5）：
//   1. 工具定义放在 currentMessage.userInputMessageContext.tools 即可（history 里不必重复）；
//   2. toolSpecification.description **不能为空**（空串 → 400 "Invalid tool use format."）；
//   3. history 里只要出现 toolUses / toolResults，currentMessage 就必须带 tools
//      （否则 400 TOOL_CONFIG_MISSING）→ 请求没给工具时按历史里出现的工具名补最小定义；
//   4. toolResults 必须与**紧邻上一个** assistant 轮的 toolUses 一一对应：多出来的结果
//      （TOOL_USE_RESULT_MISMATCH）与缺结果的调用（"tool_use ids were found without
//      tool_result"）都会 400 → 多余结果降级成文本，缺失结果补一条 error 结果；
//   5. 工具结果可以只有 toolResults、content 为空串；assistant 轮可以只有 toolUses；
//   6. 图片走 userInputMessage.images: [{format, source:{bytes:<base64>}}]（远程 URL 不可送）；
//   7. 响应帧：toolUseEvent {toolUseId,name,input?:<字符串分片>,stop?:true}、
//      contextUsageEvent {contextUsagePercentage}、meteringEvent {unit:'credit',usage}；
//   8. tool_choice 无对应字段：上游自行决定是否调用（语义上等价于 auto）。

const crypto = require('node:crypto');

const DEFAULT_CONTINUE_PROMPT = 'Continue.';
const REMOTE_IMAGE_PLACEHOLDER = '[远程图片 URL 无法经 kiro 通道发送，请改为内联 base64 图片]';
const MISSING_TOOL_RESULT_TEXT = 'Tool result unavailable: the client did not return a result for this tool call.';
const KIRO_IMAGE_FORMATS = Object.freeze({ png: 'png', jpeg: 'jpeg', jpg: 'jpeg', gif: 'gif', webp: 'webp' });
const EMPTY_TOOL_SCHEMA = Object.freeze({ type: 'object', properties: {} });

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

/** data:image/<fmt>;base64,<bytes> → kiro 图片块；不可送的（远程 URL、未知格式）返回 null。 */
function toKiroImage(url) {
  const match = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/is.exec(normalizeString(url));
  if (!match) return null;
  const format = KIRO_IMAGE_FORMATS[match[1].toLowerCase()];
  return format ? { format, source: { bytes: match[2].replace(/\s+/g, '') } } : null;
}

function readImageUrl(part) {
  if (typeof part.image_url === 'string') return part.image_url;
  if (part.image_url && typeof part.image_url.url === 'string') return part.image_url.url;
  return typeof part.url === 'string' ? part.url : '';
}

/** 消息内容 → { text, images }。图片尽量原样送，送不了的显式占位（不静默丢）。 */
function readContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const texts = [];
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.text === 'string' && /^(?:text|input_text|output_text)$/.test(String(part.type || 'text'))) {
      texts.push(part.text);
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      const image = toKiroImage(readImageUrl(part));
      if (image) images.push(image);
      else texts.push(REMOTE_IMAGE_PLACEHOLDER);
    }
  }
  return { text: texts.filter(Boolean).join('\n'), images };
}

function listRequestMessages(requestJson = {}) {
  const messages = Array.isArray(requestJson.messages) ? requestJson.messages : [];
  if (messages.length) return messages;
  // responses-wire 形态兜底：正常情况下协议桥已经把它转成 chat 形态。
  const input = Array.isArray(requestJson.input) ? requestJson.input : [];
  return input
    .filter((item) => item && typeof item === 'object' && item.role)
    .map((item) => ({ role: item.role, content: item.content }));
}

function parseToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = normalizeString(raw);
  if (!text) return {};
  const parsed = parseJsonSafe(text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  return { input: text };
}

function newTurn(role) {
  return { role, text: '', images: [], toolUses: [], toolResults: [] };
}

function appendText(turn, text) {
  if (!text) return;
  turn.text = turn.text ? `${turn.text}\n\n${text}` : text;
}

/** OpenAI messages → 交替的 user / assistant 轮（system 单独返回）。 */
function collectTurns(requestJson) {
  const systemParts = [];
  const turns = [];
  const turnFor = (role) => {
    const previous = turns[turns.length - 1];
    if (previous && previous.role === role) return previous;
    const turn = newTurn(role);
    turns.push(turn);
    return turn;
  };
  for (const message of listRequestMessages(requestJson)) {
    if (!message || typeof message !== 'object') continue;
    const role = normalizeString(message.role).toLowerCase();
    const { text, images } = readContent(message.content);
    if (role === 'system' || role === 'developer') {
      if (text) systemParts.push(text);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const toolUseId = normalizeString(message.tool_call_id || message.toolCallId);
      const turn = turnFor('user');
      if (!toolUseId) {
        appendText(turn, text);
        continue;
      }
      turn.toolResults.push({
        toolUseId,
        status: message.is_error === true || message.status === 'error' ? 'error' : 'success',
        content: [{ text: text || '(empty result)' }]
      });
      continue;
    }
    if (role === 'assistant') {
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const uses = toolCalls
        .map((call) => {
          const fn = (call && call.function) || {};
          const name = normalizeString(fn.name || (call && call.name));
          const toolUseId = normalizeString(call && call.id) || `tooluse_${crypto.randomUUID().replace(/-/g, '')}`;
          return name ? { toolUseId, name, input: parseToolArguments(fn.arguments) } : null;
        })
        .filter(Boolean);
      if (!text && !uses.length) continue;
      const turn = turnFor('assistant');
      appendText(turn, text);
      turn.toolUses.push(...uses);
      continue;
    }
    const turn = turnFor('user');
    appendText(turn, text);
    turn.images.push(...images);
  }
  return { system: systemParts.join('\n\n'), turns };
}

function describeOrphanResult(result) {
  const body = result.content.map((item) => item.text).join('\n');
  return `[tool result ${result.toolUseId}${result.status === 'error' ? ' (error)' : ''}]\n${body}`;
}

/**
 * 规则 4：toolResults 只能回应紧邻上一个 assistant 轮的 toolUses，且必须一一对应。
 * 多余的结果降级为文本；缺失的结果补 error 结果（与 Anthropic 自身的配对约束同语义）。
 */
function pairToolResults(turns) {
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== 'user') continue;
    const previous = turns[index - 1];
    const expected = previous && previous.role === 'assistant'
      ? previous.toolUses.map((use) => use.toolUseId)
      : [];
    const byId = new Map();
    const orphans = [];
    for (const result of turn.toolResults) {
      if (expected.includes(result.toolUseId) && !byId.has(result.toolUseId)) byId.set(result.toolUseId, result);
      else orphans.push(result);
    }
    turn.toolResults = expected.map((toolUseId) => byId.get(toolUseId) || {
      toolUseId,
      status: 'error',
      content: [{ text: MISSING_TOOL_RESULT_TEXT }]
    });
    if (orphans.length) {
      turn.text = [orphans.map(describeOrphanResult).join('\n\n'), turn.text].filter(Boolean).join('\n\n');
    }
  }
  // 末轮 assistant 的 toolUses 没有后继 user 轮：补一个只带结果的 user 轮，保持配对成立。
  const last = turns[turns.length - 1];
  if (last && last.role === 'assistant' && last.toolUses.length) {
    const turn = newTurn('user');
    turns.push(turn);
    pairToolResults(turns.slice(-2));
  }
}

/** OpenAI tools → toolSpecification；历史里用过却没声明的工具补最小定义（规则 3）。 */
function buildToolSpecifications(requestJson, turns) {
  const specs = [];
  const seen = new Set();
  const tools = Array.isArray(requestJson.tools) ? requestJson.tools : [];
  for (const tool of tools) {
    const fn = (tool && (tool.function || tool)) || {};
    const name = normalizeString(fn.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const schema = fn.parameters || fn.input_schema || fn.inputSchema;
    specs.push({
      toolSpecification: {
        name,
        description: normalizeString(fn.description) || name,
        inputSchema: { json: schema && typeof schema === 'object' ? schema : EMPTY_TOOL_SCHEMA }
      }
    });
  }
  for (const turn of turns) {
    for (const use of turn.toolUses) {
      if (seen.has(use.name)) continue;
      seen.add(use.name);
      specs.push({ toolSpecification: { name: use.name, description: use.name, inputSchema: { json: EMPTY_TOOL_SCHEMA } } });
    }
  }
  return specs;
}

/**
 * @param {object} requestJson OpenAI Chat 语义请求
 * @param {{modelId?: string, conversationId?: string}} [options]
 * @returns {{conversationState: object, toolCount: number, promptText: string}}
 */
function encodeKiroConversation(requestJson = {}, options = {}) {
  const { system, turns } = collectTurns(requestJson);
  if (system) {
    const firstUser = turns.find((turn) => turn.role === 'user');
    if (firstUser) firstUser.text = firstUser.text ? `${system}\n\n${firstUser.text}` : system;
    else turns.unshift({ ...newTurn('user'), text: system });
  }
  // history 必须从 user 轮开始。
  if (turns.length && turns[0].role !== 'user') turns.unshift({ ...newTurn('user'), text: DEFAULT_CONTINUE_PROMPT });
  pairToolResults(turns);
  // currentMessage 必须是 userInputMessage：末轮是 assistant 时补续写指令，不丢上下文。
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    turns.push({ ...newTurn('user'), text: DEFAULT_CONTINUE_PROMPT });
  }

  const modelId = normalizeString(options.modelId || requestJson.model);
  const toolSpecs = buildToolSpecifications(requestJson, turns);
  const encodeUser = (turn, isCurrent) => {
    const context = {};
    if (turn.toolResults.length) context.toolResults = turn.toolResults;
    if (isCurrent && toolSpecs.length) context.tools = toolSpecs;
    // 无文本、无工具结果、无图片的 history 用户轮给续写占位，避免空轮。
    const content = turn.text || (turn.toolResults.length || turn.images.length || isCurrent ? '' : DEFAULT_CONTINUE_PROMPT);
    return {
      userInputMessage: {
        content,
        userInputMessageContext: context,
        ...(turn.images.length ? { images: turn.images } : {}),
        ...(modelId ? { modelId } : {}),
        origin: 'AI_EDITOR'
      }
    };
  };
  const encodeAssistant = (turn) => ({
    assistantResponseMessage: {
      content: turn.text,
      ...(turn.toolUses.length ? { toolUses: turn.toolUses } : {})
    }
  });

  const history = turns.slice(0, -1).map((turn) => (turn.role === 'assistant' ? encodeAssistant(turn) : encodeUser(turn, false)));
  const conversationState = {
    chatTriggerType: 'MANUAL',
    conversationId: normalizeString(options.conversationId) || crypto.randomUUID(),
    currentMessage: encodeUser(turns[turns.length - 1], true)
  };
  // 空 history 会让服务端困惑（实测首轮不带 history 最稳）。
  if (history.length) conversationState.history = history;

  const promptText = [
    ...turns.map((turn) => [
      turn.text,
      ...turn.toolUses.map((use) => JSON.stringify(use.input)),
      ...turn.toolResults.map((result) => result.content.map((item) => item.text).join('\n'))
    ].join('\n')),
    toolSpecs.length ? JSON.stringify(toolSpecs) : ''
  ].join('\n');
  return { conversationState, toolCount: toolSpecs.length, promptText };
}

/**
 * 帧 → 语义事件。工具输入以字符串分片到达，`stop:true` 标记该次调用结束；
 * 同一个 toolUseId 的首帧只带 name（实测），因此「首次见到 id」即 tool_call_start。
 */
function createKiroFrameDecoder() {
  const calls = new Map();
  let nextIndex = 0;

  const finishCall = (call, events) => {
    if (call.done) return;
    call.done = true;
    events.push({ type: 'tool_call_done', index: call.index, id: call.id, name: call.name, arguments: call.arguments });
  };

  return {
    decode(frame) {
      const events = [];
      const document = parseJsonSafe(frame.payload);
      if (!document || typeof document !== 'object') return events;
      switch (frame.eventType) {
        case 'initial-response': {
          const id = normalizeString(document.conversationId);
          if (id) events.push({ type: 'conversation', id });
          break;
        }
        case 'assistantResponseEvent':
          if (typeof document.content === 'string' && document.content) events.push({ type: 'text', text: document.content });
          break;
        case 'reasoningContentEvent':
          if (typeof document.text === 'string' && document.text) events.push({ type: 'thinking', text: document.text });
          break;
        case 'toolUseEvent': {
          const id = normalizeString(document.toolUseId);
          if (!id) break;
          let call = calls.get(id);
          if (!call) {
            call = { index: nextIndex++, id, name: normalizeString(document.name), arguments: '', done: false };
            calls.set(id, call);
            events.push({ type: 'tool_call_start', index: call.index, id, name: call.name });
          }
          const input = document.input;
          const delta = typeof input === 'string' ? input : (input && typeof input === 'object' ? JSON.stringify(input) : '');
          if (delta && !call.done) {
            call.arguments += delta;
            events.push({ type: 'tool_call_delta', index: call.index, id, name: call.name, delta });
          }
          if (document.stop === true) finishCall(call, events);
          break;
        }
        case 'meteringEvent':
          if (Number.isFinite(Number(document.usage))) {
            events.push({ type: 'metering', unit: normalizeString(document.unit) || 'credit', usage: Number(document.usage) });
          }
          break;
        case 'contextUsageEvent':
          if (Number.isFinite(Number(document.contextUsagePercentage))) {
            events.push({ type: 'context_usage', percentage: Number(document.contextUsagePercentage) });
          }
          break;
        default:
          break;
      }
      return events;
    },
    /** 流正常结束：没收到 stop 的调用按已收到的输入收尾（不丢调用）。 */
    flush() {
      const events = [];
      calls.forEach((call) => finishCall(call, events));
      return events;
    },
    get toolCalls() {
      return Array.from(calls.values()).map(({ index, id, name, arguments: args }) => ({ index, id, name, arguments: args }));
    }
  };
}

module.exports = {
  encodeKiroConversation,
  createKiroFrameDecoder,
  MISSING_TOOL_RESULT_TEXT,
  __private: { collectTurns, pairToolResults, buildToolSpecifications, readContent, toKiroImage, listRequestMessages }
};
