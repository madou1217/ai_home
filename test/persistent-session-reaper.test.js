'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  describeReapResult,
  planIdleSessionReap,
  reapIdleSessions,
  resolveReapPolicy,
  sessionLastActiveAt
} = require('../lib/runtime/persistent-session-reaper');
const persistentSession = require('../lib/runtime/persistent-session');

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function row(name, idleHours, extra = {}) {
  return {
    name,
    live: false,
    created: NOW - 100 * HOUR,
    lastActiveAt: NOW - idleHours * HOUR,
    lastActivityAt: NOW - idleHours * HOUR,
    ...extra
  };
}

test('policy: defaults to 1 day / 10 idle and accepts env overrides', () => {
  assert.deepEqual(resolveReapPolicy({}), { enabled: true, idleTtlMs: 24 * HOUR, maxIdle: 10 });
  assert.deepEqual(
    resolveReapPolicy({ AIH_SESSION_IDLE_TTL_MINUTES: '60', AIH_SESSION_MAX_IDLE: '3' }),
    { enabled: true, idleTtlMs: HOUR, maxIdle: 3 }
  );
  assert.equal(resolveReapPolicy({ AIH_SESSION_IDLE_TTL_MINUTES: '0' }).idleTtlMs, 0);
  assert.equal(resolveReapPolicy({ AIH_SESSION_MAX_IDLE: '0' }).maxIdle, 0);
  assert.equal(resolveReapPolicy({ AIH_SESSION_REAP: '0' }).enabled, false);
  // 坏值回落到默认，而不是把策略变成「全杀」。
  assert.deepEqual(
    resolveReapPolicy({ AIH_SESSION_IDLE_TTL_MINUTES: 'abc', AIH_SESSION_MAX_IDLE: '-1' }),
    { enabled: true, idleTtlMs: 24 * HOUR, maxIdle: 10 }
  );
});

test('ttl: idle 24h expires, 23h59m is kept', () => {
  const plan = planIdleSessionReap([
    row('old', 24),
    row('almost', 23 + 59 / 60)
  ], { now: NOW, env: {} });
  assert.deepEqual(plan.expired.map((entry) => entry.row.name), ['old']);
  assert.deepEqual(plan.kept.map((item) => item.name), ['almost']);
});

test('activity resets the window: an old session touched a minute ago is kept', () => {
  const revived = row('revived', 24, { lastActiveAt: NOW - 60 * 1000 });
  const plan = planIdleSessionReap([revived], { now: NOW, env: {} });
  assert.equal(plan.expired.length, 0);
  assert.equal(plan.kept.length, 1);
  // lastActiveAt 取 max(最近输出, 附着/交互, 创建时间)
  assert.equal(sessionLastActiveAt({ created: NOW - 30 * HOUR, lastActivityAt: NOW - 29 * HOUR, lastActiveAt: NOW - HOUR }), NOW - HOUR);
  // tmux 的 created 是秒；只有它可用时也必须换算成毫秒，不能当成 1970 年。
  const createdSeconds = Math.floor((NOW - 30 * HOUR) / 1000);
  assert.equal(sessionLastActiveAt({ created: createdSeconds }), createdSeconds * 1000);
  const createdPlan = planIdleSessionReap([{ name: 'only-created', live: false, created: createdSeconds }], { now: NOW, env: {} });
  assert.deepEqual(createdPlan.expired.map((entry) => entry.row.name), ['only-created']);
});

test('attached sessions are never expired or evicted', () => {
  const attached = row('attached', 48, { live: true });
  const plan = planIdleSessionReap([
    attached,
    ...Array.from({ length: 12 }, (_, index) => row(`idle-${index}`, index + 1))
  ], { now: NOW, env: { AIH_SESSION_MAX_IDLE: '2' } });
  assert.equal(plan.expired.length, 0);
  assert.equal(plan.evicted.some((entry) => entry.row.name === 'attached'), false);
  assert.equal(plan.kept.some((item) => item.name === 'attached'), true);
});

