'use strict';

const test = require('node:test');
const assert = require('node:assert');

const protocol = require('../lib/server/codex-app-server-protocol');

const THREAD_ID = '019f-thread';

function notif(method, params) {
  return { jsonrpc: '2.0', method, params };
}

test('thread/turn 参数构造：confirm → untrusted + workspace-write(S3 实证组合)', () => {
  assert.deepStrictEqual(
    protocol.buildThreadStartParams({ cwd: '/tmp/work', approvalMode: 'confirm' }),
    { approvalPolicy: 'untrusted', sandbox: 'workspace-write', cwd: '/tmp/work' }
  );
  assert.deepStrictEqual(
    protocol.buildThreadResumeParams({ threadId: THREAD_ID, approvalMode: 'plan' }),
    { threadId: THREAD_ID, approvalPolicy: 'untrusted', sandbox: 'workspace-write' }
  );
});

test('turn/start 参数：text 输入 + localImage + model 覆盖', () => {
  const params = protocol.buildTurnStartParams({
    threadId: THREAD_ID,
    prompt: '你好',
    model: 'gpt-5.2-codex',
    imagePaths: ['/tmp/a.png', ' ', '/tmp/b.jpg']
  });
  assert.strictEqual(params.threadId, THREAD_ID);
  assert.strictEqual(params.model, 'gpt-5.2-codex');
  assert.deepStrictEqual(params.input, [
    { type: 'text', text: '你好' },
    { type: 'localImage', path: '/tmp/a.png' },
    { type: 'localImage', path: '/tmp/b.jpg' }
  ]);
});

test('turn/steer 与 turn/interrupt 参数形状', () => {
  assert.deepStrictEqual(
    protocol.buildTurnSteerParams({ threadId: THREAD_ID, turnId: 'turn-1', text: '换个思路' }),
    { threadId: THREAD_ID, expectedTurnId: 'turn-1', input: [{ type: 'text', text: '换个思路' }] }
  );
  assert.deepStrictEqual(
    protocol.buildTurnInterruptParams({ threadId: THREAD_ID, turnId: 'turn-1' }),
    { threadId: THREAD_ID, turnId: 'turn-1' }
  );
});

test('通知映射：delta 累计、completed 补差额、reasoning → thinking', () => {
  const state = protocol.createTurnObserverState(THREAD_ID);

  assert.deepStrictEqual(
    protocol.mapServerNotification(notif('turn/started', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1' }
    }), state),
    []
  );
  assert.strictEqual(state.turnId, 'turn-1');

  assert.deepStrictEqual(
    protocol.mapServerNotification(notif('item/agentMessage/delta', {
      threadId: THREAD_ID, itemId: 'msg-1', delta: '你好'
    }), state),
    [{ type: 'delta', delta: '你好' }]
  );
  // completed 帧带全文,缺尾按 item 补差额。
  assert.deepStrictEqual(
    protocol.mapServerNotification(notif('item/completed', {
      threadId: THREAD_ID,
      item: { type: 'agentMessage', id: 'msg-1', text: '你好，世界' }
    }), state),
    [{ type: 'delta', delta: '，世界' }]
  );
  assert.strictEqual(state.content, '你好，世界');

  assert.deepStrictEqual(
    protocol.mapServerNotification(notif('item/reasoning/summaryTextDelta', {
      threadId: THREAD_ID, itemId: 'rs-1', delta: '先想想'
    }), state),
    [{ type: 'thinking', thinking: '先想想' }]
  );
});

