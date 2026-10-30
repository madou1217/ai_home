'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

class ElementFixture {
  constructor(inTerminalScreen = false) { this.inTerminalScreen = inTerminalScreen; }
  closest(selector) { return selector === '.xterm-screen' && this.inTerminalScreen ? this : null; }
}

const source = fs.readFileSync(require.resolve('../web/src/components/hud/hud-mutations.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(compiled, { module: loaded, exports: loaded.exports, Element: ElementFixture });
const { forEachHudAddedElement } = loaded.exports;

test('ignores terminal renderer churn while keeping overlay additions observable', () => {
  const terminalRow = new ElementFixture(true);
  const page = new ElementFixture();
  const terminalCharacter = new ElementFixture(true);
  const modal = new ElementFixture();
  const notice = new ElementFixture();
  const added = [];
  forEachHudAddedElement([
    { target: terminalRow, addedNodes: [terminalCharacter] },
    { target: page, addedNodes: [modal, {}, notice] },
  ], (element) => added.push(element));
  assert.deepEqual(added, [modal, notice]);
});
