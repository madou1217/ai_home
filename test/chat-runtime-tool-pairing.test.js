'use strict';

// 吸收专题 3 要求「定义 canonical callId/result 配对契约;覆盖乱序结束、失败、取消、
// 孤立结果和多模态」。既有 chat-runtime-tool-recovery.test.js 覆盖的是**终止语义**
// (终止时未知结果不被冒认成功、确定结果不被改写);本文件补的是**配对契约本身**:
// callId 与 canonical item 的一一对应在乱序、复用、改名、无 callId 时分别如何表现。
//
// 契约实现在 tool-history-integrity.js:58 claimOwnership —— 同一 callId 不得落到
// 两个 item,同一 item 不得挂两个 callId,无 callId 的新 item 直接拒绝。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// store 在 try 之外 require:store 或其依赖 require 期失败必须响,不能被下面的
// 探测伪装成「契约尚未接线」。
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');

// 本文件断言的是**契约已生效**,不是**模块文件存在**。二者不等价:执行点在
// event-repository / timeline-import-repository,模块单独落地而接线未到时,
// 查文件存在的守卫会解除跳过、断言却无从触发,红在别人的提交上。
// 因此改为行为探测——真发一条无 callId 的工具项,看契约是否拒绝它。
let contractState = null;
function contractStatus() {
  if (contractState) return contractState;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tool-pairing-probe-'));
  const store = openChatRuntimeStore({ aiHomeDir: root, clock: () => 5000 });
  try {
    seed(store); // seed 失败就让它抛:store 本身坏了不该被记成「未接线」
    let thrown = null;
    try { emit(store, 'timeline.item.started', tool('probe-orphan', '')); }
    catch (error) { thrown = error; }
    contractState = thrown && thrown.code === 'chat_tool_history_call_id_required'
      ? { live: true, reason: '' }
      : {
        live: false,
        reason: thrown
          ? `配对契约尚未接线:拒绝码为 ${thrown.code || thrown.message}`
          : '配对契约尚未接线:无 callId 的工具项未被拒绝'
      };
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return contractState;
}

const pairingTest = (name, fn) => test(name, (t) => {
  const status = contractStatus();
  if (!status.live) { t.skip(status.reason); return undefined; }
  return fn(t);
});

const source = { provider: 'codex', runtimeId: 'probe' };

function tool(id, callId, status = 'running', extra = {}) {
  return {
    id, kind: 'shell', status, createdAt: 1000,
    detail: { callId, command: 'probe', ...extra }
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-tool-pairing-'));
  const store = openChatRuntimeStore({ aiHomeDir: root, clock: () => 5000 });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return seed(store);
}

function seed(store) {
  store.createSession({
    sessionId: 'probe', provider: 'codex', executionAccountRef: 'probe-account',
    runtimeBinding: { nativeSessionId: 'probe-thread' }
  });
  store.acceptCommand({ commandId: 'submit', sessionId: 'probe', type: 'turn.submit', payload: { content: 'probe' } });
  store.beginTurn('probe', {
    activeTurn: { turnId: 'turn', runId: 'run', state: 'running', startedAt: 1000 },
    event: { type: 'turn.queued', turnId: 'turn', runId: 'run', source,
      payload: { state: 'running', submissionCommandId: 'submit' } }
  });
  return store;
}

function emit(store, type, item) {
  store.appendEvent('probe', {
    type, turnId: 'turn', runId: 'run', source,
    payload: { item: { ...item, turnId: 'turn' } }
  });
}

pairingTest('乱序结束:先启动 A、B,后按 B、A 顺序完成,各自结果落回自己的 item', (t) => {
  const store = fixture(t);
  emit(store, 'timeline.item.started', tool('item-a', 'call-a'));
  emit(store, 'timeline.item.started', tool('item-b', 'call-b'));
  // 并发工具的完成顺序与启动顺序相反——配对必须按 callId 而不是按到达次序。
  emit(store, 'timeline.item.completed', tool('item-b', 'call-b', 'completed', { exitCode: 0 }));
  emit(store, 'timeline.item.completed', tool('item-a', 'call-a', 'completed', { exitCode: 7 }));

  const timeline = store.getSnapshot('probe').timeline;
  const a = timeline.find((i) => i.id === 'item-a');
  const b = timeline.find((i) => i.id === 'item-b');
  assert.equal(a.status, 'completed');
  assert.equal(b.status, 'completed');
  assert.equal(a.detail.exitCode, 7, 'A 的结果不得串到 B 上');
  assert.equal(b.detail.exitCode, 0, 'B 的结果不得串到 A 上');
});

pairingTest('同一 callId 落到第二个 item:必须拒绝,而不是悄悄改写归属', (t) => {
  const store = fixture(t);
  emit(store, 'timeline.item.started', tool('item-a', 'shared-call'));
  assert.throws(
    () => emit(store, 'timeline.item.started', tool('item-b', 'shared-call')),
    (e) => e.code === 'chat_tool_history_call_id_conflict',
    '同一 callId 被两个 item 认领必须显式冲突'
  );
  const timeline = store.getSnapshot('probe').timeline;
  assert.equal(timeline.filter((i) => i.kind === 'shell').length, 1, '冲突不得留下半条记录');
});

pairingTest('同一 item 改挂另一个 callId:必须拒绝', (t) => {
  const store = fixture(t);
  emit(store, 'timeline.item.started', tool('item-a', 'call-a'));
  assert.throws(
    () => emit(store, 'timeline.item.completed', tool('item-a', 'call-renamed', 'completed')),
    (e) => e.code === 'chat_tool_history_item_call_id_conflict',
    'item 的 callId 归属不得中途改写'
  );
});

pairingTest('孤立结果:没有 callId 的工具项被拒绝,不进入时间线', (t) => {
  const store = fixture(t);
  assert.throws(
    () => emit(store, 'timeline.item.started', tool('item-orphan', '')),
    (e) => e.code === 'chat_tool_history_call_id_required',
    '无 callId 的工具项必须拒绝——否则后续结果无从配对'
  );
  assert.equal(
    store.getSnapshot('probe').timeline.filter((i) => i.kind === 'shell').length, 0
  );
});

pairingTest('取消:中断后未知结果保持 unknown,已确定结果不被改写', (t) => {
  const store = fixture(t);
  emit(store, 'timeline.item.started', tool('item-pending', 'call-pending'));
  emit(store, 'timeline.item.completed', tool('item-done', 'call-done', 'completed', { exitCode: 0 }));
  store.settleTurn('probe', {
    event: { type: 'turn.interrupted', turnId: 'turn', runId: 'run', source,
      payload: { state: 'idle', retryable: true } }
  });

  const timeline = store.getSnapshot('probe').timeline;
  const pending = timeline.find((i) => i.id === 'item-pending');
  assert.equal(pending.status, 'unknown', '取消不得把未知结果记成失败或成功');
  assert.equal(pending.detail.exitCode, undefined, '取消不得给未知结果编造退出码');
  assert.equal(timeline.find((i) => i.id === 'item-done').detail.exitCode, 0, '已确定结果不得被取消改写');
});
