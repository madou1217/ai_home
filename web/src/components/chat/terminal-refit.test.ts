import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalRefitter, fitActiveTerminal } from './terminal-refit.ts';

function fakeInstance(opened: boolean) {
  const calls: number[] = [];
  return {
    opened,
    calls,
    fit: { fit: () => { calls.push(1); } },
  };
}

test('fitActiveTerminal 只 fit 激活且已挂载的实例', () => {
  const active = fakeInstance(true);
  const other = fakeInstance(true);
  const instances = new Map([
    ['a', active],
    ['b', other],
  ]);
  fitActiveTerminal(instances, 'a');
  assert.equal(active.calls.length, 1);
  assert.equal(other.calls.length, 0);
});

test('fitActiveTerminal 实例未挂载或不存在时不动作', () => {
  const unopened = fakeInstance(false);
  const instances = new Map([['a', unopened]]);
  fitActiveTerminal(instances, 'a');
  fitActiveTerminal(instances, 'missing');
  assert.equal(unopened.calls.length, 0);
});

test('fitActiveTerminal 容器无尺寸时吞掉 FitAddon 抛错', () => {
  const instances = new Map([
    ['a', {
      opened: true,
      fit: { fit: () => { throw new Error('no dimensions'); } },
    }],
  ]);
  assert.doesNotThrow(() => fitActiveTerminal(instances, 'a'));
});

test('createTerminalRefitter 同帧多次 notify 只 fit 一次', () => {
  const callbacks: Array<() => void> = [];
  let fits = 0;
  const refitter = createTerminalRefitter(
    () => { fits += 1; },
    (cb) => { callbacks.push(cb); return callbacks.length; },
    () => {},
  );
  refitter.notifyResize();
  refitter.notifyResize();
  refitter.notifyResize();
  assert.equal(callbacks.length, 1);
  callbacks.forEach((cb) => cb());
  assert.equal(fits, 1);
});

test('createTerminalRefitter dispose 取消未执行的帧', () => {
  const cancelled: number[] = [];
  const refitter = createTerminalRefitter(
    () => {},
    () => 42,
    (handle) => { cancelled.push(handle); },
  );
  refitter.notifyResize();
  refitter.dispose();
  assert.deepEqual(cancelled, [42]);
  // dispose 后可再次调度（面板重新打开场景）。
  refitter.notifyResize();
  refitter.dispose();
  assert.deepEqual(cancelled, [42, 42]);
});
