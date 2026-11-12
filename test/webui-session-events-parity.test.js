'use strict';

// 会话增量事件的 Node/Go 对拍：
// 1. fixture 由 scripts/dump-session-events-parity-cases.js 用 Node 现实现生成；
//    这里先证明 fixture 仍是 Node 的真值，Go 侧的 parity_test.go 再逐条复算。
// 2. 证明 /v0/webui/sessions/:provider/:sessionId/events 的 Go 代理只在
//    codex + Go 明确成功时接管，其余情况一律回落 Node。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readSessionEvents } = require('../lib/sessions/session-reader');
const { tryHandleGetSessionEventsViaGo } = require('../lib/server/webui-session-routes');

const FIXTURE = path.join(
  __dirname,
  '..',
  'internal',
  'transport',
  'http',
  'webuisessioneventsapi',
  'testdata',
  'parity-cases.json'
);

function writeSession(home, sessionId, testCase) {
  const directory = path.join(home, '.codex', 'sessions', '2026', '11', '12');
  fs.mkdirSync(directory, { recursive: true });
  const content = testCase.records.join('\n') + '\n' + (testCase.tail || '');
  fs.writeFileSync(path.join(directory, 'rollout-2026-11-12T10-00-00-' + sessionId + '.jsonl'), content);
}

test('fixture 仍是 Node readSessionEvents 的真值', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(fixture.version, 1);
  assert.ok(fixture.cases.length > 0);
  const previousHome = process.env.REAL_HOME;
  for (const testCase of fixture.cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-events-node-'));
    try {
      writeSession(home, testCase.sessionId, testCase);
      process.env.REAL_HOME = home;
      const actual = readSessionEvents(
        'codex',
        { sessionId: testCase.sessionId },
        { cursor: testCase.cursor }
      );
      assert.deepEqual(actual, testCase.expected, testCase.name);
    } finally {
      if (previousHome === undefined) delete process.env.REAL_HOME;
      else process.env.REAL_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

function makeCtx(options = {}) {
  let captured = null;
  const calls = [];
  const goHost = options.goHost === undefined
    ? {
        getSessionEvents: async (...args) => {
          calls.push(args);
          return options.result;
        }
      }
    : options.goHost;
  const ctx = {
    pathname: options.pathname || '/v0/webui/sessions/codex/session-1/events',
    url: new URL('http://127.0.0.1:9527' + (options.search || '?cursor=42')),
    res: {},
    deps: goHost === null ? {} : { goCoreSync: goHost },
    writeJson: (_res, status, payload) => { captured = { status, payload }; }
  };
  return { ctx, calls, get captured() { return captured; } };
}

test('Go 成功时原样返回并带上查询串', async () => {
  const state = makeCtx({
    result: { ok: true, status: 200, data: { ok: true, events: [], cursor: 42, hasAssistantToolCall: false } }
  });
  const handled = await tryHandleGetSessionEventsViaGo(state.ctx);
  assert.equal(handled, true);
  assert.deepEqual(state.calls, [['codex', 'session-1', 'cursor=42']]);
  assert.equal(state.captured.status, 200);
  assert.deepEqual(state.captured.payload, { ok: true, events: [], cursor: 42, hasAssistantToolCall: false });
});

test('Go 失败 / 形状不合法时回落 Node', async () => {
  for (const result of [
    { ok: false, status: 501, data: { ok: false, error: 'unsupported_provider' } },
    { ok: true, status: 200, data: { ok: false, error: 'get_session_events_failed' } },
    { ok: true, status: 200, data: { ok: true } },
    { ok: true, status: 200, data: { ok: true, events: [], cursor: '0' } },
    { ok: true, status: 200, data: null },
    null
  ]) {
    const state = makeCtx({ result });
    assert.equal(await tryHandleGetSessionEventsViaGo(state.ctx), false);
    assert.equal(state.captured, null);
  }
});

test('Go 调用抛错时回落 Node', async () => {
  const state = makeCtx({
    goHost: { getSessionEvents: async () => { throw new Error('network'); } }
  });
  assert.equal(await tryHandleGetSessionEventsViaGo(state.ctx), false);
  assert.equal(state.captured, null);
});

test('非 codex / 大小写不匹配时不调用 Go', async () => {
  for (const pathname of [
    '/v0/webui/sessions/claude/session-1/events',
    '/v0/webui/sessions/Codex/session-1/events'
  ]) {
    const state = makeCtx({ pathname });
    assert.equal(await tryHandleGetSessionEventsViaGo(state.ctx), false);
    assert.equal(state.calls.length, 0);
    assert.equal(state.captured, null);
  }
});

test('宿主没有 Go 方法 / Go Core 关闭时回落 Node', async () => {
  const missing = makeCtx({ goHost: {} });
  assert.equal(await tryHandleGetSessionEventsViaGo(missing.ctx), false);
  assert.equal(missing.captured, null);

  const disabled = makeCtx({ goHost: { isEnabled: () => false, getSessionEvents: async () => { throw new Error('must not call'); } } });
  assert.equal(await tryHandleGetSessionEventsViaGo(disabled.ctx), false);
  assert.equal(disabled.captured, null);
});
