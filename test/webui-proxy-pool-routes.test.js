'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { errorStatus, handleWebUiProxyPoolRoutes } = require('../lib/server/webui-proxy-pool-routes');

function createMockReqRes(method, url, body = null) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};

  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = { ...this.headers, ...headers };
    },
    end(data) {
      this.body = data;
    }
  };

  process.nextTick(() => {
    if (body) {
      req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.emit('end');
  });

  return { req, res };
}

function readyCoreStatus(overrides = {}) {
  return {
    engine: 'mihomo',
    installed: true,
    running: true,
    dataPlaneReady: true,
    binaryName: 'mihomo',
    version: 'Mihomo Meta v1.19.0',
    mixedProxyUrl: 'http://127.0.0.1:10800',
    activeListeners: [],
    lastError: null,
    ...overrides
  };
}

test('handleWebUiProxyPoolRoutes responds to GET /v0/webui/toolkit/proxy-pool/nodes', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/nodes');
  const handled = await handleWebUiProxyPoolRoutes(req, res, 'GET', '/v0/webui/toolkit/proxy-pool/nodes', {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.nodes));
});

test('handleWebUiProxyPoolRoutes responds to GET /v0/webui/toolkit/proxy-pool/subscriptions', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/subscriptions');
  const handled = await handleWebUiProxyPoolRoutes(req, res, 'GET', '/v0/webui/toolkit/proxy-pool/subscriptions', {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.subscriptions));
});

test('proxy-pool subscription sync route forwards the explicit storage-only intent', async () => {
  const calls = [];
  const proxyPoolService = {
    async syncSubscription(id, options) {
      calls.push({ id, options });
      return { ok: true, applied: true, storageOnly: true };
    }
  };
  const pathname = '/v0/webui/toolkit/proxy-pool/subscriptions/sync';
  const { req, res } = createMockReqRes('POST', pathname, {
    id: 'sub_account_egress',
    storageOnly: true
  });

  const handled = await handleWebUiProxyPoolRoutes(
    req,
    res,
    'POST',
    pathname,
    { proxyPoolService }
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [{
    id: 'sub_account_egress',
    options: { storageOnly: true }
  }]);
});

test('handleWebUiProxyPoolRoutes responds to GET /v0/webui/toolkit/proxy-pool/routing', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/routing');
  const handled = await handleWebUiProxyPoolRoutes(req, res, 'GET', '/v0/webui/toolkit/proxy-pool/routing', {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(data.routing);
});

test('handleWebUiProxyPoolRoutes responds to GET /v0/webui/toolkit/proxy-pool/dedicated-ports', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/dedicated-ports');
  const handled = await handleWebUiProxyPoolRoutes(req, res, 'GET', '/v0/webui/toolkit/proxy-pool/dedicated-ports', {});
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.ok(data.config);
});

test('GET proxy-pool core wraps the runtime status in the public API response shape', async () => {
  let statusCalls = 0;
  const core = readyCoreStatus();
  const proxyPoolService = {
    getCoreStatus() {
      statusCalls += 1;
      return core;
    }
  };
  const pathname = '/v0/webui/toolkit/proxy-pool/core';
  const { req, res } = createMockReqRes('GET', pathname);

  const handled = await handleWebUiProxyPoolRoutes(
    req,
    res,
    'GET',
    pathname,
    { proxyPoolService }
  );

  assert.equal(handled, true);
  assert.equal(statusCalls, 1);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, core });
});

test('proxy-pool core action routes delegate start, stop, and reload to the injected service', async (t) => {
  for (const action of ['start', 'stop', 'reload']) {
    await t.test(action, async () => {
      const calls = [];
      const core = readyCoreStatus({
        running: action !== 'stop',
        dataPlaneReady: action !== 'stop',
        mixedProxyUrl: action === 'stop' ? null : 'http://127.0.0.1:10800'
      });
      const result = {
        ok: true,
        action,
        applied: true,
        core,
        warnings: []
      };
      const proxyPoolService = {
        async startCore() {
          calls.push('start');
          return result;
        },
        async stopCore() {
          calls.push('stop');
          return result;
        },
        async reloadCore() {
          calls.push('reload');
          return result;
        }
      };
      const pathname = `/v0/webui/toolkit/proxy-pool/core/${action}`;
      const { req, res } = createMockReqRes('POST', pathname, {});

      const handled = await handleWebUiProxyPoolRoutes(
        req,
        res,
        'POST',
        pathname,
        { proxyPoolService }
      );

      assert.equal(handled, true);
      assert.deepEqual(calls, [action]);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.body), result);
    });
  }
});

