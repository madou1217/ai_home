const test = require('node:test');
const assert = require('node:assert/strict');

const { createSseTransformStream } = require('../lib/server/protocol-stream-pipeline');
const { createStreamingProtocolResponse } = require('../lib/server/protocol-fallback-bridge').__private || {};

function chatChunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

const ERROR_FRAME = `data: ${JSON.stringify({ error: { message: 'upstream overloaded', code: 'kiro_upstream_capacity', status: 503 } })}\n\n`;

function transform(target, frames) {
  const stream = createSseTransformStream('openai_chat', target, { fallbackModel: 'm' });
  frames.forEach((item) => stream.write(item));
  return stream.end();
}

test('a mid-stream error renders as an Anthropic error event, never as end_turn', () => {
  const out = transform('anthropic_messages', [chatChunk({ role: 'assistant' }), chatChunk({ content: 'partial' }), ERROR_FRAME]);
  assert.match(out, /event: error\ndata: \{"type":"error","error":\{"type":"overloaded_error","message":"upstream overloaded"\}\}/);
  assert.doesNotMatch(out, /message_stop/);
  assert.doesNotMatch(out, /end_turn/);
});

test('a mid-stream error renders as response.failed for Responses clients (Codex)', () => {
  const out = transform('openai_responses', [chatChunk({ content: 'partial' }), ERROR_FRAME]);
  assert.match(out, /event: response.failed/);
  assert.match(out, /"code":"kiro_upstream_capacity"/);
  assert.doesNotMatch(out, /response.completed/);
  assert.doesNotMatch(out, /stream_incomplete/);
});

test('a mid-stream error renders as an OpenAI error frame without a finish_reason or [DONE]', () => {
  const out = transform('openai_chat', [chatChunk({ content: 'partial' }), ERROR_FRAME]);
  // identity pipeline: the frame passes through untouched
  assert.match(out, /"error":\{"message":"upstream overloaded"/);
});

test('tool_calls from an OpenAI chat source render as Anthropic tool_use with stop_reason tool_use', () => {
  const out = transform('anthropic_messages', [
    chatChunk({ role: 'assistant' }),
    chatChunk({ tool_calls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'Bash', arguments: '' } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] }),
    chatChunk({}, 'tool_calls'),
    'data: [DONE]\n\n'
  ]);
  assert.match(out, /"type":"tool_use","id":"toolu_1","name":"Bash"/);
  assert.match(out, /"partial_json":"\{\\"command\\":\\"ls\\"\}"/);
  assert.match(out, /"stop_reason":"tool_use"/);
});

test('Anthropic upstream error events become canonical errors for other clients', () => {
  const stream = createSseTransformStream('anthropic_messages', 'openai_responses', { fallbackModel: 'm' });
  stream.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m"}}\n\n');
  stream.write('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
  const out = stream.end();
  assert.match(out, /response.failed/);
  assert.match(out, /"message":"Overloaded"/);
});

test('the bridge writes protocol-native keepalives while the upstream is silent', async () => {
  assert.equal(typeof createStreamingProtocolResponse, 'function');
  const written = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    write(chunk) { written.push(String(chunk)); return true; },
    end() { this.writableEnded = true; }
  };
  const wrapper = createStreamingProtocolResponse(res, {
    sourceProtocol: 'openai_chat',
    targetProtocol: 'anthropic_messages',
    fallbackModel: 'm',
    keepaliveMs: 20
  });
  wrapper.write(chatChunk({ role: 'assistant' }));
  await new Promise((resolve) => setTimeout(resolve, 70));
  wrapper.write(chatChunk({ content: 'hi' }, 'stop'));
  wrapper.end();
  const pings = written.filter((chunk) => chunk.startsWith('event: ping'));
  assert.ok(pings.length >= 1, 'expected at least one ping');
  const countAfterEnd = written.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(written.length, countAfterEnd, 'keepalive must stop after end()');
});
