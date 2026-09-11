'use strict';

// 吸收专题 1 要求的证明:「按 command ID 证明输入恰好消费一次」,并覆盖压缩中输入、
// 连续停止/续跑、重启后队列顺序。
//
// 既有 chat-runtime-automatic-queue.test.js 已覆盖「完成后迟到输入重放一次仍只入队一条」。
// 这里补它没覆盖、而专题 1 点名的三个窗口:压缩期间重放、连续停止之间重放、重启之后重放。
// 全部走客户端真实路径 dispatchCommand({type:'queue.add'}),幂等由
// CommandRepository.accept 的事务内 commandId 去重保证(command-repository.js:15)。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { createChatRuntimeService } = require('../lib/server/chat-runtime-service');

function addCommand(commandId, content) {
  return { commandId, type: 'queue.add', payload: { content, policy: 'after_turn' } };
}

function pendingCount(service, sessionId) {
  return service.store.listQueue(sessionId).filter((item) => item.status !== 'consumed').length;
}

test('压缩期间重放入队命令,只留下一条待办', async (t) => {
  const { service } = createFixture(t);
  const session = await createSession(service);
  const command = addCommand('add-during-compaction', 'c');

  // 耗时的 prepare/compaction 正是文档点名的竞态窗口:客户端在窗口内没收到应答而重发。
  await service.dispatchCommand(session.sessionId, { commandId: 'compact-1', type: 'thread.compact', payload: {} }).catch(() => {});
  await service.dispatchCommand(session.sessionId, command);
  await service.dispatchCommand(session.sessionId, command);

  assert.equal(pendingCount(service, session.sessionId), 1,
    '压缩窗口内重放不得制造第二条待办');
});

test('连续停止之间重放,队列既不丢也不翻倍', async (t) => {
  const { service } = createFixture(t);
  const session = await createSession(service);
  const command = addCommand('add-stop-resume', 's');
  await service.dispatchCommand(session.sessionId, command);

  // 用户连点停止 + 客户端重试叠加。
  for (const commandId of ['stop-1', 'stop-2']) {
    await service.dispatchCommand(session.sessionId, {
      commandId, type: 'turn.interrupt', payload: { reason: 'user_stop' }
    }).catch(() => {});
    await service.dispatchCommand(session.sessionId, command);
  }

  assert.equal(pendingCount(service, session.sessionId), 1,
    '停止穿插重放后仍应只有一条待办');
});

test('重启后队列顺序不变,且旧 commandId 仍被认作重复', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-queue-once-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const first = buildService(root);
  const session = await createSession(first.service);
  for (const content of ['a', 'b', 'c']) {
    await first.service.dispatchCommand(session.sessionId, addCommand(`add-${content}`, content));
  }
  const before = first.service.store.listQueue(session.sessionId).map((item) => item.queueId);
  assert.equal(before.length, 3);
  first.service.close();

  // 同一 aiHomeDir 重开:持久化的顺序与幂等身份都必须活过进程边界。
  const second = buildService(root);
  t.after(() => second.service.close());
  assert.deepEqual(
    second.service.store.listQueue(session.sessionId).map((item) => item.queueId),
    before,
    '重启后队列顺序必须逐条一致'
  );

  await second.service.dispatchCommand(session.sessionId, addCommand('add-a', 'a'));
  assert.equal(second.service.store.listQueue(session.sessionId).length, before.length,
    '重启后重放旧 commandId 不得新增条目');
});

let idSeed = 0;

function buildService(root) {
  let nextId = 0;
  const driver = {
    startTurn() { return new Promise(() => {}); },
    compactThread() { return new Promise(() => {}); },
    async interruptTurn() {}
  };
  const service = createChatRuntimeService({
    storeOptions: {
      fs, aiHomeDir: root, DatabaseSync,
      clock: () => 1000 + nextId,
      // id 必须跨 service 实例唯一:重启用例会在同一库上再开一个 service,
      // 若计数器归零就会和上一实例的事件 id 撞上 UNIQUE 约束。
      idFactory: (prefix) => `${prefix}-${++idSeed}-${++nextId}`
    },
    driverRegistry: { resolve: () => ({ driver, handlers: {} }) },
    runtimeResolver: {
      resolve: (provider, context) => ({
        provider, runtimeScope: context.runtimeScope,
        fingerprint: `${provider}-runtime`, generation: 1
      })
    }
  });
  return { service };
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-queue-once-'));
  const { service } = buildService(root);
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { service };
}

function createSession(service) {
  return service.createSession({
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/repo'
  });
}
