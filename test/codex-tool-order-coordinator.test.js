'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CodexToolOrderCoordinator,
  RAW_ITEM_METHOD,
  RAW_RESPONSE_METHOD
} = require('../lib/server/chat-runtime/codex-tool-order-coordinator');
const {
  CodexSessionEventBridge
} = require('../lib/server/chat-runtime/codex-session-event-bridge');

function raw(item) {
  return { method: RAW_ITEM_METHOD, params: { item } };
}

function lifecycle(callId, options = {}) {
  return {
    type: options.type || 'timeline.item.started',
    payload: { item: {
      id: options.itemId || callId,
      kind: options.kind || 'shell',
      detail: options.withoutCallId ? {} : { callId }
    } }
  };
}

function createFixture() {
  const coordinator = new CodexToolOrderCoordinator();
  const routed = [];
  const writes = [];
  const route = (event) => {
    routed.push(event.payload.item.id);
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    writes.push({ event, promise, resolve });
    return promise;
  };
  return { coordinator, route, routed, writes };
}

test('raw call 顺序约束 typed B→A 的首次持久顺序为 A→B', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'call-a' }), f.route);
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'call-b' }), f.route);

  const b = f.coordinator.schedule(lifecycle('call-b'), f.route);
  assert.deepEqual(f.routed, []);
  const a = f.coordinator.schedule(lifecycle('call-a'), f.route);
  assert.deepEqual(f.routed, ['call-a', 'call-b']);

  f.writes.forEach((write) => write.resolve());
  await Promise.all([a, b]);
});

test('首次事件释放后，同一工具的提前完成和后续更新继续独立路由', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'call-a' }), f.route);
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'call-b' }), f.route);
  const bCompleted = f.coordinator.schedule(lifecycle('call-b', {
    itemId: 'b-completed', type: 'timeline.item.completed'
  }), f.route);
  const aStarted = f.coordinator.schedule(lifecycle('call-a', { itemId: 'a-started' }), f.route);
  const bUpdated = f.coordinator.schedule(lifecycle('call-b', {
    itemId: 'b-updated', type: 'timeline.item.updated'
  }), f.route);

  assert.deepEqual(f.routed, ['a-started', 'b-completed', 'b-updated']);
  f.writes.forEach((write) => write.resolve());
  await Promise.all([aStarted, bCompleted, bUpdated]);
});

test('local_shell_call 缺失 call_id 时使用兼容字段 id 配对 typed shell', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({ type: 'local_shell_call', id: 'shell-item' }), f.route);
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'later-call' }), f.route);

  const later = f.coordinator.schedule(lifecycle('later-call'), f.route);
  assert.deepEqual(f.routed, []);
  const shell = f.coordinator.schedule(lifecycle('shell-item', { itemId: 'shell-item' }), f.route);
  assert.deepEqual(f.routed, ['shell-item', 'later-call']);

  f.writes.forEach((write) => write.resolve());
  await Promise.all([shell, later]);
});

test('raw call_id 与 raw id 都是同一工具的安全 alias', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({
    type: 'function_call', id: 'response-item', call_id: 'model-call'
  }), f.route);

  const queued = f.coordinator.schedule(lifecycle('response-item'), f.route);
  assert.deepEqual(f.routed, ['response-item']);
  f.writes.forEach((write) => write.resolve());
  await queued;
});

test('tool_search 缺失 call_id 时保持无身份，server search 不伪造排序槽位', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({
    type: 'tool_search_call', id: 'server-search', execution: 'server'
  }), f.route);
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'call-b' }), f.route);

  const b = f.coordinator.schedule(lifecycle('call-b'), f.route);
  assert.deepEqual(f.routed, ['call-b']);
  f.writes.forEach((write) => write.resolve());
  await b;
});

test('client tool_search、有 call_id 时允许通过 raw id alias 配对', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({
    type: 'tool_search_call', id: 'search-item', call_id: 'search-call', execution: 'client'
  }), f.route);
  const queued = f.coordinator.schedule(lifecycle('search-item', {
    itemId: 'search-item', kind: 'tool'
  }), f.route);
  assert.deepEqual(f.routed, ['search-item']);
  f.writes.forEach((write) => write.resolve());
  await queued;
});

