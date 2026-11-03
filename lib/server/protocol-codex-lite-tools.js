'use strict';

// Codex「Responses lite」工具声明的翻译 —— 非 Codex Provider 的协议桥适配器。
//
// 背景（2026-11-02 真机）：Codex 对 `use_responses_lite` 的模型（gpt-6.1-sol）不再把工具放在
// 请求的 `tools` 字段里，而是作为一个 **input item** 下发：
//
//   { "type": "additional_tools", "role": "developer", "tools": [
//       { "type": "namespace", "name": "functions", "tools": [
//           { "type": "custom", "name": "exec", "format": …, "description": … },
//           { "type": "function", "name": "wait", "parameters": … } ] },
//       { "type": "namespace", "name": "clock", "tools": [ … ] } ] }
//
// Codex 自己的上游认这种形状；但网关把 Responses 桥到 OpenAI Chat 时只读 `tools` 字段，
// 于是 kiro / claude / gemini 这些 Provider 收到的请求**一个工具都没有** —— 模型只能按
// 提示词里的工具说明输出 `<tool_call>…</tool_call>` 文本，Codex 不认，工具循环直接断掉
// （实测：`aih codex --model-alias kiro.glm-5` 的 exec 不执行）。
//
// 本模块只做声明层的翻译与回译：
//   * `additional_tools` / `namespace` → 扁平的 Chat 工具（名字加命名空间前缀，避免
//     `functions.exec` 与 `clock.sleep` 撞名）；
//   * `custom`（自由文本输入的工具，例如 codex 的 JS `exec`）→ 单字符串参数的 Chat 工具，
//     回来时再还原成 `custom_tool_call`（Codex 靠 `namespace` + `name` + `input` 派发）。
//
// 回译需要知道「哪些名字是 custom、哪个名字属于哪个命名空间」，这份映射随 Chat 请求体
// 一起传递（Symbol 键，`JSON.stringify` 不会带上它，因此绝不外泄到上游）。

const CUSTOM_TOOL_PARAMETER = 'input';
const TOOL_CONTEXT = Symbol.for('aih.codexLiteToolContext');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 命名空间分隔符：CodeWhisperer（kiro）只接受 `[A-Za-z0-9_-]`，点号会被判格式非法。 */
const NAMESPACE_SEPARATOR = '__';

/** Chat 工具名：`functions__exec` / `clock__sleep`（回译靠上下文映射，不靠拆字符串）。 */
function qualifyToolName(namespace, name) {
  return namespace ? `${namespace}${NAMESPACE_SEPARATOR}${name}` : name;
}

function normalizeSchema(schema) {
  return isRecord(schema) ? schema : { type: 'object', properties: {} };
}

// 自由文本工具在 Chat 协议里只能表达成「一个字符串参数」。
function customToolFunction(tool, qualifiedName) {
  const description = text(tool.description);
  return {
    type: 'function',
    function: {
      name: qualifiedName,
      description: [
        description,
        '',
        `Pass the raw ${text(tool.name) || 'tool'} input as the "${CUSTOM_TOOL_PARAMETER}" string.`
      ].filter(Boolean).join('\n'),
      parameters: {
        type: 'object',
        properties: {
          [CUSTOM_TOOL_PARAMETER]: {
            type: 'string',
            description: 'Raw tool input, passed through verbatim.'
          }
        },
        required: [CUSTOM_TOOL_PARAMETER]
      }
    }
  };
}

function functionTool(tool, qualifiedName) {
  return {
    type: 'function',
    function: {
      name: qualifiedName,
      description: text(tool.description),
      parameters: normalizeSchema(tool.parameters)
    }
  };
}

/**
 * 把一份声明（flat function / custom / namespace）展开成 Chat 工具。
 * @returns {{tools: object[], names: Array<{chatName: string, name: string, namespace: string, custom: boolean}>}}
 */
function flattenToolDeclaration(tool, out) {
  if (!isRecord(tool)) return;
  const type = text(tool.type).toLowerCase();
  if (type === 'namespace') {
    const namespace = text(tool.name);
    for (const inner of Array.isArray(tool.tools) ? tool.tools : []) flattenToolDeclaration({ ...inner, namespace }, out);
    return;
  }
  const name = text(tool.name);
  if (!name) return;
  const namespace = text(tool.namespace);
  const chatName = qualifyToolName(namespace, name);
  const custom = type === 'custom';
  out.tools.push(custom ? customToolFunction(tool, chatName) : functionTool(tool, chatName));
  out.names.push({ chatName, name, namespace, custom });
}

/**
 * 收集请求里的全部工具声明：`tools` 字段 + `additional_tools` input item。
 * @returns {{tools: object[], names: Array<object>}}
 */
function collectToolDeclarations(source) {
  const out = { tools: [], names: [] };
  const tools = source && Array.isArray(source.tools) ? source.tools : [];
  for (const tool of tools) flattenToolDeclaration(tool, out);
  const input = source && Array.isArray(source.input) ? source.input : [];
  for (const item of input) {
    if (!isRecord(item) || text(item.type) !== 'additional_tools') continue;
    for (const tool of Array.isArray(item.tools) ? item.tools : []) flattenToolDeclaration(tool, out);
  }
  // 同名工具去重（Codex 可能在 tools 与 additional_tools 里重复声明）。
  const seen = new Set();
  const unique = [];
  for (const entry of out.tools) {
    const name = entry.function.name;
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(entry);
  }
  return {
    tools: unique,
    names: out.names.filter((entry, index, all) => all.findIndex((item) => item.chatName === entry.chatName) === index)
  };
}

/** 把声明上下文挂到 Chat 请求体上（Symbol 键：不参与 JSON 序列化）。 */
function attachToolContext(chatPayload, declarations) {
  if (!chatPayload || typeof chatPayload !== 'object') return chatPayload;
  Object.defineProperty(chatPayload, TOOL_CONTEXT, {
    value: {
      custom: new Set((declarations.names || []).filter((entry) => entry.custom).map((entry) => entry.chatName)),
      names: new Map((declarations.names || []).map((entry) => [entry.chatName, { name: entry.name, namespace: entry.namespace }]))
    },
    enumerable: false,
    configurable: true
  });
  return chatPayload;
}

/** 读取声明上下文；没有声明时返回空集合（行为与以前逐字节一致）。 */
function readToolContext(payload) {
  const value = payload && typeof payload === 'object' ? payload[TOOL_CONTEXT] : null;
  return {
    custom: value && value.custom instanceof Set ? value.custom : new Set(),
    names: value && value.names instanceof Map ? value.names : new Map()
  };
}

/** Chat 的 arguments（JSON 字符串）→ custom 工具的原始输入字符串。 */
function readCustomToolInput(argumentsText) {
  const raw = typeof argumentsText === 'string' ? argumentsText : '';
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed[CUSTOM_TOOL_PARAMETER] === 'string') return parsed[CUSTOM_TOOL_PARAMETER];
    if (typeof parsed === 'string') return parsed;
  } catch (_error) {
    // 上游可能直接给原始文本（不是 JSON）——原样透传。
  }
  return raw;
}

module.exports = {
  CUSTOM_TOOL_PARAMETER,
  collectToolDeclarations,
  flattenToolDeclaration,
  attachToolContext,
  readToolContext,
  readCustomToolInput
};
