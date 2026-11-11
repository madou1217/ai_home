'use strict';

// 账号删除的宿主清理契约（Node 侧）：Go 删除事务回调的唯一入口语义。
//
// 覆盖三件事：
//   1. verify 只把「活着的精确会话」当占用，陈旧登记当场清掉，探测不确定时失败关闭；
//   2. 账号 socket 上没有登记的孤儿会话同样是写入者（登记缺一条不能当成没占用）；
//   3. cleanup 幂等：按账号 socket 回收整服务端、非规范 socket 只杀点名的会话，
//      收不干净时如实上报而不是假装成功。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAccountHostCleanupService } = require('../lib/server/account-host-cleanup');
const persistentSession = require('../lib/runtime/persistent-session');
const persistentSessionRegistry = require('../lib/runtime/persistent-session-registry');

const PROVIDER = 'codebuddy';
const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const SESSION = 'p-demo-abc123';
const CANONICAL_SOCKET = persistentSession.deriveSocket(PROVIDER, ACCOUNT_REF);

function makeAiHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-host-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedEntry(aiHomeDir, overrides = {}) {
  persistentSessionRegistry.writeEntry(aiHomeDir, {
    provider: PROVIDER,
    runtimeScope: ACCOUNT_REF,
    accountRef: ACCOUNT_REF,
    socket: CANONICAL_SOCKET,
    session: SESSION,
    cwd: aiHomeDir,
    ...overrides
  }, { strict: true });
}