test('proxy-pool core route maps an unavailable data plane to 503', async () => {
  const pathname = '/v0/webui/toolkit/proxy-pool/core/start';
  const { req, res } = createMockReqRes('POST', pathname, {});
  const proxyPoolService = {
    async startCore() {
      return {
        ok: false,
        action: 'start',
        applied: false,
        error: 'proxy_core_unavailable',
        core: readyCoreStatus({
          installed: false,
          running: false,
          dataPlaneReady: false,
          binaryName: null,
          version: null,
          mixedProxyUrl: null
        }),
        warnings: []
      };
    }
  };

  const handled = await handleWebUiProxyPoolRoutes(req, res, 'POST', pathname, { proxyPoolService });

  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, 'proxy_core_unavailable');
});

test('proxy-pool node route maps validation errors to 422', async () => {
  const pathname = '/v0/webui/toolkit/proxy-pool/nodes';
  const { req, res } = createMockReqRes('POST', pathname, { server: '', port: 70000 });
  const proxyPoolService = {
    upsertNode() {
      const error = new Error('invalid_proxy_port');
      error.code = 'invalid_proxy_port';
      throw error;
    }
  };

  await handleWebUiProxyPoolRoutes(req, res, 'POST', pathname, { proxyPoolService });

  assert.equal(res.statusCode, 422);
  assert.equal(JSON.parse(res.body).error, 'invalid_proxy_port');
});

test('proxy-pool route maps stale sync conflicts separately from rollback failures', () => {
  assert.equal(errorStatus('subscription_changed_during_sync'), 409);
  assert.equal(errorStatus('subscription_rollback_failed'), 500);
  assert.equal(errorStatus('node_rollback_failed'), 500);
});

test('proxy-pool network routes expose effective TUN/system-proxy state and require confirmation for apply', async () => {
  const plan = {
    planId: 'network-plan-1',
    kind: 'system-proxy',
    action: 'enable',
    snapshotHash: 'a'.repeat(64),
    operations: [],
    rollbackOperations: []
  };
  const calls = [];
  const proxyPoolService = {
    getNetworkStatus() {
      return { ok: true, effectiveRoute: 'tun', takeoverAllowed: false, conflicts: ['external_tun_active:clash-verge'] };
    },
    planNetworkIntegration(input) {
      calls.push(['plan', input.action]);
      return { ok: true, plan, network: this.getNetworkStatus() };
    },
    async applyNetworkIntegration(input, options) {
      calls.push(['apply', input.planId, options.confirmed]);
      return { ok: true, applied: true };
    }
  };

  const statusPath = '/v0/webui/toolkit/proxy-pool/network/status';
  const statusMock = createMockReqRes('GET', statusPath);
  await handleWebUiProxyPoolRoutes(statusMock.req, statusMock.res, 'GET', statusPath, { proxyPoolService });
  assert.deepEqual(JSON.parse(statusMock.res.body), proxyPoolService.getNetworkStatus());

  const planPath = '/v0/webui/toolkit/proxy-pool/network/plan';
  const planMock = createMockReqRes('POST', planPath, { action: 'enable', service: 'Wi-Fi' });
  await handleWebUiProxyPoolRoutes(planMock.req, planMock.res, 'POST', planPath, { proxyPoolService });
  assert.equal(planMock.res.statusCode, 200);
  assert.equal(JSON.parse(planMock.res.body).plan.planId, plan.planId);

  const applyPath = '/v0/webui/toolkit/proxy-pool/network/apply';
  const applyMock = createMockReqRes('POST', applyPath, { planId: plan.planId, confirmed: true });
  await handleWebUiProxyPoolRoutes(applyMock.req, applyMock.res, 'POST', applyPath, { proxyPoolService });
  assert.equal(applyMock.res.statusCode, 200);
  assert.deepEqual(calls, [['plan', 'enable'], ['apply', 'network-plan-1', true]]);
});

