'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');
const { getProxyCore } = require('../lib/cli/services/toolkit/proxy-pool/cores');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-proxy-core-lifecycle-'));
}

function fakeRuntime() {
  let running = false;
  const calls = [];
  return {
    calls,
    getStatus: () => ({ running, dataPlaneReady: running, installed: true, activeListeners: [] }),
    start: async () => { calls.push('start'); running = true; return { ok: true, applied: true, action: 'start', warnings: [] }; },
    stop: async () => { calls.push('stop'); running = false; return { ok: true, applied: true, action: 'stop', warnings: [] }; },
    reload: async () => ({ ok: true, applied: true, action: 'reload', warnings: [] }),
    getOwnedProcessId: () => null
  };
}

test('内核期望状态：用户启动记为运行、用户停止记为停止，服务关闭不改变期望状态', async () => {
  const filePath = path.join(tempDir(), 'proxy-pool.json');
  const runtime = fakeRuntime();
  const service = new ProxyPoolService({ storeOptions: { filePath }, coreRuntime: runtime, platform: 'linux' });
  assert.equal(service.store.getCoreConfig().desired, 'stopped');

  await service.startCore();
  assert.equal(service.store.getCoreConfig().desired, 'running');

  await service.close();
  assert.equal(runtime.getStatus().running, false);
  assert.equal(service.store.getCoreConfig().desired, 'running', '服务关闭不是用户停止');

  const restarted = fakeRuntime();
  const next = new ProxyPoolService({ storeOptions: { filePath }, coreRuntime: restarted, platform: 'linux' });
  const restored = await next.restoreCore();
  assert.equal(restored.action, 'restore');
  assert.deepEqual(restarted.calls, ['start']);
  assert.equal((await next.restoreCore()).reason, 'already_running');

  await next.stopCore();
  assert.equal(next.store.getCoreConfig().desired, 'stopped');
  const third = fakeRuntime();
  const skipped = await new ProxyPoolService({ storeOptions: { filePath }, coreRuntime: third, platform: 'linux' }).restoreCore();
  assert.equal(skipped.reason, 'not_desired');
  assert.deepEqual(third.calls, []);
});

test('内核运行时启动前清理上一实例遗留进程：只结束命令行指向本配置的进程', async () => {
  const aiHomeDir = tempDir();
  const killed = [];
  const alive = new Set([4242, 5151]);
  const commandLines = new Map();
  const runtime = getProxyCore('sing-box').createRuntime({
    aiHomeDir,
    env: { PATH: '' },
    isPidAlive: (pid) => alive.has(pid),
    killPid: (pid, signal) => { killed.push([pid, signal]); alive.delete(pid); },
    readCommandLine: (pid) => commandLines.get(pid) || ''
  });
  fs.mkdirSync(runtime.runtimeDir, { recursive: true });
  const writeRecord = (pid) => fs.writeFileSync(runtime.pidFilePath, JSON.stringify({ pid, configPath: runtime.configPath }));

  commandLines.set(4242, `/opt/sing-box run -c ${runtime.configPath} -D ${runtime.runtimeDir}`);
  writeRecord(4242);
  assert.deepEqual(await runtime.reapOrphanedProcess(), { reaped: true, pid: 4242 });
  assert.deepEqual(killed, [[4242, 'SIGTERM']]);
  assert.equal(fs.existsSync(runtime.pidFilePath), false);

  commandLines.set(5151, '/usr/bin/some-other-program --flag');
  writeRecord(5151);
  const foreign = await runtime.reapOrphanedProcess();
  assert.equal(foreign.foreign, true, 'pid 被其它程序复用时不结束它');
  assert.equal(alive.has(5151), true);

  writeRecord(9999);
  assert.equal((await runtime.reapOrphanedProcess()).stale, true);
  assert.equal(fs.existsSync(runtime.pidFilePath), false);
});

test('服务端启动时只在同一数据目录下恢复默认代理池内核', async () => {
  const { restoreDefaultProxyPoolCore, getProxyPoolService } = require('../lib/cli/services/toolkit/proxy-pool/proxy-pool-service');
  const aiHomeDir = tempDir();
  const first = await restoreDefaultProxyPoolCore({ aiHomeDir });
  assert.equal(first.reason, 'not_desired');
  assert.equal(path.dirname(getProxyPoolService().store.filePath), aiHomeDir);
  const other = await restoreDefaultProxyPoolCore({ aiHomeDir: tempDir() });
  assert.equal(other.reason, 'different_data_dir');
});

test('批量测速并发执行；推荐出口按延迟排序且不修改分流配置', async () => {
  const filePath = path.join(tempDir(), 'proxy-pool.json');
  let inFlight = 0;
  let peak = 0;
  const latency = { a: 300, b: 80, c: -1, d: 120 };
  const runtime = {
    getStatus: () => ({ running: true, dataPlaneReady: true, installed: true, activeListeners: [] }),
    pingNode: async (node) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return latency[node.name] >= 0 ? { ok: true, latencyMs: latency[node.name] } : { ok: false, error: 'timeout' };
    }
  };
  const service = new ProxyPoolService({ storeOptions: { filePath }, coreRuntime: runtime, platform: 'linux' });
  for (const name of Object.keys(latency)) {
    service.store.upsertNode({ name, protocol: 'socks5', server: `${name}.example`, port: 1080 });
  }
  const before = JSON.stringify(service.store.getRoutingConfig());
  const suggested = await service.suggestOutbound({}, { limit: 2, concurrency: 4 });
  assert.equal(suggested.ok, true);
  assert.equal(suggested.testedCount, 4);
  assert.equal(suggested.reachableCount, 3);
  assert.deepEqual(suggested.candidates.map((item) => [item.name, item.latencyMs]), [['b', 80], ['d', 120]]);
  assert.ok(peak > 1, '测速应并发进行');
  assert.equal(JSON.stringify(service.store.getRoutingConfig()), before, '推荐不改分流配置');
});