// 假 tmux：支持 -V 版本探测、list-sessions 三态、kill-server / kill-session。
// servers 就是「这台机器上还活着的 tmux 服务端」，杀掉后必须真的消失，
// 否则复探永远成功，测不出「kill 没生效」这条路径。
function createFakeTmux({ servers = {}, tmuxAvailable = true, breakList = false, ignoreKill = false } = {}) {
  const state = {
    servers: new Map(Object.entries(servers).map(([socket, sessions]) => [socket, new Set(sessions)])),
    calls: []
  };
  const spawnSync = (command, args) => {
    state.calls.push([command, ...args].join(' '));
    if (args.includes('-V')) {
      return tmuxAvailable
        ? { status: 0, stdout: 'tmux 3.8\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'tmux: command not found' };
    }
    const socketIndex = args.indexOf('-L');
    const socket = socketIndex >= 0 ? String(args[socketIndex + 1] || '') : '';
    const action = args[socketIndex + 2] || '';
    if (action === 'list-sessions') {
      if (breakList) return { status: 2, stdout: '', stderr: 'tmux exploded' };
      const sessions = state.servers.get(socket);
      if (!sessions) return { status: 1, stdout: '', stderr: 'no server running on /tmp/tmux-501/default' };
      return { status: 0, stdout: [...sessions].join('\n') + (sessions.size ? '\n' : ''), stderr: '' };
    }
    if (action === 'kill-server') {
      if (!ignoreKill) state.servers.delete(socket);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (action === 'kill-session') {
      const target = args[args.indexOf('-t') + 1];
      const sessions = state.servers.get(socket);
      if (!ignoreKill && sessions) {
        sessions.delete(target);
        if (sessions.size === 0) state.servers.delete(socket);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { state, spawnSync };
}

function createService(aiHomeDir, fake) {
  return createAccountHostCleanupService({
    fs,
    aiHomeDir,
    spawnSync: fake.spawnSync
  });
}

test('verify：活着的精确会话是占用，登记必须保留', (t) => {
  const aiHomeDir = makeAiHome(t);
  seedEntry(aiHomeDir);
  const fake = createFakeTmux({ servers: { [CANONICAL_SOCKET]: [SESSION] } });

  const result = createService(aiHomeDir, fake).verify(PROVIDER, ACCOUNT_REF);

  assert.equal(result.ok, false);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].session, SESSION);
  assert.equal(result.blockers[0].uncertain, false);
  assert.equal(
    persistentSessionRegistry.listEntries(aiHomeDir).length,
    1,
    '活会话的登记不能被当成陈旧条目清掉'
  );
  assert.ok(
    !fake.state.calls.some((call) => call.includes('kill-')),
    'verify 不允许做破坏性动作'
  );
});

test('verify：服务端不在时清掉陈旧登记并放行', (t) => {
  const aiHomeDir = makeAiHome(t);
  seedEntry(aiHomeDir);
  const fake = createFakeTmux({ servers: {} });

  const result = createService(aiHomeDir, fake).verify(PROVIDER, ACCOUNT_REF);

  assert.equal(result.ok, true);
  assert.equal(result.reaped, 1);
  assert.deepEqual(persistentSessionRegistry.listEntries(aiHomeDir), []);
});

test('verify：服务端还在但精确会话已退出，同样按陈旧处理', (t) => {
  const aiHomeDir = makeAiHome(t);
  seedEntry(aiHomeDir);
  const fake = createFakeTmux({ servers: { [CANONICAL_SOCKET]: ['p-other-session'] } });

  const result = createService(aiHomeDir, fake).verify(PROVIDER, ACCOUNT_REF);

  // p-other-session 没有登记，但账号 socket 是账号私有的，它同样是写入者。
  assert.equal(result.ok, false);
  assert.equal(result.reaped, 1, '本条登记已退出，属于陈旧登记');
  assert.deepEqual(
    result.blockers.map((item) => item.session),
    ['p-other-session']
  );
  assert.equal(result.blockers[0].unregistered, true);
});

test('verify：登记缺失的孤儿会话一样拦住删除（fail-closed）', (t) => {
  const aiHomeDir = makeAiHome(t);
  const fake = createFakeTmux({ servers: { [CANONICAL_SOCKET]: [SESSION] } });

  const result = createService(aiHomeDir, fake).verify(PROVIDER, ACCOUNT_REF);

  assert.equal(result.ok, false);
  assert.equal(result.blockers[0].unregistered, true);
});

test('verify：有登记但无法探测时失败关闭', (t) => {
  const aiHomeDir = makeAiHome(t);
  seedEntry(aiHomeDir);
  const fake = createFakeTmux({ tmuxAvailable: false });

  assert.throws(
    () => createService(aiHomeDir, fake).verify(PROVIDER, ACCOUNT_REF),
    (error) => error && error.code === 'account_host_state_unknown'
  );
  assert.equal(persistentSessionRegistry.listEntries(aiHomeDir).length, 1, '探测失败不得删登记');
});

test('verify：没有登记且这台机器没有 tmux 时放行', (t) => {
  const aiHomeDir = makeAiHome(t);
  const fake = createFakeTmux({ tmuxAvailable: false });

  const result = createService(aiHomeDir, fake).verify(PROVIDER, ACCOUNT_REF);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test('cleanup：按账号 socket 回收整服务端并清登记，且幂等', (t) => {
  const aiHomeDir = makeAiHome(t);
  seedEntry(aiHomeDir);
  const fake = createFakeTmux({ servers: { [CANONICAL_SOCKET]: [SESSION, 's-extra'] } });
  const service = createService(aiHomeDir, fake);

  const first = service.cleanup(PROVIDER, ACCOUNT_REF);

  assert.equal(first.ok, true);
  assert.equal(first.results[0].action, 'killed');
  assert.deepEqual(persistentSessionRegistry.listEntries(aiHomeDir), []);
  assert.equal(fake.state.servers.has(CANONICAL_SOCKET), false, '服务端必须真的消失');
  assert.ok(
    fake.state.calls.some((call) => call.includes('kill-server')),
    '规范 socket 直接回收整个服务端'
  );

  const callsAfterFirst = fake.state.calls.length;
  const second = service.cleanup(PROVIDER, ACCOUNT_REF);

  assert.equal(second.ok, true);
  assert.equal(second.results[0].action, 'absent');
  assert.ok(
    !fake.state.calls.slice(callsAfterFirst).some((call) => call.includes('kill-')),
    '第二次清理不得再有破坏性动作'
  );
});

test('cleanup：非规范 socket 只杀登记点名的会话，不动整个服务端', (t) => {
  const aiHomeDir = makeAiHome(t);
  const legacySocket = 'aih-legacy-scope';
  seedEntry(aiHomeDir, { socket: legacySocket });
  const fake = createFakeTmux({ servers: { [legacySocket]: [SESSION, 's-keep'] } });

  const result = createService(aiHomeDir, fake).cleanup(PROVIDER, ACCOUNT_REF);

  assert.equal(result.ok, false, 's-keep 还在，这次没收干净');
  assert.ok(fake.state.calls.some((call) => call.includes('kill-session')));
  assert.ok(
    !fake.state.calls.some((call) => call.includes('kill-server')),
    '非规范 socket 不能按账号归属回收'
  );
  assert.deepEqual([...fake.state.servers.get(legacySocket)], ['s-keep']);
  assert.equal(persistentSessionRegistry.listEntries(aiHomeDir).length, 1, '没收干净时保留登记');
});

test('cleanup：服务端杀不掉时如实上报 kill_failed 并保留登记', (t) => {
  const aiHomeDir = makeAiHome(t);
  seedEntry(aiHomeDir);
  const fake = createFakeTmux({
    servers: { [CANONICAL_SOCKET]: [SESSION] },
    ignoreKill: true
  });

  const result = createService(aiHomeDir, fake).cleanup(PROVIDER, ACCOUNT_REF);

  assert.equal(result.ok, false);
  assert.equal(result.results[0].action, 'kill_failed');
  assert.equal(result.results[0].reason, 'persistent_session_still_alive');
  assert.equal(persistentSessionRegistry.listEntries(aiHomeDir).length, 1);
});

test('cleanup：探测失败时不动 tmux、不删登记', (t) => {
  const aiHomeDir = makeAiHome(t);
  seedEntry(aiHomeDir);
  const fake = createFakeTmux({
    servers: { [CANONICAL_SOCKET]: [SESSION] },
    breakList: true
  });

  const result = createService(aiHomeDir, fake).cleanup(PROVIDER, ACCOUNT_REF);

  assert.equal(result.ok, false);
  assert.equal(result.results[0].action, 'skipped_unknown');
  assert.ok(!fake.state.calls.some((call) => call.includes('kill-')));
  assert.equal(persistentSessionRegistry.listEntries(aiHomeDir).length, 1);
});

test('verify/cleanup：账号引用非法时直接拒绝', (t) => {
  const aiHomeDir = makeAiHome(t);
  const fake = createFakeTmux();
  const service = createService(aiHomeDir, fake);

  assert.throws(
    () => service.verify(PROVIDER, '../escape'),
    (error) => error && error.code === 'account_host_cleanup_invalid_target'
  );
  assert.throws(
    () => service.cleanup('../escape', ACCOUNT_REF),
    (error) => error && error.code === 'account_host_cleanup_invalid_target'
  );
  assert.deepEqual(fake.state.calls, []);
});
