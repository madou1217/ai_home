import { describe, expect, test } from 'bun:test';
import { createSharedWatchHub, type SharedWatchEnv } from './shared-watch';

/** 假锁:同一时刻只放给一个持有者;持有者 promise 永不 resolve 直到 close 回调释放 */
function createFakeLocks() {
  let held = false;
  const queue: Array<(lock: unknown) => Promise<void> | undefined> = [];
  const requestLock = (name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | undefined) => {
    if (!held) {
      held = true;
      return Promise.resolve(callback({ name })).then(() => {});
    }
    if (options.ifAvailable) return Promise.resolve(callback(null)).then(() => {});
    queue.push(callback);
    return Promise.resolve(undefined);
  };
  return {
    requestLock: requestLock as SharedWatchEnv['requestLock'],
    release() {
      held = false;
      const next = queue.shift();
      if (next) { held = true; void next({ name: 'lock' }); }
    },
  };
}

function createFakeChannelMesh() {
  const channels: Array<{ onmessage: ((msg: MessageEvent) => void) | null; posted: unknown[] }> = [];
  return {
    channels,
    createChannel: (() => {
      const ch = {
        onmessage: null as ((msg: MessageEvent) => void) | null,
        posted: [] as unknown[],
        postMessage(payload: unknown) {
          this.posted.push(payload);
          channels.forEach((peer) => { if (peer !== ch) peer.onmessage?.({ data: payload } as MessageEvent); });
        },
        close() {},
      };
      channels.push(ch);
      return ch as unknown as BroadcastChannel;
    }) as SharedWatchEnv['createChannel'],
  };
}

function createFakeRealFactory(opened: EventSource[]) {
  return ((path: string) => {
    const real = {
      path,
      onopen: null as ((ev: Event) => void) | null,
      onmessage: null as ((ev: MessageEvent) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
      closed: false,
      close() { this.closed = true; },
    };
    opened.push(real as unknown as EventSource);
    return real as unknown as EventSource;
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('shared-watch 跨 Tab 单 holder', () => {
  test('两个 Tab 同 path 只开一条真实连接,follower 经中继收到事件', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');

    const a = tabA.open('/v0/webui/projects/watch');
    const b = tabB.open('/v0/webui/projects/watch');
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.onmessage = (ev) => gotA.push(String(ev.data));
    b.onmessage = (ev) => gotB.push(String(ev.data));
    await flush();

    expect(tabA.isLeader).toBe(true);
    expect(tabB.isLeader).toBe(false);
    expect(opened.length).toBe(1);

    (opened[0] as unknown as { onmessage: (ev: MessageEvent) => void }).onmessage({ data: '{"type":"snapshot"}' } as MessageEvent);
    expect(gotA).toEqual(['{"type":"snapshot"}']);
    expect(gotB).toEqual(['{"type":"snapshot"}']); // 经 BroadcastChannel 中继
  });

  test('leader 释放锁后 follower 继位并补开真实连接', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');
    tabA.open('/v0/webui/tasks/watch');
    tabB.open('/v0/webui/tasks/watch');
    await flush();
    expect(opened.length).toBe(1);

    locks.release(); // 模拟 leader Tab 关闭
    await flush();
    expect(tabB.isLeader).toBe(true);
    expect(opened.length).toBe(2); // 继位后补开
  });

  test('close 引用计数归零后释放真实连接;无锁环境退化为每 Tab 自持', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock2', 'chan2');
    const s1 = tabA.open('/v0/webui/accounts/watch');
    const s2 = tabA.open('/v0/webui/accounts/watch');
    await flush();
    expect(opened.length).toBe(1); // 同 path 复用
    s1.close();
    expect((opened[0] as unknown as { closed: boolean }).closed).toBe(false);
    s2.close();
    expect((opened[0] as unknown as { closed: boolean }).closed).toBe(true);

    // 无 Web Locks:每个 hub 自持(旧行为回退)
    const opened2: EventSource[] = [];
    const soloA = createSharedWatchHub({ requestLock: null, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened2) }, 'l', 'c');
    const soloB = createSharedWatchHub({ requestLock: null, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened2) }, 'l', 'c');
    soloA.open('/v0/webui/tasks/watch');
    soloB.open('/v0/webui/tasks/watch');
    await flush();
    expect(soloA.isLeader && soloB.isLeader).toBe(true);
    expect(opened2.length).toBe(2);
  });
});
