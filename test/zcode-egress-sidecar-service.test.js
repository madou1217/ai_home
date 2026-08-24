'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  EGRESS_MODE_GROUP,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL,
  writeAccountEgressBinding
} = require('../lib/account/zcode-egress-binding-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const {
  applyStoredAccountEgress,
  getAccountEgressRuntimeStatus,
  launchAccountAppWithEgress,
  restorePersistedZcodeEgress,
  resolveAccountEgress,
  rotateStoredAccountEgress
} = require('../lib/server/zcode-egress-service');

function createAccount(t, provider = 'zcode') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-egress-sidecar-service-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId: '1',
    identitySeed: `oauth:${provider}:${path.basename(aiHomeDir)}@example.com`
  });
  return { accountRef, aiHomeDir };
}

function node(id, latencyMs) {
  return {
    id,
    protocol: 'vless',
    server: `${id}.example`,
    port: 443,
    uuid: `00000000-0000-4000-8000-${id.padEnd(12, '0').slice(0, 12)}`,
    latencyMs
  };
}

function createDependencies(events, nodes = [node('node-a', 20), node('node-b', 40)]) {
  return {
    nodeStore: {
      getGroup: (groupId) => ({
        id: groupId,
        strategy: 'lowest_latency',
        failoverStrategy: 'lowest_latency'
      }),
      listNodes: () => nodes,
      getNode: (nodeId) => nodes.find((candidate) => candidate.id === nodeId) || null,
      updateNodeLatencies(results, checkedAt) {
        let updated = 0;
        let missing = 0;
        for (const result of results) {
          const candidate = nodes.find((item) => item.id === result.nodeId);
          if (!candidate) {
            missing += 1;
            continue;
          }
          candidate.latencyMs = result.latencyMs;
          candidate.lastChecked = checkedAt;
          updated += 1;
        }
        events.push(['latency-update', { results, checkedAt }]);
        return { updated, missing };
      }
    },
    leaseStore: {
      listActive: () => [],
      getLastSelectedNodeId: () => '',
      getByOwner: () => null,
      acquire(input) {
        events.push(['lease-acquire', input]);
        return { ...input, pid: null };
      },
      attachProcess(ownerId, pid) {
        events.push(['lease-attach', { ownerId, pid }]);
        return { ownerId, pid };
      },
      release(ownerId) {
        events.push(['lease-release', ownerId]);
        return true;
      },
      releaseByAccount(accountRef) {
        events.push(['lease-release-account', accountRef]);
        return 1;
      }
    },
    zcodeSingBoxRuntime: {
      ensureAccountEndpoint(input) {
        events.push(['sidecar-ensure', input]);
        return Promise.resolve({
          ok: true,
          action: 'started',
          port: 23100,
          proxyServer: '127.0.0.1:23100',
          selectedNodeId: input.resolvedTarget.selectedNodeId || null
        });
      },
      releaseAccount(accountRef) {
        events.push(['sidecar-release', accountRef]);
        return Promise.resolve({ ok: true, action: 'stopped' });
      }
    },
    probeProxyServer(proxyServer) {
      events.push(['probe', proxyServer]);
      return Promise.resolve({ ok: true });
    }
  };
}

test('group 绑定先获取租约，再把中立 target 交给 sing-box，并只返回稳定回环 endpoint', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.proxyServer, '127.0.0.1:23100');
  assert.equal(result.source, EGRESS_MODE_GROUP);
  assert.equal(result.selectedNodeId, 'node-a');
  assert.deepEqual(events.map(([name]) => name), [
    'lease-acquire',
    'sidecar-ensure',
    'probe'
  ]);
  assert.equal(events[0][1].accountRef, accountRef);
  assert.equal(events[0][1].nodeId, 'node-a');
  assert.equal(events[1][1].resolvedTarget.target.kind, 'node');
});

