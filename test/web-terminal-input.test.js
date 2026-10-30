'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/components/chat/terminal-input.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleForTest = { exports: {} };
vm.runInNewContext(compiled, { module: moduleForTest, exports: moduleForTest.exports });
const { flushTerminalInput } = moduleForTest.exports;

test('input waits for reattachment and preserves its order', async () => {
  const state = { termId: 'old', inputBuf: 'first', sending: false, inputReady: false };
  const calls = [];
  const send = async (id, text) => { calls.push([id, text]); return { ok: true }; };
  await flushTerminalInput(state, send, () => {}, () => {});
  assert.deepEqual(calls, []);
  state.inputBuf += '-second';
  state.termId = 'new';
  state.inputReady = true;
  await flushTerminalInput(state, send, () => {}, () => {});
  assert.deepEqual(calls, [['new', 'first-second']]);
  assert.equal(state.inputBuf, '');
});

test('only a definite missing terminal retries a rejected chunk', async () => {
  const state = { termId: 'old', inputBuf: 'command\r', sending: false, inputReady: true };
  let missing = 0;
  let uncertain = 0;
  await flushTerminalInput(state, async () => ({ ok: false, error: 'terminal_not_found' }), () => { missing += 1; }, () => { uncertain += 1; });
  assert.equal(missing, 1);
  assert.equal(state.inputReady, false);
  assert.equal(state.inputBuf, 'command\r');
  state.termId = 'new';
  state.inputReady = true;
  const sent = [];
  await flushTerminalInput(state, async (id, text) => { sent.push([id, text]); return { ok: true }; }, () => {}, () => {});
  assert.deepEqual(sent, [['new', 'command\r']]);
  state.inputBuf = 'possibly-executed\r';
  await flushTerminalInput(state, async () => { throw new Error('connection lost'); }, () => {}, () => { uncertain += 1; });
  assert.equal(state.inputBuf, '');
  assert.equal(uncertain, 1);
});

test('a reconnect during an in-flight write does not strand later input', async () => {
  const state = { termId: 'old', inputBuf: 'first', sending: false, inputReady: true };
  const calls = [];
  let finishFirst;
  const send = (id, text) => {
    calls.push([id, text]);
    if (calls.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
    return Promise.resolve({ ok: true });
  };
  const first = flushTerminalInput(state, send, () => {}, () => {});
  state.inputReady = false;
  state.inputBuf = 'second';
  state.termId = 'new';
  state.inputReady = true;
  await flushTerminalInput(state, send, () => {}, () => {});
  finishFirst({ ok: false, error: 'terminal_request_failed' });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['old', 'first'], ['new', 'second']]);
  assert.equal(state.inputBuf, '');
});
