import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, Session } from '@/types';
import {
  SESSION_OFFLINE_CACHE_VERSION,
  SESSION_OFFLINE_DIRECTORY_ENTRY_LIMIT,
  SESSION_OFFLINE_DIRECTORY_SESSION_LIMIT,
  SESSION_OFFLINE_MESSAGE_ENTRY_LIMIT,
  SESSION_OFFLINE_MESSAGES_PER_SESSION_LIMIT,
  hashSessionOfflineCacheKey,
  readCachedSessionDirectory,
  readCachedSessionMessages,
  writeCachedSessionDirectory,
  writeCachedSessionMessages,
  type SessionOfflineCacheStorage,
} from './session-offline-cache';

function createStorage(budgetBytes = Number.POSITIVE_INFINITY): SessionOfflineCacheStorage & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      const next = new Map(store);
      next.set(key, String(value));
      const total = [...next.values()].reduce((sum, item) => sum + item.length, 0);
      if (total > budgetBytes) {
        const error = new Error('quota exceeded');
        (error as { name?: string }).name = 'QuotaExceededError';
        throw error;
      }
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

function makeSession(id: string, updatedAt = 10): Session {
  return {
    id,
    title: `会话 ${id}`,
    updatedAt,
    provider: 'codex',
    projectPath: '/workspace/repo',
    status: 'done',
  };
}

function makeMessage(index: number): ChatMessage {
  return { role: index % 2 === 0 ? 'user' : 'assistant', content: `消息 ${index}` };
}

test('目录缓存读写往返，并按 requestKey 隔离', () => {
  const storage = createStorage();
  const sessions = [makeSession('s-1', 20), makeSession('s-2', 10)];

  writeCachedSessionDirectory('scope-a', 'request-key-1', sessions, storage);

  assert.deepEqual(
    readCachedSessionDirectory('scope-a', 'request-key-1', storage).map((item) => item.id),
    ['s-1', 's-2'],
  );
  // 不同请求 key / 不同 scope 读不到彼此的缓存。
  assert.deepEqual(readCachedSessionDirectory('scope-a', 'request-key-2', storage), []);
  assert.deepEqual(readCachedSessionDirectory('scope-b', 'request-key-1', storage), []);
});

test('目录缓存按条数上限截断，保留最新的一段', () => {
  const storage = createStorage();
  const sessions = Array.from(
    { length: SESSION_OFFLINE_DIRECTORY_SESSION_LIMIT + 50 },
    (_, index) => makeSession(`s-${index}`, index),
  );

  writeCachedSessionDirectory('scope-a', 'request-key', sessions, storage);

  const cached = readCachedSessionDirectory('scope-a', 'request-key', storage);
  assert.equal(cached.length, SESSION_OFFLINE_DIRECTORY_SESSION_LIMIT);
  assert.equal(cached[0]?.id, 's-0');
});

test('目录缓存条目数超限按写入时间淘汰最旧条目', () => {
  const storage = createStorage();
  for (let index = 0; index <= SESSION_OFFLINE_DIRECTORY_ENTRY_LIMIT; index += 1) {
    writeCachedSessionDirectory('scope-a', `request-key-${index}`, [makeSession(`s-${index}`)], storage);
  }

  assert.deepEqual(readCachedSessionDirectory('scope-a', 'request-key-0', storage), []);
  assert.equal(
    readCachedSessionDirectory('scope-a', `request-key-${SESSION_OFFLINE_DIRECTORY_ENTRY_LIMIT}`, storage).length,
    1,
  );
});

test('消息缓存按会话读写往返', () => {
  const storage = createStorage();
  const session = { provider: 'claude', id: 'session-1', projectDirName: '-repo' };
  const messages = [makeMessage(0), makeMessage(1)];

  writeCachedSessionMessages('scope-a', session, messages, storage);

  assert.deepEqual(
    readCachedSessionMessages('scope-a', session, storage).map((item) => item.content),
    ['消息 0', '消息 1'],
  );
  // 会话身份不同（含 projectDirName 差异）读不到。
  assert.deepEqual(
    readCachedSessionMessages('scope-a', { ...session, projectDirName: '-other' }, storage),
    [],
  );
});

