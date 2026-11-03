import type {
  Account,
  AccountRemovedEvent,
  AccountsListResponse,
} from '@/types';

export interface LegacyChatAccountCatalogWatchHandlers {
  readonly onSnapshot?: (snapshot: AccountsListResponse) => void;
  readonly onAccount?: (account: Account) => void;
  readonly onAccountRemoved?: (event: AccountRemovedEvent) => void;
  readonly onError?: () => void;
}

export interface LegacyChatAccountCatalogStream {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface LegacyChatAccountCatalogTransport {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  openStream(url: string): LegacyChatAccountCatalogStream;
}

// LegacyChatAccountCatalogClient 只暴露聊天所需的目录读取，杜绝旧账号写入口回流。
export class LegacyChatAccountCatalogClient {
  private readonly transport: LegacyChatAccountCatalogTransport;

  constructor(transport: LegacyChatAccountCatalogTransport) {
    this.transport = transport;
  }

  async list(): Promise<AccountsListResponse> {
    const response = await this.transport.fetch('/v0/webui/accounts', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`legacy_chat_account_catalog_http_${response.status}`);
    }
    return decodeSnapshot(await response.json());
  }

  watch(handlers: LegacyChatAccountCatalogWatchHandlers): { close(): void } {
    let closed = false;
    let stream: LegacyChatAccountCatalogStream;
    try {
      stream = this.transport.openStream('/v0/webui/accounts/watch');
    } catch (_error) {
      // 订阅构造失败不能穿透 React effect；异步转成一次可恢复的目录错误。
      queueMicrotask(() => {
        if (!closed) handlers.onError?.();
      });
      return {
        close: () => {
          closed = true;
        },
      };
    }
    stream.onmessage = (event) => {
      try {
        dispatchWatchEvent(JSON.parse(String(event.data || '{}')), handlers);
      } catch (_error) {
        // 单个畸形事件不能中断后续账号目录更新。
      }
    };
    stream.onerror = () => {
      if (!closed) handlers.onError?.();
    };
    return {
      close: () => {
        closed = true;
        stream.close();
      },
    };
  }
}

function dispatchWatchEvent(
  input: unknown,
  handlers: LegacyChatAccountCatalogWatchHandlers,
): void {
  if (!isRecord(input)) return;
  if (input.type === 'snapshot') {
    handlers.onSnapshot?.(decodeSnapshot(input));
    return;
  }
  if (input.type === 'account' && isRecord(input.account)) {
    handlers.onAccount?.(input.account as unknown as Account);
    return;
  }
  if (input.type !== 'account-removed') return;
  handlers.onAccountRemoved?.({
    provider: String(input.provider || '') as AccountRemovedEvent['provider'],
    accountRef: String(input.accountRef || ''),
    reason: String(input.reason || ''),
    removedAt: Number(input.removedAt) || 0,
  });
}

function decodeSnapshot(input: unknown): AccountsListResponse {
  if (!isRecord(input) || !Array.isArray(input.accounts)) {
    throw new Error('legacy_chat_account_catalog_response_invalid');
  }
  return {
    accounts: input.accounts as Account[],
    hydrating: input.hydrating === true,
    providerNativeCapabilities: isRecord(input.providerNativeCapabilities)
      ? input.providerNativeCapabilities
      : {},
  } as AccountsListResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
