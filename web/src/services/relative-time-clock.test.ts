import { expect, test } from 'bun:test';
import { createRelativeTimeClock } from './relative-time-clock';

function createClockHarness() {
  let now = 100;
  let visible = true;
  let tick: (() => void) | null = null;
  let visibility: (() => void) | null = null;
  let started = 0;
  let stopped = 0;
  const clock = createRelativeTimeClock({
    now: () => now,
    isVisible: () => visible,
    startTimer(callback) {
      started += 1;
      tick = callback;
      return () => { stopped += 1; tick = null; };
    },
    watchVisibility(callback) {
      visibility = callback;
      return () => { visibility = null; };
    },
  });
  return {
    clock,
    advance(value: number) { now = value; tick?.(); },
    show(value: boolean) { visible = value; visibility?.(); },
    get started() { return started; },
    get stopped() { return stopped; },
    get watching() { return visibility !== null; },
  };
}

test('多条会话只共用一个计时器，全部卸载后停止；再次进入取得当前时间', () => {
  const harness = createClockHarness();
  const values: number[] = [];
  const a = harness.clock.subscribe(() => values.push(harness.clock.getSnapshot()));
  const b = harness.clock.subscribe(() => values.push(harness.clock.getSnapshot()));
  expect(harness.started).toBe(1);
  harness.advance(200);
  expect(values).toEqual([200, 200]);
  a();
  expect(harness.stopped).toBe(0);
  b();
  expect(harness.stopped).toBe(1);
  expect(harness.watching).toBe(false);
  harness.advance(500);
  const c = harness.clock.subscribe(() => {});
  expect(harness.clock.getSnapshot()).toBe(500);
  expect(harness.started).toBe(2);
  c();
});

test('后台停止重绘，回到前台立即更新，不等待下一个计时周期', () => {
  const harness = createClockHarness();
  const values: number[] = [];
  const close = harness.clock.subscribe(() => values.push(harness.clock.getSnapshot()));
  harness.show(false);
  expect(harness.stopped).toBe(1);
  harness.advance(60000);
  expect(values).toEqual([]);
  harness.show(true);
  expect(values).toEqual([60000]);
  expect(harness.started).toBe(2);
  close();
});
