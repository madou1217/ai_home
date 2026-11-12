'use strict';

// 账号级规则导入路由的契约：Node 只做转发，导入复用正常推送路径（force），
// GET 返回 Go 的账号级配置并把 Go 引用翻译回 Node 引用供脚本对拍。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLLECTION_PATH,
  IMPORT_PATH,
  handleWebUiAccountUpstreamErrorRulesRelayRoutes
} = require('../lib/server/webui-account-upstream-error-rules-relay-routes');

function createStubHost() {
  const calls = [];
  return {
    calls,
    async listAccountUpstreamErrorRules() {
      return {
        ok: true,
        status: 200,
        data: {
          generation: 9,
          supported_providers: ['codex'],
          accounts: [{
            account_ref: 'acct_go_ref',
            provider: 'codex',
            group_ids: ['uem_group'],
            rules: []
          }]
        }
      };
    },
    async pushUpstreamErrorRules(options) {
      calls.push(options);
      return {
        ok: true,
        pushed: 2,
        accepted: 2,
        failed: 0,
        dropped: 0,
        droppedReasons: [],
        skippedAccounts: []
      };
    },
    nodeAccountRefFor(goRef) {
      return goRef === 'acct_go_ref' ? 'acct_node_ref' : goRef;
    }
  };
}

async function callRoute(goHost, { method, pathname }) {
  const res = { statusCode: 0, payload: null };
  const handled = await handleWebUiAccountUpstreamErrorRulesRelayRoutes({
    req: {},
    res,
    method,
    pathname,
    deps: { goCoreSync: goHost },
    writeJson: (target, status, payload) => {
      target.statusCode = status;
      target.payload = payload;
    }
  });
  assert.equal(handled, true);
  return res;
}

test('GET 返回 Go 配置并附带 Node 引用', async () => {
  const host = createStubHost();
  const response = await callRoute(host, { method: 'GET', pathname: COLLECTION_PATH });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.generation, 9);
  assert.equal(response.payload.accounts[0].node_account_ref, 'acct_node_ref');
  assert.deepEqual(response.payload.accounts[0].group_ids, ['uem_group']);
});

test('Go 响应保留完整 body 包装时也能取到内层', async () => {
  const host = createStubHost();
  host.listAccountUpstreamErrorRules = async () => ({
    ok: true,
    status: 200,
    data: undefined,
    body: {
      data: {
        generation: 3,
        supported_providers: ['codex'],
        accounts: [{ account_ref: 'acct_go_ref', group_ids: [], rules: [] }]
      }
    }
  });
  const response = await callRoute(host, { method: 'GET', pathname: COLLECTION_PATH });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.accounts.length, 1);
});

test('POST import 复用 force 推送', async () => {
  const host = createStubHost();
  const response = await callRoute(host, { method: 'POST', pathname: IMPORT_PATH });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(host.calls, [{ force: true }]);
  assert.equal(response.payload.pushed, 2);
  assert.equal(response.payload.accepted, 2);
});

test('Go 不可用时返回 503', async () => {
  const res = { statusCode: 0, payload: null };
  const handled = await handleWebUiAccountUpstreamErrorRulesRelayRoutes({
    req: {},
    res,
    method: 'GET',
    pathname: COLLECTION_PATH,
    deps: {},
    writeJson: (target, status, payload) => {
      target.statusCode = status;
      target.payload = payload;
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 503);
});
