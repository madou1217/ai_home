/**
 * Cross-Tab Session & Active State Synchronizer
 * 吸收 dsh 2.0 生产级多 Tab 状态协同，基于 BroadcastChannel 实现跨 Tab 会话与模型状态毫秒级自愈
 */

export interface CrossTabSyncEvent {
  type: 'SESSION_FORKED' | 'SESSION_PINNED' | 'SESSION_UPDATED' | 'MODEL_CHANGED' | 'THEME_CHANGED';
  payload: any;
  timestamp: number;
  sourceTabId: string;
}

const SYNC_CHANNEL_NAME = 'aih_cross_tab_sync_channel';
const TAB_ID = Math.random().toString(36).substring(2, 9);

class CrossTabSyncCoordinator {
  private channel: BroadcastChannel | null = null;
  private listeners: Map<string, Set<(event: CrossTabSyncEvent) => void>> = new Map();

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
        this.channel.onmessage = (messageEvent) => {
          const event: CrossTabSyncEvent = messageEvent.data;
          if (event && event.sourceTabId !== TAB_ID) {
            this.notify(event);
          }
        };
      } catch (err) {
        console.warn('[CrossTabSync] BroadcastChannel not supported or failed to initialize:', err);
      }
    }
  }

  public broadcast(type: CrossTabSyncEvent['type'], payload: any): void {
    if (!this.channel) return;
    try {
      const event: CrossTabSyncEvent = {
        type,
        payload,
        timestamp: Date.now(),
        sourceTabId: TAB_ID,
      };
      this.channel.postMessage(event);
    } catch (err) {
      console.warn('[CrossTabSync] Broadcast failed:', err);
    }
  }

  public subscribe(type: CrossTabSyncEvent['type'] | '*', callback: (event: CrossTabSyncEvent) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);

    return () => {
      const set = this.listeners.get(type);
      if (set) {
        set.delete(callback);
      }
    };
  }

  private notify(event: CrossTabSyncEvent): void {
    const specificCallbacks = this.listeners.get(event.type);
    if (specificCallbacks) {
      specificCallbacks.forEach((cb) => cb(event));
    }
    const wildcardCallbacks = this.listeners.get('*');
    if (wildcardCallbacks) {
      wildcardCallbacks.forEach((cb) => cb(event));
    }
  }
}

export const crossTabSync = new CrossTabSyncCoordinator();

// THEME_CHANGED 接收端：把其他 Tab（广播方见 GlobalCommandPalette）的主题切换应用到本页。
// 只应用、不回播；配合 sourceTabId 过滤与 BroadcastChannel 不回送发送者的语义，保证无回环。
if (typeof document !== 'undefined') {
  crossTabSync.subscribe('THEME_CHANGED', (event) => {
    const theme = event?.payload?.theme;
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  });
}
