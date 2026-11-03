'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/components/chat/terminal-resize-effects.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { module: loaded, exports: loaded.exports });
const { suspendBackgroundBlur } = loaded.exports;

test('overlapping resizes restore the original background state once all finish', () => {
  const classes = new Set();
  const root = { classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name) } };
  const first = suspendBackgroundBlur(root);
  const second = suspendBackgroundBlur(root);
  assert.equal(classes.has('aih-terminal-resizing'), true);
  first(); first();
  assert.equal(classes.has('aih-terminal-resizing'), true);
  second();
  assert.equal(classes.has('aih-terminal-resizing'), false);
  classes.add('aih-terminal-resizing');
  suspendBackgroundBlur(root)();
  assert.equal(classes.has('aih-terminal-resizing'), true);
});