test('proxy-pool network apply rejects a client-supplied command plan', async () => {
  let applyCalls = 0;
  const proxyPoolService = {
    async applyNetworkIntegration() {
      applyCalls += 1;
      return { ok: true, applied: true };
    }
  };
  const pathname = '/v0/webui/toolkit/proxy-pool/network/apply';
  const { req, res } = createMockReqRes('POST', pathname, {
    confirmed: true,
    plan: {
      planId: 'attacker-plan',
      kind: 'system-proxy',
      snapshotHash: 'b'.repeat(64),
      operations: [{ command: 'sh', args: ['-c', 'touch /tmp/should-not-run'] }],
      rollbackOperations: []
    }
  });

  await handleWebUiProxyPoolRoutes(req, res, 'POST', pathname, { proxyPoolService });

  assert.equal(res.statusCode, 422);
  assert.equal(JSON.parse(res.body).error, 'network_plan_invalid');
  assert.equal(applyCalls, 0);
});

test('proxy-pool network plan does not trust client-supplied snapshots', async () => {
  let plannedInput;
  const proxyPoolService = {
    planNetworkIntegration(input) {
      plannedInput = input;
      return {
        ok: true,
        plan: {
          planId: 'server-plan-1',
          snapshotHash: 'c'.repeat(64),
          operations: [],
          rollbackOperations: []
        },
        network: { tun: { state: 'inactive', owner: null } }
      };
    }
  };
  const pathname = '/v0/webui/toolkit/proxy-pool/network/plan';
  const { req, res } = createMockReqRes('POST', pathname, {
    kind: 'system-proxy',
    action: 'enable',
    service: 'Wi-Fi',
    proxyUrl: 'http://127.0.0.1:10800',
    current: { web: { enabled: true, server: 'attacker', port: 1 } },
    network: { tun: { state: 'inactive', owner: null } },
    tun: { enabled: true, stack: 'gvisor' }
  });

  await handleWebUiProxyPoolRoutes(req, res, 'POST', pathname, { proxyPoolService });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(plannedInput, {
    action: 'enable',
    service: 'Wi-Fi',
    proxyUrl: 'http://127.0.0.1:10800'
  });
});

test('proxy-pool core install routes keep the official digest plan and require explicit confirmation', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-route-core-install-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const archive = zlib.gzipSync(Buffer.from('#!/bin/sh\necho mihomo-test\n'));
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  const metadata = JSON.stringify({
    tag_name: 'v1.19.29',
    draft: false,
    prerelease: false,
    assets: [{
      name: 'mihomo-darwin-arm64-v1.19.29.gz',
      browser_download_url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.29/mihomo-darwin-arm64-v1.19.29.gz',
      digest: `sha256:${digest}`,
      size: archive.length
    }]
  });
  const proxyPoolService = {
    getCoreStatus() { return { installed: false, running: false }; },
    coreRuntime: { refreshBinary() {} }
  };
  const requestImpl = async (url) => {
    if (url.includes('/releases/latest')) return {
      statusCode: 200,
      body: { async text() { return metadata; } }
    };
    return {
      statusCode: 200,
      body: { async arrayBuffer() { return archive; } }
    };
  };
  const context = { proxyPoolService, aiHomeDir, requestImpl };
  const planPath = '/v0/webui/toolkit/proxy-pool/core/install/plan';
  const planMock = createMockReqRes('POST', planPath, { platform: 'darwin', arch: 'arm64' });
  await handleWebUiProxyPoolRoutes(planMock.req, planMock.res, 'POST', planPath, context);
  assert.equal(planMock.res.statusCode, 200);
  const planPayload = JSON.parse(planMock.res.body);
  assert.equal(planPayload.ok, true);
  assert.equal(planPayload.plan.digest, digest);

  const executePath = '/v0/webui/toolkit/proxy-pool/core/install/execute';
  const declined = createMockReqRes('POST', executePath, { planId: planPayload.plan.planId, confirmed: false });
  await handleWebUiProxyPoolRoutes(declined.req, declined.res, 'POST', executePath, context);
  assert.equal(declined.res.statusCode, 428);
  assert.equal(JSON.parse(declined.res.body).error, 'confirmation_required');

  const execute = createMockReqRes('POST', executePath, { planId: planPayload.plan.planId, confirmed: true });
  await handleWebUiProxyPoolRoutes(execute.req, execute.res, 'POST', executePath, context);
  assert.equal(execute.res.statusCode, 200);
  assert.equal(JSON.parse(execute.res.body).ok, true);
});
