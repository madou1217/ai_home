/**
 * 跨 Tab 共享的 WebUI watch SSE 持有者。
 *
 * 背景(2026-09-11,B30):HTTP/1.1 下浏览器对单源只有 6 条连接。每个 Tab 各自持有
 * projects/accounts/tasks 三条 watch SSE 后,第二个 Tab 的普通 API 请求再也拿不到
 * 连接(实测 chrome 侧 6 条 ESTABLISHED 全被 SSE 占满,`/v0/webui/chat-sessions`
 * 排队至 30s 超时),表现为「回访 Tab 纯聊天会话列表为空、任务面板不更新」。
 *
 * 设计:每个订阅路径只允许一个「leader」Tab 真正持有 SSE——用 Web Locks 按路径选主,
 * 不同页面可以持有不同路径,避免账号页 leader 没订阅 projects 时会话页永远收不到更新。
 * 关页/崩溃或最后一个本地订阅关闭后释放锁,等待中的 Tab 自动继位并重连。事件经 BroadcastChannel
 * 中继给 follower Tab;后加入的订阅只回放完整快照和最新状态,不重放一次性业务事件。
 * 不支持 Web Locks / BroadcastChannel 的环境退化为每 Tab 自持(旧行为)。
 *
 * 只实现本仓库 watch 消费方用到的 EventSource 子集:onopen/onmessage/onerror/close。
 */
import {
  guardedWebUiEventSource,
  isTransportTargetStillValid,
  resolveActiveTransportTarget,
  subscribeTransportTargetChange,
  type WebUiTransportTarget,
} from './webui-auth-transport';

type WatchEventKind = 'open' | 'message' | 'error';
type RelayPayload = {
  path?: unknown;
  kind?: unknown;
  data?: unknown;
  recipient?: unknown;
  readyState?: unknown;
  frames?: unknown;
};

type LockRequest = (name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void> | undefined) => Promise<unknown>;

export interface SharedWatchEnv {
  readonly requestLock: LockRequest | null;
  readonly createChannel: (name: string) => BroadcastChannel | null;
  readonly openReal: (path: string) => EventSource;
}

export interface SharedWatchSource {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  readonly readyState: number;
  close(): void;
}

interface SourceRecord {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  readyState: number;
  closed: boolean;
  awaitingReplay: boolean;
}

interface PathHub {
  real: EventSource | null;
  sources: Set<SourceRecord>;
  leader: boolean;
  electionStarted: boolean;
  releaseLeadership: (() => void) | null;
  readyState: number;
  replayFrames: Map<string, string>;
}

export interface SharedWatchHub {
  open(path: string): SharedWatchSource;
  /** 仅供测试:当前是否为 leader */
  readonly isLeader: boolean;
  /** 关闭该 hub 下的全部真实连接、频道并释放锁，阻止过期 scope 继续重连。 */
  dispose?(): void;
}

