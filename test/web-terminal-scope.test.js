'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/features/web-terminal/web-terminal-scope.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleForTest = { exports: {} };
vm.runInNewContext(compiled, { module: moduleForTest, exports: moduleForTest.exports });
const { updateTerminalScope } = moduleForTest.exports;

test('late session changes update their originating server without altering the active server', () => {
  const stored = new Map([['local', ['first']], ['remote', ['remote-session']]]);
  const read = (id) => stored.get(id) || [];
  const persist = (id, state) => stored.set(id, state);
  const current = { serverId: 'remote', state: stored.get('remote') };
  const afterOpen = updateTerminalScope(current, 'local', (items) => [...items, 'new'], read, persist);
  assert.equal(afterOpen, current);
  assert.deepEqual(stored.get('local'), ['first', 'new']);
  assert.deepEqual(stored.get('remote'), ['remote-session']);
  const afterClose = updateTerminalScope(current, 'local', (items) => items.filter((item) => item !== 'first'), read, persist);
  assert.equal(afterClose, current);
  assert.deepEqual(stored.get('local'), ['new']);
});

test('updates to the active server update both rendered state and storage', () => {
  const stored = new Map();
  const current = { serverId: 'local', state: ['first'] };
  const next = updateTerminalScope(current, 'local', (items) => [...items, 'second'], () => [], (id, state) => stored.set(id, state));
  assert.notEqual(next, current);
  assert.equal(next.serverId, 'local');
  assert.deepEqual(next.state, ['first', 'second']);
  assert.deepEqual(stored.get('local'), next.state);
});
