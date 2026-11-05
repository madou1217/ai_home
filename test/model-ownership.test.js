'use strict';

// 模型目录归属的双向守卫：GO_MODEL_OWNERS ↔ 各 Provider 描述符 ↔ 发现策略链。
//
// 迁移期最容易出的错不是「忘了改描述符」，而是「改了描述符但仍然探测上游」：
// 策略链里残留一条 http/cli 策略，Node 就会继续出网，Go 与 Node 两份目录各自漂移。
// 这个用例锁三件事：
//   1) 表里登记的 Provider，descriptor 的 models 必须逐字段由 goOwnedModels() 派生；
//   2) 任何声明了 `go-account-models` 的 descriptor 都必须在表里登记，且不能再带
//      其它 handler（禁止「读 Go + 顺手探一下上游」）；
//   3) 行为层面：fetchModelsForAccount 对 Go 接管的 Provider 只读 Go，不出网；
//      Go 读不到时抛出可识别的错误，绝不回落到通用探测。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GO_MODEL_OWNERS, goOwnedModels, isGoOwnedModels } = require('../lib/providers/model-ownership');
const { fetchModelsForAccount } = require('../lib/server/http-utils');
const { HANDLERS } = require('../lib/server/model-discovery/http-handlers');

const DEFS_DIR = path.join(__dirname, '..', 'lib', 'providers', 'defs');
const GO_HANDLER = 'go-account-models';

function loadDescriptors() {
  const descriptors = new Map();
  for (const name of fs.readdirSync(DEFS_DIR)) {
    if (!name.endsWith('.js')) continue;
    const descriptor = require(path.join(DEFS_DIR, name));
    if (!descriptor || typeof descriptor !== 'object' || !descriptor.id) continue;
    descriptors.set(descriptor.id, descriptor);
  }
  return descriptors;
}

function listModelStrategies(descriptor) {
  const models = descriptor && descriptor.capabilities && descriptor.capabilities.models;
  if (!models || models.supported !== true) return [];
  return Array.isArray(models.strategies) ? models.strategies : [];
}

test('Go 接管的 Provider：descriptor 的 models 必须由 goOwnedModels() 派生', () => {
  const descriptors = loadDescriptors();
  for (const providerID of Object.keys(GO_MODEL_OWNERS)) {
    const descriptor = descriptors.get(providerID);
    assert.ok(descriptor, '缺少 descriptor: ' + providerID);
    const models = descriptor.capabilities.models;
    assert.deepEqual(
      JSON.parse(JSON.stringify(models)),
      JSON.parse(JSON.stringify(goOwnedModels(providerID))),
      providerID + ' 的 models 必须由 goOwnedModels() 派生，不能手写策略'
    );
  }
});

test('Go 接管的 Provider 不能保留任何出网/CLI 探测策略', () => {
  for (const providerID of Object.keys(GO_MODEL_OWNERS)) {
    const strategies = listModelStrategies(require(path.join(DEFS_DIR, providerID + '.js')));
    assert.deepEqual(strategies.map((s) => s.handler), [GO_HANDLER], providerID + ' 只能有 go-account-models 一条策略');
    for (const strategy of strategies) {
      assert.equal(strategy.transport, 'local', providerID + ' 的策略必须是 local（Go 是本机服务，不走出网解析）');
      assert.equal(strategy.clientDependent, false, providerID + ' 不应声明依赖本机客户端');
    }
  }
});

test('反向守卫：声明 go-account-models 的 descriptor 必须登记在表里', () => {
  const descriptors = loadDescriptors();
  for (const [providerID, descriptor] of descriptors) {
    const strategies = listModelStrategies(descriptor);
    if (!strategies.some((strategy) => strategy.handler === GO_HANDLER)) continue;
    assert.ok(
      isGoOwnedModels(providerID),
      providerID + ' 声称读 Go，但不在 GO_MODEL_OWNERS 里——请登记归属，不要手写策略'
    );
    assert.deepEqual(strategies.map((s) => s.handler), [GO_HANDLER], providerID + ' 不能同时保留上游探测策略');
  }
});

test('上游探测 handler 已删除（opencode / cline 不再由 Node 探测）', () => {
  assert.equal(HANDLERS['opencode-models'], undefined, 'opencode-models handler 必须删除');
  assert.equal(HANDLERS['cline-static-catalog'], undefined, 'cline-static-catalog handler 必须删除');
  assert.equal(typeof HANDLERS[GO_HANDLER], 'function', 'go-account-models handler 必须已注册');
});

