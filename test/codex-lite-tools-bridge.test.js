'use strict';

// Codex「Responses lite」工具声明 → 非 Codex Provider 的协议桥适配器。
//
// 真机故障（2026-11-02）：`aih codex --model gpt-6.1-sol --model-alias kiro.2.glm-5` 的
// 工具调用不执行。Codex 把工具放在 `additional_tools` input item 里（lite 模式），
// 而 Responses→Chat 适配器只读 `tools` 字段 → kiro 收到的请求没有任何工具，
// 模型只能输出 `<tool_call>…</tool_call>` 文本。
//
// 这组用例守两件事：声明能被翻译成 Chat 工具；回来的调用能还原成 Codex 认识的
// `custom_tool_call` / 带命名空间的 `function_call`。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectToolDeclarations,
  attachToolContext,
  readToolContext,
  readCustomToolInput
} = require('../lib/server/protocol-codex-lite-tools');
const { convertOpenAIResponsesToOpenAIChat } = require('../lib/server/protocol-adapters');
const {
  renderOpenAIResponsesSseFromCanonicalEvents
} = require('../lib/server/protocol-canonical');
const { createSseTransformStream } = require('../lib/server/protocol-stream-pipeline');

const LITE_REQUEST = {
  model: 'gpt-6.1-sol',
  stream: true,
  input: [{
    type: 'additional_tools',
    role: 'developer',
    tools: [{
      type: 'namespace',
      name: 'functions',
      tools: [
        { type: 'custom', name: 'exec', description: 'Run JavaScript', format: { type: 'text' } },
        { type: 'function', name: 'wait', description: 'Wait', parameters: { type: 'object', properties: {} } }
      ]
    }, {
      type: 'namespace',
      name: 'clock',
      tools: [{ type: 'function', name: 'sleep', description: 'Sleep', parameters: { type: 'object', properties: {} } }]
    }]
  }, { role: 'user', content: [{ type: 'input_text', text: 'run it' }] }],
  tool_choice: 'auto'
};

test('声明翻译：additional_tools 的命名空间被展开成扁平 Chat 工具', () => {
  const declarations = collectToolDeclarations(LITE_REQUEST);
  assert.deepEqual(declarations.tools.map((tool) => tool.function.name), ['functions__exec', 'functions__wait', 'clock__sleep']);
  const exec = declarations.tools[0];
  // 自由文本工具：Chat 侧退化成单个字符串参数。
  assert.deepEqual(Object.keys(exec.function.parameters.properties), ['input']);
  assert.equal(exec.function.parameters.required[0], 'input');
  const custom = declarations.names.filter((entry) => entry.custom);
  assert.deepEqual(custom.map((entry) => entry.chatName), ['functions__exec']);
  // 与旧的 `tools` 字段声明并存时按名字去重。
  const merged = collectToolDeclarations({
    ...LITE_REQUEST,
    tools: [{ type: 'function', name: 'functions.wait', parameters: { type: 'object', properties: {} } }]
  });
  assert.equal(merged.tools.filter((tool) => tool.function.name === 'functions.wait').length, 1);
});