test('首次最低延迟选择先用 sing-box 测候选，再热切到真实最低延迟节点', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const nodes = [node('node-a', null), node('node-b', null)];
  const events = [];
  const deps = createDependencies(events, nodes);
  deps.zcodeSingBoxRuntime.measureAccountCandidateLatencies = async ({ nodeIds }) => {
    events.push(['latency-measure', [...nodeIds]]);
    return {
      ok: true,
      measuredCount: 2,
      healthyCount: 2,
      failedCount: 0,
      results: [
        { nodeId: 'node-a', ok: true, measured: true, latencyMs: 90 },
        { nodeId: 'node-b', ok: true, measured: true, latencyMs: 15 }
      ]
    };
  };

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.selectedNodeId, 'node-b');
  assert.deepEqual(
    events.filter(([name]) => name === 'sidecar-ensure')
      .map(([, value]) => value.resolvedTarget.selectedNodeId),
    ['node-a', 'node-b']
  );
  assert.deepEqual(events.find(([name]) => name === 'latency-measure')[1], ['node-a', 'node-b']);
  assert.deepEqual(nodes.map((candidate) => candidate.latencyMs), [90, 15]);
  assert.equal(events.filter(([name]) => name === 'probe').length, 1);
});

test('sidecar 或真实出口探测失败时释放待启动租约并撤销账号监听', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  deps.probeProxyServer = async () => ({ ok: false, reason: 'curl_exit_7' });

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_unreachable');
  assert.ok(events.some(([name]) => name === 'lease-release'));
  assert.ok(events.some(([name]) => name === 'sidecar-release'));
});

test('运行态热切换探测失败时保留现有 sidecar endpoint 供绑定事务回滚', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  deps.probeProxyServer = async () => ({ ok: false, reason: 'curl_exit_28' });

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    preserveAccountEndpointOnFailure: true,
    deps
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'proxy_unreachable');
  assert.ok(events.some(([name]) => name === 'lease-release'));
  assert.equal(events.some(([name]) => name === 'sidecar-release'), false);
});

test('group 首节点探测失败时热切到下一节点并继续启动', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  let probeCalls = 0;
  deps.probeProxyServer = async () => {
    probeCalls += 1;
    return probeCalls === 1
      ? { ok: false, reason: 'first_node_unreachable' }
      : { ok: true };
  };

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.selectedNodeId, 'node-b');
  assert.equal(probeCalls, 2);
  assert.deepEqual(
    events.filter(([name]) => name === 'lease-acquire').map(([, value]) => value.nodeId),
    ['node-a', 'node-b']
  );
  assert.equal(events.filter(([name]) => name === 'sidecar-ensure').length, 2);
  assert.equal(events.some(([name]) => name === 'sidecar-release'), false);
});

test('Desktop 启动成功后把待启动租约绑定到真实 ZCode PID', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  let calls = 0;
  const launcher = {
    launchAccountApp(input) {
      calls += 1;
      if (input.deferDesktopSpawn) return { ok: true, status: 'launch_ready' };
      assert.equal(input.egress.proxyServer, '127.0.0.1:23100');
      return { ok: true, status: 'launched', pid: 7123 };
    }
  };

  const launched = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps
    }
  });

  assert.equal(calls, 2);
  assert.equal(launched.result.status, 'launched');
  assert.ok(events.some(([name, value]) => (
    name === 'lease-attach' && value.pid === 7123
  )));
});

test('真实启动失败时释放租约与 sidecar 账号配置，不留下假占用', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  const launcher = {
    launchAccountApp(input) {
      return input.deferDesktopSpawn
        ? { ok: true, status: 'launch_ready' }
        : { ok: false, error: 'launch_failed' };
    }
  };

  const launched = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'open'
    },
    egressInput: {
      fs,
      aiHomeDir,
      processObj: { platform: 'darwin' },
      deps
    }
  });

  assert.equal(launched.result.ok, false);
  assert.ok(events.some(([name]) => name === 'lease-release'));
  assert.ok(events.some(([name]) => name === 'sidecar-release'));
});

test('关闭或未绑定 ZCode Desktop 时释放租约和 sidecar，不触碰系统代理', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  const events = [];
  const deps = createDependencies(events);
  const launcher = {
    launchAccountApp() {
      return { ok: true, status: 'closed', pids: [7123] };
    }
  };

  const closed = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'zcode',
      accountRef,
      kind: 'desktop',
      action: 'close'
    },
    egressInput: { fs, aiHomeDir, processObj: { platform: 'darwin' }, deps }
  });
  assert.equal(closed.result.status, 'closed');
  assert.ok(events.some(([name]) => name === 'lease-release-account'));
  assert.ok(events.some(([name]) => name === 'sidecar-release'));

  events.length = 0;
  const unbound = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });
  assert.equal(unbound, null);
  assert.ok(events.some(([name]) => name === 'lease-release-account'));
  assert.ok(events.some(([name]) => name === 'sidecar-release'));
});

