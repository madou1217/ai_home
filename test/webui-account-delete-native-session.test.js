'use strict';

// 删除路由的「运行中会话」拦截：旧实现在路由里直接调 assertNoActiveNativeRunBeforeDelete
// 抛 account_runtime_active（无差别硬拦）。现在统一交给占位者探测
// （account-deletion-occupancy 的 native_session），语义变成「先列占用者、带 force 才终止」。
//
// 这个测试锁住替换后的行为：同一事实只能有一条判定路径，且 force 前后都不能静默丢功能。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleDeleteAccountRequest } = require('../lib/server/webui-account-routes');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { ensureAccountRefsTable, resolveAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');

const PROVIDER = 'codex';
const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function makeAiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-delete-native-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedAccount(dir) {
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  try {
    ensureAccountRefsTable(db);
    db.prepare(`
      INSERT INTO account_refs (account_ref, provider, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(ACCOUNT_REF, PROVIDER, 1, 1);
  } finally {
    db.close();
  }
  writeAccountCredentials(fs, dir, ACCOUNT_REF, {});
}

function createGoHost() {
  const calls = [];
  return {
    calls,
    host: {
      isEnabled: () => true,
      deleteAccount: async (accountRef) => {
        calls.push(accountRef);
        return { ok: true, status: 204 };
      }
    }
  };
}

function createNativeRun() {
  const state = { aborted: 0, unregistered: [] };
  const run = {
    provider: PROVIDER,
    accountRef: ACCOUNT_REF,
    runId: 'run-native-1',
    sessionId: 'session-native-1',
    abort: () => { state.aborted += 1; }
  };
  return {
    state,
    ctx: {
      listNativeChatRuns: () => [run],
      getNativeChatRun: (runId) => (runId === run.runId ? run : null),
      unregisterNativeChatRun: (runId) => state.unregistered.push(runId)
    }
  };
}

async function deleteViaRoute({ dir, goHost, force, extraCtx }) {
  const writes = [];
  const url = new URL(`http://127.0.0.1/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}${force ? '?force=1' : ''}`);
  const ctx = {
    ...extraCtx,
    pathname: url.pathname,
    url,
    req: { url: url.pathname + url.search },
    res: {},
    fs,
    aiHomeDir: dir,
    deps: { aiHomeDir: dir, goCoreSync: goHost },
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
  const handled = await handleDeleteAccountRequest(ctx);
  assert.equal(handled, true);
  assert.equal(writes.length, 1);
  return writes[0];
}

test('有运行中会话且未确认：409 列出 native_session 占用者，不终止会话也不删账号', async (t) => {
  const dir = makeAiHome(t);
  seedAccount(dir);
  const { host, calls } = createGoHost();
  const { state, ctx } = createNativeRun();

  const result = await deleteViaRoute({ dir, goHost: host, force: false, extraCtx: ctx });

  assert.equal(result.status, 409);
  assert.equal(result.payload.error, 'account_runtime_active');
  assert.equal(result.payload.occupants.length, 1);
  assert.equal(result.payload.occupants[0].kind, 'native_session');
  assert.equal(result.payload.occupants[0].runId, 'run-native-1');
  assert.match(result.payload.message, /正在占用/);
  assert.equal(state.aborted, 0, '未确认前不得终止会话');
  assert.deepEqual(state.unregistered, [], '未确认前不得注销会话');
  assert.deepEqual(calls, [], '未确认前不得调用 Go 删除');
  assert.ok(resolveAccountRef(fs, dir, ACCOUNT_REF, { bestEffort: true }), '账号行不应被删除');
});

test('force=1：先终止会话再走 Go 删除，账号行被清掉', async (t) => {
  const dir = makeAiHome(t);
  seedAccount(dir);
  const { host, calls } = createGoHost();
  const { state, ctx } = createNativeRun();

  const result = await deleteViaRoute({ dir, goHost: host, force: true, extraCtx: ctx });

  assert.equal(result.status, 200);
  assert.equal(state.aborted, 1);
  assert.deepEqual(state.unregistered, ['run-native-1']);
  assert.deepEqual(calls, [ACCOUNT_REF]);
  assert.equal(
    resolveAccountRef(fs, dir, ACCOUNT_REF, { bestEffort: true }),
    null,
    '账号行应已删除'
  );
});