test('通知映射：commandExecution 工具卡(started 出卡、completed 出结果、去重)', () => {
  const state = protocol.createTurnObserverState(THREAD_ID);
  const startedEvents = protocol.mapServerNotification(notif('item/started', {
    threadId: THREAD_ID,
    item: { type: 'commandExecution', id: 'call-1', command: 'ls -la', status: 'inProgress' }
  }), state);
  assert.strictEqual(startedEvents.length, 1);
  assert.strictEqual(startedEvents[0].type, 'assistant_tool_call');
  assert.match(startedEvents[0].content, /:::tool\{name="Shell"\}/);
  assert.match(startedEvents[0].content, /ls -la/);

  const completedEvents = protocol.mapServerNotification(notif('item/completed', {
    threadId: THREAD_ID,
    item: {
      type: 'commandExecution', id: 'call-1', command: 'ls -la',
      status: 'completed', aggregatedOutput: 'total 0', exitCode: 0
    }
  }), state);
  // 同 item 不再重复出卡,只出结果。
  assert.deepStrictEqual(
    completedEvents.map((event) => event.type),
    ['assistant_tool_result']
  );
  assert.match(completedEvents[0].content, /total 0/);
});

test('通知映射：turn/completed → result;失败 → error;非本 thread 忽略', () => {
  const state = protocol.createTurnObserverState(THREAD_ID);
  protocol.mapServerNotification(notif('item/agentMessage/delta', {
    threadId: THREAD_ID, itemId: 'msg-1', delta: '完成'
  }), state);

  assert.deepStrictEqual(
    protocol.mapServerNotification(notif('item/agentMessage/delta', {
      threadId: 'other-thread', itemId: 'msg-x', delta: '别的会话'
    }), state),
    []
  );

  assert.deepStrictEqual(
    protocol.mapServerNotification(notif('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'turn-1', status: 'completed', error: null }
    }), state),
    [{ type: 'result', content: '完成', turnStatus: 'completed' }]
  );

  const failedState = protocol.createTurnObserverState(THREAD_ID);
  assert.deepStrictEqual(
    protocol.mapServerNotification(notif('turn/completed', {
      threadId: THREAD_ID,
      turn: { id: 'turn-2', status: 'failed', error: { message: 'quota exceeded' } }
    }), failedState),
    [{ type: 'error', message: 'quota exceeded' }]
  );
});

test('审批映射：commandExecution 带 command/cwd,fileChange 从缓存 item 取变更', () => {
  const state = protocol.createTurnObserverState(THREAD_ID);
  const commandRequest = {
    jsonrpc: '2.0',
    id: 0,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: THREAD_ID,
      itemId: 'call-1',
      command: 'rm -rf /tmp/x',
      cwd: '/tmp/work',
      availableDecisions: ['accept', 'decline']
    }
  };
  assert.strictEqual(protocol.isApprovalServerRequest(commandRequest), true);
  assert.deepStrictEqual(protocol.mapApprovalServerRequest(commandRequest, state), {
    toolName: 'Shell',
    toolUseId: 'call-1',
    input: { command: 'rm -rf /tmp/x', cwd: '/tmp/work' }
  });

  // fileChange 请求本身不带 diff：详情来自缓存的 item/started。
  protocol.mapServerNotification(notif('item/started', {
    threadId: THREAD_ID,
    item: {
      type: 'fileChange',
      id: 'call-2',
      status: 'inProgress',
      changes: [{ path: '/tmp/work/a.txt', kind: { type: 'add' }, diff: 'hello\n' }]
    }
  }), state);
  const fileRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'item/fileChange/requestApproval',
    params: { threadId: THREAD_ID, itemId: 'call-2', reason: null }
  };
  assert.deepStrictEqual(protocol.mapApprovalServerRequest(fileRequest, state), {
    toolName: 'FileChange',
    toolUseId: 'call-2',
    input: { changes: [{ path: '/tmp/work/a.txt', kind: 'add' }] }
  });

  // 通知(无 id)不是审批 request。
  assert.strictEqual(
    protocol.isApprovalServerRequest(notif('item/commandExecution/requestApproval', {})),
    false
  );
});

test('决策映射：allow→accept、deny→decline', () => {
  assert.deepStrictEqual(protocol.approvalDecisionToResult('allow'), { decision: 'accept' });
  assert.deepStrictEqual(protocol.approvalDecisionToResult('deny'), { decision: 'decline' });
  assert.deepStrictEqual(protocol.approvalDecisionToResult(undefined), { decision: 'decline' });
});
