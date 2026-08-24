'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const routePath = path.join(__dirname, '../lib/server/webui-account-egress-catalog-routes.js');

test('账号出口目录拥有独立于 Toolkit 的 HTTP 路由边界', () => {
  assert.equal(fs.existsSync(routePath), true);
});

const {
  ROUTE_PREFIX,
  handleWebUiAccountEgressCatalogRoutes
} = require(routePath);

function createMockReqRes(method, pathname, body = null, query = '') {
  const req = new EventEmitter();
  req.method = method;
  req.url = `${pathname}${query}`;
  req.headers = {};
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(data) {
      this.body = data || '';
    }
  };
  process.nextTick(() => {
    if (body !== null) req.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    req.emit('end');
  });
  return { req, res };
}

async function invoke(method, suffix, service, body = null, query = '') {
  const pathname = `${ROUTE_PREFIX}${suffix}`;
  const { req, res } = createMockReqRes(method, pathname, body, query);
  const handled = await handleWebUiAccountEgressCatalogRoutes(
    req,
    res,
    method,
    pathname,
    { accountEgressCatalogService: service }
  );
  return { handled, res, data: res.body ? JSON.parse(res.body) : null };
}

test('目录路由只接管 account-egress/catalog 前缀', async () => {
  const { req, res } = createMockReqRes('GET', '/v0/webui/toolkit/proxy-pool/nodes');
  const handled = await handleWebUiAccountEgressCatalogRoutes(
    req,
    res,
    'GET',
    '/v0/webui/toolkit/proxy-pool/nodes',
    {}
  );
  assert.equal(handled, false);
  assert.equal(res.body, '');
});

test('GET nodes 只把中立筛选参数交给目录服务', async () => {
  const calls = [];
  const service = {
    listNodes(filter) {
      calls.push(filter);
      return { ok: true, nodes: [{ id: 'node-1' }] };
    }
  };
  const result = await invoke('GET', '/nodes', service, null, '?group=manual&protocol=socks5');
  assert.equal(result.handled, true);
  assert.equal(result.res.statusCode, 200);
  assert.deepEqual(calls, [{ group: 'manual', protocol: 'socks5' }]);
  assert.deepEqual(result.data.nodes, [{ id: 'node-1' }]);
});

test('GET groups 和 subscriptions 返回目录快照', async () => {
  const service = {
    listGroups: () => ({ ok: true, groups: [{ id: 'group-1' }] }),
    listSubscriptions: () => ({ ok: true, manualSyncOnly: true, subscriptions: [{ id: 'sub-1' }] })
  };
  const groups = await invoke('GET', '/groups', service);
  const subscriptions = await invoke('GET', '/subscriptions', service);
  assert.equal(groups.res.statusCode, 200);
  assert.deepEqual(groups.data.groups, [{ id: 'group-1' }]);
  assert.equal(subscriptions.data.manualSyncOnly, true);
  assert.deepEqual(subscriptions.data.subscriptions, [{ id: 'sub-1' }]);
});

test('POST nodes、groups 和 subscriptions 只执行目录写入', async () => {
  const calls = [];
  const service = {
    async upsertNode(input) {
      calls.push(['node', input]);
      return { ok: true, applied: true, node: { id: 'node-1', ...input } };
    },
    async upsertGroup(input) {
      calls.push(['group', input]);
      return { ok: true, applied: true, group: { id: 'group-1', ...input } };
    },
    async upsertSubscription(input) {
      calls.push(['subscription', input]);
      return { ok: true, applied: true, subscription: { id: 'sub-1', ...input } };
    }
  };
  await invoke('POST', '/nodes', service, { name: 'node' });
  await invoke('POST', '/groups', service, { name: 'group' });
  await invoke('POST', '/subscriptions', service, { name: 'subscription' });
  assert.deepEqual(calls, [
    ['node', { name: 'node' }],
    ['group', { name: 'group' }],
    ['subscription', { name: 'subscription' }]
  ]);
});

test('import 和 subscription sync 始终走手动存储目录语义', async () => {
  const calls = [];
  const service = {
    async importNodes(content, subscriptionId) {
      calls.push(['import', content, subscriptionId]);
      return { ok: true, applied: true, count: 1 };
    },
    async syncSubscription(id) {
      calls.push(['sync', id]);
      return { ok: true, applied: true, storageOnly: true, manualSyncOnly: true, count: 1 };
    }
  };
  const imported = await invoke('POST', '/import', service, {
    content: 'socks5://127.0.0.1:1080',
    subscriptionId: 'sub-1'
  });
  const synced = await invoke('POST', '/subscriptions/sync', service, { id: 'sub-1' });
  assert.deepEqual(calls, [
    ['import', 'socks5://127.0.0.1:1080', 'sub-1'],
    ['sync', 'sub-1']
  ]);
  assert.equal(imported.data.applied, true);
  assert.equal(synced.data.manualSyncOnly, true);
});

test('分组策略更新与三类删除映射到明确目录资源', async () => {
  const calls = [];
  const service = {
    async updateGroupPolicy(id, policy) {
      calls.push(['policy', id, policy]);
      return { ok: true, applied: true };
    },
    async deleteNode(id) {
      calls.push(['node', id]);
      return { ok: true, applied: true };
    },
    async deleteGroup(id) {
      calls.push(['group', id]);
      return { ok: true, applied: true };
    },
    async deleteSubscription(id) {
      calls.push(['subscription', id]);
      return { ok: true, applied: true };
    }
  };
  await invoke('POST', '/groups/policy', service, {
    id: 'group/a',
    strategy: 'sticky',
    failoverStrategy: 'lowest_latency'
  });
  await invoke('DELETE', '/nodes/node%2F1', service);
  await invoke('DELETE', '/groups/group%2F1', service);
  await invoke('DELETE', '/subscriptions/sub%2F1', service);
  assert.deepEqual(calls, [
    ['policy', 'group/a', { strategy: 'sticky', failoverStrategy: 'lowest_latency' }],
    ['node', 'node/1'],
    ['group', 'group/1'],
    ['subscription', 'sub/1']
  ]);
});

test('目录输入错误返回 4xx，不泄漏内部异常', async () => {
  const validationError = Object.assign(new Error('private details'), { code: 'invalid_proxy_port' });
  const invalid = await invoke('POST', '/nodes', {
    async upsertNode() {
      throw validationError;
    }
  }, { port: 70000 });
  const missingId = await invoke('POST', '/subscriptions/sync', {
    async syncSubscription() {
      throw new Error('must not run');
    }
  }, {});
  assert.equal(invalid.res.statusCode, 422);
  assert.deepEqual(invalid.data, { ok: false, error: 'invalid_proxy_port' });
  assert.equal(missingId.res.statusCode, 400);
  assert.deepEqual(missingId.data, { ok: false, error: 'subscription_id_required' });
});

test('WebUI 总路由挂载账号出口目录且不借道 Toolkit', () => {
  const router = fs.readFileSync(path.join(__dirname, '../lib/server/web-ui-router.js'), 'utf8');
  assert.match(router, /handleWebUiAccountEgressCatalogRoutes/u);
  assert.match(
    router,
    /pathname\.startsWith\('\/v0\/webui\/account-egress\/catalog'\)[\s\S]*handleWebUiAccountEgressCatalogRoutes/u
  );
});
