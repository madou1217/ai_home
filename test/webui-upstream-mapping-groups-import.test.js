'use strict';

// 映射组导入路由的契约：Node 只做转发，幂等/冲突语义必须与 Go 的 POST 完全一致。
// 这里用 stub host 模拟 Go 的 Create 语义（同 id 同内容 200，不同内容 409），
// 断言路由的计数与字段透传——真正打 Go 的验证由 scripts/import-upstream-mappings.js
// --verify 在真机上完成。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COLLECTION_PATH,
  IMPORT_PATH,
  handleWebUiUpstreamMappingGroupRelayRoutes
} = require('../lib/server/webui-upstream-mapping-group-relay-routes');

const RULES = [
  {
    name: '余额不足',
    enabled: true,
    statuses: [400, 402],
    matchers: [{ source: 'json', operator: 'contains', path: 'error.message', value: '余额不足' }],
    kind: 'billing_blocked'
  },
  {
    name: '并发限流',
    enabled: true,
    statuses: [429],
    matchers: [{ source: 'body', operator: 'regex', value: '^rate limit' }],
    kind: 'rate_limited'
  }
];

function group(overrides = {}) {
  return {
    id: 'uem_test_group',
    name: '测试映射组',
    description: '导入路由测试',
    provider: 'all',
    enabled: true,
    rules: JSON.parse(JSON.stringify(RULES)),
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
    return result;
  }
  return value;
}

function sameContent(left, right) {
  const fields = ['name', 'description', 'provider', 'enabled', 'rules'];
  const pick = (value) => fields.reduce((acc, field) => { acc[field] = value[field]; return acc; }, {});
  return JSON.stringify(canonical(pick(left))) === JSON.stringify(canonical(pick(right)));
}

// stub host：与 Go 的 Create 语义一致，并记录每次收到的组字段。
function createStubHost(initialGroups = []) {
  const stored = new Map(initialGroups.map((item) => [item.id, clone(item)]));
  const calls = [];
  const list = () => ({ ok: true, version: 1, groups: [...stored.values()].map(clone) });
  return {
    calls,
    stored,
    async listUpstreamMappingGroups() {
      return { ok: true, status: 200, data: list() };
    },
    async createUpstreamMappingGroup(input) {
      calls.push(clone(input));
      const existing = stored.get(input.id);
      if (existing) {
        if (sameContent(existing, input)) {
          return { ok: true, status: 200, data: { ok: true, group: clone(existing), groups: list().groups } };
        }
        return { ok: false, status: 409, data: null, errorCode: 'mapping_group_exists' };
      }
      stored.set(input.id, clone(input));
      return { ok: true, status: 200, data: { ok: true, group: clone(input), groups: list().groups } };
    }
  };
}

async function callRoute(goHost, { method, pathname, body }) {
  const res = { statusCode: 0, payload: null };
  const handled = await handleWebUiUpstreamMappingGroupRelayRoutes({
    req: {},
    res,
    method,
    pathname,
    deps: { goCoreSync: goHost },
    readRequestBody: async () => Buffer.from(JSON.stringify(body === undefined ? {} : body)),
    writeJson: (target, status, payload) => {
      target.statusCode = status;
      target.payload = payload;
    }
  });
  assert.equal(handled, true);
  return res;
}

test('同内容重复导入按幂等处理：第一次 imported，第二次 skipped', async () => {
  const host = createStubHost();
  const payload = { groups: [group()] };

  const first = await callRoute(host, { method: 'POST', pathname: IMPORT_PATH, body: payload });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.payload, { ok: true, imported: 1, skipped: 0, conflicts: 0 });

  const second = await callRoute(host, { method: 'POST', pathname: IMPORT_PATH, body: payload });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.payload, { ok: true, imported: 0, skipped: 1, conflicts: 0 });
  // 两次都把组透传给 Go，由 Go 判定幂等；Node 不自己吞掉请求。
  assert.equal(host.calls.length, 2);
});

test('同 id 不同内容按冲突计数，不覆盖 Go 的既有内容', async () => {
  const existing = group({ name: '旧名字' });
  const host = createStubHost([existing]);
  const changed = group({ name: '新名字', description: '内容已变' });

  const response = await callRoute(host, {
    method: 'POST',
    pathname: IMPORT_PATH,
    body: { groups: [changed] }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload, { ok: true, imported: 0, skipped: 0, conflicts: 1 });
  assert.equal(host.stored.get(existing.id).name, '旧名字');
});

test('字段透传：只转发 Go 认识的组字段，rules 顺序原样保留', async () => {
  const host = createStubHost();
  const input = {
    ...group({ enabled: false, provider: 'zcode' }),
    // Go 的 POST 用 DisallowUnknownFields，这些元数据必须被路由剥掉。
    position: 7,
    version: 9,
    createdAtMs: 1700000000000
  };

  const response = await callRoute(host, {
    method: 'POST',
    pathname: IMPORT_PATH,
    body: { groups: [input] }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(host.calls, [{
    id: 'uem_test_group',
    name: '测试映射组',
    description: '导入路由测试',
    provider: 'zcode',
    enabled: false,
    rules: input.rules
  }]);
  // 规则顺序是匹配语义，不能按字段或名称重排。
  assert.equal(host.calls[0].rules[0].name, '余额不足');
  assert.equal(host.calls[0].rules[1].name, '并发限流');
});

test('GET 路由返回 Go 的组供 --verify 对拍', async () => {
  const host = createStubHost([group()]);
  const response = await callRoute(host, { method: 'GET', pathname: COLLECTION_PATH });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.version, 1);
  assert.equal(response.payload.groups.length, 1);
  assert.equal(response.payload.groups[0].id, 'uem_test_group');
});

test('非 POST 的导入请求返回 405，body 缺 groups 返回 400', async () => {
  const host = createStubHost();
  const wrongMethod = await callRoute(host, { method: 'GET', pathname: IMPORT_PATH });
  assert.equal(wrongMethod.statusCode, 405);

  const empty = await callRoute(host, { method: 'POST', pathname: IMPORT_PATH, body: { groups: [] } });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.payload.error, 'groups_required');
});