test('web search 与 image generation 使用 raw id 配对 typed detail.callId', async () => {
  for (const [rawType, kind, id] of [
    ['web_search_call', 'tool', 'web-item'],
    ['image_generation_call', 'tool', 'image-item']
  ]) {
    const f = createFixture();
    await f.coordinator.observe(raw({ type: rawType, id }), f.route);
    const queued = f.coordinator.schedule(lifecycle(id, { itemId: id, kind }), f.route);
    assert.deepEqual(f.routed, [id]);
    f.writes.forEach((write) => write.resolve());
    await queued;
  }
});

test('MCP progress、结构化 custom/function output 和无身份项安全透传', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'call-a' }), f.route);
  await f.coordinator.observe(raw({
    type: 'custom_tool_call_output', call_id: 'call-a', output: [{ type: 'input_text', text: 'ok' }]
  }), f.route);
  await f.coordinator.observe(raw({
    type: 'function_call_output', call_id: 'call-b', output: [{ type: 'output_text', text: 'done' }]
  }), f.route);
  const progress = f.coordinator.schedule(lifecycle('', {
    itemId: 'mcp-progress', kind: 'tool', withoutCallId: true
  }), f.route);
  assert.deepEqual(f.routed, ['mcp-progress']);
  f.writes.forEach((write) => write.resolve());
  await progress;
});

test('alias 冲突时 fail-open，直接路由而不按到达顺序猜配', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({ type: 'function_call', id: 'shared-item', call_id: 'call-a' }), f.route);
  await f.coordinator.observe(raw({ type: 'function_call', id: 'shared-item', call_id: 'call-b' }), f.route);

  const shared = f.coordinator.schedule(lifecycle('shared-item'), f.route);
  assert.deepEqual(f.routed, ['shared-item']);
  f.writes.forEach((write) => write.resolve());
  await shared;
});

test('不同 call_id 借用同一 raw id 时也 fail-open', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({ type: 'function_call', id: 'same-item', call_id: 'call-a' }), f.route);
  await f.coordinator.observe(raw({ type: 'function_call', id: 'same-item', call_id: 'call-b' }), f.route);

  const a = f.coordinator.schedule(lifecycle('call-a'), f.route);
  const b = f.coordinator.schedule(lifecycle('call-b'), f.route);
  assert.deepEqual(f.routed, ['call-a', 'call-b']);
  f.writes.forEach((write) => write.resolve());
  await Promise.all([a, b]);
});

test('新 call_id 借用旧工具的 raw id 时不与旧槽位合并', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({ type: 'function_call', id: 'old-item', call_id: 'call-a' }), f.route);
  await f.coordinator.observe(raw({ type: 'function_call', id: 'call-a', call_id: 'call-b' }), f.route);

  const b = f.coordinator.schedule(lifecycle('call-b'), f.route);
  assert.deepEqual(f.routed, ['call-b']);
  const a = f.coordinator.schedule(lifecycle('call-a'), f.route);
  assert.deepEqual(f.routed, ['call-b', 'call-a']);
  f.writes.forEach((write) => write.resolve());
  await Promise.all([a, b]);
});

test('raw output 可跳过没有 typed lifecycle 的调用槽位', async () => {
  const f = createFixture();
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'call-a' }), f.route);
  await f.coordinator.observe(raw({ type: 'function_call', call_id: 'call-b' }), f.route);
  const b = f.coordinator.schedule(lifecycle('call-b'), f.route);
  assert.deepEqual(f.routed, []);

  const output = f.coordinator.observe(raw({ type: 'function_call_output', call_id: 'call-a' }), f.route);
  assert.deepEqual(f.routed, ['call-b']);
  f.writes[0].resolve();
  await Promise.all([output, b]);
});

test('terminal、cancel 和 cleanup flush 会释放尚未观察到 typed lifecycle 的槽位', async () => {
  for (const reason of ['terminal', 'cancel', 'cleanup']) {
    const f = createFixture();
    await f.coordinator.observe(raw({ type: 'function_call', call_id: `${reason}-a` }), f.route);
    await f.coordinator.observe(raw({ type: 'function_call', call_id: `${reason}-b` }), f.route);
    const b = f.coordinator.schedule(lifecycle(`${reason}-b`), f.route);
    assert.deepEqual(f.routed, []);

    const flushed = f.coordinator.flush(f.route);
    assert.deepEqual(f.routed, [`${reason}-b`]);
    f.writes[0].resolve();
    await Promise.all([b, flushed]);
  }
});

