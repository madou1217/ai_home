'use strict';

// Go 承接删除后，Node 的账号删除服务不得重复做宿主清理。
//
// 边界由 createAccountRemovalService 的 hostCleanupHandledByGo 事实位控制：删除路由
// 按「本次删除是否走 Go」算出后传入，不是配置开关。这里直接验证两种承接方下
// 账号删除服务的行为差异——Go 承接时不探测 tmux、不删投影；Node 承接时保持原样
// （先 fail-closed 拦截活会话，再清掉陈旧登记并删除投影）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAccountRemovalService } = require('../lib/account/account-removal');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const {
  ensureAccountRefsTable,
  resolveAccountRef
} = require('../lib/server/account-ref-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const persistentSessionRegistry = require('../lib/runtime/persistent-session-registry');

const PROVIDER = 'claude';
const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const SOCKET = 'aih-delete-scope-test';
const SESSION = 'claude-persistent-1';
const SESSION_LIST_SEPARATOR = '\x1f';

function makeAiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-removal-scope-'));
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

function seedRuntimeProjection(dir) {
  const runtimeDir = resolveAccountRuntimeDir(dir, PROVIDER, ACCOUNT_REF);
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'credentials.json'), '{}\n');
  return runtimeDir;
}

function seedPersistentSession(dir) {
  persistentSessionRegistry.writeEntry(dir, {
    provider: PROVIDER,
    runtimeScope: ACCOUNT_REF,
    accountRef: ACCOUNT_REF,
    socket: SOCKET,
    session: SESSION,
    cwd: dir
  }, { strict: true });
}

// 假 tmux：-V 应答版本探测；list-sessions 按 alive 返回「会话还活着」或
// 「服务端在、精确会话已退出」。调用次数就是「有没有真的去探测 tmux」的证据。
function createTmuxProbe({ alive }) {
  const state = { alive, calls: [] };
  const spawnSync = (command, args) => {
    state.calls.push([command, ...args].join(' '));
    if (args.includes('-V')) return { status: 0, stdout: 'tmux 3.8\n', stderr: '' };
    if (!state.alive) return { status: 0, stdout: '', stderr: '' };
    const line = [SESSION, '0', '1', '/tmp', 'title', 'window', 'zsh', '123', '', '0', '/tmp', '', '']
      .join(SESSION_LIST_SEPARATOR);
    return { status: 0, stdout: `${line}\n`, stderr: '' };
  };
  return { state, spawnSync };
}

function createService({ dir, probe, hostCleanupHandledByGo }) {
  return createAccountRemovalService({
    fs,
    aiHomeDir: dir,
    spawnSync: probe.spawnSync,
    hostCleanupHandledByGo,
    // Node 承接时资源对账是删除前的一步；对账本身另有测试，这里给它一个空实现。
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0 }),
    // 本用例只关心宿主清理边界，app-server 停机另有测试覆盖。
    invalidateCodexAppServerEndpoint: () => {}
  });
}

test('Go 承接：不探测 tmux、不删投影，只清 Node 独占数据', (t) => {
  const dir = makeAiHome(t);
  seedAccount(dir);
  const runtimeDir = seedRuntimeProjection(dir);
  seedPersistentSession(dir);
  const probe = createTmuxProbe({ alive: true });

  const removal = createService({ dir, probe, hostCleanupHandledByGo: true })
    .deleteAccountByRef(PROVIDER, ACCOUNT_REF);

  assert.equal(removal.deleted, true);
  assert.deepEqual(probe.state.calls, [], 'Go 已做过会话写者守卫，Node 不得再探测 tmux');
  assert.ok(fs.existsSync(runtimeDir), 'Go 已回收投影，Node 不得再删一次');
  assert.ok(
    persistentSessionRegistry.listEntries(dir).some((entry) => entry.session === SESSION),
    '陈旧登记的清理属于 Go 的 guard，Node 不应越俎代庖'
  );
  assert.equal(
    resolveAccountRef(fs, dir, ACCOUNT_REF, { bestEffort: true }),
    null,
    '账号行仍由 Node 删除'
  );
});

test('Node 承接：保持原行为——活会话 fail-closed，陈旧登记清掉后删投影', (t) => {
  const dir = makeAiHome(t);
  seedAccount(dir);
  const runtimeDir = seedRuntimeProjection(dir);
  seedPersistentSession(dir);
  const probe = createTmuxProbe({ alive: true });

  assert.throws(
    () => createService({ dir, probe, hostCleanupHandledByGo: false })
      .deleteAccountByRef(PROVIDER, ACCOUNT_REF),
    (error) => error && error.code === 'account_runtime_active'
  );
  assert.ok(probe.state.calls.length > 0, 'Node 承接时必须自己探测 tmux');
  assert.ok(fs.existsSync(runtimeDir), '被拦截时不得动投影');
  assert.ok(
    persistentSessionRegistry.listEntries(dir).some((entry) => entry.session === SESSION),
    '活会话的登记必须保留'
  );

  // 会话退出后登记变成陈旧条目：Node 现场清掉它并继续删除。
  probe.state.alive = false;
  const removal = createService({ dir, probe, hostCleanupHandledByGo: false })
    .deleteAccountByRef(PROVIDER, ACCOUNT_REF);

  assert.equal(removal.deleted, true);
  assert.equal(fs.existsSync(runtimeDir), false, 'Node 承接时由 Node 删除投影');
  assert.deepEqual(persistentSessionRegistry.listEntries(dir), [], '陈旧登记应被清掉');
  assert.equal(resolveAccountRef(fs, dir, ACCOUNT_REF, { bestEffort: true }), null);
});
