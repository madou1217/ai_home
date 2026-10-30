'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const compile = (path) => ts.transpileModule(fs.readFileSync(require.resolve(path), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const policy = { exports: {} };
vm.runInNewContext(compile('../web/src/features/project-workbench/workbench-layout-policy.js'), { module: policy, exports: policy.exports });
const layout = { exports: {} };
vm.runInNewContext(compile('../web/src/features/project-workbench/workbench-layout.ts'), { module: layout, exports: layout.exports, require: () => policy.exports });

function fixture() {
  const listeners = new Map();
  const frames = new Map();
  const commits = [];
  const saved = [];
  const events = [];
  let frameId = 0;
  let unmount;
  let blurSuspended = 0;
  class PointerEvent { constructor(type, props = {}) { this.type = type; Object.assign(this, props); } }
  class Event { constructor(type) { this.type = type; } }
  const body = { style: { userSelect: 'text', cursor: 'crosshair' } };
  const node = { clientWidth: 1672, style: { gridTemplateColumns: 'initial' }, querySelectorAll: () => [{ dispatchEvent: (event) => events.push(event.type) }] };
  const window = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const react = { useRef: (value) => ({ current: value }), useCallback: (fn) => fn, useEffect: (effect) => { unmount = effect(); } };
  const loaded = { exports: {} };
  vm.runInNewContext(compile('../web/src/features/project-workbench/use-workbench-divider-drag.ts'), {
    module: loaded, exports: loaded.exports,
    require: (name) => name === 'react' ? react : name === './workbench-layout' ? layout.exports : name === './workbench-layout-persistence' ? { saveColumnLayout: (value) => saved.push(JSON.parse(JSON.stringify(value))) } : name.endsWith('terminal-resize-effects') ? { suspendBackgroundBlur: () => { blurSuspended += 1; return () => { blurSuspended -= 1; }; } } : { TERMINAL_RESIZE_FINISHED: 'resize-finished' },
    window, document: { body }, PointerEvent, Event,
    requestAnimationFrame: (fn) => { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  const desiredRef = { current: { left: 280, right: 420 } };
  const start = loaded.exports.useWorkbenchDividerDrag({
    containerRef: { current: node }, widthsRef: { current: { left: 280, right: 420 } }, desiredRef,
    collapsedRef: { current: { left: false, right: false } }, visibilityRef: { current: { left: true, right: true } },
    shownRef: { current: { left: true, right: true } }, templateRef: { current: 'initial' },
    setDesired: (value) => commits.push(JSON.parse(JSON.stringify(value))),
  });
  const emit = (type, x, pointerId = 1) => listeners.get(type)?.(new PointerEvent(type, { clientX: x, pointerId }));
  return { node, body, frames, commits, saved, events, desiredRef, emit, blurSuspended: () => blurSuspended,
    start: (divider = 'right') => start(divider)({ button: 0, isPrimary: true, pointerId: 1, clientX: 500, preventDefault() {} }),
    paint: () => { const callback = [...frames.values()][0]; frames.clear(); callback(); }, unmount: () => unmount() };
}

test('divider previews at most once per frame and persists the actual release width', () => {
  const f = fixture();
  f.start();
  assert.equal(f.blurSuspended(), 1);
  for (let x = 499; x >= 410; x--) f.emit('pointermove', x);
  assert.equal(f.frames.size, 1);
  assert.deepEqual(f.commits, []);
  f.paint();
  assert.equal(f.node.style.gridTemplateColumns, '280px 6px minmax(0, 1fr) 6px 510px');
  f.emit('pointerup', 400);
  assert.equal(f.node.style.gridTemplateColumns, '280px 6px minmax(0, 1fr) 6px 520px');
  assert.deepEqual(f.commits, [{ left: 280, right: 520 }]);
  assert.deepEqual(f.saved, [{ widths: { left: 280, right: 520 }, collapsed: { left: false, right: false } }]);
  assert.deepEqual(f.events, ['resize-finished']);
  assert.equal(f.blurSuspended(), 0);
  assert.equal(f.body.style.userSelect, 'text');
  assert.equal(f.body.style.cursor, 'crosshair');
});

test('unmount cancels pending work and restores the grid and background', () => {
  const f = fixture();
  f.start('left');
  f.emit('pointermove', 550, 2);
  assert.equal(f.frames.size, 0);
  f.emit('pointermove', 550);
  f.paint();
  f.emit('pointermove', 560);
  f.unmount();
  assert.equal(f.node.style.gridTemplateColumns, 'initial');
  assert.equal(f.frames.size, 0);
  assert.equal(f.blurSuspended(), 0);
  assert.deepEqual(f.commits, []);
  assert.deepEqual(f.saved, []);
});

test('a click does not replace saved widths; cancellation commits the last preview', () => {
  const clicked = fixture();
  clicked.desiredRef.current = { left: 280, right: 900 };
  clicked.start();
  clicked.emit('pointerup', 500);
  assert.deepEqual(clicked.commits, []);
  assert.deepEqual(clicked.saved, []);
  assert.equal(clicked.desiredRef.current.right, 900);
  assert.equal(clicked.blurSuspended(), 0);

  const canceled = fixture();
  canceled.start();
  canceled.emit('pointermove', 460);
  canceled.emit('pointercancel', 0);
  assert.deepEqual(canceled.saved, [{ widths: { left: 280, right: 460 }, collapsed: { left: false, right: false } }]);
  assert.equal(canceled.frames.size, 0);
  assert.equal(canceled.blurSuspended(), 0);
});
