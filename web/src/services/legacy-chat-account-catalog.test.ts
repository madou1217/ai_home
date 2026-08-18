import assert from 'node:assert/strict';
import test from 'node:test';

import { LegacyChatAccountCatalogClient } from './legacy-chat-account-catalog-core.ts';

test('旧聊天账号目录从 Node 只读快照保留非 Codex/Claude Provider', async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchResource = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Response.json({
      ok: true,
      accounts: [
        account('grok', 'grok-account'),
        account('agy', 'agy-account'),
      ],
      hydrating: false,
      providerNativeCapabilities: {},
    });
  };
  const client = new LegacyChatAccountCatalogClient({
    fetch: fetchResource,
    openStream: () => {
      throw new Error('unexpected_stream');
    },
  });

  const snapshot = await client.list();

  assert.deepEqual(snapshot.accounts.map(({ provider }) => provider), ['grok', 'agy']);
  assert.equal(String(requests[0]?.input), '/v0/webui/accounts');
  assert.equal(requests[0]?.init?.method, 'GET');
});

test('旧聊天账号目录 SSE 只投影快照、账号变更和删除事件', () => {
  const stream = new FakeStream();
  const client = new LegacyChatAccountCatalogClient({
    fetch: async () => {
      throw new Error('unexpected_fetch');
    },
    openStream: (url) => {
      assert.equal(url, '/v0/webui/accounts/watch');
      return stream;
    },
  });
  const snapshots: string[][] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  let errors = 0;

  const watcher = client.watch({
    onSnapshot: ({ accounts }) => snapshots.push(accounts.map(({ provider }) => provider)),
    onAccount: ({ accountRef }) => changed.push(accountRef),
    onAccountRemoved: ({ accountRef }) => removed.push(accountRef),
    onError: () => { errors += 1; },
  });
  stream.emit({
    type: 'snapshot',
    accounts: [account('gemini', 'gemini-account'), account('kimi', 'kimi-account')],
    hydrating: true,
    providerNativeCapabilities: {},
  });
  stream.emit({ type: 'account', account: account('grok', 'grok-account') });
  stream.emit({
    type: 'account-removed',
    provider: 'agy',
    accountRef: 'agy-account',
    reason: 'deleted',
    removedAt: 123,
  });
  stream.emit({ type: 'unknown', secret: 'must-not-surface' });
  stream.onerror?.(new Event('error'));
  watcher.close();

  assert.deepEqual(snapshots, [['gemini', 'kimi']]);
  assert.deepEqual(changed, ['grok-account']);
  assert.deepEqual(removed, ['agy-account']);
  assert.equal(errors, 1);
  assert.equal(stream.closed, true);
});

test('旧聊天账号目录订阅构造失败不抛出并异步通知一次', async () => {
  let errors = 0;
  const client = new LegacyChatAccountCatalogClient({
    fetch: async () => {
      throw new Error('unexpected_fetch');
    },
    openStream: () => {
      throw new Error('stream_constructor_failed');
    },
  });

  const watcher = client.watch({
    onError: () => {
      errors += 1;
    },
  });
  await Promise.resolve();

  assert.equal(errors, 1);
  assert.doesNotThrow(() => watcher.close());
  assert.doesNotThrow(() => watcher.close());
});

class FakeStream {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  emit(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  close(): void {
    this.closed = true;
  }
}

function account(provider: string, accountRef: string) {
  return {
    provider,
    accountRef,
    status: 'up',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 1,
  };
}