test('goOwnedModels 对未登记 Provider 直接抛错', () => {
  assert.throws(() => goOwnedModels('plugin-unknown'), /不是 Go 发现/);
  assert.equal(isGoOwnedModels('plugin-unknown'), false);
  assert.equal(isGoOwnedModels('OPENCODE'), true);
  assert.equal(isGoOwnedModels('cline'), true);
  assert.equal(isGoOwnedModels('codex'), true);
  assert.equal(isGoOwnedModels('claude'), true);
});

function goCatalogResponse(accountRef, provider, models) {
  return {
    ok: true,
    status: 200,
    body: {
      data: [{
        account_ref: accountRef,
        provider_id: provider,
        last_source: models.length > 0 ? 'remote' : 'empty',
        models: models.map((modelId) => ({ model_id: modelId }))
      }],
      generation: 1,
      updated_at_ms: Date.now()
    }
  };
}

test('fetchModelsForAccount 对 Go 接管的 Provider 只读 Go，不触发出网解析', async () => {
  const requested = [];
  const models = await fetchModelsForAccount({
    goAccountModels: (requestPath) => {
      requested.push(requestPath);
      return goCatalogResponse('acct_go', 'opencode', ['opencode-go/z-model', 'opencode/a-model']);
    },
    goAccountRefFor: (nodeRef) => (nodeRef === 'acct_node' ? 'acct_go' : ''),
    // 只要走到出网解析就失败：Go 接管后这条路径必须完全不可达。
    resolveAccountEgressRequestOptions: () => {
      throw new Error('egress_must_not_run');
    }
  }, { provider: 'opencode', accountRef: 'acct_node', accessToken: 'token' }, 500);

  assert.deepEqual(models, ['opencode-go/z-model', 'opencode/a-model']);
  assert.equal(requested.length, 1, '应只读一次 Go');
  assert.match(requested[0], /^\/v1\/management\/account-models\?/);
  assert.match(requested[0], /account_ref=acct_go/);
});

test('fetchModelsForAccount 对 Go 返回的空目录返回空数组（不回落探测）', async () => {
  const models = await fetchModelsForAccount({
    goAccountModels: () => goCatalogResponse('acct_go', 'cline', []),
    goAccountRefFor: () => 'acct_go',
    resolveAccountEgressRequestOptions: () => {
      throw new Error('egress_must_not_run');
    }
  }, { provider: 'cline', accountRef: 'acct_node', accessToken: 'token' }, 500);
  assert.deepEqual(models, []);
});

test('Go 读不到时抛出 go_model_catalog_unavailable，不回落通用探测', async () => {
  await assert.rejects(
    () => fetchModelsForAccount({
      resolveAccountEgressRequestOptions: () => {
        throw new Error('egress_must_not_run');
      }
    }, { provider: 'opencode', accountRef: 'acct_node', accessToken: 'token' }, 500),
    (error) => error && error.code === 'go_model_catalog_unavailable' && /go_model_catalog_reader_missing/.test(error.message)
  );
});

test('账号引用翻译：没有同步链接时按恒等，不返回空串', () => {
  const { __private: { translateNodeRefToGo, translateGoRefToNode } } = require('../lib/server/go-core-host');
  const links = { acct_node_rekeyed: { goRef: 'acct_go_rekeyed' } };
  assert.equal(translateNodeRefToGo('acct_same', links), 'acct_same');
  assert.equal(translateNodeRefToGo('acct_node_rekeyed', links), 'acct_go_rekeyed');
  assert.equal(translateNodeRefToGo('', links), '');
  assert.equal(translateNodeRefToGo('acct_same', null), 'acct_same');
  assert.equal(translateGoRefToNode('acct_same', links), 'acct_same');
  assert.equal(translateGoRefToNode('acct_go_rekeyed', links), 'acct_node_rekeyed');
  assert.equal(translateGoRefToNode('', links), '');
  assert.equal(translateGoRefToNode('acct_same', null), 'acct_same');
});

test('Go 接管的 Provider 不采用 Node 的本地目录兜底', async () => {
  const { discoverProviderModels } = require('../lib/server/provider-model-discovery');
  const accountRef = 'acct_00000000000000000001';
  const state = {
    accounts: {
      opencode: [{
        provider: 'opencode',
        accountRef,
        accessToken: 'token',
        availableModels: ['stale/legacy-model']
      }]
    }
  };
  const result = await discoverProviderModels({
    state,
    options: {},
    providerMode: 'opencode',
    includeRegistry: false,
    includeAccountModels: true,
    accountLimit: 5,
    fetchModelsForAccount: async () => ['opencode/authoritative-model']
  });
  assert.deepEqual(result.byAccount[accountRef], ['opencode/authoritative-model']);
  const catalogSurface = JSON.stringify({
    byAccount: result.byAccount,
    byProvider: result.byProvider,
    ids: result.ids
  });
  assert.equal(catalogSurface.includes('stale/legacy-model'), false, '本地历史目录不得进入 Go 接管的目录');
});
