// 协议一致性矩阵：同一组上游流（OpenAI Chat 语义，所有回落型 provider transport 的公共产出形态）
// × 每一种客户端协议（Claude Code = anthropic_messages、Codex = openai_responses、OpenAI chat、Gemini）。
// 每格断言「客户端看到的终态」与「工具调用是否完整送达」，而不是逐字节比对——
// 新增 provider 只要产出这组语义，就自动在所有客户端协议下成立；新增客户端协议只需加一个终态读取器。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSseTransformStream } = require('../lib/server/protocol-stream-pipeline');

function chunk(delta, finishReason = null, extra = {}) {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`;
}
const DONE = 'data: [DONE]\n\n';
const USAGE = { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
const toolStart = (index, id, name) => chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] });
const toolArgs = (index, args) => chunk({ tool_calls: [{ index, function: { arguments: args } }] });
const errorFrame = `data: ${JSON.stringify({ error: { message: 'upstream overloaded', code: 'kiro_upstream_capacity', status: 503 } })}\n\n`;

// 上游流 fixture（kiro 2026-10-19 真机产出的形状：首帧 role、文本 delta、工具分片、finish + usage、[DONE]）。
const FIXTURES = {
  text: {
    frames: [chunk({ role: 'assistant' }), chunk({ content: 'Hello' }), chunk({ content: ' world' }), chunk({}, 'stop', USAGE), DONE],
    expect: { terminal: 'completed', reason: 'stop', tools: [] }
  },
  single_tool: {
    frames: [chunk({ role: 'assistant' }), chunk({ content: 'Checking.' }), toolStart(0, 'toolu_1', 'Bash'),
      toolArgs(0, '{"command":'), toolArgs(0, '"ls"}'), chunk({}, 'tool_calls', USAGE), DONE],
    expect: { terminal: 'completed', reason: 'tool_use', tools: [['toolu_1', 'Bash', { command: 'ls' }]] }
  },
  parallel_tools: {
    frames: [chunk({ role: 'assistant' }), toolStart(0, 't_a', 'Read'), toolArgs(0, '{"path":"a"}'),
      toolStart(1, 't_b', 'Read'), toolArgs(1, '{"path":"b"}'), chunk({}, 'tool_calls', USAGE), DONE],
    expect: { terminal: 'completed', reason: 'tool_use', tools: [['t_a', 'Read', { path: 'a' }], ['t_b', 'Read', { path: 'b' }]] }
  },
  mid_stream_error: {
    frames: [chunk({ role: 'assistant' }), chunk({ content: 'partial' }), errorFrame],
    expect: { terminal: 'failed', tools: [] }
  }
};

function sseEvents(text) {
  const events = [];
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n');
    const event = (lines.find((line) => line.startsWith('event: ')) || '').slice(7);
    const dataLine = lines.find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    const raw = dataLine.slice(6);
    events.push({ event, data: raw === '[DONE]' ? '[DONE]' : JSON.parse(raw) });
  }
  return events;
}

// 每种客户端协议一个终态读取器：{ terminal: completed|failed|none, reason, tools:[[id,name,args]] }。
const READERS = {
  anthropic_messages(events) {
    const tools = [];
    const blocks = new Map();
    let reason = '';
    for (const { event, data } of events) {
      if (event === 'content_block_start' && data.content_block.type === 'tool_use') {
        blocks.set(data.index, { id: data.content_block.id, name: data.content_block.name, json: '' });
      }
      if (event === 'content_block_delta' && data.delta.type === 'input_json_delta') blocks.get(data.index).json += data.delta.partial_json;
      if (event === 'content_block_stop' && blocks.has(data.index)) {
        const block = blocks.get(data.index);
        tools.push([block.id, block.name, JSON.parse(block.json || '{}')]);
      }
      if (event === 'message_delta') reason = data.delta.stop_reason === 'end_turn' ? 'stop' : data.delta.stop_reason;
    }
    if (events.some((item) => item.event === 'error')) return { terminal: 'failed', tools };
    return { terminal: events.some((item) => item.event === 'message_stop') ? 'completed' : 'none', reason, tools };
  },
  openai_responses(events) {
    const tools = events
      .filter((item) => item.event === 'response.output_item.done' && item.data.item.type === 'function_call')
      .map((item) => [item.data.item.call_id, item.data.item.name, JSON.parse(item.data.item.arguments || '{}')]);
    if (events.some((item) => item.event === 'response.failed')) return { terminal: 'failed', tools };
    const completed = events.some((item) => item.event === 'response.completed');
    return { terminal: completed ? 'completed' : 'none', reason: tools.length ? 'tool_use' : 'stop', tools };
  },
  openai_chat(events) {
    const calls = new Map();
    let reason = '';
    let failed = false;
    for (const { data } of events) {
      if (data === '[DONE]') continue;
      if (data.error) failed = true;
      const choice = data.choices && data.choices[0];
      if (!choice) continue;
      for (const call of (choice.delta && choice.delta.tool_calls) || []) {
        const current = calls.get(call.index) || { id: '', name: '', args: '' };
        if (call.id) current.id = call.id;
        if (call.function && call.function.name) current.name = call.function.name;
        current.args += (call.function && call.function.arguments) || '';
        calls.set(call.index, current);
      }
      if (choice.finish_reason) reason = choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason;
    }
    const tools = [...calls.values()].map((call) => [call.id, call.name, JSON.parse(call.args || '{}')]);
    if (failed) return { terminal: 'failed', tools };
    return { terminal: reason ? 'completed' : 'none', reason, tools };
  },
  gemini_stream_generate_content(events) {
    const tools = [];
    let reason = '';
    let failed = false;
    for (const { data } of events) {
      if (data.error) failed = true;
      const candidate = data.candidates && data.candidates[0];
      if (!candidate) continue;
      for (const part of (candidate.content && candidate.content.parts) || []) {
        if (part.functionCall) tools.push([part.functionCall.id, part.functionCall.name, part.functionCall.args]);
      }
      if (candidate.finishReason) reason = candidate.finishReason;
    }
    if (failed) return { terminal: 'failed', tools };
    // Gemini 没有独立的「工具调用」终止原因：工具调用以 functionCall part 表达、finishReason=STOP。
    return { terminal: reason ? 'completed' : 'none', reason: tools.length ? 'tool_use' : 'stop', tools };
  }
};

for (const [target, read] of Object.entries(READERS)) {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    test(`conformance: openai_chat upstream "${name}" -> ${target}`, () => {
      const transform = createSseTransformStream('openai_chat', target, { fallbackModel: 'm' });
      fixture.frames.forEach((frame) => transform.write(frame));
      const result = read(sseEvents(transform.end()));
      assert.equal(result.terminal, fixture.expect.terminal, 'terminal state');
      if (fixture.expect.reason) assert.equal(result.reason, fixture.expect.reason, 'stop reason');
      assert.deepEqual(result.tools, fixture.expect.tools, 'tool calls delivered intact');
    });
  }
}
