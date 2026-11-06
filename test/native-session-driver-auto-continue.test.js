'use strict';

// 回归守卫（2026-11-06 真机）：WebUI chat 自动换号后**没有**继续对话，
// 用户必须自己再发一条消息才能把被打断的一轮接上。
//
// 期望的闭环（与 CLI 的 switch-continue 同口径）：
//   1. 失败被分类为「换账号可恢复」（限流 / 额度墙 / 权限）时，自动换下一个账号；
//   2. 本轮已经有输出 → 向同一个原生会话写 `continue` 续写，而不是重发原消息；
//   3. 本轮完全没有输出 → 重发原消息（不会产生重复内容）；
//   4. 换号与续写都在服务端完成，界面只看到一条「已换账号继续本轮」的提示。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { NativeSessionDriver } = require('../lib/server/chat-runtime/native-session-driver');
const { classifyNativeSessionFailure } = require('../lib/server/native-session-chat-failure');

const RATE_LIMITED = 'stream disconnected before completion: last status: 429 Too Many Requests';

function makeSession(overrides = {}) {
  return {
    sessionId: 'session-1',
    provider: 'codex',
    executionAccountRef: 'acct_primary',
    projectPath: '/tmp/project',
    policy: { model: 'gpt-5', approvalMode: 'bypass' },
    runtimeBinding: {},
    ...overrides
  };
}

function makeDriver({ events, session = makeSession(), fallback = ['acct_secondary'] }) {
  const driver = new NativeSessionDriver({
    session,
    eventSink: (event) => events.push(event),
    resolveFallbackAccountRefs: () => fallback
  });
  driver.resolveApproval = () => ({ support: 'bypass' });
  driver.ensureCliReady = async () => ({ ok: true });
  driver.projectionDir = () => '';
  return driver;
}

function context() {
  return {
    turnId: 'turn-1',
    runId: 'run-1',
    clientUserMessageId: 'msg-1',
    command: { type: 'turn.submit', payload: { content: '帮我改一下这个文件' } }
  };
}

function noticeTexts(events) {
  return events
    .filter((event) => event && event.payload && event.payload.item && event.payload.item.kind === 'notice')
    .map((event) => String(event.payload.item.content || ''));
}

test('已有输出后换号：自动向新账号续写 continue，不重发原消息', async () => {
  const events = [];
  const calls = [];
  const driver = makeDriver({ events });
  driver.spawnTurn = (input) => {
    calls.push(input);
    if (calls.length === 1) {
      return {
        done: (async () => {
          input.onEvent({ type: 'delta', delta: '部分输出' });
          throw new Error(RATE_LIMITED);
        })()
      };
    }
    return {
      done: (async () => {
        input.onEvent({ type: 'delta', delta: '继续完成' });
        return { sessionId: 'sess-1' };
      })()
    };
  };

  const result = await driver.startTurn(context());

  assert.equal(result.turnId, 'turn-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt, '帮我改一下这个文件');
  assert.equal(calls[1].prompt, 'continue');
  assert.deepEqual(calls[1].imagePaths, []);
  assert.equal(calls[1].accountRef, 'acct_secondary');
  assert.ok(
    noticeTexts(events).some((text) => text.includes('已换账号继续本轮')),
    `missing retry notice: ${JSON.stringify(noticeTexts(events))}`
  );
  assert.ok(
    noticeTexts(events).some((text) => text.includes('已恢复')),
    `missing recovered notice: ${JSON.stringify(noticeTexts(events))}`
  );
});

test('完全没有输出时换号：重发原消息而不是 continue', async () => {
  const events = [];
  const calls = [];
  const driver = makeDriver({ events });
  driver.spawnTurn = (input) => {
    calls.push(input);
    if (calls.length === 1) return { done: Promise.reject(new Error(RATE_LIMITED)) };
    return { done: Promise.resolve({ sessionId: 'sess-1' }) };
  };

  await driver.startTurn(context());

  assert.equal(calls.length, 2);
  assert.equal(calls[1].prompt, '帮我改一下这个文件');
});

test('不可换号的失败不重试', async () => {
  const events = [];
  const calls = [];
  const driver = makeDriver({ events });
  driver.spawnTurn = (input) => {
    calls.push(input);
    return { done: Promise.reject(new Error('tool crashed')) };
  };

  await assert.rejects(() => driver.startTurn(context()), /tool crashed/);
  assert.equal(calls.length, 1);
});

test('分类器看得到被包进 details.detail 的上游正文', () => {
  const classified = classifyNativeSessionFailure('codex', {
    code: 'native_session_failed',
    message: 'native_session_failed',
    details: { provider: 'codex', detail: RATE_LIMITED }
  });
  assert.equal(classified.retryAnotherAccount, true);
  assert.equal(classified.code, 'upstream_rate_limited');
});

test('分类器对普通失败不误判为可换号', () => {
  const classified = classifyNativeSessionFailure('codex', new Error('tool crashed'));
  assert.equal(classified.retryAnotherAccount, false);
});
