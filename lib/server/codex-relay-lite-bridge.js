'use strict';

// Codex「Responses lite」在**中转账号**上的兼容层。
//
// 场景（2026-11-02 真机）：本机的 Codex API-key 账号指向另一台 AIH 网关（中转）。
// Codex 对 `use_responses_lite` 的模型（gpt-6.1-sol）把工具放在 `additional_tools` input
// item 里，而旧版中转只读 `tools` —— 工具被丢，模型想调工具时只输出一段 reasoning 就结束，
// 客户端看到的是「一直转圈、没有回复」。本机已经把 Responses→Chat/Gemini 桥修好了
// （protocol-codex-lite-tools），但中转是旧版本，请求在到达它之前就得降级。
//
// 做法：出站前把 `additional_tools` 换成普通的 `tools`（命名空间拍平成安全名字），
// 回程再把中转产出的 `function_call` 升回 Codex 认识的 `custom_tool_call` / 带 namespace
// 的 `function_call`。只对**中转账号 + lite 请求**生效，其余请求逐字节不变。

const { collectToolDeclarations, readCustomToolInput } = require('./protocol-codex-lite-tools');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 请求是否带 Codex lite 的工具声明。 */
function isCodexLitePayload(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return false;
  return payload.input.some((item) => isRecord(item) && String(item.type || '') === 'additional_tools');
}

/**
 * 出站降级：`additional_tools` → 普通 `tools`。
 * @returns {{payload: object, context: {custom: Set<string>, names: Map<string, {name: string, namespace: string}>}}|null}
 */
function buildCodexLiteDowngrade(payload) {
  if (!isCodexLitePayload(payload)) return null;
  const declarations = collectToolDeclarations(payload);
  if (!declarations.tools.length) return null;
  const input = payload.input
    .filter((item) => !(isRecord(item) && String(item.type || '') === 'additional_tools'))
    .map((item) => downgradeHistoryItem(item));
  const tools = declarations.tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters
  }));
  return {
    payload: { ...payload, input, tools },
    context: {
      custom: new Set(declarations.names.filter((entry) => entry.custom).map((entry) => entry.chatName)),
      names: new Map(declarations.names.map((entry) => [entry.chatName, { name: entry.name, namespace: entry.namespace }]))
    }
  };
}

/** 历史里的自由文本工具调用/结果 → 普通 function_call / function_call_output（旧中转只认这两种）。 */
function downgradeHistoryItem(item) {
  if (!isRecord(item)) return item;
  const type = String(item.type || '');
  const namespace = String(item.namespace || '').trim();
  const name = String(item.name || '').trim();
  const qualified = namespace && name ? `${namespace}__${name}` : name;
  if (type === 'custom_tool_call') {
    const { input, namespace: _namespace, ...rest } = item;
    return {
      ...rest,
      type: 'function_call',
      ...(qualified ? { name: qualified } : {}),
      arguments: JSON.stringify({ input: String(input || '') })
    };
  }
  if (type === 'custom_tool_call_output') {
    return { ...item, type: 'function_call_output' };
  }
  return item;
}

function upgradeToolItem(item, context) {
  if (!isRecord(item) || item.type !== 'function_call') return item;
  const meta = context.names.get(String(item.name || ''));
  if (!meta) return item;
  if (context.custom.has(String(item.name || ''))) {
    const { arguments: rawArguments, ...rest } = item;
    return {
      ...rest,
      type: 'custom_tool_call',
      name: meta.name,
      ...(meta.namespace ? { namespace: meta.namespace } : {}),
      input: readCustomToolInput(rawArguments),
      status: item.status || 'completed'
    };
  }
  return {
    ...item,
    name: meta.name,
    ...(meta.namespace ? { namespace: meta.namespace } : {})
  };
}

/** 单个 SSE 事件（已解析的 data JSON）→ 新事件或 null（丢弃）。 */
function upgradeResponseEvent(event, context, customIds) {
  if (!isRecord(event)) return event;
  const type = String(event.type || '');
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = upgradeToolItem(event.item, context);
    if (item && item.type === 'custom_tool_call' && item.id) customIds.add(String(item.id));
    return { ...event, item };
  }
  if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
    // 自由文本工具的输入由 output_item.done 一次性交付；增量参数是 JSON 包装，直接丢掉。
    if (customIds.has(String(event.item_id || ''))) return null;
    const meta = context.names.get(String(event.name || ''));
    return meta ? { ...event } : event;
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    const response = isRecord(event.response) ? event.response : null;
    if (!response || !Array.isArray(response.output)) return event;
    return { ...event, response: { ...response, output: response.output.map((item) => upgradeToolItem(item, context)) } };
  }
  return event;
}

/**
 * 回程升格：把上游 SSE 里的 `function_call` 改成 Codex 期望的形状。
 * 返回一个 web TransformStream（fetch 的 body 可以直接 pipeThrough）。
 */
function createCodexLiteResponseUpgrader(context) {
  const customIds = new Set();
  let buffer = '';
  const rewrite = (chunk) => {
    buffer += chunk;
    let out = '';
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = buffer.slice(0, index + 2);
      buffer = buffer.slice(index + 2);
      out += rewriteBlock(block, context, customIds);
      index = buffer.indexOf('\n\n');
    }
    return out;
  };
  return new TransformStream({
    transform(chunk, controller) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const out = rewrite(text);
      if (out) controller.enqueue(Buffer.from(out, 'utf8'));
    },
    flush(controller) {
      if (buffer) {
        const out = rewriteBlock(buffer, context, customIds);
        buffer = '';
        if (out) controller.enqueue(Buffer.from(out, 'utf8'));
      }
    }
  });
}

function rewriteBlock(block, context, customIds) {
  const lines = block.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event: '));
  const dataIndex = lines.findIndex((line) => line.startsWith('data: '));
  if (dataIndex < 0) return block;
  const raw = lines[dataIndex].slice(6);
  if (raw === '[DONE]') return block;
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_error) { return block; }
  const next = upgradeResponseEvent(parsed, context, customIds);
  if (next === null) return '';
  if (next === parsed) return block;
  lines[dataIndex] = `data: ${JSON.stringify(next)}`;
  const eventType = String(next.type || '');
  if (eventLine && eventType) lines[lines.indexOf(eventLine)] = `event: ${eventType}`;
  return lines.join('\n');
}

/** 非流式 JSON 响应（buffered）同样升格。失败原样返回。 */
function upgradeCodexLiteBufferedBody(bodyText, context) {
  try {
    const parsed = JSON.parse(bodyText);
    // 非流式体就是 response 对象本身（没有 SSE 的 type 字段）。
    const output = isRecord(parsed) && Array.isArray(parsed.output) ? parsed.output : null;
    if (!output) return bodyText;
    return JSON.stringify({ ...parsed, output: output.map((item) => upgradeToolItem(item, context)) });
  } catch (_error) {
    return bodyText;
  }
}

/** 逐事件升格工厂（codex-adapter 的流式转发按事件重写，比按字节改写更精确）。 */
function createCodexLiteEventUpgrader(context) {
  const customIds = new Set();
  return (event) => upgradeResponseEvent(event, context, customIds);
}

module.exports = {
  isCodexLitePayload,
  createCodexLiteEventUpgrader,
  buildCodexLiteDowngrade,
  createCodexLiteResponseUpgrader,
  upgradeCodexLiteBufferedBody,
  __private: { upgradeResponseEvent, upgradeToolItem }
};
