'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { codexAuth, ensureGoServerBinary, seedNodeAccounts } = require('./helpers/go-bridge');
const { createGoAccountSync, newerGoNativeAuth } = require('../lib/server/go-account-sync');
const { createGoManagementClient } = require('../lib/account/go-bridge/go-management-client');
const { readGoAccounts } = require('../lib/account/go-bridge/go-account-store-reader');
const { readNodeAccounts } = require('../lib/account/go-bridge/node-account-reader');
const { startGoServerProcess } = require('../lib/account/go-bridge/go-server-process');

const goBinary = ensureGoServerBinary();
const skip = goBinary ? false : 'Go toolchain unavailable: cannot build the real aih-server';
const silentLog = { log() {}, error() {} };

function writeGoCredential(aiHomeDir, accountRef, mutate) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(aiHomeDir, 'aih.db'));
  try {
    const row = db.prepare('SELECT credential_json, updated_at_ms FROM account_credentials WHERE account_ref = ?').get(accountRef);
    const next = mutate(JSON.parse(row.credential_json));
    db.prepare('UPDATE account_credentials SET credential_json = ?, updated_at_ms = ? WHERE account_ref = ?')
      .run(JSON.stringify(next), Number(row.updated_at_ms) + 1000, accountRef);
  } finally {
    db.close();
  }
}

