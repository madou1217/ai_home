'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const runtimePath = path.resolve(__dirname, '../lib/server/zcode-sing-box-runtime.js');

function loadRuntime() {
  assert.equal(fs.existsSync(runtimePath), true, '缺少独立的 ZCode sing-box runtime');
  return require(runtimePath);
}

function vlessNode(id, server = `${id}.example`) {
  return {
    id,
    protocol: 'vless',
    server,
    port: 443,
    uuid: `00000000-0000-4000-8000-${id.padEnd(12, '0').slice(0, 12)}`,
    network: 'tcp',
    security: 'reality',
    sni: 'www.example.com',
    publicKey: `public-${id}`,
    shortId: '0123456789abcdef',
    fingerprint: 'chrome'
  };
}

function groupTarget(selectedNode, candidateNodes) {
  return {
    ok: true,
    source: 'group',
    target: { kind: 'node', node: selectedNode },
    candidateNodes,
    selectedNodeId: selectedNode.id,
    groupId: 'group-fast'
  };
}

function createHarness(t, options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-sing-box-runtime-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const events = {
    spawned: [],
    stopped: [],
    selected: [],
    closed: [],
    delayed: [],
    validated: []
  };
  let nextPid = 5000;
  const { ZcodeSingBoxRuntime } = loadRuntime();
  const runtime = new ZcodeSingBoxRuntime({
    aiHomeDir,
    platform: 'darwin',
    basePort: 23100,
    maxPorts: 32,
    requestedControllerPort: 23190,
    discoverBinary: options.discoverBinary || (() => ({
      path: '/opt/homebrew/bin/sing-box',
      version: '1.13.19'
    })),
    isPortAvailable: options.isPortAvailable || (async () => true),
    validateConfig: async (input) => {
      events.validated.push(input);
      return { ok: true };
    },
    spawnSidecar: async (input) => {
      const child = { pid: nextPid++, running: true };
      events.spawned.push({ ...input, child });
      return child;
    },
    stopSidecar: async (child) => {
      if (child) child.running = false;
      events.stopped.push(child?.pid || null);
      return true;
    },
    isChildRunning: (child) => Boolean(child?.running),
    readinessProbe: typeof options.readinessProbe === 'function'
      ? options.readinessProbe
      : async () => true,
    selectOutbound: async (input) => {
      events.selected.push(input);
      return typeof options.selectOutbound === 'function'
        ? options.selectOutbound(input)
        : { ok: true };
    },
    closeAccountConnections: async (input) => {
      events.closed.push(input);
      return typeof options.closeAccountConnections === 'function'
        ? options.closeAccountConnections(input)
        : { ok: true, closedConnections: 0 };
    },
    probeOutboundDelays: async (input) => {
      events.delayed.push(input);
      return typeof options.probeOutboundDelays === 'function'
        ? options.probeOutboundDelays(input)
        : { ok: true, results: [], measuredCount: 0, healthyCount: 0, failedCount: 0 };
    },
    resolveUnderlay: options.resolveUnderlay || (() => ({
      ok: true,
      platform: 'macos',
      interfaceName: 'en1',
      dnsServer: '114.114.114.114'
    }))
  });
  return { aiHomeDir, events, runtime };
}

