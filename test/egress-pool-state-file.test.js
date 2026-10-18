'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const stateFile = require('../lib/runtime/egress-pool-state-file');
const registry = require('../lib/runtime/egress-pool-registry');
const { resolveEgressTarget } = require('../lib/server/zcode-egress-resolver');

function tempAiHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-egress-pool-state-'));
  fs.mkdirSync(stateFile.egressPoolWorkDir(dir), { recursive: true, mode: 0o700 });
  return dir;
}

// 存活进程：本测试进程自己（owner 与 core 都指向它，liveness 检查必然通过）。
// 已死进程：一个已经退出的子进程 pid。
function deadPid() {
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

test('the state file is written 0600 and read back only with both processes alive', () => {
  const aiHomeDir = tempAiHome();
  try {
    assert.equal(stateFile.writeEgressPoolState({
      aiHomeDir, ownerPid: process.pid, corePid: process.pid,
      proxyUrl: 'http://127.0.0.1:17890', controllerPort: 17891, secret: 's3cret'
    }), true);
    const mode = fs.statSync(stateFile.egressPoolStateFilePath(aiHomeDir)).mode & 0o777;
    assert.equal(mode, 0o600);
    const live = stateFile.readLiveEgressPoolState({ aiHomeDir });
    assert.equal(live.reason, '');
    assert.equal(live.state.proxyUrl, 'http://127.0.0.1:17890');

    const dead = deadPid();
    stateFile.writeEgressPoolState({ aiHomeDir, ownerPid: dead, corePid: process.pid, proxyUrl: 'http://127.0.0.1:17890' });
    assert.deepEqual(stateFile.readLiveEgressPoolState({ aiHomeDir }), { state: null, reason: 'egress_pool_server_not_running' });
    stateFile.writeEgressPoolState({ aiHomeDir, ownerPid: process.pid, corePid: dead, proxyUrl: 'http://127.0.0.1:17890' });
    assert.deepEqual(stateFile.readLiveEgressPoolState({ aiHomeDir }), { state: null, reason: 'egress_pool_core_exited' });

    stateFile.removeEgressPoolState({ aiHomeDir });
    assert.deepEqual(stateFile.readLiveEgressPoolState({ aiHomeDir }), { state: null, reason: 'egress_pool_server_not_running' });
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('a tampered state file pointing off loopback is never used', () => {
  const aiHomeDir = tempAiHome();
  try {
    stateFile.writeEgressPoolState({
      aiHomeDir, ownerPid: process.pid, corePid: process.pid, proxyUrl: 'http://203.0.113.5:17890'
    });
    assert.equal(stateFile.readEgressPoolState({ aiHomeDir }), null);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

// 复现 v3 评审的 CLI 路径：进程里没有登记任何池服务（用户自己启动的 `aih <cli>`）。
test('a CLI process with no registered pool resolves a pool binding from the live server state file', () => {
  registry.resetEgressPoolServiceForTests();
  const { applyAccountEgressProxyEnv } = require('../lib/runtime/account-egress-proxy');
  const { writeAccountEgressBinding } = require('../lib/account/zcode-egress-binding-store');
  const { upsertAccountRef } = require('../lib/server/account-ref-store');
  const aiHomeDir = tempAiHome();
  try {
    const accountRef = upsertAccountRef(fs, aiHomeDir, {
      provider: 'opencode',
      cliAccountId: '1',
      identitySeed: 'oauth:opencode:pool-cli@example.com'
    });
    writeAccountEgressBinding(fs, aiHomeDir, accountRef, { mode: 'pool' });

    // server 不在：fail-closed，且原因说清楚是 server 没在跑，而不是笼统地怪池子。
    assert.throws(
      () => applyAccountEgressProxyEnv({}, 'opencode', { aiHomeDir, accountRef, platform: 'darwin' }),
      (error) => error.code === 'egress_pool_not_ready' && error.reason === 'egress_pool_server_not_running'
    );

    // server 的池就绪（运行文件在、两个进程都活）：CLI 拿到池地址。
    stateFile.writeEgressPoolState({
      aiHomeDir, ownerPid: process.pid, corePid: process.pid,
      proxyUrl: 'http://127.0.0.1:17890', controllerPort: 17891, secret: 's'
    });
    const env = applyAccountEgressProxyEnv({}, 'opencode', { aiHomeDir, accountRef, platform: 'darwin' });
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:17890');
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');

    // 内核已退出：重新 fail-closed，不回落到任何别的出口。
    stateFile.writeEgressPoolState({ aiHomeDir, ownerPid: process.pid, corePid: deadPid(), proxyUrl: 'http://127.0.0.1:17890' });
    assert.throws(
      () => applyAccountEgressProxyEnv({}, 'opencode', { aiHomeDir, accountRef, platform: 'darwin' }),
      (error) => error.code === 'egress_pool_not_ready' && error.reason === 'egress_pool_core_exited'
    );
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('a process that holds a pool ignores the state file and reports its own start failure', () => {
  const aiHomeDir = tempAiHome();
  try {
    stateFile.writeEgressPoolState({
      aiHomeDir, ownerPid: process.pid, corePid: process.pid, proxyUrl: 'http://127.0.0.1:17890'
    });
    registry.setEgressPoolService({
      ready: false,
      proxyUrl: '',
      status: { starting: false, lastError: 'egress_pool_controller_port_in_use' },
      ensureStarted: () => false
    });
    const result = resolveEgressTarget({ binding: { mode: 'pool' }, platform: 'darwin', aiHomeDir });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'egress_pool_not_ready');
    assert.equal(result.reason, 'egress_pool_controller_port_in_use');
  } finally {
    registry.resetEgressPoolServiceForTests();
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
