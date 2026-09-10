'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSseTransformStream, convertSseViaCanonical } = require('../lib/server/protocol-stream-pipeline');

const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({
  id: 'reasoning-probe', model: 'k3', choices: [{ index: 0, delta, finish_reason }]
})}\n\n`;
const parse = (text) => text.split('\n').filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6)));

test('separate usage after finish_reason reaches Responses exactly once before DONE', () => {
  const chunks = [];
  const stream = createSseTransformStream('openai_chat', 'openai_responses', { onChunk: (chunk) => chunks.push(chunk) });
  stream.write(frame({ content: 'answer' }) + frame({}, 'stop'));
  assert.equal(parse(chunks.join('')).some((event) => event.type === 'response.completed'), false);
  stream.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  stream.write('data: [DONE]\n\n');
  stream.end();
  const completed = parse(chunks.join('')).filter((event) => event.type === 'response.completed');
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].response.usage, { input_tokens: 100, output_tokens: 20, total_tokens: 120 });
  const raw = frame({ content: 'answer' }) + frame({}, 'stop')
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`;
  const { parseOpenAIChatSseToCanonicalEvents } = require('../lib/server/protocol-canonical');
  assert.deepEqual(parseOpenAIChatSseToCanonicalEvents(raw).at(-1).usage,
    { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
});

test('Kimi thinking reaches Responses before text or completion, with stable distinct output indexes', () => {
  const chunks = [];
  const transform = createSseTransformStream('openai_chat', 'openai_responses', {
    onChunk: (chunk) => chunks.push(chunk)
  });
  const reasoning = frame({ reasoning_content: '检查边界。' });
  transform.write(reasoning.slice(0, 15));
  assert.equal(chunks.length, 0);
  transform.write(reasoning.slice(15));
  let events = parse(chunks.join(''));
  assert.equal(events.at(-1).type, 'response.reasoning_summary_text.delta');
  assert.equal(events.at(-1).delta, '检查边界。');
  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  transform.write(frame({ reasoning_content: '再验证结果。' }));
  transform.write(frame({ tool_calls: [{ index: 0, id: 'call_probe', type: 'function',
    function: { name: 'lookup', arguments: '{}' } }] }));
  transform.write(frame({ content: '最终答案' }));
  transform.write(frame({}, 'tool_calls'));
  transform.end();
  events = parse(chunks.join(''));
  const added = events.filter((event) => event.type === 'response.output_item.added');
  assert.deepEqual(added.map((event) => [event.output_index, event.item.type]),
    [[0, 'reasoning'], [1, 'function_call'], [2, 'message']]);
  const output = events.at(-1).response.output;
  assert.deepEqual(output.map((item) => item.type), ['reasoning', 'function_call', 'message']);
  assert.equal(output[0].summary[0].text, '检查边界。再验证结果。');
  assert.equal(output[2].content[0].text, '最终答案');
  assert.equal(events.filter((event) => event.type === 'response.completed').length, 1);
  for (const event of events.filter((entry) => entry.item_id)) {
    assert.equal(event.item_id, output[event.output_index].id);
  }
});

test('buffered and incremental Responses conversions retain the same thinking and answer', () => {
  const raw = frame({ reasoning_content: 'thinking' }) + frame({ content: 'answer' }) + frame({}, 'stop');
  const stream = createSseTransformStream('openai_chat', 'openai_responses');
  stream.write(raw);
  const streamed = parse(stream.end());
  const buffered = parse(convertSseViaCanonical('openai_chat', 'openai_responses', raw));
  const project = (events) => events.map(({ type, delta, output_index }) => ({ type, delta, output_index }));
  assert.deepEqual(project(buffered), project(streamed));
});

test('truncated Kimi thinking and text never become a successful Responses completion', () => {
  const raw = frame({ reasoning_content: 'working' }) + frame({ content: '<html>unfinished' });
  const stream = createSseTransformStream('openai_chat', 'openai_responses');
  stream.write(raw);
  const streamed = parse(stream.end());
  const buffered = parse(convertSseViaCanonical('openai_chat', 'openai_responses', raw));
  for (const events of [streamed, buffered]) {
    assert.equal(events.some((event) => event.type === 'response.completed'), false);
    assert.equal(events.some((event) => event.type === 'response.output_item.done'), false);
    assert.equal(events.find((event) => event.type === 'response.output_text.delta').delta, '<html>unfinished');
    assert.equal(events.at(-1).type, 'response.failed');
    assert.equal(events.at(-1).response.error.code, 'stream_incomplete');
  }
});

test('Kimi token exhaustion preserves partial output and fails instead of claiming completion', () => {
  const raw = frame({ content: '<html>unfinished' }) + frame({}, 'length');
  const stream = createSseTransformStream('openai_chat', 'openai_responses');
  stream.write(raw);
  for (const events of [parse(stream.end()), parse(convertSseViaCanonical('openai_chat', 'openai_responses', raw))]) {
    assert.equal(events.some((event) => event.type === 'response.completed'), false);
    assert.equal(events.at(-1).response.error.code, 'max_output_tokens');
    assert.equal(events.find(event => event.type === 'response.output_text.delta').delta, '<html>unfinished');
  }
});