test('关闭仍绑定出口的非 ZCode Desktop 时保留 sidecar，供 CLI 与 Gateway 继续复用', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t, 'claude');
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: '127.0.0.1:10801'
  });
  const events = [];
  const deps = createDependencies(events);
  const launcher = {
    launchAccountApp() {
      return { ok: true, status: 'closed', pids: [7221] };
    }
  };

  const closed = await launchAccountAppWithEgress({
    launcher,
    launchInput: {
      provider: 'claude',
      accountRef,
      kind: 'desktop',
      action: 'close'
    },
    egressInput: { fs, aiHomeDir, processObj: { platform: 'darwin' }, deps }
  });

  assert.equal(closed.result.status, 'closed');
  assert.equal(events.some(([name]) => name === 'lease-release-account'), false);
  assert.equal(events.some(([name]) => name === 'sidecar-release'), false);
});

test('URL 模式也经过稳定本地 sidecar，而不是把远端地址直接写入 ZCode', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: 'socks5://proxy.example:1080'
  });
  const events = [];
  const deps = createDependencies(events);

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(result.proxyServer, '127.0.0.1:23100');
  const ensure = events.find(([name]) => name === 'sidecar-ensure')[1];
  assert.deepEqual(ensure.resolvedTarget.target, {
    kind: 'proxy-url',
    proxyUrl: 'socks5://proxy.example:1080'
  });
  assert.equal(events.some(([name]) => name === 'lease-acquire'), false);
});

test('非 macOS 在初始化节点仓、租约或 sidecar 前返回 not_supported', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const calls = [];

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'win32' },
    deps: {
      getProxyNodeStore() {
        calls.push('node-store');
        throw new Error('node store must stay lazy');
      },
      getZcodeEgressLeaseStore() {
        calls.push('lease-store');
        throw new Error('lease store must stay lazy');
      },
      getZcodeSingBoxRuntime() {
        calls.push('sidecar');
        throw new Error('sidecar must stay lazy');
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_supported');
  assert.equal(result.platform, 'windows');
  assert.deepEqual(calls, []);
});

test('无效 URL 在初始化租约或 sidecar 前返回 invalid_proxy_url', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: 'not-a-proxy-url'
  });
  const calls = [];

  const result = await resolveAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps: {
      getZcodeEgressLeaseStore() {
        calls.push('lease-store');
        throw new Error('lease store must stay lazy');
      },
      getZcodeSingBoxRuntime() {
        calls.push('sidecar');
        throw new Error('sidecar must stay lazy');
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_proxy_url');
  assert.deepEqual(calls, []);
});

test('ZCode service 源码不再加载旧 Proxy Pool 数据面', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../lib/server/zcode-egress-service.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /mihomo|ProxyPoolService|toggleDedicatedPort|startDedicatedPort/i);
});

test('运行中的账号保存绑定后实时切 selector；尚未启动的账号只标记下次启动应用', async (t) => {
  assert.equal(typeof applyStoredAccountEgress, 'function');
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  deps.zcodeSingBoxRuntime.getStatus = () => ({
    running: true,
    accounts: [{ accountRef, port: 23100 }]
  });
  const launcher = {
    launchAccountApp(input) {
      assert.equal(input.deferDesktopSpawn, true);
      return { ok: true, status: 'already_running', pids: [7101] };
    }
  };

  const applied = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps,
    launcher
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.proxyServer, '127.0.0.1:23100');
  assert.ok(events.some(([name, value]) => (
    name === 'lease-attach' && value.pid === 7101
  )));

  deps.zcodeSingBoxRuntime.getStatus = () => ({ running: false, accounts: [] });
  events.length = 0;
  const pending = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });
  assert.deepEqual(pending, {
    ok: true,
    applied: false,
    status: 'pending_launch'
  });
  assert.equal(events.length, 0);
});

