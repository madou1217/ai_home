import type {
  Account,
  AccountAddJob,
  AccountRefreshJob,
  AccountRemovedEvent,
  AccountsListResponse,
  AccountsSnapshotRequestResponse
} from '../../types/index.ts';
import { AccountManagementError } from './errors.ts';
import type { AccountsWatchHandlers } from './legacy-contract.ts';

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface VisibilitySource {
  readonly visibilityState?: string;
  addEventListener(type: 'visibilitychange', listener: EventListener): void;
  removeEventListener(type: 'visibilitychange', listener: EventListener): void;
}
export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface AccountWatchCoordinatorOptions {
  loadSnapshot: () => Promise<AccountsListResponse>;
  now?: () => number;
  pollIntervalMs?: number;
  visibility?: VisibilitySource | null;
  scheduler?: TimerScheduler;
}

// AccountWatchCoordinator 合并页面订阅、显式变更通知和可见态低频轮询。
export class AccountWatchCoordinator {
  private readonly loadSnapshot: () => Promise<AccountsListResponse>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly visibility: VisibilitySource | null;
  private readonly scheduler: TimerScheduler;
  private readonly watchers = new Set<AccountsWatchHandlers>();
  private refreshInFlight: Promise<AccountsListResponse> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private mutationRefreshQueued = false;
  private visibilityListenerInstalled = false;

  constructor(options: AccountWatchCoordinatorOptions) {
    this.loadSnapshot = options.loadSnapshot;
    this.now = options.now || Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1_000) {
      throw new AccountManagementError('account_management_poll_interval_invalid');
    }
    this.visibility = options.visibility === undefined
      ? defaultVisibilitySource()
      : options.visibility;
    this.scheduler = options.scheduler || {
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) => globalThis.clearTimeout(handle)
    };
  }

  watch(handlers: AccountsWatchHandlers) {
    this.watchers.add(handlers);
    this.ensureVisibilityListener();
    if (this.isVisible()) void this.refresh().catch(() => {});
    return {
      close: () => {
        this.watchers.delete(handlers);
        if (this.watchers.size === 0) this.stopLifecycle();
      }
    };
  }

  async requestSnapshot(): Promise<AccountsSnapshotRequestResponse> {
    const requestedAt = this.now();
    const alreadyRunning = this.refreshInFlight !== null;
    this.forEachWatcher((handlers) => {
      handlers.onSnapshotRequested?.({ requestedAt, hydrating: false });
    });
    await this.refresh();
    return {
      ok: true,
      accepted: !alreadyRunning,
      alreadyRunning,
      requestedAt
    };
  }

  notifyMutation(): void {
    if (this.watchers.size === 0 || this.mutationRefreshQueued) return;
    this.mutationRefreshQueued = true;
    void Promise.resolve().then(() => {
      this.mutationRefreshQueued = false;
      return this.refresh();
    }).catch(() => {});
  }

  emitAccount(account: Account): void {
    this.forEachWatcher((handlers) => handlers.onAccount?.(account));
  }

  emitAccountRemoved(event: AccountRemovedEvent): void {
    this.forEachWatcher((handlers) => handlers.onAccountRemoved?.(event));
  }

  emitAuthJob(job: AccountAddJob): void {
    this.forEachWatcher((handlers) => handlers.onAuthJob?.(job));
  }

  emitRefreshJob(job: AccountRefreshJob): void {
    this.forEachWatcher((handlers) => handlers.onAccountRefreshJob?.(job));
  }

  private async refresh(): Promise<AccountsListResponse> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.clearPollTimer();
    const refresh = this.loadSnapshot()
      .then((snapshot) => {
        const hydratedAt = this.now();
        this.forEachWatcher((handlers) => {
          handlers.onSnapshot?.(snapshot);
          handlers.onHydrated?.({ hydratedAt });
        });
        return snapshot;
      })
      .catch((error: unknown) => {
        this.forEachWatcher((handlers) => handlers.onError?.());
        throw error;
      })
      .finally(() => {
        if (this.refreshInFlight === refresh) this.refreshInFlight = null;
        this.schedulePoll();
      });
    this.refreshInFlight = refresh;
    return refresh;
  }

  private forEachWatcher(notify: (handlers: AccountsWatchHandlers) => void): void {
    for (const handlers of this.watchers) {
      try {
        notify(handlers);
      } catch (_error) {
        // 单个页面回调异常不能中断其他订阅者或账号请求。
      }
    }
  }

  private ensureVisibilityListener(): void {
    if (!this.visibility || this.visibilityListenerInstalled) return;
    this.visibility.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.visibilityListenerInstalled = true;
  }

  private readonly handleVisibilityChange: EventListener = () => {
    if (!this.isVisible()) {
      this.clearPollTimer();
      return;
    }
    void this.refresh().catch(() => {});
  };

  private isVisible(): boolean {
    return !this.visibility || this.visibility.visibilityState !== 'hidden';
  }

  private schedulePoll(): void {
    this.clearPollTimer();
    if (this.watchers.size === 0 || !this.isVisible()) return;
    this.pollTimer = this.scheduler.setTimeout(() => {
      this.pollTimer = null;
      void this.refresh().catch(() => {});
    }, this.pollIntervalMs);
  }

  private clearPollTimer(): void {
    if (this.pollTimer === null) return;
    this.scheduler.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private stopLifecycle(): void {
    this.clearPollTimer();
    if (this.visibility && this.visibilityListenerInstalled) {
      this.visibility.removeEventListener('visibilitychange', this.handleVisibilityChange);
      this.visibilityListenerInstalled = false;
    }
  }
}

function defaultVisibilitySource(): VisibilitySource | null {
  return typeof document === 'undefined' ? null : document;
}
