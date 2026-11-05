'use strict';

// 真实状态事件日志：契约格式、容量轮转、未启用零副作用，以及三个生产钩子。
// 日志是 §7-d 双读比对的输入，写坏了不会立刻报错，只会让 oracle 复算出错误的状态 ——
// 所以这里逐条断言落盘字段。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const journal = require('../lib/server/status-event-journal');
const { applyAccountFailurePolicy } = require('../lib/server/account-runtime-state');
const { createAccountStateService } = require('../lib/account/state-service');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-status-journal-'));
  t.after(() => {
    journal.disable();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) {}
  });
  return dir;
}

function journalFile(home) {
  return path.join(home, 'observability', journal.FILE_NAME);
}

function readEvents(home) {
  const file = journalFile(home);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function baseEvent(overrides = {}) {
  return {
    accountRef: 'acct_0123456789abcdef0123',
    provider: 'codex',
    atMs: 1790000000000,
    ...overrides
  };
}

test('三种事件按契约落盘并可逐行读回', async (t) => {
  const home = tempHome(t);
  assert.equal(journal.enable({ fs, aiHomeDir: home }), true);

  assert.equal(journal.append(baseEvent({
    op: 'failure',
    failure: {
      kind: 'auth_invalid',
      reason: '401 unauthorized',
      cooldownMs: 300000,
      routingBlockRecheck: null
    }
  })), true);
  assert.equal(journal.append(baseEvent({
    op: 'clear',
    evidence: 'login_success'
  })), true);
  assert.equal(journal.append(baseEvent({
    op: 'runtime_state',
    state: null
  })), true);
  assert.equal(await journal.flush(), true);

  const events = readEvents(home);
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], {
    v: 1,
    atMs: 1790000000000,
    accountRef: 'acct_0123456789abcdef0123',
    provider: 'codex',
    op: 'failure',
    failure: {
      kind: 'auth_invalid',
      reason: '401 unauthorized',
      cooldownMs: 300000,
      routingBlockRecheck: null
    }
  });
  assert.deepEqual(events[1], {
    v: 1,
    atMs: 1790000000000,
    accountRef: 'acct_0123456789abcdef0123',
    provider: 'codex',
    op: 'clear',
    evidence: 'login_success'
  });
  assert.deepEqual(events[2], {
    v: 1,
    atMs: 1790000000000,
    accountRef: 'acct_0123456789abcdef0123',
    provider: 'codex',
    op: 'runtime_state',
    state: null
  });
});

test('超限轮转：只保留一份 .1 旧档，主文件不超过上限', async (t) => {
  const home = tempHome(t);
  const maxBytes = 260;
  assert.equal(journal.enable({ fs, aiHomeDir: home, maxBytes }), true);

  journal.append(baseEvent({ op: 'clear', evidence: 'login_success' }));
  assert.equal(await journal.flush(), true);
  const firstSize = fs.statSync(journalFile(home)).size;
  assert.equal(firstSize > 0, true);

  journal.append(baseEvent({ op: 'clear', evidence: 'manual_admin_clear' }));
  journal.append(baseEvent({ op: 'clear', evidence: 'upstream_success' }));
  assert.equal(await journal.flush(), true);

  const archive = path.join(home, 'observability', journal.ARCHIVE_FILE_NAME);
  assert.equal(fs.existsSync(archive), true, '超限后必须把旧文件 rename 成 .1');
  const mainSize = fs.statSync(journalFile(home)).size;
  assert.equal(mainSize <= maxBytes, true, `主文件 ${mainSize} 超过上限 ${maxBytes}`);
  // 旧档至少保留了轮转前那一条，且仍是一行一条 JSON。
  const archived = fs.readFileSync(archive, 'utf8').split('\n').filter(Boolean);
  assert.equal(archived.length, 1);
  assert.equal(JSON.parse(archived[0]).op, 'clear');
});

