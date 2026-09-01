import assert from 'node:assert/strict';
import test from 'node:test';

// BroadcastChannel 假实现：多个实例共享总线，但消息不投递给发送者自身（与浏览器语义一致）。
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  onmessage: ((ev: { data: any }) => void) | null = null;
  posted: any[] = [];
  constructor(public name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: any) {
    this.posted.push(data);
    for (const inst of FakeBroadcastChannel.instances) {
      if (inst !== this && inst.name === this.name) inst.onmessage?.({ data });
    }
  }
  close() {}
}

function createStorageShim() {
  const store = new Map<string, string>();
  return {
    store,
    shim: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    },
  };
}

const SYNC_CHANNEL_NAME = 'aih_cross_tab_sync_channel';
const themeAttributes = new Map<string, string>();

// 模块单例在 import 时即读取 window/BroadcastChannel/document，必须先注入假环境再动态导入。
(globalThis as any).window = globalThis;
// 补齐 location：bun 全量测试同进程内其他测试文件会评估 axios，其浏览器环境探测要求 window.location 存在
(globalThis as any).location = { href: 'http://localhost/' };
(globalThis as any).BroadcastChannel = FakeBroadcastChannel;
(globalThis as any).document = {
  documentElement: {
    setAttribute: (k: string, v: string) => {
      themeAttributes.set(k, v);
    },
    getAttribute: (k: string) => (themeAttributes.has(k) ? themeAttributes.get(k)! : null),
  },
};
const tabA = createStorageShim();
const tabB = createStorageShim();
(globalThis as any).localStorage = tabA.shim;

const { crossTabSync } = await import('@/services/cross-tab-session-sync');
const pinState = await import('@/components/chat/pin-session-state');

// 模块加载时协调器创建的频道实例（第 0 个），其余实例为各测试里扮演的“其他 Tab”。
const coordinatorChannel = FakeBroadcastChannel.instances[0];
assert.ok(coordinatorChannel instanceof FakeBroadcastChannel);

function openForeignTab() {
  return new FakeBroadcastChannel(SYNC_CHANNEL_NAME);
}

test('setPinnedSessionId / togglePinnedSessionId 幂等读写 localStorage', () => {
  tabA.store.clear();
  assert.deepEqual([...pinState.getPinnedSessionIds()], []);

  const pinned = pinState.setPinnedSessionId('s1', true);
  assert.equal(pinned.has('s1'), true);
  assert.equal(pinState.getPinnedSessionIds().has('s1'), true);
  // 幂等：重复设置同一状态不产生差异
  assert.deepEqual([...pinState.setPinnedSessionId('s1', true)], ['s1']);

  const unpinned = pinState.setPinnedSessionId('s1', false);
  assert.equal(unpinned.has('s1'), false);
  assert.equal(pinState.getPinnedSessionIds().has('s1'), false);

  assert.equal(pinState.togglePinnedSessionId('s2').has('s2'), true);
  assert.equal(pinState.togglePinnedSessionId('s2').has('s2'), false);
  assert.equal(tabA.store.get('aih_pinned_sessions'), '[]');
});

test('置顶 -> 广播 SESSION_PINNED -> 另一 Tab 应用端幂等更新自身存储且不回播', () => {
  tabA.store.clear();
  tabB.store.clear();
  FakeBroadcastChannel.instances.forEach((inst) => {
    inst.posted = [];
  });

  // Tab B：模拟 ProjectList 订阅端，收到事件后写入自己独立的 localStorage（只应用，不广播）。
  const tabBChannel = openForeignTab();
  let tabBPinned: Set<string> = new Set();
  tabBChannel.onmessage = (ev) => {
    const event = ev.data;
    if (event?.type !== 'SESSION_PINNED') return;
    (globalThis as any).localStorage = tabB.shim;
    try {
      tabBPinned = pinState.setPinnedSessionId(
        String(event.payload?.sessionId || ''),
        Boolean(event.payload?.pinned),
      );
    } finally {
      (globalThis as any).localStorage = tabA.shim;
    }
  };

  // Tab A：用户点击置顶（ProjectList.handleTogglePin 的等价动作）。
  const next = pinState.togglePinnedSessionId('s1');
  crossTabSync.broadcast('SESSION_PINNED', { sessionId: 's1', pinned: next.has('s1') });

  // Tab B 的 UI 状态与持久化存储均已更新
  assert.equal(tabBPinned.has('s1'), true);
  assert.equal(tabB.store.get('aih_pinned_sessions'), '["s1"]');
  // Tab A 自身存储不受影响地保持置顶
  assert.equal(tabA.store.get('aih_pinned_sessions'), '["s1"]');

  // 无回环：全总线只有 Tab A 的这一次广播，应用端没有再 postMessage
  const totalPosted = FakeBroadcastChannel.instances.reduce((sum, inst) => sum + inst.posted.length, 0);
  assert.equal(totalPosted, 1);

  // 另一 Tab 取消置顶，同样同步到 Tab B
  const after = pinState.togglePinnedSessionId('s1');
  crossTabSync.broadcast('SESSION_PINNED', { sessionId: 's1', pinned: after.has('s1') });
  assert.equal(tabBPinned.has('s1'), false);
  assert.equal(tabB.store.get('aih_pinned_sessions'), '[]');

  tabBChannel.close();
});

test('自身广播不触发自身订阅回调（总线不回送 + sourceTabId 过滤双保险）', () => {
  let received = 0;
  const unsubscribe = crossTabSync.subscribe('SESSION_PINNED', () => {
    received += 1;
  });

  crossTabSync.broadcast('SESSION_PINNED', { sessionId: 's2', pinned: true });
  assert.equal(received, 0);

  // 即使总线把同一条事件原样回送，sourceTabId 相同也会被协调器过滤
  const selfEvent = coordinatorChannel.posted[coordinatorChannel.posted.length - 1];
  assert.ok(selfEvent?.sourceTabId);
  openForeignTab().postMessage(selfEvent);
  assert.equal(received, 0);

  unsubscribe();
});

test('远端事件驱动订阅回调，退订后不再接收', () => {
  const received: string[] = [];
  const unsubscribe = crossTabSync.subscribe('SESSION_PINNED', (event) => {
    received.push(String(event.payload?.sessionId || ''));
  });

  const foreign = openForeignTab();
  foreign.postMessage({
    type: 'SESSION_PINNED',
    payload: { sessionId: 's9', pinned: true },
    timestamp: Date.now(),
    sourceTabId: 'other-tab',
  });
  assert.deepEqual(received, ['s9']);

  unsubscribe();
  foreign.postMessage({
    type: 'SESSION_PINNED',
    payload: { sessionId: 's10', pinned: true },
    timestamp: Date.now(),
    sourceTabId: 'other-tab',
  });
  assert.deepEqual(received, ['s9']);
  foreign.close();
});

test('THEME_CHANGED 接收端把远端主题应用到 documentElement，非法值忽略', () => {
  themeAttributes.clear();
  const foreign = openForeignTab();
  foreign.postMessage({
    type: 'THEME_CHANGED',
    payload: { theme: 'dark' },
    timestamp: Date.now(),
    sourceTabId: 'other-tab',
  });
  assert.equal(themeAttributes.get('data-theme'), 'dark');

  foreign.postMessage({
    type: 'THEME_CHANGED',
    payload: { theme: 'neon' },
    timestamp: Date.now(),
    sourceTabId: 'other-tab',
  });
  assert.equal(themeAttributes.get('data-theme'), 'dark');
  foreign.close();
});