test('Server 重启后持久 endpoint 直接重建 sidecar，不重启仍在运行的 ZCode', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_TUN
  });
  const events = [];
  const deps = createDependencies(events);
  deps.detectTun = () => ({ state: 'active', owner: 'clash-verge' });
  deps.zcodeSingBoxRuntime.getStatus = () => ({ running: false, accounts: [] });
  deps.zcodeSingBoxRuntime.getAccountState = () => ({
    accountRef,
    port: 23100,
    source: EGRESS_MODE_TUN,
    selectedTarget: { kind: 'direct' },
    candidateTargets: [{ kind: 'direct' }]
  });

  const restored = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(restored.ok, true);
  assert.equal(restored.applied, true);
  assert.equal(restored.status, 'started');
  assert.equal(restored.source, EGRESS_MODE_TUN);
  assert.equal(restored.proxyServer, '127.0.0.1:23100');
  assert.deepEqual(new Set(events.map(([name]) => name)), new Set([
    'lease-release',
    'sidecar-ensure',
    'probe'
  ]));
});

test('Server 启动恢复全部持久 ZCode endpoint，并复用同一个 runtime', async (t) => {
  assert.equal(typeof restorePersistedZcodeEgress, 'function');
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_TUN
  });
  const events = [];
  const deps = createDependencies(events);
  deps.detectTun = () => ({ state: 'active', owner: 'clash-verge' });
  deps.zcodeSingBoxRuntime.readState = () => ({
    accounts: {
      [accountRef]: {
        source: EGRESS_MODE_TUN,
        selectedTarget: { kind: 'direct' },
        candidateTargets: [{ kind: 'direct' }]
      }
    }
  });
  deps.zcodeSingBoxRuntime.getStatus = () => ({ running: false, accounts: [] });
  deps.zcodeSingBoxRuntime.getAccountState = () => ({
    accountRef,
    port: 23100,
    source: EGRESS_MODE_TUN,
    selectedTarget: { kind: 'direct' },
    candidateTargets: [{ kind: 'direct' }]
  });

  const result = await restorePersistedZcodeEgress({
    fs,
    aiHomeDir,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.discovered, 1);
  assert.equal(result.restored, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].accountRef, accountRef);
  assert.equal(result.results[0].status, 'started');
  assert.equal(events.filter(([name]) => name === 'sidecar-ensure').length, 1);
});

test('Server 启动从账号绑定恢复缺失 runtime state 的非 ZCode endpoint', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t, 'claude');
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_URL,
    proxyUrl: 'http://proxy.example:8080'
  });
  const events = [];
  const deps = createDependencies(events);
  deps.zcodeSingBoxRuntime.readState = () => ({ accounts: {} });
  deps.zcodeSingBoxRuntime.getStatus = () => ({ running: false, accounts: [] });
  deps.zcodeSingBoxRuntime.getAccountState = () => null;

  const result = await restorePersistedZcodeEgress({
    fs,
    aiHomeDir,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.discovered, 1);
  assert.equal(result.restored, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].provider, 'claude');
  assert.equal(result.results[0].accountRef, accountRef);
  assert.equal(events.filter(([name]) => name === 'sidecar-ensure').length, 1);
});

test('首次绑定会先验证出口，再精确重启已运行但尚未接入 sidecar 的 ZCode 账号', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  deps.zcodeSingBoxRuntime.getStatus = () => ({ running: false, accounts: [] });
  const launcher = {
    launchAccountApp(input) {
      if (input.deferDesktopSpawn) {
        events.push(['desktop-preflight', input]);
        return { ok: true, status: 'already_running', pids: [7101] };
      }
      if (input.action === 'close') {
        events.push(['desktop-close', input]);
        return { ok: true, status: 'closed', pids: [7101] };
      }
      events.push(['desktop-open', input]);
      assert.equal(input.egress.proxyServer, '127.0.0.1:23100');
      return { ok: true, status: 'launched', pid: 7102 };
    }
  };

  const applied = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps,
    launcher
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.status, 'restarted');
  assert.equal(applied.restarted, true);
  assert.equal(applied.pid, 7102);
  assert.deepEqual(applied.previousPids, [7101]);
  assert.equal(applied.proxyServer, '127.0.0.1:23100');
  assert.equal(applied.selectedNodeId, 'node-a');
  assert.ok(events.findIndex(([name]) => name === 'probe') < events.findIndex(([name]) => name === 'desktop-close'));
  assert.ok(events.some(([name, value]) => name === 'lease-attach' && value.pid === 7102));
});