test('ZCode runtime 明确使用 sing-box，缺失时不回退到其它代理核心', async (t) => {
  const { ZcodeSingBoxRuntime } = loadRuntime();
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-sing-box-missing-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  let spawned = false;
  const runtime = new ZcodeSingBoxRuntime({
    aiHomeDir,
    platform: 'darwin',
    discoverBinary: () => null,
    spawnSidecar: async () => {
      spawned = true;
      return null;
    }
  });

  const result = await runtime.ensureAccountEndpoint({
    accountRef: 'acct_11111111111111111111',
    resolvedTarget: {
      ok: true,
      source: 'url',
      target: { kind: 'proxy-url', proxyUrl: 'http://proxy.example:8080' }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'sing_box_unavailable');
  assert.equal(spawned, false);
  const source = fs.readFileSync(runtimePath, 'utf8');
  assert.doesNotMatch(source, /mihomo|clash-meta|ProxyPoolService/i);
});

test('sing-box 优先从 AIH 私有目录发现，无需修改全局 PATH', (t) => {
  const { discoverSingBoxBinary } = loadRuntime();
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-sing-box-private-bin-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const binaryPath = path.join(aiHomeDir, 'bin', 'sing-box');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  assert.deepEqual(discoverSingBoxBinary({
    aiHomeDir,
    env: { PATH: '' },
    fs,
    path
  }), {
    path: binaryPath,
    source: 'aih-home'
  });
});

test('远端节点 underlay 探测失败时保留旧数据面并返回明确错误', async (t) => {
  let resolveCount = 0;
  const { events, runtime } = createHarness(t, {
    resolveUnderlay() {
      resolveCount += 1;
      return { ok: false, error: 'zcode_underlay_dns_unavailable', interfaceName: 'en1' };
    }
  });

  const result = await runtime.ensureAccountEndpoint({
    accountRef: 'acct_11111111111111111111',
    resolvedTarget: groupTarget(vlessNode('a'), [vlessNode('a')])
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'zcode_underlay_dns_unavailable');
  assert.equal(resolveCount, 1);
  assert.equal(events.spawned.length, 0);
  assert.equal(runtime.getStatus().running, false);
});

test('direct target 不探测或绑定物理 underlay', async (t) => {
  let resolveCount = 0;
  const { events, runtime } = createHarness(t, {
    resolveUnderlay() {
      resolveCount += 1;
      return { ok: false, error: 'must_not_be_called' };
    }
  });

  const result = await runtime.ensureAccountEndpoint({
    accountRef: 'acct_11111111111111111111',
    resolvedTarget: {
      ok: true,
      source: 'tun',
      target: { kind: 'direct' }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(resolveCount, 0);
  assert.equal(events.spawned.length, 1);
  assert.equal(events.validated[0].compiled.config.dns, undefined);
});

test('同账号端口跨节点切换保持稳定，候选已在配置中时只调用 selector API', async (t) => {
  const { events, runtime } = createHarness(t);
  const accountRef = 'acct_11111111111111111111';
  const nodeA = vlessNode('a');
  const nodeB = vlessNode('b');

  const first = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeA, [nodeA, nodeB])
  });
  const second = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeB, [nodeA, nodeB])
  });

  assert.equal(first.ok, true);
  assert.equal(first.action, 'started');
  assert.equal(second.ok, true);
  assert.equal(second.action, 'selected');
  assert.equal(second.proxyServer, first.proxyServer);
  assert.equal(events.spawned.length, 1);
  assert.equal(events.stopped.length, 0);
  assert.equal(events.selected.length, 1);
  assert.equal(events.selected[0].accountRef, accountRef);
  assert.notEqual(events.selected[0].selectorTag, events.selected[0].outboundTag);
  assert.equal(events.closed.length, 1);
  assert.equal(events.closed[0].accountRef, accountRef);
  assert.match(events.closed[0].inboundTag, /^aih-zcode-in-/);
});

test('候选节点测速读取 controller outbound，不切 selector 或关闭现有连接', async (t) => {
  const accountRef = 'acct_11111111111111111111';
  const nodeA = vlessNode('a');
  const nodeB = vlessNode('b');
  const { events, runtime } = createHarness(t, {
    probeOutboundDelays: async (input) => ({
      ok: true,
      results: input.candidates.map((candidate, index) => ({
        nodeId: candidate.nodeId,
        ok: true,
        measured: true,
        latencyMs: index === 0 ? 80 : 20
      })),
      measuredCount: input.candidates.length,
      healthyCount: input.candidates.length,
      failedCount: 0
    })
  });
  await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeA, [nodeA, nodeB])
  });

  const measured = await runtime.measureAccountCandidateLatencies({
    accountRef,
    nodeIds: ['a', 'b']
  });

  assert.equal(measured.ok, true);
  assert.deepEqual(measured.results.map((item) => [item.nodeId, item.latencyMs]), [
    ['a', 80],
    ['b', 20]
  ]);
  assert.equal(events.delayed.length, 1);
  assert.deepEqual(events.delayed[0].candidates.map((item) => item.nodeId), ['a', 'b']);
  assert.ok(events.delayed[0].candidates.every((item) => /^aih-zcode-target-/.test(item.outboundTag)));
  assert.equal(events.selected.length, 0);
  assert.equal(events.closed.length, 0);
});

