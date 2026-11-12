'use strict';

// 映射组 CRUD 切流契约：Go 可用时以 Go 为唯一写者，Node 只保留降级快照；
// 409 是版本冲突，必须原样透传——回落 Node 会把冲突伪装成保存成功。
// 账号级规则（账号 PATCH 上的 upstreamErrorRules）不属于本路由，不能被顺手接管。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleWebUiUpstreamErrorMappingRoutes } = require('../lib/server/webui-upstream-error-mapping-routes');
const {
  readUpstreamErrorMappingGroups,
  saveUpstreamErrorMappingGroups
} = require('../lib/server/upstream-error-mapping-store');

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
    id: 'uem_seed_group',
    name: '测试映射组',
    description: '切流测试',
    provider: 'all',
    enabled: true,
    rules: JSON.parse(JSON.stringify(RULES)),
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seedNode(aiHomeDir, groups) {
  saveUpstreamErrorMappingGroups(fs, aiHomeDir, { groups: clone(groups) });
}

function nodeGroups(aiHomeDir) {
  return readUpstreamErrorMappingGroups(fs, aiHomeDir).groups;
}

// stub host 按 Go 的真实语义实现：单组 version 递增，PUT/DELETE 带 version 时做 CAS。
function createStubHost(initialGroups = [], options = {}) {
  const stored = new Map(initialGroups.map((item) => [item.id, {
    ...clone(item),
    position: 0,
    version: Number(options.version) || 1,
    createdAtMs: 1,
    updatedAtMs: 1
  }]));
  const calls = [];
  const list = () => [...stored.values()].map(clone);
  const okGroup = (item) => ({
    ok: true,
    status: 200,
    data: { ok: true, group: clone(item), groups: list() }
  });
  return {
    calls,
    stored,
    isEnabled: () => options.enabled !== false,
    async listUpstreamMappingGroups() {
      calls.push({ method: 'list' });
      return { ok: true, status: 200, data: { ok: true, version: 1, groups: list() } };
    },
    async createUpstreamMappingGroup(input) {
      calls.push({ method: 'create', input: clone(input) });
      const item = { ...clone(input), position: stored.size, version: 1, createdAtMs: 1, updatedAtMs: 1 };
      stored.set(item.id, item);
      return okGroup(item);
    },
    async getUpstreamMappingGroup(id) {
      calls.push({ method: 'get', id });
      const item = stored.get(id);
      if (!item) {
        return { ok: false, status: 404, errorCode: 'mapping_group_not_found' };
      }
      return { ok: true, status: 200, data: { ok: true, group: clone(item) } };
    },
    async updateUpstreamMappingGroup(id, patch, version) {
      calls.push({ method: 'update', id, patch: clone(patch), version });
      const item = stored.get(id);
      if (!item) return { ok: false, status: 404, errorCode: 'mapping_group_not_found' };
      if (version != null && version !== item.version) {
        return {
          ok: false,
          status: 409,
          errorCode: 'mapping_group_conflict',
          data: { ok: false, error: 'mapping_group_conflict', message: '映射组已被其他请求修改，请刷新后重试' }
        };
      }
      const next = { ...item, ...clone(patch), version: item.version + 1, updatedAtMs: item.updatedAtMs + 1 };
      stored.set(id, next);
      return okGroup(next);
    },
    async deleteUpstreamMappingGroup(id, version) {
      calls.push({ method: 'delete', id, version });
      const item = stored.get(id);
      if (!item) return { ok: false, status: 404, errorCode: 'mapping_group_not_found' };
      if (version != null && version !== item.version) {
        return {
          ok: false,
          status: 409,
          errorCode: 'mapping_group_conflict',
          data: { ok: false, error: 'mapping_group_conflict', message: '映射组已被其他请求修改，请刷新后重试' }
        };
      }
      stored.delete(id);
      return { ok: true, status: 200, data: { ok: true } };
    }
  };
}

function setup(t, groups) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-mapping-cutover-'));
  if (groups) seedNode(aiHomeDir, groups);
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

async function callRoute(aiHomeDir, goCoreSync, { method, pathname, body, search }) {
  let statusCode = 0;
  let payload = null;
  const handled = await handleWebUiUpstreamErrorMappingRoutes({
    req: {},
    res: {},
    method,
    pathname,
    url: new URL('http://127.0.0.1' + pathname + (search || '')),
    fs,
    state: {},
    deps: { aiHomeDir, goCoreSync },
    readRequestBody: async () => Buffer.from(JSON.stringify(body === undefined ? {} : body)),
    writeJson: (_res, status, value) => {
      statusCode = status;
      payload = value;
    }
  });
  return { handled, statusCode, payload };
}