test('消息缓存只保留每会话尾部 N 条', () => {
  const storage = createStorage();
  const session = { provider: 'codex', id: 'session-1' };
  const total = SESSION_OFFLINE_MESSAGES_PER_SESSION_LIMIT + 30;
  const messages = Array.from({ length: total }, (_, index) => makeMessage(index));

  writeCachedSessionMessages('scope-a', session, messages, storage);

  const cached = readCachedSessionMessages('scope-a', session, storage);
  assert.equal(cached.length, SESSION_OFFLINE_MESSAGES_PER_SESSION_LIMIT);
  assert.equal(cached[0]?.content, `消息 ${total - SESSION_OFFLINE_MESSAGES_PER_SESSION_LIMIT}`);
  assert.equal(cached[cached.length - 1]?.content, `消息 ${total - 1}`);
});

test('消息缓存会话条数超限按写入时间淘汰最旧会话', () => {
  const storage = createStorage();
  for (let index = 0; index <= SESSION_OFFLINE_MESSAGE_ENTRY_LIMIT; index += 1) {
    writeCachedSessionMessages(
      'scope-a',
      { provider: 'codex', id: `session-${index}` },
      [makeMessage(index)],
      storage,
    );
  }

  assert.deepEqual(
    readCachedSessionMessages('scope-a', { provider: 'codex', id: 'session-0' }, storage),
    [],
  );
  assert.equal(
    readCachedSessionMessages(
      'scope-a',
      { provider: 'codex', id: `session-${SESSION_OFFLINE_MESSAGE_ENTRY_LIMIT}` },
      storage,
    ).length,
    1,
  );
});

test('版本不符的缓存被丢弃并清除', () => {
  const storage = createStorage();
  const session = { provider: 'codex', id: 'session-1' };
  writeCachedSessionMessages('scope-a', session, [makeMessage(0)], storage);
  const key = [...storage.store.keys()].find((item) => item.includes(':messages:'))!;
  storage.store.set(key, JSON.stringify({ version: 'v0', updatedAt: 1, items: [makeMessage(0)] }));

  assert.deepEqual(readCachedSessionMessages('scope-a', session, storage), []);
  assert.equal(storage.store.has(key), false);
});

test('配额不足时淘汰最旧条目重试写入', () => {
  // 预算卡在「两份条目 + 索引」之下、「单份条目 + 索引」之上：
  // 第二次写入必须淘汰第一份才能成功。
  const probe = createStorage();
  const sessionA = { provider: 'codex', id: 'session-a' };
  const sessionB = { provider: 'codex', id: 'session-b' };
  const bigMessages = [makeMessage(0), { role: 'assistant' as const, content: 'x'.repeat(1024) }];
  writeCachedSessionMessages('scope-a', sessionA, bigMessages, probe);
  writeCachedSessionMessages('scope-a', sessionB, bigMessages, probe);
  const bothSize = [...probe.store.values()].reduce((sum, item) => sum + item.length, 0);

  const storage = createStorage(bothSize - 200);
  writeCachedSessionMessages('scope-a', sessionA, bigMessages, storage);
  writeCachedSessionMessages('scope-a', sessionB, bigMessages, storage);

  assert.deepEqual(readCachedSessionMessages('scope-a', sessionA, storage), []);
  assert.equal(readCachedSessionMessages('scope-a', sessionB, storage).length, 2);
});

test('无存储环境读写安全返回空', () => {
  const globalTarget = globalThis as { localStorage?: unknown };
  const original = globalTarget.localStorage;
  delete globalTarget.localStorage;
  try {
    assert.deepEqual(readCachedSessionDirectory('scope-a', 'key'), []);
    assert.deepEqual(readCachedSessionMessages('scope-a', { provider: 'codex', id: 's' }), []);
    writeCachedSessionDirectory('scope-a', 'key', [makeSession('s-1')]);
    writeCachedSessionMessages('scope-a', { provider: 'codex', id: 's' }, [makeMessage(0)]);
  } finally {
    if (original !== undefined) globalTarget.localStorage = original;
  }
});

test('哈希函数稳定且收敛 key 长度', () => {
  const longKey = 'scope\u0000'.repeat(200);
  assert.equal(hashSessionOfflineCacheKey(longKey), hashSessionOfflineCacheKey(longKey));
  assert.notEqual(hashSessionOfflineCacheKey('a'), hashSessionOfflineCacheKey('b'));
  assert.ok(hashSessionOfflineCacheKey(longKey).length <= 12);
});

test('写入空数据不落盘，版本号常量随 key 前缀生效', () => {
  const storage = createStorage();
  writeCachedSessionDirectory('scope-a', 'key', [], storage);
  writeCachedSessionMessages('scope-a', { provider: 'codex', id: 's' }, [], storage);
  assert.equal(storage.store.size, 0);
  assert.ok(SESSION_OFFLINE_CACHE_VERSION.length > 0);
});
