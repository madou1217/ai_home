import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRafScrollSync } from './raf-scroll-sync';

/** 可控的 rAF 假实现：回调排队，由测试显式按帧驱动 */
function createFakeRaf() {
  const queue: Array<() => void> = [];
  let nextHandle = 1;
  const handles = new Map<number, () => void>();
  const cancelled: number[] = [];
  return {
    raf(cb: () => void): number {
      const handle = nextHandle++;
      handles.set(handle, cb);
      queue.push(cb);
      return handle;
    },
    cancelRaf(handle: number): void {
      cancelled.push(handle);
      const cb = handles.get(handle);
      handles.delete(handle);
      if (cb) {
        const index = queue.indexOf(cb);
        if (index !== -1) queue.splice(index, 1);
      }
    },
    /** 执行一帧：取出当前排队的全部回调并依次触发 */
    flushFrame(): void {
      const pending = queue.splice(0, queue.length);
      for (const cb of pending) {
        cb();
      }
    },
    get pendingCount(): number {
      return queue.length;
    },
    cancelled,
  };
}

describe('createRafScrollSync', () => {
  it('coalesces 100 rapid scroll events into a single apply per frame', () => {
    const fake = createFakeRaf();
    let scrollTop = 0;
    const applied: number[] = [];
    const sync = createRafScrollSync(
      () => scrollTop,
      (value) => applied.push(value),
      fake.raf,
      fake.cancelRaf,
    );

    // 模拟一帧内 100 次高频 scroll 事件
    for (let i = 0; i < 100; i++) {
      scrollTop = i * 10;
      sync.notifyScroll();
    }

    // 同一帧内只调度了一次 rAF，且尚未触发 setState
    assert.equal(fake.pendingCount, 1);
    assert.equal(applied.length, 0);

    fake.flushFrame();
    // 100 次 scroll 事件只产生 1 次 setState，且取到的是最新 scrollTop
    assert.equal(applied.length, 1);
    assert.equal(applied[0], 990);
  });

  it('applies at most once per frame across sustained scrolling', () => {
    const fake = createFakeRaf();
    let scrollTop = 0;
    let applyCount = 0;
    const sync = createRafScrollSync(
      () => scrollTop,
      () => {
        applyCount += 1;
      },
      fake.raf,
      fake.cancelRaf,
    );

    // 10 帧 × 每帧 100 次 scroll 事件
    for (let frame = 0; frame < 10; frame++) {
      for (let i = 0; i < 100; i++) {
        scrollTop += 1;
        sync.notifyScroll();
      }
      fake.flushFrame();
    }

    // 1000 次 scroll 事件只触发 10 次 setState（每帧一次）
    assert.equal(applyCount, 10);
  });

  it('dispose cancels the pending frame so no apply fires after unmount', () => {
    const fake = createFakeRaf();
    const applied: number[] = [];
    const sync = createRafScrollSync(
      () => 42,
      (value) => applied.push(value),
      fake.raf,
      fake.cancelRaf,
    );

    sync.notifyScroll();
    assert.equal(fake.pendingCount, 1);

    sync.dispose();
    assert.equal(fake.cancelled.length, 1);

    fake.flushFrame();
    assert.equal(applied.length, 0);
  });

  it('dispose is a no-op when no frame is pending', () => {
    const fake = createFakeRaf();
    const sync = createRafScrollSync(
      () => 0,
      () => undefined,
      fake.raf,
      fake.cancelRaf,
    );
    sync.dispose();
    assert.equal(fake.cancelled.length, 0);
  });
});