test('Go 可用：列表/创建/更新/删除都以 source=go 返回并镜像回 Node', async (t) => {
  const seed = group();
  const aiHomeDir = setup(t, [seed]);
  const host = createStubHost([seed]);

  const listed = await callRoute(aiHomeDir, host, { method: 'GET', pathname: '/v0/webui/upstream-error-mappings' });
  assert.equal(listed.handled, true);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.payload.source, 'go');
  assert.equal(listed.payload.groups.length, 1);

  const created = await callRoute(aiHomeDir, host, {
    method: 'POST',
    pathname: '/v0/webui/upstream-error-mappings',
    body: group({ id: undefined, name: '新建组' })
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.source, 'go');
  const createdId = created.payload.group.id;
  assert.match(createdId, /^uem_/);
  assert.deepEqual(nodeGroups(aiHomeDir).map((item) => item.id).sort(), [seed.id, createdId].sort());

  const updated = await callRoute(aiHomeDir, host, {
    method: 'PUT',
    pathname: '/v0/webui/upstream-error-mappings/' + createdId,
    body: { name: '改名后的组', description: 'Go 已接受', provider: 'all', enabled: false, rules: RULES }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.payload.source, 'go');
  assert.equal(updated.payload.group.name, '改名后的组');
  const mirroredUpdate = nodeGroups(aiHomeDir).find((item) => item.id === createdId);
  assert.equal(mirroredUpdate.name, '改名后的组');
  assert.equal(mirroredUpdate.enabled, false);

  const removed = await callRoute(aiHomeDir, host, {
    method: 'DELETE',
    pathname: '/v0/webui/upstream-error-mappings/' + createdId
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.payload.source, 'go');
  assert.equal(nodeGroups(aiHomeDir).some((item) => item.id === createdId), false);
  assert.equal(host.stored.has(createdId), false);
});

test('Go 失败：回落到 Node 存储，行为与切流前一致（source=node）', async (t) => {
  const seed = group();
  const aiHomeDir = setup(t, [seed]);
  const host = createStubHost([seed]);
  const failure = async () => ({ ok: false, status: 503, errorCode: 'go_core_unavailable' });
  host.listUpstreamMappingGroups = failure;
  host.createUpstreamMappingGroup = failure;
  host.updateUpstreamMappingGroup = failure;
  host.deleteUpstreamMappingGroup = failure;

  const listed = await callRoute(aiHomeDir, host, { method: 'GET', pathname: '/v0/webui/upstream-error-mappings' });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.payload.source, 'node');
  assert.equal(listed.payload.groups.length, 1);

  const created = await callRoute(aiHomeDir, host, {
    method: 'POST',
    pathname: '/v0/webui/upstream-error-mappings',
    body: group({ id: undefined, name: '降级新建' })
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.source, 'node');
  const createdId = created.payload.group.id;
  assert.equal(nodeGroups(aiHomeDir).some((item) => item.id === createdId), true);

  const updated = await callRoute(aiHomeDir, host, {
    method: 'PUT',
    pathname: '/v0/webui/upstream-error-mappings/' + createdId,
    body: { name: '降级更新', rules: RULES }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.payload.source, 'node');
  assert.equal(nodeGroups(aiHomeDir).find((item) => item.id === createdId).name, '降级更新');

  const removed = await callRoute(aiHomeDir, host, {
    method: 'DELETE',
    pathname: '/v0/webui/upstream-error-mappings/' + createdId
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.payload.source, 'node');
  assert.equal(nodeGroups(aiHomeDir).some((item) => item.id === createdId), false);
});

test('409 原样透传：不回落 Node，也不改动本地快照', async (t) => {
  const seed = group({ name: '冲突前的名字' });
  const aiHomeDir = setup(t, [seed]);
  const host = createStubHost([seed], { version: 5 });

  const response = await callRoute(aiHomeDir, host, {
    method: 'PUT',
    pathname: '/v0/webui/upstream-error-mappings/' + seed.id,
    body: { name: '用旧版本覆盖', version: 1, rules: RULES }
  });

  assert.equal(response.handled, true);
  assert.equal(response.statusCode, 409);
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.error, 'mapping_group_conflict');
  // 关键：没有走 Node 的“直接写”分支，旧版本没有被当成新值保存。
  assert.equal(nodeGroups(aiHomeDir)[0].name, '冲突前的名字');
  assert.equal(host.stored.get(seed.id).name, '冲突前的名字');
});

test('账号级规则路径不受影响：映射组路由不接管账号请求', async (t) => {
  const aiHomeDir = setup(t, []);
  const host = createStubHost([]);
  const response = await callRoute(aiHomeDir, host, {
    method: 'PATCH',
    pathname: '/v0/webui/accounts/acct_cutover_test',
    body: { upstreamErrorRules: [{ name: '账号级', kind: 'rate_limited', statuses: [429], matchers: [] }] }
  });

  assert.equal(response.handled, false);
  assert.deepEqual(host.calls, []);
});