test('请求桥：additional_tools 进 tools，custom 调用回放成 Chat 工具消息', () => {
  const chat = convertOpenAIResponsesToOpenAIChat({
    ...LITE_REQUEST,
    input: [
      ...LITE_REQUEST.input,
      { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', namespace: 'functions', input: "text('hi')" },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'hi' }
    ]
  });
  assert.deepEqual(chat.tools.map((tool) => tool.function.name), ['functions__exec', 'functions__wait', 'clock__sleep']);
  const assistantCall = chat.messages.find((message) => Array.isArray(message.tool_calls));
  assert.equal(assistantCall.tool_calls[0].function.name, 'functions__exec');
  assert.deepEqual(JSON.parse(assistantCall.tool_calls[0].function.arguments), { input: "text('hi')" });
  const toolMessage = chat.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.equal(toolMessage.content, 'hi');
  // 上下文挂在对象上，且不参与 JSON 序列化（绝不发到上游）。
  const context = readToolContext(chat);
  assert.ok(context.custom.has('functions__exec'));
  assert.deepEqual(context.names.get('functions__exec'), { name: 'exec', namespace: 'functions' });
  assert.equal(JSON.stringify(chat).includes('codexLiteToolContext'), false);
});

test('响应渲染：custom 工具还原成 custom_tool_call（Codex 靠它派发）', () => {
  const chat = convertOpenAIResponsesToOpenAIChat(LITE_REQUEST);
  const toolContext = readToolContext(chat);
  const sse = createSseTransformStream('openai_chat', 'openai_responses', {
    fallbackModel: 'glm-5',
    toolContext
  });
  sse.write('data: {"id":"c1","model":"glm-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"functions__exec","arguments":"{\\"input\\":\\"text(1)\\"}"}}]}}]}\n\n');
  sse.write('data: {"id":"c1","model":"glm-5","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  sse.write('data: [DONE]\n\n');
  const output = sse.end();
  assert.match(output, /"type":"custom_tool_call"/);
  assert.match(output, /"name":"exec"/);
  assert.match(output, /"namespace":"functions"/);
  assert.match(output, /"input":"text\(1\)"/);
  assert.match(output, /response\.custom_tool_call_input\.delta/);
  assert.equal(output.includes('"type":"function_call"'), false);
});

test('响应渲染：命名空间里的普通函数保留 namespace，参数仍是 JSON', () => {
  const chat = convertOpenAIResponsesToOpenAIChat(LITE_REQUEST);
  const sse = createSseTransformStream('openai_chat', 'openai_responses', {
    fallbackModel: 'glm-5',
    toolContext: readToolContext(chat)
  });
  sse.write('data: {"id":"c1","model":"glm-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"clock__sleep","arguments":"{\\"ms\\":5}"}}]}}]}\n\n');
  sse.write('data: {"id":"c1","model":"glm-5","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  sse.write('data: [DONE]\n\n');
  const output = sse.end();
  assert.match(output, /"type":"function_call"/);
  assert.match(output, /"name":"sleep"/);
  assert.match(output, /"namespace":"clock"/);
  assert.match(output, /"arguments":"\{\\"ms\\":5\}"/);
});

test('响应渲染：没有工具上下文时行为不变（普通 function_call）', () => {
  const sse = createSseTransformStream('openai_chat', 'openai_responses', { fallbackModel: 'm' });
  sse.write('data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_3","type":"function","function":{"name":"get_weather","arguments":"{}"}}]}}]}\n\n');
  sse.write('data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  sse.write('data: [DONE]\n\n');
  const output = sse.end();
  assert.match(output, /"type":"function_call"/);
  assert.match(output, /"name":"get_weather"/);
  assert.equal(output.includes('namespace'), false);
});

test('custom 输入解码：JSON 包装、裸文本、空串', () => {
  assert.equal(readCustomToolInput('{"input":"raw"}'), 'raw');
  assert.equal(readCustomToolInput('raw text'), 'raw text');
  assert.equal(readCustomToolInput(''), '');
  assert.equal(readCustomToolInput('{"other":1}'), '{"other":1}');
});

test('attachToolContext 幂等且不改变对象可见键', () => {
  const chat = convertOpenAIResponsesToOpenAIChat(LITE_REQUEST);
  const before = Object.keys(chat);
  attachToolContext(chat, { names: [] });
  assert.deepEqual(Object.keys(chat), before);
});

test('renderOpenAIResponsesSseFromCanonicalEvents 仍是纯渲染器（无上下文路径不变）', () => {
  const sse = renderOpenAIResponsesSseFromCanonicalEvents([
    { type: 'message_start', id: 'r1', model: 'm' },
    { type: 'tool_call_start', index: 0, id: 'call_1', name: 'fn' },
    { type: 'tool_call_delta', index: 0, delta: '{}' },
    { type: 'tool_call_done', index: 0 },
    { type: 'message_stop', finishReason: 'tool_calls' }
  ], 'm');
  assert.match(sse, /"type":"function_call"/);
});