test('Node <-> Go account sync converges both stores and is quiet at steady state', { skip, timeout: 120000 }, async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-sync-'));
  const refs = seedNodeAccounts(aiHomeDir);
  const server = await startGoServerProcess({ binaryPath: goBinary, aiHomeDir });
  t.after(async () => {
    await server.stop();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const client = createGoManagementClient({ baseUrl: server.baseUrl, managementKey: server.managementKey });
  const sync = createGoAccountSync({ fs, aiHomeDir, getClient: () => client, log: silentLog });

  // 首轮：9 个可承接的 Node 账号推送进 Go，得到 8 个 Go 账号（两个官方地址 API Key 归并）。
  const first = await sync.reconcile();
  assert.deepEqual(first.errors, []);
  assert.equal(first.pushed, 9);
  assert.equal(first.unsupported, 2);
  let go = readGoAccounts(aiHomeDir);
  assert.equal(go.accounts.length, 8);
  assert.equal(go.defaults.codex, refs.codexTeam);
  assert.equal(go.defaults.claude, refs.claudeOauth);
  assert.equal(go.accounts.filter((account) => !account.enabled).length, 1, 'Node status down is mirrored');

  // 工作区在两端是同一事实：Go 管理 API 的 workspace_id 与 Node 共享模型逐账号一致。
  const { resolveCodexWorkspaceFields } = require('../lib/account/codex-auth-metadata');
  for (const record of readNodeAccounts(aiHomeDir).accounts.filter((account) => account.provider === 'codex' && account.nativeAuth.auth)) {
    const nodeWorkspace = resolveCodexWorkspaceFields(record.nativeAuth.auth);
    if (nodeWorkspace.workspaceError) continue;
    const goView = await client.getAccount(record.accountRef);
    assert.equal(goView.ok, true, record.accountRef);
    assert.equal(goView.data.workspace_id, nodeWorkspace.workspaceId, `workspace of ${record.accountRef}`);
  }

  // 稳态：没有任何变化时不发任何写请求。
  const steady = await sync.reconcile();
  assert.deepEqual({ pushed: steady.pushed, pulled: steady.pulled, enabled: steady.enabledChanged, defaults: steady.defaultsChanged, deleted: steady.deleted, adopted: steady.adopted },
    { pushed: 0, pulled: 0, enabled: 0, defaults: 0, deleted: 0, adopted: 0 });

  // Go -> Node：Go 在推理链路刷新了 token（refresh_token 已轮换），Node 必须收到新 token。
  writeGoCredential(aiHomeDir, refs.codexTeam, (credential) => ({
    ...credential,
    access_token: `${credential.access_token}.rotated`,
    refresh_token: 'rt-team-rotated-by-go',
    refreshed_at_ms: Date.parse('2026-09-21T00:00:00Z')
  }));
  const pulled = await sync.reconcile();
  assert.equal(pulled.pulled, 1);
  const nodeTeam = readNodeAccounts(aiHomeDir).accounts.find((account) => account.accountRef === refs.codexTeam);
  assert.equal(nodeTeam.nativeAuth.auth.tokens.refresh_token, 'rt-team-rotated-by-go');
  assert.equal(nodeTeam.nativeAuth.auth.last_refresh, '2026-09-21T00:00:00.000Z');
  assert.equal(nodeTeam.nativeAuth.auth.tokens.account_id, undefined, 'unrelated auth.json fields are preserved as-is');
  assert.equal((await sync.reconcile()).pulled, 0, 'a pulled credential is not pulled twice');

  // Node 停用账号 -> Go 同步停用。
  const { createAccountStateIndex } = require('../lib/account/state-index');
  const stateIndex = createAccountStateIndex({ fs, aiHomeDir });
  stateIndex.upsertAccountState(refs.agy, 'agy', { status: 'down' });
  stateIndex.close();
  assert.equal((await sync.reconcile()).enabledChanged, 1);
  assert.equal(readGoAccounts(aiHomeDir).accounts.find((account) => account.accountRef === refs.agy).enabled, false);

  // Node 删除账号 -> Go 删除，且不会在后续轮次被当作 Go 独有账号收养回来。
  const { DatabaseSync } = require('node:sqlite');
  const nodeDb = new DatabaseSync(path.join(aiHomeDir, 'app-state.db'));
  nodeDb.exec('PRAGMA foreign_keys = ON');
  nodeDb.prepare('DELETE FROM account_refs WHERE account_ref = ?').run(refs.claudeOauth);
  nodeDb.close();
  const deleted = await sync.reconcile();
  assert.equal(deleted.deleted, 1);
  assert.equal(deleted.adopted, 0);
  assert.equal(readGoAccounts(aiHomeDir).accounts.some((account) => account.accountRef === refs.claudeOauth), false);
  assert.equal((await sync.reconcile()).adopted, 0);

  // Go 独有账号（经 Go 管理 API 直接导入）-> 收养进 Node，下一轮建立映射且不重复建号。
  const imported = await client.send({
    method: 'POST',
    path: '/v1/management/account-imports',
    body: { provider_id: 'codex', artifacts: { auth_json: codexAuth({ userId: 'user-go-only', workspace: 'ws-go', email: 'go@example.com', suffix: 'go-only' }) } }
  });
  assert.equal(imported.status, 201);
  const adopted = await sync.reconcile();
  assert.equal(adopted.adopted, 1);
  const adoptedNode = readNodeAccounts(aiHomeDir).accounts.find((account) => account.accountRef === imported.data.account_ref);
  assert.ok(adoptedNode, 'Go-only Codex OAuth account now exists in Node under the same accountRef');
  const linked = await sync.reconcile();
  assert.deepEqual(linked.errors, []);
  assert.equal(linked.adopted, 0);
  go = readGoAccounts(aiHomeDir);
  assert.equal(go.accounts.filter((account) => account.accountRef === imported.data.account_ref).length, 1);
});

test('Go -> Node pull-back only moves strictly newer credentials', () => {
  const record = {
    provider: 'codex',
    nativeAuthUpdatedAt: 1,
    nativeAuth: { auth: { tokens: { access_token: 'a1', refresh_token: 'r1', id_token: 'i1' }, last_refresh: '2026-09-20T00:00:00Z' } }
  };
  const older = { credential: { access_token: 'a0', refresh_token: 'r0', id_token: 'i0', refreshed_at_ms: Date.parse('2026-09-19T00:00:00Z') } };
  const same = { credential: { access_token: 'a1', refresh_token: 'r1', id_token: 'i1', refreshed_at_ms: Date.parse('2026-09-22T00:00:00Z') } };
  const newer = { credential: { access_token: 'a2', refresh_token: 'r2', id_token: 'i2', refreshed_at_ms: Date.parse('2026-09-22T00:00:00Z') } };
  assert.equal(newerGoNativeAuth(record, older), null);
  assert.equal(newerGoNativeAuth(record, same), null);
  assert.equal(newerGoNativeAuth(record, newer).auth.tokens.refresh_token, 'r2');

  const claude = {
    provider: 'claude',
    nativeAuth: { credentials: { claudeAiOauth: { accessToken: 'c1', refreshToken: 'cr1', expiresAt: 1000, account: { uuid: 'u' } } } }
  };
  const next = newerGoNativeAuth(claude, { credential: { access_token: 'c2', refresh_token: 'cr2', expires_at_ms: 2000 } });
  assert.deepEqual(next.credentials.claudeAiOauth, { accessToken: 'c2', refreshToken: 'cr2', expiresAt: 2000, account: { uuid: 'u' } });
  assert.equal(newerGoNativeAuth(claude, { credential: { access_token: 'c0', refresh_token: 'cr0', expires_at_ms: 500 } }), null);
});
