'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/features/web-terminal/use-terminal-window-gesture.ts'), 'utf8');
const geometry = fs.readFileSync(require.resolve('../web/src/features/web-terminal/terminal-window-geometry.ts'), 'utf8');
const transpile = (text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const geometryModule = { exports: {} };
vm.runInNewContext(transpile(geometry), { module: geometryModule, exports: geometryModule.exports });

function fixture(supported = true) {
  const listeners = new Map();
  const frames = new Map();
  const classes = new Set();
  const commits = [];
  const events = [];
  let frameId = 0;
  let effectCleanup;
  class PointerEvent {
    constructor(type, properties = {}) { this.type = type; Object.assign(this, properties); }
  }
  class Event { constructor(type) { this.type = type; } }
  const node = {
    style: { left: '100px', top: '100px', width: '700px', height: '400px', translate: '' },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 700, height: 400 }),
    dispatchEvent: (event) => events.push(event.type),
  };
  const window = {
    innerWidth: 1440, innerHeight: 900,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const body = { style: { userSelect: 'text', cursor: 'crosshair' } };
  let blurSuspended = 0;
  const react = {
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useEffect: (effect) => { effectCleanup = effect(); },
  };
  const loaded = { exports: {} };
  vm.runInNewContext(transpile(source), {
    module: loaded, exports: loaded.exports,
    require: (name) => name === 'react' ? react : name === './terminal-window-geometry' ? geometryModule.exports : name.endsWith('terminal-resize-effects') ? { suspendBackgroundBlur: () => { blurSuspended += 1; return () => { blurSuspended -= 1; }; } } : { TERMINAL_RESIZE_FINISHED: 'resize-finished' },
    window, document: { body }, PointerEvent, Event,
    CSS: { supports: () => supported },
    getComputedStyle: () => ({ cursor: 'nwse-resize' }),
    requestAnimationFrame: (fn) => { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  const startGesture = loaded.exports.useTerminalWindowGesture({ current: node }, (value) => commits.push(JSON.parse(JSON.stringify(value))), 'scope', node.style);
  const start = (edge) => startGesture(edge, { button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100, target: { closest: () => null }, currentTarget: {}, preventDefault() {}, stopPropagation() {} });
  const emit = (type, x, y, pointerId = 1) => listeners.get(type)?.(new PointerEvent(type, { clientX: x, clientY: y, pointerId }));
  const paint = () => { const callback = [...frames.values()][0]; frames.clear(); callback(); };
  return { node, body, classes, commits, events, listeners, frames, start, emit, paint, cleanup: () => effectCleanup(), blurSuspended: () => blurSuspended };
}

test('window movement uses compositor translation until the final position is committed', () => {
  const f = fixture();
  f.start('move');
  assert.equal(f.blurSuspended(), 0);
  f.emit('pointermove', 200, 150);
  f.emit('pointermove', 250, 200);
  assert.equal(f.frames.size, 1);
  f.paint();
  assert.equal(f.node.style.left, '100px');
  assert.equal(f.node.style.top, '100px');
  assert.equal(f.node.style.translate, '150px 100px');
  f.emit('pointerup', 260, 210);
  assert.equal(f.node.style.left, '260px');
  assert.equal(f.node.style.top, '210px');
  assert.equal(f.node.style.translate, '');
  assert.deepEqual(f.commits, [{ x: 260, y: 210 }]);
  assert.equal(f.classes.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.body.style.cursor, 'crosshair');
});

test('cleanup removes temporary translation and older browsers retain position-based dragging', () => {
  const f = fixture();
  f.start('move');
  f.emit('pointermove', 200, 150);
  f.paint();
  f.cleanup();
  assert.equal(f.node.style.translate, '');
  assert.equal(f.node.style.left, '100px');
  assert.deepEqual(f.commits, []);
  assert.equal(f.listeners.size, 0);
  const fallback = fixture(false);
  fallback.start('move');
  fallback.emit('pointermove', 200, 150);
  fallback.paint();
  assert.equal(fallback.node.style.left, '200px');
  assert.equal(fallback.node.style.top, '150px');
  fallback.emit('pointercancel', 200, 150);
  assert.deepEqual(fallback.commits, [{ x: 200, y: 150 }]);
});

test('edge resizing continues to update size and signals the final fit', () => {
  const f = fixture();
  f.start('nw');
  assert.equal(f.blurSuspended(), 1);
  f.emit('pointermove', 80, 70);
  f.paint();
  assert.equal(f.node.style.left, '80px');
  assert.equal(f.node.style.top, '70px');
  assert.equal(f.node.style.width, '720px');
  assert.equal(f.node.style.height, '430px');
  f.emit('pointerup', 80, 70);
  assert.deepEqual(f.commits, [{ x: 80, y: 70, width: 720, height: 430 }]);
  assert.deepEqual(f.events, ['resize-finished']);
  assert.equal(f.blurSuspended(), 0);
});

test('interrupted resize restores background effects', () => {
  const f = fixture();
  f.start('se');
  assert.equal(f.blurSuspended(), 1);
  f.cleanup();
  assert.equal(f.blurSuspended(), 0);
  const canceled = fixture();
  canceled.start('e');
  canceled.emit('pointercancel', 100, 100);
  assert.equal(canceled.blurSuspended(), 0);
});