test('cap: more than 10 idle sessions evicts the least recently active first', () => {
  const rows = Array.from({ length: 12 }, (_, index) => row(`idle-${index}`, index + 1));
  const plan = planIdleSessionReap(rows, { now: NOW, env: {} });
  assert.deepEqual(plan.evicted.map((entry) => entry.row.name), ['idle-11', 'idle-10']);
  assert.equal(plan.kept.length, 10);
  assert.equal(plan.kept.some((item) => item.name === 'idle-11'), false);
});

test('expiry and cap combine: expired first, then evict down to the cap', () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, index) => row(`expired-${index}`, 25 + index)),
    ...Array.from({ length: 12 }, (_, index) => row(`fresh-${index}`, index + 1))
  ];
  const plan = planIdleSessionReap(rows, { now: NOW, env: {} });
  assert.equal(plan.expired.length, 3);
  assert.equal(plan.evicted.length, 2);
  assert.equal(plan.kept.length, 10);
  assert.equal(plan.expired.some((entry) => entry.row.name.startsWith('fresh')), false);
});

test('unknown timestamps are not expired but count toward the cap', () => {
  const unknown = { name: 'unknown', live: false, created: 0, lastActiveAt: 0, lastActivityAt: 0 };
  const plan = planIdleSessionReap([
    unknown,
    ...Array.from({ length: 10 }, (_, index) => row(`idle-${index}`, index + 1))
  ], { now: NOW, env: {} });
  assert.equal(plan.expired.length, 0);
  assert.equal(plan.evicted.length, 1);
  assert.equal(plan.evicted[0].row.name, 'unknown');
});

test('reap closes only planned rows and counts failures without aborting', () => {
  const closed = [];
  const result = reapIdleSessions([
    row('expired', 25),
    row('keep', 1),
    row('evict', 2)
  ], {
    now: NOW,
    env: { AIH_SESSION_MAX_IDLE: '1' },
    closeSession: (item) => {
      if (item.name === 'evict') return { ok: false, message: 'nope' };
      closed.push(item.name);
      return { ok: true };
    }
  });
  assert.deepEqual(closed, ['expired']);
  assert.equal(result.closed, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.closedRows.map((item) => item.name), ['expired']);
});

test('describeReapResult explains why sessions were reclaimed', () => {
  const plan = planIdleSessionReap([
    row('expired', 25),
    ...Array.from({ length: 11 }, (_, index) => row(`idle-${index}`, index + 1))
  ], { now: NOW, env: {} });
  const result = { ...plan, closed: 2, failed: 0, closedRows: [] };
  const message = describeReapResult(result);
  assert.match(message, /已回收 2 个空闲会话/);
  assert.match(message, /空闲超 1 天/);
  assert.match(message, /超出 10 个空闲上限/);
  assert.equal(describeReapResult({ ...plan, closed: 0, failed: 0 }), '');
});

test('tmux list parsing keeps window activity and adds session activity', () => {
  const sep = persistentSession.SESSION_LIST_SEPARATOR;
  const windowActivity = Math.floor((NOW - 30 * HOUR) / 1000);
  const sessionActivity = Math.floor((NOW - 5 * 60 * 1000) / 1000);
  const fields = [
    's-demo', '0', String(Math.floor((NOW - 100 * HOUR) / 1000)), '/p', 'title', 'win',
    'codex', '1234', '', '0', '/p', '', String(windowActivity), String(sessionActivity)
  ];
  const [parsed] = persistentSession.parseSessionList(fields.join(sep));
  assert.equal(parsed.lastActivityAt, windowActivity * 1000);
  assert.equal(parsed.lastActiveAt, sessionActivity * 1000);

  // 13 字段（旧格式 / 平台不提供 session_activity）仍然可用，lastActiveAt 回落到窗口活动。
  const legacy = persistentSession.parseSessionList(fields.slice(0, 13).join(sep));
  assert.equal(legacy[0].lastActiveAt, windowActivity * 1000);
});
