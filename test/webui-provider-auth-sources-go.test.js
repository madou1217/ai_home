'use strict';

// 回归守卫（2026-11-12）：/v0/webui/accounts/provider-auth-sources 的数据面切到 Go。
//
// 这个端点决定界面要不要显示「从本机导入」「装上客户端就能导入」「安装客户端」三个入口。
// 切流必须守住两条边界：
//   1. Go 形状完整时原样转发（Node 不再自己算一遍，避免两份结论打架）；
//   2. Go 不可用、报错或形状不完整（旧版 Go 没有 installable / alreadyImported）时**回落 Node**，
//      绝不让安装入口因为一次管理面故障消失。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleProviderAuthSourcesRequest } = require('../lib/server/webui-account-routes');
const { getPluginSystem } = require('../lib/plugins/control/plugin-system');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-auth-sources-'));
}

function createCtx({ provider = 'claude', goCoreSync, state, aiHomeDir = tempDir() } = {}) {
  const writes = [];
  const url = new URL('http://127.0.0.1/v0/webui/accounts/provider-auth-sources');
  if (provider !== null) url.searchParams.set('provider', provider);
  return {
    aiHomeDir,
    fs,
    state: state || {},
    deps: goCoreSync === undefined ? {} : { goCoreSync, hostHomeDir: aiHomeDir },
    writes,
    url,
    res: {},
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
}

// goSource 是 Go 形状的单条来源（含 installable / alreadyImported）。
function goSource(overrides = {}) {
  return {
    id: 'claude-host-local',
    kind: 'local',
    clientDependent: true,
    requiresApp: 'cli',
    authMode: 'oauth-browser',
    handler: '',
    pluginLogin: false,
    directImport: true,
    description: '读取本机 claude 客户端的登录态并直接入库',
    available: false,
    installable: true,
    alreadyImported: false,
    reason: 'client_not_installed',
    implementation: null,
    ...overrides
  };
}

function goPayload(overrides = {}) {
  return {
    ok: true,
    supported: true,
    provider: 'claude',
    methods: [{
      authMode: 'oauth-browser',
      sources: [goSource()],
      preferredSourceId: '',
      installableSourceId: 'claude-host-local',
      localSourceAvailable: false
    }],
    derivedBy: 'go_partial',
    unfilledFields: ['pluginSources'],
    ...overrides
  };
}

test('Go 形状完整时原样转发，不再自己算一遍', async () => {
  const payload = goPayload();
  const calls = [];
  const ctx = createCtx({
    goCoreSync: {
      getProviderAuthSources: async (provider) => {
        calls.push(provider);
        return { ok: true, status: 200, data: payload };
      }
    }
  });
  await handleProviderAuthSourcesRequest(ctx);
  assert.deepEqual(calls, ['claude']);
  assert.equal(ctx.writes.length, 1);
  assert.equal(ctx.writes[0].status, 200);
  // 深度相等即证明 Node 没有叠加自己的 methods/pluginWarnings。
  assert.deepEqual(ctx.writes[0].payload, payload);
});

test('Go 不可用（未接线）时回落 Node 实现', async () => {
  const ctx = createCtx();
  await handleProviderAuthSourcesRequest(ctx);
  assert.equal(ctx.writes.length, 1);
  const { status, payload } = ctx.writes[0];
  assert.equal(status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.provider, 'claude');
  // Node 实现同样给出这三块键；缺了界面就渲染不出安装提示。
  const method = payload.methods[0];
  assert.equal(typeof method.authMode, 'string');
  assert.ok(Object.prototype.hasOwnProperty.call(method, 'installableSourceId'));
  assert.ok(Object.prototype.hasOwnProperty.call(method.sources[0], 'installable'));
  assert.ok(Object.prototype.hasOwnProperty.call(method.sources[0], 'alreadyImported'));
});

test('Go 调用抛错时回落 Node 实现', async () => {
  const ctx = createCtx({
    goCoreSync: {
      getProviderAuthSources: async () => { throw new Error('go core down'); }
    }
  });
  await handleProviderAuthSourcesRequest(ctx);
  assert.equal(ctx.writes[0].status, 200);
  assert.equal(ctx.writes[0].payload.ok, true);
  assert.equal(ctx.writes[0].payload.provider, 'claude');
});

test('Go 返回旧形状（缺 installable/alreadyImported）时回落 Node 实现', async () => {
  // 二进制版本错配的真实形态：Go Core 还没升级，sources 里没有这两个键。
  const legacy = goPayload();
  delete legacy.methods[0].sources[0].installable;
  delete legacy.methods[0].sources[0].alreadyImported;
  const ctx = createCtx({
    goCoreSync: { getProviderAuthSources: async () => ({ ok: true, status: 200, data: legacy }) }
  });
  await handleProviderAuthSourcesRequest(ctx);
  const payload = ctx.writes[0].payload;
  assert.equal(payload.ok, true);
  assert.notEqual(payload.derivedBy, 'go_partial', '旧形状不能被当成 Go 的成功响应转发');
  assert.ok(Object.prototype.hasOwnProperty.call(payload.methods[0].sources[0], 'installable'));
});

test('Go 返回的 provider 与请求不一致时回落 Node 实现', async () => {
  const mismatched = goPayload({ provider: 'codex' });
  const ctx = createCtx({
    goCoreSync: { getProviderAuthSources: async () => ({ ok: true, status: 200, data: mismatched }) }
  });
  await handleProviderAuthSourcesRequest(ctx);
  assert.equal(ctx.writes[0].payload.provider, 'claude');
});

test('插件系统在场但没有插件来源时仍走 Go', async () => {
  const state = {};
  getPluginSystem(state, { aiHomeDir: tempDir(), pluginDescriptorSync: false });
  const calls = [];
  const payload = goPayload();
  const ctx = createCtx({
    state,
    goCoreSync: {
      getProviderAuthSources: async (provider) => {
        calls.push(provider);
        return { ok: true, status: 200, data: payload };
      }
    }
  });
  await handleProviderAuthSourcesRequest(ctx);
  assert.deepEqual(calls, ['claude'], '没有插件来源时不该绕过 Go');
  assert.deepEqual(ctx.writes[0].payload, payload);
});

test('缺少 provider 参数时仍然是 400，不调 Go', async () => {
  const calls = [];
  const ctx = createCtx({
    provider: null,
    goCoreSync: {
      getProviderAuthSources: async () => {
        calls.push('called');
        return { ok: true, status: 200, data: goPayload() };
      }
    }
  });
  await handleProviderAuthSourcesRequest(ctx);
  assert.deepEqual(calls, []);
  assert.equal(ctx.writes[0].status, 400);
  assert.equal(ctx.writes[0].payload.error, 'missing_provider');
});
