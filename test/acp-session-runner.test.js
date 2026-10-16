'use strict';

// ACP runner 协议级回归：真实 spawn（node 跑假 agent 夹具）+ NDJSON 往返。
// 覆盖：握手序列与认证方法、load 回放丢弃、delta/工具事件映射、权限往返
// （bypass 自动允许 / 非 bypass fail closed）、握手失败与进程死亡、stderr 透传。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createAcpSessionChild, startAcpSessionTurn } = require('../lib/server/acp-session-runner');

const FIXTURE = path.join(__dirname, 'fixtures', 'acp-fake-agent.fixture.js');

function launchFake(scenario) {
  const events = [];
  const fatals = [];
  const stderrTexts = [];
  const { child, client } = createAcpSessionChild({
    command: process.execPath,
    args: [FIXTURE],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ACP_FAKE_SCENARIO: scenario }
  });
  child.onErrorData((text) => stderrTexts.push(text));
  const exitInfo = new Promise((resolve) => child.onExit(resolve));
  return { child, client, events, fatals, stderrTexts, exitInfo };
}

async function runTurn(scenario, turnOptions = {}) {
  const fake = launchFake(scenario);
  const turn = startAcpSessionTurn(fake.client, {
    sessionId: 'ses_fixture_1',
    cwd: path.join(__dirname, '..'),
    prompt: 'ping',
    authMethod: 'cline-pass',
    approvalMode: turnOptions.approvalMode || 'bypass',
    emitEvent: (event) => fake.events.push(event),
    onFatal: (error) => fake.fatals.push(error)
  });
  await turn;
  // onFatal 在权限路径上经 setImmediate 延迟，让出一个 tick 再断言。
  await new Promise((resolve) => setImmediate(resolve));
  fake.child.kill();
  const exit = await fake.exitInfo;
  return { ...fake, exit };
}

test('runAcpTurn 握手成功并丢弃 load 回放，delta 流式映射', async () => {
  const { events, fatals, stderrTexts } = await runTurn('happy');
  assert.deepEqual(fatals, []);
  // 回放（replay agent/user）必须被丢弃：第一条 delta 是 prompt 之后的认证回显。
  assert.deepEqual(events.filter((event) => event.type === 'delta').map((event) => event.delta), [
    'auth=cline-pass;',
    'hel',
    'lo'
  ]);
  assert.ok(stderrTexts.join('').includes('[acp-fake] boot'), 'stderr 应透传到引擎（认证/错误扫描用）');
});

test('bypass 权限请求自动允许（优先 allow_always）并产出工具事件', async () => {
  const { events, fatals } = await runTurn('permission');
  assert.deepEqual(fatals, []);
  assert.ok(events.some((event) => event.type === 'assistant_tool_call'
    && event.content === 'run_commands: echo hi'), 'tool_call 应映射为 assistant_tool_call 事件');
  const deltas = events.filter((event) => event.type === 'delta').map((event) => event.delta);
  assert.equal(deltas[deltas.length - 1], 'allowed:opt-always');
});

test('非 bypass 且无审批桥时 fail closed（拒绝权限并上报失败）', async () => {
  const { events, fatals } = await runTurn('permission', { approvalMode: 'confirm' });
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].code, 'native_session_approval_bridge_unavailable');
  const deltas = events.filter((event) => event.type === 'delta').map((event) => event.delta);
  assert.equal(deltas[deltas.length - 1], 'denied');
});

test('authenticate 失败上报 onFatal（错误码透传）', async () => {
  const { events, fatals } = await runTurn('authfail');
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].code, 'acp_request_failed');
  assert.equal(events.filter((event) => event.type === 'delta').length, 0);
});

test('进程在握手期死亡：请求 reject + onExit 透传退出码', async () => {
  const { fatals, exit } = await runTurn('crash');
  assert.equal(exit.exitCode, 7);
  assert.equal(fatals.length, 1);
  assert.equal(fatals[0].code, 'acp_session_process_exited');
});