test('typed-only 旧线程和无法关联的工具形态安全透传', async () => {
  const f = createFixture();
  const cases = [
    lifecycle('typed-only'),
    lifecycle('', { itemId: 'mcp-missing-id', kind: 'tool', withoutCallId: true }),
    lifecycle('', { itemId: 'dynamic-missing-id', kind: 'tool', withoutCallId: true }),
    lifecycle('', { itemId: 'web-missing-id', kind: 'tool', withoutCallId: true }),
    lifecycle('', { itemId: 'image-missing-id', kind: 'tool', withoutCallId: true }),
    lifecycle('', { itemId: 'control', kind: 'notice', withoutCallId: true }),
    lifecycle('', { itemId: 'subagent', kind: 'subagent', withoutCallId: true })
  ];
  const promises = cases.map((event) => f.coordinator.schedule(event, f.route));

  assert.deepEqual(f.routed, cases.map((event) => event.payload.item.id));
  f.writes.forEach((write) => write.resolve());
  await Promise.all(promises);
});

test('raw response 边界和缺少 callId 的 raw item 仅作为内部 no-op', async () => {
  const f = createFixture();
  assert.equal(f.coordinator.accepts({ method: RAW_ITEM_METHOD }), true);
  assert.equal(f.coordinator.accepts({ method: RAW_RESPONSE_METHOD }), true);
  assert.equal(f.coordinator.accepts({ id: 1, method: RAW_ITEM_METHOD }), false);
  await f.coordinator.observe({ method: RAW_RESPONSE_METHOD, params: {} }, f.route);
  await f.coordinator.observe(raw({ type: 'function_call' }), f.route);
  assert.deepEqual(f.routed, []);
});

test('Bridge terminal flush 等待排队工具真正写入后才完成', async () => {
  let release;
  const persisted = new Promise((resolve) => { release = resolve; });
  const routed = [];
  const bridge = new CodexSessionEventBridge({
    eventSink(event) {
      routed.push(event.payload.item.id);
      return persisted;
    }
  });
  const toolOrder = bridge.createToolOrder();
  const context = { runId: 'run', turnId: 'turn', toolOrder };
  bridge.forwardNotification(raw({ type: 'function_call', call_id: 'call-a' }), context);
  bridge.forwardNotification(raw({ type: 'function_call', call_id: 'call-b' }), context);
  const queued = bridge.forwardNotification({
    method: 'item/started',
    params: {
      turnId: 'native-turn',
      item: { type: 'commandExecution', id: 'call-b', command: 'probe', status: 'inProgress' }
    }
  }, context);
  let terminalDone = false;
  const terminal = bridge.forwardNotification({
    method: 'turn/completed',
    params: { turn: { id: 'native-turn', status: 'completed' } }
  }, context).persisted.then(() => { terminalDone = true; });

  await Promise.resolve();
  assert.deepEqual(routed, ['call-b']);
  await Promise.resolve();
  assert.equal(terminalDone, false);
  release();
  await Promise.all([queued.persisted, terminal]);
  assert.equal(terminalDone, true);
});

test('Bridge cleanup flush 返回真实持久化 Promise 和错误', async () => {
  const expected = new Error('sink failed');
  const bridge = new CodexSessionEventBridge({ eventSink: async () => { throw expected; } });
  const toolOrder = bridge.createToolOrder();
  const context = { runId: 'run', turnId: 'turn', toolOrder };
  bridge.forwardNotification(raw({ type: 'function_call', call_id: 'call-a' }), context);
  bridge.forwardNotification(raw({ type: 'function_call', call_id: 'call-b' }), context);
  const queued = bridge.forwardNotification({
    method: 'item/started',
    params: {
      turnId: 'native-turn',
      item: { type: 'commandExecution', id: 'call-b', command: 'probe', status: 'inProgress' }
    }
  }, context);

  await assert.rejects(bridge.flushToolOrder(toolOrder), expected);
  await assert.rejects(queued.persisted, expected);
});
