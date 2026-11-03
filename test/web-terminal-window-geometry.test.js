'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/features/web-terminal/terminal-window-geometry.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { module: loaded, exports: loaded.exports });
const { moveTerminalWindow } = loaded.exports;
const plain = (value) => JSON.parse(JSON.stringify(value));
const start = { x: 100, y: 100, width: 700, height: 400 };

test('dragging stays in the viewport without changing window size', () => {
  assert.deepEqual(plain(moveTerminalWindow(start, 'move', 1000, -500, 1200, 800)),
    { x: 492, y: 8, width: 700, height: 400 });
});

test('resizing keeps the opposite edge fixed at minimum size and screen edges', () => {
  assert.deepEqual(plain(moveTerminalWindow(start, 'nw', 1000, 1000, 1200, 800)),
    { x: 380, y: 320, width: 420, height: 180 });
  assert.deepEqual(plain(moveTerminalWindow(start, 'se', 1000, 1000, 1200, 800)),
    { x: 100, y: 100, width: 1092, height: 692 });
  assert.deepEqual(plain(moveTerminalWindow(start, 'w', -1000, 0, 1200, 800)),
    { x: 8, y: 100, width: 792, height: 400 });
});

test('small viewports can use the full available area', () => {
  assert.deepEqual(plain(moveTerminalWindow({ x: 8, y: 8, width: 344, height: 284 }, 'se', 100, 100, 360, 300)),
    { x: 8, y: 8, width: 344, height: 284 });
});
