'use strict';

// Codex「Responses lite」经旧版中转网关的兼容层（出站降级 + 回程升格）。
//
// 真机故障（2026-11-02）：TUI 用 `--model-alias gemini-3.8-flash-high` 时一直「没有回复」。
// 上游是中转的另一台旧版 AIH 网关：它只读 `tools`，Codex 的 `additional_tools` 被丢，
// 模型想读 MEMORY.md 时只输出 reasoning 就结束。本机在转发前后各做一次翻译。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCodexLitePayload,
  buildCodexLiteDowngrade,
  createCodexLiteResponseUpgrader,
  upgradeCodexLiteBufferedBody
} = require('../lib/server/codex-relay-lite-bridge');

const LITE_PAYLOAD = {
  model: 'gpt-6.1-sol',
  stream: true,
  input: [
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [
      { type: 'custom', name: 'exec', description: 'Run JavaScript', format: { type: 'text' } },
      { type: 'function', name: 'wait', description: 'Wait', parameters: { type: 'object', properties: {} } }
    ] }] },
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }
  ],
  tool_choice: 'auto'
};

test('出站降级：additional_tools 换成普通 tools，input 里不再有它', () => {
  assert.equal(isCodexLitePayload(LITE_PAYLOAD), true);
  const downgraded = buildCodexLiteDowngrade(LITE_PAYLOAD);
  assert.ok(downgraded);
  assert.deepEqual(downgraded.payload.tools.map((t) => t.name), ['functions__exec', 'functions__wait']);
  assert.equal(downgraded.payload.input.some((item) => item.type === 'additional_tools'), false);
  assert.equal(downgraded.payload.input.length, 1);
  // 其余字段原样。
  assert.equal(downgraded.payload.model, 'gpt-6.1-sol');
  assert.equal(downgraded.payload.tool_choice, 'auto');
  // 上下文：exec 是自由文本工具。
  assert.deepEqual([...downgraded.context.custom], ['functions__exec']);
  assert.deepEqual(downgraded.context.names.get('functions__exec'), { name: 'exec', namespace: 'functions' });
});

test('出站降级：非 lite / 没有工具声明时不动', () => {
  assert.equal(buildCodexLiteDowngrade({ model: 'm', input: 'hi' }), null);
  assert.equal(buildCodexLiteDowngrade({ model: 'm', input: [{ type: 'additional_tools', role: 'developer', tools: [] }] }), null);
  assert.equal(isCodexLitePayload(null), false);
});

async function runUpgrader(context, chunks) {
  const upgrader = createCodexLiteResponseUpgrader(context);
  const writer = upgrader.writable.getWriter();
  const reader = upgrader.readable.getReader();
  const out = [];
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(Buffer.from(value).toString('utf8'));
    }
  })();
  for (const chunk of chunks) await writer.write(Buffer.from(chunk, 'utf8'));
  await writer.close();
  await reading;
  return out.join('');
}

function contextOf(payload) {
  return buildCodexLiteDowngrade(payload).context;
}

test('回程升格：function_call(functions__exec) → custom_tool_call（name/namespace/input）', async () => {
  const context = contextOf(LITE_PAYLOAD);
  const added = `event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: 'call_1', name: 'functions__exec', arguments: '' } })}\n\n`;
  const delta = `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"input":"text' })}\n\n`;
  const done = `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"input":"text(1)"}' })}\n\n`;
  const item = { id: 'fc_1', type: 'function_call', status: 'completed', call_id: 'call_1', name: 'functions__exec', arguments: '{"input":"text(1)"}' };
  const itemDone = `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`;
  const completed = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [item] } })}\n\n`;

  const output = await runUpgrader(context, [added, delta, done, itemDone, completed]);
  assert.match(output, /"type":"custom_tool_call"/);
  assert.match(output, /"name":"exec"/);
  assert.match(output, /"namespace":"functions"/);
  assert.match(output, /"input":"text\(1\)"/);
  // 增量参数（JSON 包装）与 done 事件都被丢掉，避免 Codex 把 JSON 当原始输入。
  assert.equal(output.includes('"type":"response.function_call_arguments'), false);
  // completed 的 output 数组同样升格。
  assert.equal((output.match(/"type":"custom_tool_call"/g) || []).length >= 2, true);
});

test('回程升格：命名空间函数工具只改 name/namespace，参数仍走 JSON', async () => {
  const context = contextOf(LITE_PAYLOAD);
  const item = { id: 'fc_2', type: 'function_call', status: 'completed', call_id: 'call_2', name: 'functions__wait', arguments: '{"ms":5}' };
  const output = await runUpgrader(context, [
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}\n\n`
  ]);
  assert.match(output, /"type":"function_call"/);
  assert.match(output, /"name":"wait"/);
  assert.match(output, /"namespace":"functions"/);
  assert.match(output, /"arguments":"\{\\"ms\\":5\}"/);
});

test('回程升格：未知工具与普通事件逐字节透传', async () => {
  const context = contextOf(LITE_PAYLOAD);
  const block = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';
  const output = await runUpgrader(context, [block]);
  assert.equal(output, block);
});

test('非流式 JSON 同样升格；解析失败原样返回', () => {
  const context = contextOf(LITE_PAYLOAD);
  const body = JSON.stringify({ id: 'r1', status: 'completed', output: [
    { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'functions__exec', arguments: '{"input":"text(1)"}' }
  ] });
  const upgraded = JSON.parse(upgradeCodexLiteBufferedBody(body, context));
  assert.equal(upgraded.output[0].type, 'custom_tool_call');
  assert.equal(upgraded.output[0].input, 'text(1)');
  assert.equal(upgradeCodexLiteBufferedBody('not json', context), 'not json');
});

test('出站降级：历史里的 custom_tool_call(_output) 也换成普通 function_call(_output)', () => {
  const downgraded = buildCodexLiteDowngrade({
    ...LITE_PAYLOAD,
    input: [
      ...LITE_PAYLOAD.input,
      { type: 'custom_tool_call', call_id: 'call_1', name: 'exec', namespace: 'functions', input: "text('hi')" },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'hi' }
    ]
  });
  const call = downgraded.payload.input.find((item) => item.type === 'function_call');
  assert.equal(call.name, 'functions__exec');
  assert.equal(call.call_id, 'call_1');
  assert.deepEqual(JSON.parse(call.arguments), { input: "text('hi')" });
  const output = downgraded.payload.input.find((item) => item.type === 'function_call_output');
  assert.equal(output.call_id, 'call_1');
  assert.equal(output.output, 'hi');
});