test('非 ZCode Desktop 首次绑定时也会重启已运行实例，让账号代理真正生效', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t, 'claude');
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  deps.zcodeSingBoxRuntime.getStatus = () => ({ running: false, accounts: [] });
  const ensureAccountEndpoint = deps.zcodeSingBoxRuntime.ensureAccountEndpoint;
  deps.zcodeSingBoxRuntime.ensureAccountEndpoint = async (input) => ({
    ...(await ensureAccountEndpoint(input)),
    sidecar: { pid: 7300 }
  });
  const launcher = {
    launchAccountApp(input) {
      if (input.inspectDesktopRunning) {
        events.push(['desktop-inspect', input]);
        return { ok: true, status: 'already_running', pids: [7201] };
      }
      if (input.action === 'close') {
        events.push(['desktop-close', input]);
        return { ok: true, status: 'closed', pids: [7201] };
      }
      events.push(['desktop-open', input]);
      assert.equal(input.egress.proxyServer, '127.0.0.1:23100');
      return { ok: true, status: 'launched', pid: 7202 };
    }
  };

  const applied = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'claude',
    accountRef,
    processObj: { platform: 'darwin' },
    deps,
    launcher
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.status, 'restarted');
  assert.equal(applied.restarted, true);
  assert.equal(applied.pid, 7202);
  assert.deepEqual(applied.previousPids, [7201]);
  assert.ok(events.findIndex(([name]) => name === 'probe') < events.findIndex(([name]) => name === 'desktop-close'));
  assert.ok(events.some(([name, value]) => name === 'lease-attach' && value.pid === 7300));
});

test('首次绑定在 ZCode 未运行时保持 pending_launch，不提前启动 sidecar', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const deps = createDependencies(events);
  deps.zcodeSingBoxRuntime.getStatus = () => ({ running: false, accounts: [] });
  const launcher = {
    launchAccountApp(input) {
      assert.equal(input.deferDesktopSpawn, true);
      events.push(['desktop-preflight', input]);
      return { ok: true, status: 'launch_ready' };
    }
  };

  const pending = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps,
    launcher
  });

  assert.deepEqual(pending, {
    ok: true,
    applied: false,
    status: 'pending_launch'
  });
  assert.deepEqual(events.map(([name]) => name), ['desktop-preflight']);
});

test('运行中解除绑定时把既有稳定 endpoint 热切到 direct，关闭后再移除', async (t) => {
  assert.equal(typeof applyStoredAccountEgress, 'function');
  const { accountRef, aiHomeDir } = createAccount(t);
  const events = [];
  const deps = createDependencies(events);
  deps.zcodeSingBoxRuntime.getStatus = () => ({
    running: true,
    accounts: [{ accountRef, port: 23100 }]
  });

  const applied = await applyStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  const ensure = events.find(([name]) => name === 'sidecar-ensure')[1];
  assert.deepEqual(ensure.resolvedTarget, {
    ok: true,
    source: 'direct',
    target: { kind: 'direct' }
  });
  assert.ok(events.some(([name]) => name === 'lease-release-account'));
});

