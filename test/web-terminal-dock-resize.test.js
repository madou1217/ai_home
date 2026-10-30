'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

const source = fs.readFileSync(require.resolve('../web/src/components/chat/use-terminal-dock-resize.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function fixture() {
  const listeners = new Map();
  const frames = new Map();
  let frameId = 0;
  let effectCleanup;
  const commits = [];
  const events = [];
  const node = { style: { height: '300px' }, dispatchEvent: (event) => events.push(event.type) };
  class PointerEvent {
    constructor(type, properties = {}) { this.type = type; Object.assign(this, properties); }
  }
  class Event { constructor(type) { this.type = type; } }
  const win = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const body = { style: { userSelect: 'text', cursor: 'crosshair' } };
  const loaded = { exports: {} };
  const react = {
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useEffect: (effect) => { effectCleanup = effect(); },
  };
  vm.runInNewContext(compiled, {
    module: loaded, exports: loaded.exports,
    require: (name) => name === 'react' ? react : { TERMINAL_RESIZE_FINISHED: 'resize-finished' },
    document: { body }, window: win, PointerEvent, Event,
    requestAnimationFrame: (fn) => { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  const resize = loaded.exports.useTerminalDockResize({ current: node }, 300, '300px', true, 120, () => 630, (height) => commits.push(height));
  const emit = (type, y, pointerId = 1) => listeners.get(type)?.(new PointerEvent(type, { clientY: y, pointerId }));
  const start = () => resize.onPointerDown({ button: 0, isPrimary: true, pointerId: 1, clientY: 500, preventDefault() {} });
  return { node, body, resize, frames, listeners, commits, events, emit, start, cleanup: () => effectCleanup() };
}

test('dock drag coalesces pointer movement and commits the final height', () => {
  const f = fixture();
  f.start();
  for (let y = 499; y >= 370; y -= 1) f.emit('pointermove', y);
  assert.equal(f.frames.size, 1);
  const frame = [...f.frames.values()][0]; f.frames.clear(); frame();
  assert.equal(f.node.style.height, '430px');
  f.emit('pointerup', 360);
  assert.equal(f.node.style.height, '440px');
  assert.deepEqual(f.commits, [440]);
  assert.deepEqual(f.events, ['resize-finished']);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.body.style.userSelect, 'text');
  assert.equal(f.body.style.cursor, 'crosshair');
});

test('interrupted dock gestures clean up and keyboard resizing respects bounds', () => {
  const f = fixture();
  f.start();
  f.emit('pointermove', 0);
  f.cleanup();
  assert.equal(f.node.style.height, '300px');
  assert.equal(f.frames.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.body.style.userSelect, 'text');
  f.resize.resizeWithKeyboard(1000);
  f.resize.resizeWithKeyboard(-1000);
  assert.deepEqual(f.commits, [630, 120]);
});