export function createSharedWatchHub(env: SharedWatchEnv, lockName: string, channelName: string): SharedWatchHub {
  let channel: BroadcastChannel | null = null;
  let disposed = false;
  const hubs = new Map<string, PathHub>();
  const relayId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random()}`;

  const hubFor = (path: string): PathHub => {
    let hub = hubs.get(path);
    if (!hub) {
      hub = {
        real: null,
        sources: new Set(),
        leader: false,
        electionStarted: false,
        releaseLeadership: null,
        readyState: 0,
        replayFrames: new Map(),
      };
      hubs.set(path, hub);
    }
    return hub;
  };

  const deliverRecord = (record: SourceRecord, kind: WatchEventKind, data: string): void => {
    if (record.closed) return;
    try {
      if (kind === 'open') {
        record.readyState = 1;
        record.onopen?.(new Event('open'));
      } else if (kind === 'message') {
        record.onmessage?.({ data } as MessageEvent);
      } else {
        record.readyState = 0;
        record.onerror?.(new Event('error'));
      }
    } catch (_error) {
      // 单个订阅回调异常不能中断其它订阅或跨 Tab 中继。
    }
  };

  const deliver = (path: string, kind: WatchEventKind, data: string): void => {
    const hub = hubs.get(path);
    if (!hub || hub.sources.size === 0) return;
    if (kind === 'message') {
      rememberReplayFrame(hub.replayFrames, data);
      if (isSnapshotFrame(data)) {
        // A live snapshot may race a replay request. It already establishes the
        // subscriber's baseline, so do not send that same snapshot twice.
        hub.sources.forEach((record) => { record.awaitingReplay = false; });
      }
    }
    else {
      hub.readyState = kind === 'open' ? 1 : 0;
      if (kind === 'error') hub.replayFrames.clear();
    }
    hub.sources.forEach((record) => deliverRecord(record, kind, data));
  };

  const replayRecord = (hub: PathHub, record: SourceRecord): void => {
    if (record.closed || !record.awaitingReplay) return;
    record.awaitingReplay = false;
    if (hub.readyState === 1) deliverRecord(record, 'open', '');
    hub.replayFrames.forEach((data) => deliverRecord(record, 'message', data));
  };

  const ensureChannel = (): void => {
    if (channel || !env.createChannel) return;
    channel = env.createChannel(channelName);
    if (!channel) return;
    channel.onmessage = (msg: MessageEvent) => {
      const payload = (msg.data || {}) as RelayPayload;
      if (typeof payload.path !== 'string' || typeof payload.kind !== 'string') return;
      const hub = hubs.get(payload.path);
      if (payload.kind === 'replay-request') {
        if (hub?.leader && typeof payload.recipient === 'string') {
          channel?.postMessage({
            path: payload.path,
            kind: 'replay',
            recipient: payload.recipient,
            readyState: hub.readyState,
            frames: [...hub.replayFrames.values()],
          });
        }
        return;
      }
      // 当前路径的 leader 本地已直接投递;其它路径的 leader 事件仍需接收。
      if (hub?.leader) return;
      if (!hub || hub.sources.size === 0) return;
      if (payload.kind === 'replay') {
        if (payload.recipient !== relayId || !Array.isArray(payload.frames)) return;
        if (![...hub.sources].some((record) => record.awaitingReplay)) return;
        hub.readyState = payload.readyState === 1 ? 1 : 0;
        payload.frames.forEach((frame) => {
          if (typeof frame === 'string') rememberReplayFrame(hub.replayFrames, frame);
        });
        hub.sources.forEach((record) => replayRecord(hub, record));
        return;
      }
      if (payload.kind === 'open' || payload.kind === 'message' || payload.kind === 'error') {
        deliver(payload.path, payload.kind, String(payload.data ?? ''));
      }
    };
  };

  const relay = (path: string, kind: WatchEventKind, data = ''): void => {
    channel?.postMessage({ path, kind, data });
  };

  const closeReal = (hub: PathHub): void => {
    const real = hub.real;
    if (!real) return;
    hub.real = null;
    real.onopen = null;
    real.onmessage = null;
    real.onerror = null;
    try { real.close(); } catch (_error) { /* ignore */ }
  };

  const openReal = (path: string, hub: PathHub): void => {
    if (disposed || hub.real) return;
    hub.readyState = 0;
    hub.replayFrames.clear();
    const real = env.openReal(path);
    hub.real = real;
    real.onopen = () => {
      if (disposed || hub.real !== real) return;
      deliver(path, 'open', '');
      relay(path, 'open');
    };
    real.onmessage = (event) => {
      if (disposed || hub.real !== real) return;
      const data = String(event.data ?? '');
      deliver(path, 'message', data);
      relay(path, 'message', data);
    };
    real.onerror = () => {
      if (disposed || hub.real !== real) return;
      deliver(path, 'error', '');
      relay(path, 'error');
    };
  };

  const holdLeadership = (path: string, hub: PathHub): Promise<void> | undefined => {
    if (disposed || hub.sources.size === 0) return undefined;
    hub.leader = true;
    openReal(path, hub);
    // 最后一个订阅关闭即释放,其它标签页无需等 leader 整页关闭。
    return new Promise<void>((resolve) => {
      hub.releaseLeadership = () => {
        hub.leader = false;
        hub.releaseLeadership = null;
        resolve();
      };
    });
  };

  const ensureElection = (path: string, hub: PathHub): void => {
    if (disposed || hub.electionStarted || hub.sources.size === 0) return;
    hub.electionStarted = true;
    const settleElection = (): void => {
      hub.electionStarted = false;
      if (!disposed && hub.sources.size > 0) ensureElection(path, hub);
    };
    if (!env.requestLock) {
      // 无 Web Locks:退化为每 Tab 自持(与改造前一致)
      void holdLeadership(path, hub)?.finally(settleElection);
      return;
    }
    const pathLockName = `${lockName}:${path}`;
    try {
      void env.requestLock(pathLockName, { ifAvailable: true }, (lock) => {
        if (lock) return holdLeadership(path, hub);
        // 已有 leader:本 Tab 保持 follower,挂常规请求排队继位
        return env.requestLock!(pathLockName, { ifAvailable: false }, () => holdLeadership(path, hub))
          .then(() => {});
      }).catch((error: unknown) => {
        // 已无本地订阅、已持主、已销毁或显式取消的锁等待绝不降级成无锁重复连接。
        if (disposed || hub.sources.size === 0 || hub.leader) return undefined;
        if ((error as { name?: string } | null)?.name === 'AbortError') return undefined;
        return holdLeadership(path, hub);
      }).finally(settleElection);
    } catch (_error) {
      if (!disposed && hub.sources.size > 0 && !hub.leader) {
        void holdLeadership(path, hub)?.finally(settleElection);
      } else {
        hub.electionStarted = false;
      }
    }
  };

  return {
    get isLeader() { return !disposed && [...hubs.values()].some((hub) => hub.leader); },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const hub of hubs.values()) {
        for (const record of hub.sources) {
          record.closed = true;
          record.readyState = 2;
        }
        hub.sources.clear();
        closeReal(hub);
        hub.readyState = 0;
        hub.replayFrames.clear();
        hub.releaseLeadership?.();
      }
      hubs.clear();
      if (channel) {
        channel.onmessage = null;
        try { channel.close(); } catch (_error) { /* ignore */ }
        channel = null;
      }
    },
    open(path: string): SharedWatchSource {
      if (disposed) {
        return {
          onopen: null,
          onmessage: null,
          onerror: null,
          readyState: 2,
          close() {},
        };
      }
      ensureChannel();
      const hub = hubFor(path);
      const record: SourceRecord = {
        onopen: null, onmessage: null, onerror: null,
        readyState: 0, closed: false, awaitingReplay: true,
      };
      hub.sources.add(record);
      ensureElection(path, hub);
      // 回调安装完成后再回放;BroadcastChannel 不保留订阅前的事件。
      queueMicrotask(() => {
        if (record.closed) return;
        if (hub.replayFrames.has('snapshot') || hub.leader) replayRecord(hub, record);
        else channel?.postMessage({ path, kind: 'replay-request', recipient: relayId });
      });
      return {
        get onopen() { return record.onopen; },
        set onopen(fn) { record.onopen = fn; },
        get onmessage() { return record.onmessage; },
        set onmessage(fn) { record.onmessage = fn; },
        get onerror() { return record.onerror; },
        set onerror(fn) { record.onerror = fn; },
        get readyState() { return record.readyState; },
        close() {
          if (record.closed) return;
          record.closed = true;
          record.readyState = 2;
          hub.sources.delete(record);
          // 引用计数归零:leader 侧释放真实连接,不让空 path 白占连接
          if (hub.sources.size === 0) {
            closeReal(hub);
            hub.readyState = 0;
            hub.replayFrames.clear();
            hub.releaseLeadership?.();
          }
        },
      };
    },
  };
}

/** 只保留可重建目录的状态;token 消耗、作业等一次性事件绝不回放。 */
function rememberReplayFrame(frames: Map<string, string>, data: string): void {
  try {
    const payload = JSON.parse(data);
    if (payload.type === 'snapshot') {
      const runtime = frames.get('runtime');
      frames.clear();
      frames.set('snapshot', data);
      if (runtime) frames.set('runtime', runtime);
    } else if (payload.type === 'account' && payload.account?.accountRef) {
      frames.set(`account:${payload.account.accountRef}`, data);
    } else if (payload.type === 'account-removed' && payload.accountRef) {
      frames.set(`account:${payload.accountRef}`, data);
    } else if (payload.type === 'task' && payload.task?.id) {
      frames.set(`task:${payload.task.id}`, data);
    } else if (payload.type === 'runtime' || payload.type === 'hydrated') {
      frames.set(payload.type, data);
    }
  } catch (_error) {
    // 畸形事件仍实时中继,但不能污染供新订阅重建目录的状态。
  }
}

function isSnapshotFrame(data: string): boolean {
  try {
    return JSON.parse(data)?.type === 'snapshot';
  } catch (_error) {
    return false;
  }
}

const DEFAULT_LOCK_NAME = 'aih-webui-watch-holder-v2';
const DEFAULT_CHANNEL_NAME = 'aih-webui-watch-relay-v2';

interface ScopedDefaultHubEntry {
  readonly target: WebUiTransportTarget;
  readonly hub: SharedWatchHub;
  openCount: number;
}

const defaultHubsByScope = new Map<string, ScopedDefaultHubEntry>();
const liveLeaderSources = new Set<EventSource>();
let lifecycleListenersInstalled = false;

function disposeScopedHubEntry(scopeKey: string, entry: ScopedDefaultHubEntry): void {
  if (defaultHubsByScope.get(scopeKey) === entry) {
    defaultHubsByScope.delete(scopeKey);
  }
  entry.hub.dispose?.();
}

function pruneObsoleteScopedHubs(): void {
  const currentTarget = resolveActiveTransportTarget();
  for (const [scopeKey, entry] of [...defaultHubsByScope.entries()]) {
    if (!isTransportTargetStillValid(entry.target)) {
      disposeScopedHubEntry(scopeKey, entry);
      continue;
    }
    if (scopeKey !== currentTarget.scopeKey && entry.openCount <= 0) {
      disposeScopedHubEntry(scopeKey, entry);
    }
  }
}

function ensureLifecycleListeners(): void {
  if (lifecycleListenersInstalled || typeof window === 'undefined') return;
  lifecycleListenersInstalled = true;
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    for (const source of [...liveLeaderSources]) {
      liveLeaderSources.delete(source);
      try { source.close(); } catch (_error) { /* ignore */ }
    }
    for (const [scopeKey, entry] of [...defaultHubsByScope.entries()]) {
      disposeScopedHubEntry(scopeKey, entry);
    }
  });
  subscribeTransportTargetChange(pruneObsoleteScopedHubs);
}

function createBoundRealOpener(target: WebUiTransportTarget): (path: string) => EventSource {
  return (path: string) => {
    ensureLifecycleListeners();
    // Always bind the real EventSource to this hub's captured transport target
    // (never reading the shifting global active server) so reconnects and Web
    // Lock leadership handoffs cannot connect to server B under hub A's scope.
    const real = guardedWebUiEventSource(path, { target });
    liveLeaderSources.add(real);
    const originalClose = real.close.bind(real);
    real.close = () => {
      liveLeaderSources.delete(real);
      originalClose();
    };
    return real;
  };
}

function resolveDefaultHubEntry(target: WebUiTransportTarget): ScopedDefaultHubEntry | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  ensureLifecycleListeners();
  const existing = defaultHubsByScope.get(target.scopeKey);
  if (existing && isTransportTargetStillValid(existing.target)) {
    return existing;
  }
  if (existing) {
    disposeScopedHubEntry(target.scopeKey, existing);
  }
  const lockName = target.scopeKey === 'local'
    ? DEFAULT_LOCK_NAME
    : `${DEFAULT_LOCK_NAME}:${target.scopeKey}`;
  const channelName = target.scopeKey === 'local'
    ? DEFAULT_CHANNEL_NAME
    : `${DEFAULT_CHANNEL_NAME}:${target.scopeKey}`;
  const nav = navigator as Navigator & { locks?: { request: LockRequest } };
  const hub = createSharedWatchHub(
    {
      requestLock: nav.locks ? (name, options, callback) => nav.locks!.request(name, options, callback) : null,
      createChannel: (name) => new BroadcastChannel(name),
      openReal: createBoundRealOpener(target),
    },
    lockName,
    channelName,
  );
  const entry: ScopedDefaultHubEntry = { target, hub, openCount: 0 };
  defaultHubsByScope.set(target.scopeKey, entry);
  return entry;
}

/**
 * 打开跨 Tab 共享的 watch SSE。返回值满足本仓库 watch 消费方使用的 EventSource 子集。
 * 环境不支持共享(无 window/BroadcastChannel)时退化为直连真实 EventSource。
 */
export function openSharedWebUiEventSource(path: string): EventSource {
  const target = resolveActiveTransportTarget();
  const entry = resolveDefaultHubEntry(target);
  if (!entry) return guardedWebUiEventSource(path, { target });
  const source = entry.hub.open(path);
  entry.openCount += 1;
  let closed = false;
  const originalClose = source.close.bind(source);
  source.close = () => {
    if (closed) return;
    closed = true;
    entry.openCount = Math.max(0, entry.openCount - 1);
    originalClose();
    if (entry.openCount === 0 && resolveActiveTransportTarget().scopeKey !== entry.target.scopeKey) {
      disposeScopedHubEntry(entry.target.scopeKey, entry);
    }
  };
  return source as unknown as EventSource;
}