function createRotationDependencies(accountRef, events, probeResults) {
  const nodes = [
    node('node-a', 10),
    node('node-b', 20),
    node('node-c', 30)
  ];
  let lease = {
    ownerId: `zcode:desktop:${accountRef}`,
    accountRef,
    instanceKind: 'desktop',
    groupId: 'group-fast',
    nodeId: 'node-a',
    pid: 8123
  };
  let accountState = {
    accountRef,
    port: 23100,
    source: EGRESS_MODE_GROUP,
    selectedTarget: { kind: 'node', node: nodes[0] },
    candidateTargets: nodes.map((candidate) => ({ kind: 'node', node: candidate })),
    selectedNodeId: 'node-a',
    groupId: 'group-fast'
  };
  const healthTracks = [];
  return {
    deps: {
      nodeStore: {
        getGroup: () => ({
          id: 'group-fast',
          strategy: 'sticky',
          failoverStrategy: 'lowest_latency'
        }),
        listNodes: () => nodes,
        getNode: (nodeId) => nodes.find((candidate) => candidate.id === nodeId) || null,
        updateNodeLatencies(results, checkedAt) {
          let updated = 0;
          let missing = 0;
          for (const result of results) {
            const candidate = nodes.find((item) => item.id === result.nodeId);
            if (!candidate) {
              missing += 1;
              continue;
            }
            candidate.latencyMs = result.latencyMs;
            candidate.lastChecked = checkedAt;
            updated += 1;
          }
          events.push(['latency-update', { results, checkedAt }]);
          return { updated, missing };
        }
      },
      leaseStore: {
        getByOwner: () => ({ ...lease }),
        listActive: () => [{ ...lease }],
        getLastSelectedNodeId: () => lease.nodeId,
        acquire(input) {
          lease = { ...lease, ...input };
          events.push(['lease-acquire', { ...input }]);
          return { ...lease };
        },
        release() {
          events.push(['lease-release']);
          lease = null;
          return true;
        }
      },
      zcodeSingBoxRuntime: {
        getStatus() {
          return {
            engine: 'sing-box',
            installed: true,
            running: true,
            dataPlaneReady: true,
            pid: 9001,
            accounts: [{
              accountRef,
              port: 23100,
              source: accountState.source,
              selectedNodeId: accountState.selectedNodeId
            }]
          };
        },
        getAccountState() {
          return JSON.parse(JSON.stringify(accountState));
        },
        async ensureAccountEndpoint({ resolvedTarget }) {
          accountState = {
            accountRef,
            port: 23100,
            source: resolvedTarget.source,
            selectedTarget: JSON.parse(JSON.stringify(resolvedTarget.target)),
            candidateTargets: (resolvedTarget.candidateNodes || [])
              .map((candidate) => ({ kind: 'node', node: JSON.parse(JSON.stringify(candidate)) })),
            selectedNodeId: resolvedTarget.selectedNodeId,
            groupId: resolvedTarget.groupId
          };
          events.push(['sidecar-ensure', resolvedTarget.selectedNodeId]);
          return {
            ok: true,
            action: 'selected',
            proxyServer: '127.0.0.1:23100'
          };
        },
        async releaseAccount() {
          events.push(['sidecar-release']);
          return { ok: true, action: 'stopped' };
        }
      },
      zcodeEgressHealthMonitor: {
        track(input) {
          healthTracks.push({ ...input });
          return { monitoring: true };
        },
        getStatus() {
          return {
            monitoring: true,
            consecutiveFailures: 0,
            intervalMs: 30000,
            failureThreshold: 2
          };
        }
      },
      async probeProxyServer() {
        const next = probeResults.shift();
        return next || { ok: true };
      }
    },
    getAccountState: () => JSON.parse(JSON.stringify(accountState)),
    getHealthTracks: () => [...healthTracks],
    getLease: () => ({ ...lease }),
    getNodes: () => nodes.map((candidate) => ({ ...candidate }))
  };
}

test('ZCode 运行态返回当前节点、分组、sidecar 与健康监测状态', (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const fixture = createRotationDependencies(accountRef, [], []);

  const status = getAccountEgressRuntimeStatus({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    deps: fixture.deps
  });

  assert.equal(status.ok, true);
  assert.equal(status.runtime.running, true);
  assert.equal(status.runtime.dataPlaneReady, true);
  assert.equal(status.runtime.proxyServer, '127.0.0.1:23100');
  assert.equal(status.runtime.selectedNodeId, 'node-a');
  assert.equal(status.runtime.groupId, 'group-fast');
  assert.equal(status.runtime.zcodePid, 8123);
  assert.equal(status.runtime.canRotate, true);
  assert.equal(status.runtime.sidecar.engine, 'sing-box');
  assert.equal(status.runtime.health.monitoring, true);
});

test('非 group 运行态从账号 Desktop 探针返回真实 ZCode PID', (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_TUN
  });
  const deps = createDependencies([]);
  deps.zcodeSingBoxRuntime.getStatus = () => ({
    engine: 'sing-box',
    installed: true,
    running: true,
    dataPlaneReady: true,
    pid: 9001,
    accounts: [{ accountRef, port: 23100, source: EGRESS_MODE_TUN }]
  });
  const launcher = {
    launchAccountApp(input) {
      assert.deepEqual(input, {
        provider: 'zcode',
        accountRef,
        kind: 'desktop',
        action: 'open',
        deferDesktopSpawn: true
      });
      return { ok: true, status: 'already_running', pids: [8124] };
    }
  };

  const status = getAccountEgressRuntimeStatus({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    deps,
    launcher
  });

  assert.equal(status.ok, true);
  assert.equal(status.runtime.zcodePid, 8124);
  assert.equal(status.runtime.canRotate, false);
});

