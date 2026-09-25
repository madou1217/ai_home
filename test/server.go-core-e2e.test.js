'use strict';

// S5 端到端：真实 startLocalServer 在进程内监督真实 Go Core（aih-server 二进制），
// 首轮账号同步后 Node /readyz 汇合 Go 状态，已划转的 /v1/props 由 Go 应答。

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');

const { startLocalServer } = require('../lib/server/server');
const { createGoCoreHost } = require('../lib/server/go-core-host');
const { ensureGoServerBinary, seedNodeAccounts } = require('./helpers/go-bridge');
const {
  createProcessCapture,
  createServeOptions,
  createServerDeps,
  getFreePort
} = require('./helpers/local-server-harness');

const goBinary = ensureGoServerBinary();
const CLIENT_KEY = 'client-key-that-is-long-enough-for-tests';

function lifecycleCounters() {
  return {
    relayClosed: 0,
    webrtcClosed: 0,
    fabricClosed: 0,
    mdnsStopped: 0,
    outboundStopped: 0,
    frpStopped: 0,
    logTimers: new Set(),
    logTimersCleared: 0
  };
}

async function startWithGoCore(t, env) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-go-core-e2e-'));
  seedNodeAccounts(aiHomeDir);
  const processObj = createProcessCapture();
  Object.assign(processObj.env, {
    // Go 解析 Provider 原生共享目录需要 HOME；指向临时目录保持与真实用户目录隔离。
    HOME: aiHomeDir,
    AIH_GO_CORE_ENABLED: '1',
    AIH_GO_CORE_BINARY: goBinary,
    AIH_GO_CORE_PORT: String(await getFreePort()),
    ...env
  });
  const port = await getFreePort();
  let goHost = null;
  const handle = await startLocalServer(
    createServeOptions(port, { manageProcessLifecycle: false, clientKey: CLIENT_KEY }),
    createServerDeps(aiHomeDir, processObj, lifecycleCounters(), {
      // 其余依赖保持替身；只有 Go Core 使用真实子进程与真实 HTTP。
      createGoCoreHost: (options) => {
        goHost = createGoCoreHost({ ...options, spawn: childProcess.spawn, fetchImpl: fetch });
        return goHost;
      }
    })
  );
  t.after(async () => {
    await handle.stop('test-cleanup');
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !(goHost.status().state === 'ready' && goHost.status().accountsSynced)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { base: `http://127.0.0.1:${port}`, goHost };
}

test('Node /readyz merges a real Go Core and forwards Go-owned routes', { skip: !goBinary && 'Go toolchain/binary unavailable' }, async (t) => {
  const { base, goHost } = await startWithGoCore(t, { AIH_GO_CORE_ROUTES: 'gateway.props' });
  assert.equal(goHost.status().state, 'ready');
  assert.equal(goHost.status().accountsSynced, true);

  const readyz = await (await fetch(`${base}/readyz`)).json();
  assert.equal(readyz.go_core.enabled, true);
  assert.equal(readyz.go_core.state, 'ready');
  assert.equal(readyz.go_core.accounts_synced, true);
  assert.equal(readyz.go_core.forwarding, true);
  assert.deepEqual(readyz.go_core.routes, ['gateway.props']);
  assert.equal(readyz.go_core.ready, readyz.go_core.go_ready);

  const unauthorized = await fetch(`${base}/v1/props`);
  assert.equal(unauthorized.status, 401, 'Node still enforces its client key before forwarding');

  const props = await fetch(`${base}/v1/props`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
  assert.equal(props.status, 200);
  assert.equal(typeof (await props.json()), 'object');

  // 模型目录只能在推理全部划转后跟随（S6），单独划转会被整体拒绝并失败关闭。
  const { resolveGoOwnedEntryIds, loadRouteOwnershipManifest } = require('../lib/server/go-core-route-ownership');
  const rejected = resolveGoOwnedEntryIds(loadRouteOwnershipManifest(), ['gateway.models.list']);
  assert.match(rejected.errors.join('\n'), /moves only after every inference route/);
});

test('Node serves Go-owned routes while the Go process is down and Go recovers after auto restart', { skip: !goBinary && 'Go toolchain/binary unavailable' }, async (t) => {
  const { base, goHost } = await startWithGoCore(t, { AIH_GO_CORE_ROUTES: 'gateway.props' });
  assert.equal(goHost.status().state, 'ready');
  process.kill(goHost.status().pid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && goHost.status().state === 'ready') {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const readyz = await (await fetch(`${base}/readyz`)).json();
  assert.equal(readyz.ready, false);
  assert.equal(readyz.go_core.ready, false);
  // 共存期 Node 仍是完整实现：Go 不可用时请求交由 Node 应答，而不是 503；就绪态仍如实报告。
  const props = await fetch(`${base}/v1/props`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
  assert.equal(props.status, 200);

  // 监督器按退避自动拉起 Go，转发随之恢复；Go 的输出落在 logs/go-core.log。
  const recoverBy = Date.now() + 15000;
  while (Date.now() < recoverBy && goHost.status().state !== 'ready') {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(goHost.status().state, 'ready');
  assert.equal(goHost.status().restarts, 1);
  const recovered = await fetch(`${base}/v1/props`, { headers: { authorization: `Bearer ${CLIENT_KEY}` } });
  assert.equal(recovered.status, 200);
  assert.equal(fs.existsSync(goHost.status().logFile), true);
});
