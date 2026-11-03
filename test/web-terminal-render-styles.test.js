'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/components/chat/terminal-render-styles.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { module: loaded, exports: loaded.exports });
const { avoidDuplicateTerminalStyleWrites } = loaded.exports;

class TestNode {
  constructor(text) { this.value = text; this.writes = 0; }
  get textContent() { return this.value; }
  set textContent(value) { this.writes += 1; this.value = value === null ? '' : String(value); }
}

function terminal(styles, NodeType = TestNode) {
  return {
    ownerDocument: { defaultView: { Node: NodeType } },
    querySelectorAll(selector) { assert.equal(selector, '.xterm-screen > style'); return styles; },
  };
}

test('skips only identical style writes while preserving changed themes and cleanup', () => {
  const dimensions = new TestNode('dimensions css');
  const theme = new TestNode('dark theme');
  const restore = avoidDuplicateTerminalStyleWrites(terminal([dimensions, theme]));
  for (let i = 0; i < 100; i++) dimensions.textContent = 'dimensions css';
  assert.equal(dimensions.writes, 0);
  theme.textContent = 'light theme';
  assert.equal(theme.textContent, 'light theme');
  assert.equal(theme.writes, 1);
  theme.textContent = 'light theme';
  assert.equal(theme.writes, 1);
  restore();
  dimensions.textContent = 'dimensions css';
  assert.equal(dimensions.writes, 1);
  theme.textContent = 'dark theme';
  assert.equal(theme.writes, 2);
  restore();
});

test('leaves existing custom accessors alone and fails open without the native descriptor', () => {
  const style = new TestNode('original');
  Object.defineProperty(style, 'textContent', { configurable: true, get: () => 'custom', set: () => {} });
  const oldDescriptor = Object.getOwnPropertyDescriptor(style, 'textContent');
  avoidDuplicateTerminalStyleWrites(terminal([style]))();
  assert.equal(Object.getOwnPropertyDescriptor(style, 'textContent').get, oldDescriptor.get);
  assert.doesNotThrow(() => avoidDuplicateTerminalStyleWrites(terminal([new TestNode('x')], class {}))());
  assert.doesNotThrow(() => avoidDuplicateTerminalStyleWrites({ ownerDocument: { defaultView: null } })());
  const sealed = Object.preventExtensions(new TestNode('sealed'));
  assert.doesNotThrow(() => avoidDuplicateTerminalStyleWrites(terminal([sealed]))());
  sealed.textContent = 'sealed';
  assert.equal(sealed.writes, 1);
});

test('cleanup does not remove a replacement accessor installed by another owner', () => {
  const style = new TestNode('original');
  const restore = avoidDuplicateTerminalStyleWrites(terminal([style]));
  const replacement = () => 'replacement';
  Object.defineProperty(style, 'textContent', { configurable: true, get: replacement });
  restore();
  assert.equal(Object.getOwnPropertyDescriptor(style, 'textContent').get, replacement);
});