test('立即换节点排除当前节点并保留真实 ZCode PID', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const fixture = createRotationDependencies(accountRef, events, [{ ok: true }]);

  const result = await rotateStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps: fixture.deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.rotated, true);
  assert.equal(result.previousNodeId, 'node-a');
  assert.equal(result.selectedNodeId, 'node-b');
  assert.equal(fixture.getLease().nodeId, 'node-b');
  assert.equal(fixture.getLease().pid, 8123);
  assert.equal(fixture.getAccountState().selectedNodeId, 'node-b');
  assert.deepEqual(events.map(([name, value]) => [name, value?.nodeId || value]), [
    ['lease-acquire', 'node-b'],
    ['sidecar-ensure', 'node-b']
  ]);
  assert.equal(fixture.getHealthTracks().at(-1).selectedNodeId, 'node-b');
});

test('故障切换前刷新陈旧候选延迟，并选择实测最低的健康节点', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const fixture = createRotationDependencies(accountRef, events, [{ ok: true }]);
  fixture.deps.zcodeSingBoxRuntime.measureAccountCandidateLatencies = async ({ nodeIds }) => {
    events.push(['latency-measure', [...nodeIds]]);
    return {
      ok: true,
      measuredCount: 2,
      healthyCount: 2,
      failedCount: 0,
      results: [
        { nodeId: 'node-b', ok: true, measured: true, latencyMs: 70 },
        { nodeId: 'node-c', ok: true, measured: true, latencyMs: 12 }
      ]
    };
  };

  const result = await rotateStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps: fixture.deps
  });

  assert.equal(result.ok, true);
  assert.equal(result.selectedNodeId, 'node-c');
  assert.deepEqual(events.find(([name]) => name === 'latency-measure')[1], [
    'node-b', 'node-c'
  ]);
  assert.deepEqual(fixture.getNodes().map((candidate) => candidate.latencyMs), [10, 70, 12]);
  assert.ok(
    events.findIndex(([name]) => name === 'latency-update')
      < events.findIndex(([name]) => name === 'lease-acquire')
  );
});

test('立即换节点所有替代项失败时恢复原 selector、租约与 ZCode PID', async (t) => {
  const { accountRef, aiHomeDir } = createAccount(t);
  writeAccountEgressBinding(fs, aiHomeDir, accountRef, {
    mode: EGRESS_MODE_GROUP,
    groupId: 'group-fast'
  });
  const events = [];
  const fixture = createRotationDependencies(accountRef, events, [
    { ok: false, reason: 'node-b-offline' },
    { ok: false, reason: 'node-c-offline' }
  ]);

  const result = await rotateStoredAccountEgress({
    fs,
    aiHomeDir,
    provider: 'zcode',
    accountRef,
    processObj: { platform: 'darwin' },
    deps: fixture.deps
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'zcode_egress_rotate_no_healthy_candidate');
  assert.equal(result.rolledBack, true);
  assert.equal(result.attemptedNodeCount, 2);
  assert.equal(result.selectedNodeId, 'node-a');
  assert.equal(fixture.getLease().nodeId, 'node-a');
  assert.equal(fixture.getLease().pid, 8123);
  assert.equal(fixture.getAccountState().selectedNodeId, 'node-a');
  assert.deepEqual(
    events.filter(([name]) => name === 'lease-acquire').map(([, value]) => [value.nodeId, value.pid]),
    [['node-b', 8123], ['node-c', 8123], ['node-a', 8123]]
  );
  assert.deepEqual(
    events.filter(([name]) => name === 'sidecar-ensure').map(([, value]) => value),
    ['node-b', 'node-c', 'node-a']
  );
  assert.equal(events.some(([name]) => name === 'sidecar-release'), false);
  assert.equal(fixture.getHealthTracks().at(-1).selectedNodeId, 'node-a');
});
