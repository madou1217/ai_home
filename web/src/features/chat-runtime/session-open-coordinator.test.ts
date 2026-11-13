import test from 'node:test';
import assert from 'node:assert/strict';

import type { ChatRuntimeSession } from '@/chat-runtime';
import type { SessionRuntimeTarget } from './session-surface-policy.ts';
import { SessionOpenCoordinator, type SessionOpenApi } from './session-open-coordinator.ts';

// 并发挂载去重的回归守卫：同一目标同时打开时只能有一条请求真正发出，
// 且去重只覆盖「在途」——请求结束后必须释放，下一次主动打开要重新请求。

function target(overrides: Partial<SessionRuntimeTarget> = {}): SessionRuntimeTarget {
  return {
    provider: 'kiro',
    executionAccountRef: 'gateway',
    projectPath: '',
    policy: { approvalMode: 'confirm' },
    ...overrides
  };
}

function session(sessionId: string): ChatRuntimeSession {
  return {
    sessionId,
    provider: 'kiro',
    executionAccountRef: 'gateway',
    projectPath: '',
    state: 'idle',
    lastEventSeq: 0,
    createdAt: 1,
    updatedAt: 1,
    policy: {},
    runtimeBinding: {},
    capabilitySnapshot: {} as ChatRuntimeSession['capabilitySnapshot']
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function countingApi(create: () => Promise<ChatRuntimeSession>) {
  const calls = { create: 0, resolve: 0 };
  const api: SessionOpenApi = {
    createSession: () => {
      calls.create += 1;
      return create();
    },
    resolveSession: (input) => {
      calls.resolve += 1;
      return Promise.resolve({ status: 'adopted', session: session(String(input.sessionId)) });
    }
  };
  return { api, calls };
}

test('并发打开同一目标只发一条创建请求，双方拿到同一个会话', async () => {
  const coordinator = new SessionOpenCoordinator();
  const gate = deferred<ChatRuntimeSession>();
  const { api, calls } = countingApi(() => gate.promise);

  const first = coordinator.open(target(), api);
  const second = coordinator.open(target(), api);

  assert.equal(calls.create, 1, '并发两次只允许有一次真正请求');
  assert.equal(coordinator.pendingCount, 1);

  const shared = session('session-shared');
  gate.resolve(shared);

  assert.equal(await first, shared);
  assert.equal(await second, shared);
  assert.equal(coordinator.pendingCount, 0, '请求结束后必须释放在途表');
});

test('目标不同（执行账号不同）不合并', async () => {
  const coordinator = new SessionOpenCoordinator();
  const { api, calls } = countingApi(() => Promise.resolve(session('session-a')));

  await Promise.all([
    coordinator.open(target(), api),
    coordinator.open(target({ executionAccountRef: 'acct_x' }), api)
  ]);

  assert.equal(calls.create, 2);
});

test('并发解析同一已有会话只发一条 resolve', async () => {
  const coordinator = new SessionOpenCoordinator();
  const { api, calls } = countingApi(() => Promise.resolve(session('unused')));

  const [first, second] = await Promise.all([
    coordinator.open(target({ sessionId: 'session-1' }), api),
    coordinator.open(target({ sessionId: 'session-1' }), api)
  ]);

  assert.equal(calls.resolve, 1);
  assert.equal(calls.create, 0);
  assert.equal(first.sessionId, 'session-1');
  assert.equal(second.sessionId, 'session-1');
});

test('请求失败后释放在途表，下一次打开会重试而不是复用失败结果', async () => {
  const coordinator = new SessionOpenCoordinator();
  const failing = countingApi(() => Promise.reject(new Error('chat_runtime_unavailable')));

  await assert.rejects(coordinator.open(target(), failing.api), /chat_runtime_unavailable/);
  assert.equal(coordinator.pendingCount, 0, '失败也必须释放在途表');

  const retry = countingApi(() => Promise.resolve(session('session-retry')));
  assert.equal((await coordinator.open(target(), retry.api)).sessionId, 'session-retry');
  assert.equal(retry.calls.create, 1);
});

test('请求结束后的再次打开是新请求（只合并同时在途，不缓存结果）', async () => {
  const coordinator = new SessionOpenCoordinator();
  let created = 0;
  const api: SessionOpenApi = {
    createSession: () => {
      created += 1;
      return Promise.resolve(session('session-' + created));
    },
    resolveSession: (input) => Promise.resolve({
      status: 'adopted',
      session: session(String(input.sessionId))
    })
  };

  await coordinator.open(target(), api);
  await coordinator.open(target(), api);

  assert.equal(created, 2, '用户主动再次新建时不能被旧结果吞掉');
});
