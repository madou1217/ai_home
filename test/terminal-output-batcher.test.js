'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalOutputBatcher } = require('../lib/server/terminal-output-batcher');

test('batches bursts without changing byte order and flushes before exit', () => {
  const events = [];
  const batch = createTerminalOutputBatcher((chunk) => events.push(['output', chunk]), { delayMs: 1000 });
  batch.push('A');
  batch.push('中文');
  batch.push('\x1b[0m');
  assert.deepEqual(events, []);
  batch.flush();
  events.push(['exit']);
  assert.deepEqual(events, [['output', 'A中文\x1b[0m'], ['exit']]);
});

test('large bursts flush immediately and later output stays ordered', () => {
  const output = [];
  const batch = createTerminalOutputBatcher((chunk) => output.push(chunk), { delayMs: 1000, maxBytes: 4 });
  batch.push('ab');
  batch.push('cd');
  batch.push('e');
  batch.flush();
  assert.deepEqual(output, ['abcd', 'e']);
});

test('small output is delivered after the latency window', async () => {
  const output = [];
  const batch = createTerminalOutputBatcher((chunk) => output.push(chunk), { delayMs: 5 });
  batch.push('prompt');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(output, ['prompt']);
});