test('连接清理只关闭目标账号 mixed inbound，不中断其它账号', async () => {
  const { closeSingBoxInboundConnections } = loadRuntime();
  assert.equal(typeof closeSingBoxInboundConnections, 'function');
  const calls = [];
  const response = (statusCode, body = '') => ({
    statusCode,
    body: { text: async () => body }
  });
  const result = await closeSingBoxInboundConnections({
    controllerPort: 23190,
    controllerSecret: 'secret',
    inboundTag: 'aih-zcode-in-target',
    requestImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') {
        return response(200, JSON.stringify({
          connections: [
            { id: '11111111-1111-4111-8111-111111111111', metadata: { type: 'mixed/aih-zcode-in-target' } },
            { id: '22222222-2222-4222-8222-222222222222', metadata: { type: 'mixed/aih-zcode-in-other' } }
          ]
        }));
      }
      return response(204);
    }
  });

  assert.deepEqual(result, { ok: true, closedConnections: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[1].options.method, 'DELETE');
  assert.match(calls[1].url, /11111111-1111-4111-8111-111111111111$/);
  assert.equal(calls.some((call) => call.url.includes('22222222-2222-4222-8222-222222222222')), false);
});

test('selector 切换后连接清理失败时回滚旧节点，持久化状态不漂移', async (t) => {
  const { events, runtime } = createHarness(t, {
    closeAccountConnections: async () => ({
      ok: false,
      error: 'sing_box_connection_close_failed',
      reason: 'controller_delete_failed'
    })
  });
  const accountRef = 'acct_11111111111111111111';
  const nodeA = vlessNode('a');
  const nodeB = vlessNode('b');
  const first = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeA, [nodeA, nodeB])
  });

  const switched = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeB, [nodeA, nodeB])
  });

  assert.equal(first.ok, true);
  assert.equal(switched.ok, false);
  assert.equal(switched.error, 'sing_box_connection_close_failed');
  assert.equal(events.selected.length, 2);
  assert.notEqual(events.selected[0].outboundTag, events.selected[1].outboundTag);
  assert.equal(
    events.selected[1].outboundTag,
    runtime.currentCompiled.accounts[accountRef].selectedOutboundTag
  );
  assert.equal(runtime.readState().accounts[accountRef].selectedNodeId, 'a');
  assert.equal(runtime.getStatus().dataPlaneReady, true);
});

test('连接清理失败且 selector 无法回滚时停止数据面并保留旧状态', async (t) => {
  let selectionCount = 0;
  const { events, runtime } = createHarness(t, {
    selectOutbound: async () => {
      selectionCount += 1;
      return selectionCount === 1
        ? { ok: true }
        : { ok: false, error: 'sing_box_selector_failed', reason: 'rollback_rejected' };
    },
    closeAccountConnections: async () => ({
      ok: false,
      error: 'sing_box_connection_close_failed'
    })
  });
  const accountRef = 'acct_11111111111111111111';
  const nodeA = vlessNode('a');
  const nodeB = vlessNode('b');
  await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeA, [nodeA, nodeB])
  });

  const switched = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeB, [nodeA, nodeB])
  });
  const status = runtime.getStatus();

  assert.equal(switched.ok, false);
  assert.equal(switched.error, 'sing_box_selector_rollback_failed');
  assert.equal(switched.connectionError, 'sing_box_connection_close_failed');
  assert.deepEqual(events.stopped, [5000]);
  assert.equal(runtime.readState().accounts[accountRef].selectedNodeId, 'a');
  assert.equal(status.running, false);
  assert.equal(status.dataPlaneReady, false);
  assert.equal(status.lastError, 'sing_box_selector_rollback_failed');
});

test('新增候选使配置形状变化时只重启 sidecar，ZCode 固定 endpoint 不变', async (t) => {
  const { events, runtime } = createHarness(t);
  const accountRef = 'acct_11111111111111111111';
  const nodeA = vlessNode('a');
  const nodeB = vlessNode('b');

  const first = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeA, [nodeA])
  });
  const second = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeB, [nodeA, nodeB])
  });

  assert.equal(first.action, 'started');
  assert.equal(second.action, 'restarted');
  assert.equal(second.proxyServer, first.proxyServer);
  assert.equal(events.spawned.length, 2);
  assert.deepEqual(events.stopped, [5000]);
  assert.equal(events.selected.length, 0);
});

