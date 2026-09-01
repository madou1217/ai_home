import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@/types';
import type { CanonicalSessionDirectoryResult } from './canonical-session-directory';
import {
  createCanonicalSessionDirectoryRequestState,
  reduceCanonicalSessionDirectoryRequest,
} from './canonical-session-directory';

function session(id: string, updatedAt = 10): Session {
  return {
    id,
    title: '会话',
    updatedAt,
    provider: 'codex',
    projectPath: '/workspace/repo',
    status: 'done',
  };
}

function directory(sessions: readonly Session[]): CanonicalSessionDirectoryResult {
  return { sessions };
}

test('key 变化期间保留上一份成功数据并标记 stale，不清空列表', () => {
  const loaded = reduceCanonicalSessionDirectoryRequest(
    createCanonicalSessionDirectoryRequestState(true),
    { type: 'succeed', key: 'key-a', result: directory([session('s-1')]) },
  );

  const refreshing = reduceCanonicalSessionDirectoryRequest(loaded, { type: 'begin', key: 'key-b' });
  assert.equal(refreshing.status, 'loading');
  assert.equal(refreshing.stale, true);
  assert.deepEqual(refreshing.result.sessions.map((entry) => entry.id), ['s-1']);

  const settled = reduceCanonicalSessionDirectoryRequest(
    refreshing,
    { type: 'succeed', key: 'key-b', result: directory([session('s-2')]) },
  );
  assert.equal(settled.status, 'ready');
  assert.equal(settled.stale, false);
  assert.deepEqual(settled.result.sessions.map((entry) => entry.id), ['s-2']);
});

test('同 key 刷新不标记 stale', () => {
  const loaded = reduceCanonicalSessionDirectoryRequest(
    createCanonicalSessionDirectoryRequestState(true),
    { type: 'succeed', key: 'key-a', result: directory([session('s-1')]) },
  );

  const refreshing = reduceCanonicalSessionDirectoryRequest(loaded, { type: 'begin', key: 'key-a' });
  assert.equal(refreshing.status, 'loading');
  assert.equal(refreshing.stale, false);
  assert.deepEqual(refreshing.result.sessions.map((entry) => entry.id), ['s-1']);
});

test('请求失败保留旧数据并置 failed，可再次刷新恢复', () => {
  const loaded = reduceCanonicalSessionDirectoryRequest(
    createCanonicalSessionDirectoryRequestState(true),
    { type: 'succeed', key: 'key-a', result: directory([session('s-1')]) },
  );

  const failed = reduceCanonicalSessionDirectoryRequest(loaded, { type: 'fail', key: 'key-a' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stale, false);
  assert.deepEqual(failed.result.sessions.map((entry) => entry.id), ['s-1']);

  const recovered = reduceCanonicalSessionDirectoryRequest(
    failed,
    { type: 'succeed', key: 'key-a', result: directory([session('s-3')]) },
  );
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.stale, false);
  assert.deepEqual(recovered.result.sessions.map((entry) => entry.id), ['s-3']);
});

test('key 变化期间失败：保留旧 key 数据、置 failed 且标记 stale', () => {
  const loaded = reduceCanonicalSessionDirectoryRequest(
    createCanonicalSessionDirectoryRequestState(true),
    { type: 'succeed', key: 'key-a', result: directory([session('s-1')]) },
  );
  const refreshing = reduceCanonicalSessionDirectoryRequest(loaded, { type: 'begin', key: 'key-b' });

  const failed = reduceCanonicalSessionDirectoryRequest(refreshing, { type: 'fail', key: 'key-b' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.stale, true);
  assert.deepEqual(failed.result.sessions.map((entry) => entry.id), ['s-1']);
});

test('空 queries 两态区分：项目目录加载中为 loading，确实无项目为 ready 空目录', () => {
  const loaded = reduceCanonicalSessionDirectoryRequest(
    createCanonicalSessionDirectoryRequestState(true),
    { type: 'succeed', key: 'key-a', result: directory([session('s-1')]) },
  );

  const pending = reduceCanonicalSessionDirectoryRequest(loaded, { type: 'pending', key: 'key-b' });
  assert.equal(pending.status, 'loading');
  assert.equal(pending.stale, true);
  assert.deepEqual(pending.result.sessions.map((entry) => entry.id), ['s-1']);

  const empty = reduceCanonicalSessionDirectoryRequest(loaded, { type: 'empty' });
  assert.equal(empty.status, 'ready');
  assert.equal(empty.stale, false);
  assert.deepEqual(empty.result.sessions, []);
});

test('初始状态按 pending 区分 loading 与 ready', () => {
  assert.equal(createCanonicalSessionDirectoryRequestState(true).status, 'loading');
  assert.equal(createCanonicalSessionDirectoryRequestState(false).status, 'ready');
});

test('离线回退：restore 载入磁盘缓存，保持 failed 并标注 offlineCached', () => {
  const restored = reduceCanonicalSessionDirectoryRequest(
    reduceCanonicalSessionDirectoryRequest(
      createCanonicalSessionDirectoryRequestState(true),
      { type: 'fail', key: 'key-a' },
    ),
    { type: 'restore', key: 'key-a', result: directory([session('s-1')]) },
  );
  assert.equal(restored.status, 'failed');
  assert.equal(restored.stale, false);
  assert.equal(restored.offlineCached, true);
  assert.deepEqual(restored.result.sessions.map((entry) => entry.id), ['s-1']);

  // 再次失败仍保留离线缓存数据与标注。
  const refailed = reduceCanonicalSessionDirectoryRequest(restored, { type: 'fail', key: 'key-a' });
  assert.equal(refailed.status, 'failed');
  assert.equal(refailed.offlineCached, true);
  assert.deepEqual(refailed.result.sessions.map((entry) => entry.id), ['s-1']);

  // 恢复在线后清除标注。
  const recovered = reduceCanonicalSessionDirectoryRequest(
    refailed,
    { type: 'succeed', key: 'key-a', result: directory([session('s-2')]) },
  );
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.offlineCached, false);
});