test('未启用时 append 无副作用：不建目录、不写文件、不抛错', async (t) => {
  const home = tempHome(t);
  journal.disable();
  assert.equal(journal.append(baseEvent({ op: 'clear', evidence: 'login_success' })), false);
  assert.equal(journal.append(null), false);
  assert.equal(await journal.flush(), false);
  assert.equal(fs.existsSync(path.join(home, 'observability')), false);
});

test('非法事件被丢弃，不要写进 oracle 读不懂的行', async (t) => {
  const home = tempHome(t);
  assert.equal(journal.enable({ fs, aiHomeDir: home }), true);

  assert.equal(journal.append(baseEvent({ op: 'clear' })), false, '缺 evidence');
  assert.equal(journal.append(baseEvent({
    op: 'failure',
    failure: { reason: 'no kind', cooldownMs: 1 }
  })), false, '缺 kind');
  assert.equal(journal.append({ op: 'clear', provider: 'codex', evidence: 'login_success' }), false, '缺 accountRef');
  assert.equal(journal.append(baseEvent({ op: 'nope' })), false, '未知 op');
  assert.equal(await journal.flush(), true);
  assert.deepEqual(readEvents(home), []);
});

test('failure.reason 截断到 200 字符（含中文）', async (t) => {
  const home = tempHome(t);
  assert.equal(journal.enable({ fs, aiHomeDir: home }), true);

  const longReason = '失'.repeat(300);
  journal.append(baseEvent({
    op: 'failure',
    failure: { kind: 'auth_invalid', reason: longReason, cooldownMs: 1000 }
  }));
  assert.equal(await journal.flush(), true);

  const [event] = readEvents(home);
  assert.equal(Array.from(event.failure.reason).length, 200);
  assert.equal(event.failure.reason, '失'.repeat(200));
});

test('disable 会把队列里的行同步落盘', async (t) => {
  const home = tempHome(t);
  assert.equal(journal.enable({ fs, aiHomeDir: home }), true);
  journal.append(baseEvent({ op: 'clear', evidence: 'login_success' }));
  assert.equal(journal.disable(), true);
  const events = readEvents(home);
  assert.equal(events.length, 1);
  assert.equal(events[0].op, 'clear');
});

test('钩子：失败策略、整份写入、清除证据都进日志', async (t) => {
  const home = tempHome(t);
  assert.equal(journal.enable({ fs, aiHomeDir: home }), true);

  // 钩子 1：applyAccountFailurePolicy（真实策略形状，threshold 缺省 = 立即冷却）。
  applyAccountFailurePolicy(
    { accountRef: 'acct_0123456789abcdef0123', provider: 'codex' },
    { kind: 'auth_invalid', shouldMarkFailure: true, cooldownMs: 300000, failureReason: '401 from upstream' }
  );

  // 钩子 2/3：state-service 的整份替换与清除。
  const written = [];
  const index = {
    getAccountState: () => ({}),
    upsertRuntimeState: (ref, provider, state) => { written.push({ ref, provider, state }); return true; },
    upsertAccountState: () => true,
    clearRuntimeState: () => true
  };
  const service = createAccountStateService({ accountStateIndex: index });
  service.recordRuntimeState('acct_0123456789abcdef0123', 'codex', { cooldownUntil: 1790000300000 });
  service.clearRuntimeBlock('acct_0123456789abcdef0123', 'codex', { evidence: 'login_success' });
  // 白名单外的证据不该产生事件。
  service.clearRuntimeBlock('acct_0123456789abcdef0123', 'codex', { evidence: 'not_in_whitelist' });

  assert.equal(await journal.flush(), true);
  const events = readEvents(home);
  assert.deepEqual(events.map((event) => event.op), ['failure', 'runtime_state', 'clear']);
  assert.deepEqual(events[0].failure, {
    kind: 'auth_invalid',
    reason: '401 from upstream',
    cooldownMs: 300000,
    routingBlockRecheck: null
  });
  assert.deepEqual(events[1].state, { cooldownUntil: 1790000300000 });
  assert.equal(events[2].evidence, 'login_success');
});
