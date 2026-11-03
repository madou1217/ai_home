'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

function loadClipboard({ clipboard, copyResult = true }) {
  const events = [];
  const previousFocus = { focus: () => events.push('restore-focus') };
  class HTMLElement {}
  Object.setPrototypeOf(previousFocus, HTMLElement.prototype);
  const textarea = {
    style: {},
    setAttribute() {},
    focus() { events.push('focus'); },
    select() { events.push('select'); },
    remove() { events.push('remove'); }
  };
  const document = {
    activeElement: previousFocus,
    body: { appendChild: () => events.push('append') },
    createElement: () => textarea,
    execCommand: (command) => { events.push(command); return copyResult; }
  };
  const source = fs.readFileSync(require.resolve('../web/src/utils/clipboard.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, navigator: { clipboard }, document, HTMLElement });
  return { write: module.exports.writeClipboardText, events, textarea };
}

test('clipboard falls back to selection when browser API rejects', async () => {
  const { write, events, textarea } = loadClipboard({ clipboard: { writeText: async () => { throw new Error('denied'); } } });
  await write('安装失败详情');
  assert.equal(textarea.value, '安装失败详情');
  assert.deepEqual(events, ['append', 'focus', 'select', 'copy', 'remove', 'restore-focus']);
});

test('clipboard reports failure and cleans up when fallback is rejected', async () => {
  const { write, events } = loadClipboard({ copyResult: false });
  await assert.rejects(write('error'), /拒绝/);
  assert.deepEqual(events.slice(-2), ['remove', 'restore-focus']);
});
