import { describe, expect, test } from 'bun:test';
import { createSharedWatchHub, type SharedWatchEnv } from './shared-watch';

/** 假锁:同一时刻只放给一个持有者;持有者 promise 永不 resolve 直到 close 回调释放 */
function createFakeLocks() {
  const locks = new Map<string, { held: boolean; generation: number; queue: Array<() => void> }>();
  const release = (name: string): void => {
    const lock = locks.get(name);
    if (!lock) return;
    lock.held = false;
    lock.queue.shift()?.();
  };
  const requestLock = (name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | undefined) => {
    const lock = locks.get(name) || { held: false, generation: 0, queue: [] };
    locks.set(name, lock);
    if (lock.held && options.ifAvailable) return Promise.resolve(callback(null)).then(() => {});
    return new Promise<void>((resolve, reject) => {
      const enter = () => {
        lock.held = true;
        const generation = ++lock.generation;
        Promise.resolve(callback({ name })).then(() => {
          if (lock.generation === generation) release(name);
          resolve();
        }, reject);
      };
      if (lock.held) lock.queue.push(enter);
      else enter();
    });
  };
  return {
    requestLock: requestLock as SharedWatchEnv['requestLock'],
    release() {
      const name = [...locks].find(([_name, lock]) => lock.held)?.[0];
      if (name) release(name);
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
  test('三个管理和同会话页签共享五条 watch,为真实聊天保留连接', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabs = Array.from({ length: 3 }, () => createSharedWatchHub(env(), 'lock', 'chan'));
    const paths = [
      '/v0/webui/management/watch',
      '/v0/webui/tasks/watch',
      '/v0/webui/accounts/watch',
      '/v0/webui/projects/watch',
      '/v0/webui/sessions/watch?sessionId=shared&provider=workbuddycn',
    ];
    const subscriptions = tabs.flatMap((tab) => paths.map((path) => tab.open(path)));
    await flush();

    expect(opened.length).toBe(5);
    const received: string[] = [];
    subscriptions.at(-1)!.onmessage = (event) => received.push(String(event.data));
    const sessionWatch = opened.at(-1)!;
    const update = JSON.stringify({ type: 'update', sessionId: 'shared', phase: 'complete' });
    sessionWatch.onmessage?.call(sessionWatch, { data: update } as MessageEvent);
    expect(received).toEqual([update]);
    const late = tabs[2].open(paths.at(-1)!);
    late.onmessage = (event) => received.push(String(event.data));
    await flush();
    expect(received).toEqual([update]);

    subscriptions.forEach((subscription) => subscription.close());
    late.close();
  });

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

  test('leader 已收到 snapshot 后新 follower 立即回放完整快照', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'replay-lock', 'replay-chan');
    const tabB = createSharedWatchHub(env(), 'replay-lock', 'replay-chan');
    const leader = tabA.open('/v0/webui/accounts/watch');
    await flush();
    opened[0].onmessage?.call(opened[0], { data: JSON.stringify({ type: 'snapshot', accounts: [{ accountRef: 'acct_complete' }] }) } as MessageEvent);

    const got: string[] = [];
    const follower = tabB.open('/v0/webui/accounts/watch');
    follower.onmessage = (event) => got.push(String(event.data));
    await flush();

    expect(opened.length).toBe(1);
    expect(got).toEqual([JSON.stringify({ type: 'snapshot', accounts: [{ accountRef: 'acct_complete' }] })]);
    leader.close();
    follower.close();
  });

  test('回放只发给新订阅,同 Tab 和其它 follower 已有订阅不重复接收', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');
    const a = tabA.open('/v0/webui/accounts/watch');
    const b = tabB.open('/v0/webui/accounts/watch');
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.onmessage = (event) => gotA.push(String(event.data));
    b.onmessage = (event) => gotB.push(String(event.data));
    await flush();
    const snapshot = JSON.stringify({ type: 'snapshot', accounts: [] });
    opened[0].onopen?.call(opened[0], new Event('open'));
    opened[0].onmessage?.call(opened[0], { data: snapshot } as MessageEvent);

    const local = tabA.open('/v0/webui/accounts/watch');
    const localEvents: string[] = [];
    local.onmessage = (event) => localEvents.push(String(event.data));
    const tabC = createSharedWatchHub(env(), 'lock', 'chan');
    const newFollower = tabC.open('/v0/webui/accounts/watch');
    const followerEvents: string[] = [];
    let openedFollower = 0;
    newFollower.onmessage = (event) => followerEvents.push(String(event.data));
    newFollower.onopen = () => { openedFollower += 1; };
    await flush();

    expect(gotA).toEqual([snapshot]);
    expect(gotB).toEqual([snapshot]);
    expect(localEvents).toEqual([snapshot]);
    expect(followerEvents).toEqual([snapshot]);
    expect(openedFollower).toBe(1);
    expect(newFollower.readyState).toBe(1);
    expect(opened.length).toBe(1);
    a.close(); b.close(); local.close(); newFollower.close();
  });

  test('实时 snapshot 与回放请求竞态时不会重复投递', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');
    tabA.open('/v0/webui/accounts/watch');
    await flush();
    const snapshot = JSON.stringify({ type: 'snapshot', accounts: [] });
    const follower = tabB.open('/v0/webui/accounts/watch');
    const got: string[] = [];
    follower.onmessage = (event) => got.push(String(event.data));
    // The leader sends a fresh snapshot before the replay response is observed.
    opened[0].onmessage?.call(opened[0], { data: snapshot } as MessageEvent);
    await flush();
    expect(got).toEqual([snapshot]);
    follower.close();
  });

  test('账号回放包含最新变更和删除,不会重复 token 消耗和作业事件', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const a = tabA.open('/v0/webui/accounts/watch');
    await flush();
    const frames = [
      { type: 'snapshot', accounts: [{ accountRef: 'a', remainingPct: 90 }, { accountRef: 'b' }], hydrating: true },
      { type: 'account', account: { accountRef: 'a', remainingPct: 80 } },
      { type: 'account', account: { accountRef: 'a', remainingPct: 70 } },
      { type: 'account-removed', accountRef: 'b' },
      { type: 'hydrated', hydratedAt: 42 },
      { type: 'token-consumed', accountRef: 'a', tokens: { total: 99 } },
      { type: 'auth-job', job: { id: 'job' } },
    ];
    frames.forEach((frame) => opened[0].onmessage?.call(opened[0], { data: JSON.stringify(frame) } as MessageEvent));
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');
    const b = tabB.open('/v0/webui/accounts/watch');
    const got: unknown[] = [];
    b.onmessage = (event) => got.push(JSON.parse(String(event.data)));
    await flush();

    expect(got).toEqual([frames[0], frames[2], frames[3], frames[4]]);
    expect(opened.length).toBe(1);
    a.close(); b.close();
  });

  test('回放保留完整任务与项目运行态,重新 snapshot 清理旧增量', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const a = tabA.open('/v0/webui/projects/watch');
    await flush();
    const frames = [
      { type: 'snapshot', projects: ['old'] },
      { type: 'runtime', runningSessionKeys: ['active'] },
      { type: 'account', account: { accountRef: 'stale' } },
      { type: 'snapshot', projects: ['current'] },
    ];
    frames.forEach((frame) => opened[0].onmessage?.call(opened[0], { data: JSON.stringify(frame) } as MessageEvent));
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');
    const b = tabB.open('/v0/webui/projects/watch');
    const got: unknown[] = [];
    b.onmessage = (event) => got.push(JSON.parse(String(event.data)));
    await flush();
    expect(got).toEqual([frames[3], frames[1]]);

    const tasks = tabA.open('/v0/webui/tasks/watch');
    await flush();
    const taskFrames = [
      { type: 'snapshot', tasks: [{ id: 't', status: 'running' }] },
      { type: 'task', task: { id: 't', status: 'succeeded' } },
    ];
    taskFrames.forEach((frame) => opened[1].onmessage?.call(opened[1], { data: JSON.stringify(frame) } as MessageEvent));
    const lateTasks = tabB.open('/v0/webui/tasks/watch');
    const gotTasks: unknown[] = [];
    lateTasks.onmessage = (event) => gotTasks.push(JSON.parse(String(event.data)));
    await flush();
    expect(gotTasks).toEqual(taskFrames);
    a.close(); b.close(); tasks.close(); lateTasks.close();
  });

  test('断线和最后订阅关闭清理回放状态,坏回调不阻断其它订阅', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const a = tabA.open('/v0/webui/accounts/watch');
    a.onmessage = () => { throw new Error('consumer_failed'); };
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');
    const b = tabB.open('/v0/webui/accounts/watch');
    const got: string[] = [];
    b.onmessage = (event) => got.push(String(event.data));
    await flush();
    opened[0].onmessage?.call(opened[0], { data: '{"type":"snapshot","accounts":[]}' } as MessageEvent);
    expect(got.length).toBe(1);
    opened[0].onerror?.call(opened[0], new Event('error'));
    const tabC = createSharedWatchHub(env(), 'lock', 'chan');
    const c = tabC.open('/v0/webui/accounts/watch');
    const late: string[] = [];
    c.onmessage = (event) => late.push(String(event.data));
    await flush();
    expect(late).toEqual([]);
    expect(c.readyState).toBe(0);
    a.close(); b.close(); c.close();
    await flush();
    const next = tabA.open('/v0/webui/accounts/watch');
    next.onmessage = (event) => late.push(String(event.data));
    await flush();
    expect(late).toEqual([]);
    expect(opened.length).toBe(2);
    next.close();
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

  test('账号页 leader 不阻止会话页订阅项目更新,两条路径各只有一条真实连接', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const accountsTab = createSharedWatchHub(env(), 'lock', 'chan');
    const chatTab = createSharedWatchHub(env(), 'lock', 'chan');
    accountsTab.open('/v0/webui/accounts/watch');
    const projects = chatTab.open('/v0/webui/projects/watch');
    const relayedProjects = accountsTab.open('/v0/webui/projects/watch');
    const gotChat: string[] = [];
    const gotAccounts: string[] = [];
    projects.onmessage = (event) => gotChat.push(String(event.data));
    relayedProjects.onmessage = (event) => gotAccounts.push(String(event.data));
    await flush();

    expect(opened.length).toBe(2);
    expect(accountsTab.isLeader && chatTab.isLeader).toBe(true);
    const realProjects = opened.find((real) => (real as unknown as { path: string }).path === '/v0/webui/projects/watch')!;
    realProjects.onmessage?.call(realProjects, { data: '{"type":"snapshot","updatedAt":42}' } as MessageEvent);
    expect(gotChat).toEqual(['{"type":"snapshot","updatedAt":42}']);
    expect(gotAccounts).toEqual(gotChat);
  });

  test('最后一个本地订阅关闭立即让其它标签页接管同一路径', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');
    const a = tabA.open('/v0/webui/projects/watch');
    const b = tabB.open('/v0/webui/projects/watch');
    const got: string[] = [];
    b.onmessage = (event) => got.push(String(event.data));
    await flush();
    a.close();
    await flush();
    expect((opened[0] as unknown as { closed: boolean }).closed).toBe(true);
    expect(tabA.isLeader).toBe(false);
    expect(tabB.isLeader).toBe(true);
    expect(opened.length).toBe(2);
    opened[1].onmessage?.call(opened[1], { data: 'fresh' } as MessageEvent);
    expect(got).toEqual(['fresh']);
  });

  test('关闭等待中的订阅不会在接管时打开多余连接', async () => {
    const locks = createFakeLocks();
    const mesh = createFakeChannelMesh();
    const opened: EventSource[] = [];
    const env = (): SharedWatchEnv => ({ requestLock: locks.requestLock, createChannel: mesh.createChannel, openReal: createFakeRealFactory(opened) });
    const tabA = createSharedWatchHub(env(), 'lock', 'chan');
    const tabB = createSharedWatchHub(env(), 'lock', 'chan');
    const a = tabA.open('/v0/webui/projects/watch');
    const b = tabB.open('/v0/webui/projects/watch');
    await flush();
    b.close();
    a.close();
    await flush();
    expect(opened.length).toBe(1);
    expect(tabB.isLeader).toBe(false);
    tabB.open('/v0/webui/projects/watch');
    await flush();
    expect(opened.length).toBe(2);
    expect(tabB.isLeader).toBe(true);
  });
});
