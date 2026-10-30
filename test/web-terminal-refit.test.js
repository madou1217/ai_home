'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/components/chat/terminal-refit.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleForTest = { exports: {} };
vm.runInNewContext(compiled, { module: moduleForTest, exports: moduleForTest.exports, setTimeout, clearTimeout });
const { createTerminalRefitter, fitActiveTerminal } = moduleForTest.exports;

test('resize notifications are coalesced and fit the active terminal', () => {
  let scheduled;
  let canceled = 0;
  let fitted = 0;
  const refitter = createTerminalRefitter(
    () => { fitted += 1; },
    (callback) => { scheduled = callback; return 1; },
    () => { canceled += 1; }
  );
  refitter.notifyResize();
  refitter.notifyResize();
  assert.equal(fitted, 0);
  scheduled();
  assert.equal(fitted, 1);
  refitter.notifyResize();
  refitter.dispose();
  assert.equal(canceled, 1);
});

test('fitActiveTerminal never fits a hidden session and tolerates fit errors', () => {
  let fitted = 0;
  const instances = new Map([
    ['hidden', { opened: false, fit: { fit: () => { fitted += 1; } } }],
    ['active', { opened: true, fit: { fit: () => { throw new Error('no size'); } } }]
  ]);
  fitActiveTerminal(instances, 'hidden');
  fitActiveTerminal(instances, 'active');
  assert.equal(fitted, 0);
});

test('interactive fits are paced and release flushes the latest size immediately', () => {
  let now = 0;
  let frame;
  let timer;
  let timerCleared = false;
  let fitted = 0;
  const refitter = createTerminalRefitter(
    () => { fitted += 1; },
    (callback) => { frame = callback; return 1; },
    () => {},
    { minInterval: () => 64, now: () => now,
      setTimer: (callback) => { timer = callback; return 2; },
      clearTimer: () => { timerCleared = true; timer = undefined; } }
  );
  refitter.notifyResize();
  frame();
  now = 16;
  refitter.notifyResize();
  refitter.notifyResize();
  assert.equal(fitted, 1);
  assert.equal(typeof timer, 'function');
  refitter.flush();
  assert.equal(timerCleared, true);
  frame();
  assert.equal(fitted, 2);
  refitter.dispose();
});
