/**
 * 跨 Tab 共享的 WebUI watch SSE 持有者。
 *
 * 背景(2026-09-11,B30):HTTP/1.1 下浏览器对单源只有 6 条连接。每个 Tab 各自持有
 * projects/accounts/tasks 三条 watch SSE 后,第二个 Tab 的普通 API 请求再也拿不到
 * 连接(实测 chrome 侧 6 条 ESTABLISHED 全被 SSE 占满,`/v0/webui/chat-sessions`
 * 排队至 30s 超时),表现为「回访 Tab 纯聊天会话列表为空、任务面板不更新」。
 *
 * 设计:全浏览器只允许一个「leader」Tab 真正持有 SSE——用 Web Locks 选主,
 * 关页/崩溃锁自动释放,等待中的 Tab 自动继位并重连。事件经 BroadcastChannel
 * 中继给 follower Tab,各 Tab 的消费代码(刷新列表等)完全不用变。
 * 不支持 Web Locks / BroadcastChannel 的环境退化为每 Tab 自持(旧行为)。
 *
 * 只实现本仓库 watch 消费方用到的 EventSource 子集:onopen/onmessage/onerror/close。
 */
import { guardedWebUiEventSource } from './webui-auth-transport';

type WatchEventKind = 'open' | 'message' | 'error';

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
}

interface PathHub {
  real: EventSource | null;
  sources: Set<SourceRecord>;
}

export interface SharedWatchHub {
  open(path: string): SharedWatchSource;
  /** 仅供测试:当前是否为 leader */
  readonly isLeader: boolean;
}

export function createSharedWatchHub(env: SharedWatchEnv, lockName: string, channelName: string): SharedWatchHub {
  let leader = false;
  let electionStarted = false;
  let channel: BroadcastChannel | null = null;
  const hubs = new Map<string, PathHub>();

  const hubFor = (path: string): PathHub => {
    let hub = hubs.get(path);
    if (!hub) {
      hub = { real: null, sources: new Set() };
      hubs.set(path, hub);
    }
    return hub;
  };

  const deliver = (path: string, kind: WatchEventKind, data: string): void => {
    const hub = hubs.get(path);
    if (!hub) return;
    hub.sources.forEach((record) => {
      if (record.closed) return;
      if (kind === 'open') {
        record.readyState = 1;
        record.onopen?.(new Event('open'));
      } else if (kind === 'message') {
        record.onmessage?.({ data } as MessageEvent);
      } else {
        record.onerror?.(new Event('error'));
      }
    });
  };

  const ensureChannel = (): void => {
    if (channel || !env.createChannel) return;
    channel = env.createChannel(channelName);
    if (!channel) return;
    channel.onmessage = (msg: MessageEvent) => {
      // leader 本地已直接投递,跳过自己的回声
      if (leader) return;
      const payload = (msg.data || {}) as { path?: unknown; kind?: unknown; data?: unknown };
      if (typeof payload.path !== 'string' || typeof payload.kind !== 'string') return;
      deliver(payload.path, payload.kind as WatchEventKind, String(payload.data ?? ''));
    };
  };

  const relay = (path: string, kind: WatchEventKind, data = ''): void => {
    channel?.postMessage({ path, kind, data });
  };

  const openReal = (path: string, hub: PathHub): void => {
    if (hub.real) return;
    const real = env.openReal(path);
    hub.real = real;
    real.onopen = () => { deliver(path, 'open', ''); relay(path, 'open'); };
    real.onmessage = (event) => {
      const data = String(event.data ?? '');
      deliver(path, 'message', data);
      relay(path, 'message', data);
    };
    real.onerror = () => { deliver(path, 'error', ''); relay(path, 'error'); };
  };

  const holdLeadership = (): Promise<void> => {
    if (!leader) {
      leader = true;
      // 继位:为本 Tab 已注册的所有 path 补开真实连接
      hubs.forEach((hub, path) => { if (hub.sources.size > 0) openReal(path, hub); });
    }
    // 永不 resolve = 持有锁直到页面关闭/崩溃,浏览器自动释放
    return new Promise<void>(() => {});
  };

  const ensureElection = (): void => {
    if (electionStarted) return;
    electionStarted = true;
    if (!env.requestLock) {
      // 无 Web Locks:退化为每 Tab 自持(与改造前一致)
      void holdLeadership();
      return;
    }
    try {
      void env.requestLock(lockName, { ifAvailable: true }, (lock) => {
        if (lock) return holdLeadership();
        // 已有 leader:本 Tab 保持 follower,挂常规请求排队继位
        void env.requestLock!(lockName, { ifAvailable: false }, () => holdLeadership()).catch(() => {});
        return undefined;
      }).catch(() => { void holdLeadership(); });
    } catch (_error) {
      void holdLeadership();
    }
  };

  return {
    get isLeader() { return leader; },
    open(path: string): SharedWatchSource {
      ensureChannel();
      ensureElection();
      const hub = hubFor(path);
      const record: SourceRecord = {
        onopen: null, onmessage: null, onerror: null,
        readyState: 0, closed: false,
      };
      hub.sources.add(record);
      if (leader) openReal(path, hub);
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
          if (hub.sources.size === 0 && hub.real) {
            hub.real.close();
            hub.real = null;
          }
        },
      };
    },
  };
}

const DEFAULT_LOCK_NAME = 'aih-webui-watch-holder-v1';
const DEFAULT_CHANNEL_NAME = 'aih-webui-watch-relay-v1';

let defaultHub: SharedWatchHub | null = null;

function resolveDefaultHub(): SharedWatchHub | null {
  if (defaultHub) return defaultHub;
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  const nav = navigator as Navigator & { locks?: { request: LockRequest } };
  defaultHub = createSharedWatchHub(
    {
      requestLock: nav.locks ? (name, options, callback) => nav.locks!.request(name, options, callback) : null,
      createChannel: (name) => new BroadcastChannel(name),
      openReal: (path) => guardedWebUiEventSource(path),
    },
    DEFAULT_LOCK_NAME,
    DEFAULT_CHANNEL_NAME,
  );
  return defaultHub;
}

/**
 * 打开跨 Tab 共享的 watch SSE。返回值满足本仓库 watch 消费方使用的 EventSource 子集。
 * 环境不支持共享(无 window/BroadcastChannel)时退化为直连真实 EventSource。
 */
export function openSharedWebUiEventSource(path: string): EventSource {
  const hub = resolveDefaultHub();
  if (!hub) return guardedWebUiEventSource(path);
  return hub.open(path) as unknown as EventSource;
}
