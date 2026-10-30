'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clearWebTerminalScreen } = require('../lib/cli/services/pty/web-terminal-screen');
const { setRuntimeMarkerField } = require('../lib/runtime/persistent-session');

test('successful Web Terminal CLI exit clears the previous screen', () => {
  const env = {};
  setRuntimeMarkerField(env, 'web', '1');
  const writes = [];
  const processObj = { env, stdout: { isTTY: true, write: (value) => writes.push(value) } };
  assert.equal(clearWebTerminalScreen(processObj, { exitCode: 0 }), true);
  assert.deepEqual(writes, ['\x1b[2J\x1b[3J\x1b[H']);
});

test('ordinary terminals, login and failed CLI runs keep their output', () => {
  const writes = [];
  const output = { isTTY: true, write: (value) => writes.push(value) };
  const web = { env: { AIH_RUNTIME_MARKER: 'web=1' }, stdout: output };
  assert.equal(clearWebTerminalScreen({ env: {}, stdout: output }, { exitCode: 0 }), false);
  assert.equal(clearWebTerminalScreen(web, { exitCode: 1 }), false);
  assert.equal(clearWebTerminalScreen(web, { exitCode: 0, isLogin: true }), false);
  assert.equal(clearWebTerminalScreen(web, { exitCode: 0, headless: true }), false);
  assert.deepEqual(writes, []);
});

test('a closed output stream cannot prevent CLI cleanup', () => {
  const processObj = { env: { AIH_RUNTIME_MARKER: 'web=1' }, stdout: { isTTY: true, write() { throw new Error('closed'); } } };
  assert.equal(clearWebTerminalScreen(processObj, { exitCode: 0 }), false);
});