test('新配置启动失败且旧数据面也无法恢复时显式报告回滚失败', async (t) => {
  let readinessCount = 0;
  const { events, runtime } = createHarness(t, {
    readinessProbe: async () => {
      readinessCount += 1;
      return readinessCount === 1;
    }
  });
  const accountRef = 'acct_11111111111111111111';
  const nodeA = vlessNode('a');
  const nodeB = vlessNode('b');
  const first = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeA, [nodeA])
  });

  const restarted = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(nodeB, [nodeA, nodeB])
  });
  const status = runtime.getStatus();

  assert.equal(first.ok, true);
  assert.equal(restarted.ok, false);
  assert.equal(restarted.error, 'sing_box_restart_rollback_failed');
  assert.equal(restarted.applyError, 'sing_box_readiness_failed');
  assert.equal(restarted.reason, 'sing_box_readiness_failed');
  assert.deepEqual(events.stopped, [5000, 5001, 5002]);
  assert.equal(runtime.readState().accounts[accountRef].selectedNodeId, 'a');
  assert.equal(status.running, false);
  assert.equal(status.dataPlaneReady, false);
  assert.equal(status.lastError, 'sing_box_restart_rollback_failed');
});

test('readiness 探针抛错时停止刚启动的 sidecar，不遗留未托管数据面', async (t) => {
  const { events, runtime } = createHarness(t, {
    readinessProbe: async () => {
      throw new Error('readiness probe crashed');
    }
  });
  const node = vlessNode('a');

  const result = await runtime.ensureAccountEndpoint({
    accountRef: 'acct_11111111111111111111',
    resolvedTarget: groupTarget(node, [node])
  });
  const status = runtime.getStatus();

  assert.equal(result.ok, false);
  assert.equal(result.error, 'sing_box_readiness_failed');
  assert.equal(result.reason, 'readiness probe crashed');
  assert.deepEqual(events.stopped, [5000]);
  assert.equal(status.running, false);
  assert.equal(status.dataPlaneReady, false);
});

test('已持久化账号端口被外部进程占用时 fail-closed，不静默换端口', async (t) => {
  const firstHarness = createHarness(t);
  const accountRef = 'acct_11111111111111111111';
  const node = vlessNode('a');
  const first = await firstHarness.runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(node, [node])
  });
  assert.equal(first.ok, true);
  await firstHarness.runtime.stop();

  const { ZcodeSingBoxRuntime } = loadRuntime();
  const runtime = new ZcodeSingBoxRuntime({
    aiHomeDir: firstHarness.aiHomeDir,
    platform: 'darwin',
    discoverBinary: () => ({ path: '/opt/homebrew/bin/sing-box', version: '1.13.19' }),
    isPortAvailable: async (port) => port !== first.port,
    validateConfig: async () => ({ ok: true }),
    spawnSidecar: async () => ({ pid: 6000, running: true }),
    isChildRunning: (child) => Boolean(child?.running),
    readinessProbe: async () => true
  });

  const conflicted = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(node, [node])
  });

  assert.equal(conflicted.ok, false);
  assert.equal(conflicted.error, 'zcode_sidecar_port_conflict');
  assert.equal(conflicted.port, first.port);
});

test('配置、日志、状态和端口映射文件均为私有权限', async (t) => {
  const { runtime } = createHarness(t);
  const node = vlessNode('a');
  const result = await runtime.ensureAccountEndpoint({
    accountRef: 'acct_11111111111111111111',
    resolvedTarget: groupTarget(node, [node])
  });
  assert.equal(result.ok, true);

  const paths = runtime.getPaths();
  assert.equal(fs.statSync(paths.runtimeDir).mode & 0o777, 0o700);
  for (const filePath of [paths.configPath, paths.logPath, paths.statusPath, paths.statePath]) {
    assert.equal(fs.existsSync(filePath), true, filePath);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, filePath);
  }
});

test('释放最后一个账号时停止 sidecar，但保留该账号稳定端口映射', async (t) => {
  const { events, runtime } = createHarness(t);
  const accountRef = 'acct_11111111111111111111';
  const node = vlessNode('a');
  const first = await runtime.ensureAccountEndpoint({
    accountRef,
    resolvedTarget: groupTarget(node, [node])
  });

  const released = await runtime.releaseAccount(accountRef);
  const status = runtime.getStatus();

  assert.equal(released.ok, true);
  assert.equal(released.action, 'stopped');
  assert.deepEqual(events.stopped, [5000]);
  assert.equal(status.running, false);
  assert.equal(status.accounts.length, 0);
  assert.equal(runtime.readState().portAssignments[accountRef], first.port);
});
