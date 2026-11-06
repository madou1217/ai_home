'use strict';

// 上游错误映射组的「导入 / 对拍读取」中转路由。
//
//   GET  /v0/webui/upstream-error-mapping-groups         读取 Go 当前持有的组
//   POST /v0/webui/upstream-error-mapping-groups/import  把 Node 存量组逐组转发给 Go
//
// 为什么必须走 Node 中转：Go 的 management key 由 Node 启动时生成，不落盘、不对外，
// 唯一持有者是进程内的 goCoreSync。让 scripts/import-upstream-mappings.js 直连 Go
// 就得把密钥写进磁盘或环境变量，泄漏面比「多一跳」大得多。这里只做转发与计数，
// 「同 id 同内容幂等、不同内容冲突」完全由 Go 的 POST 语义保证（不在这里重复实现）。

const COLLECTION_PATH = '/v0/webui/upstream-error-mapping-groups';
const IMPORT_PATH = COLLECTION_PATH + '/import';
const MAX_GROUPS = 100;

// Go 的 POST 用 DisallowUnknownFields 解码：只透传它认识的组字段。
// 调用方带来的 position / version / createdAtMs 等 Go 侧元数据会把整组打成 400，
// 而它们本来也不该由导入方决定。
const GROUP_FIELDS = Object.freeze(['id', 'name', 'description', 'provider', 'enabled', 'rules']);

function pickGroupFields(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const group = {};
  for (const field of GROUP_FIELDS) {
    if (source[field] !== undefined) group[field] = source[field];
  }
  return group;
}

// 管理客户端在响应带 data 包装时返回内层，否则返回整份 JSON；两种形状都接受。
function responseBody(response) {
  const body = response && response.body;
  if (body && typeof body === 'object') return body;
  const data = response && response.data;
  if (!data || typeof data !== 'object') return null;
  return data.data && typeof data.data === 'object' ? data.data : data;
}

function upstreamStatus(response) {
  const status = Number(response && response.status) || 0;
  return status >= 400 ? status : 502;
}

async function handleGetGroups(ctx, goHost) {
  if (typeof goHost.listUpstreamMappingGroups !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  const response = await goHost.listUpstreamMappingGroups();
  const body = response && response.ok === true ? responseBody(response) : null;
  if (!body) {
    ctx.writeJson(ctx.res, upstreamStatus(response), {
      ok: false,
      error: (response && response.errorCode) || 'go_core_unavailable'
    });
    return true;
  }
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    version: Number(body.version) || 1,
    groups: Array.isArray(body.groups) ? body.groups : []
  });
  return true;
}

async function readImportGroups(ctx) {
  let payload;
  try {
    const raw = await ctx.readRequestBody(ctx.req, { maxBytes: 2 * 1024 * 1024 });
    payload = JSON.parse(raw.toString('utf8'));
  } catch (_error) {
    return { error: 'invalid_request_body' };
  }
  const groups = payload && Array.isArray(payload.groups) ? payload.groups : null;
  if (!groups || groups.length === 0) return { error: 'groups_required' };
  if (groups.length > MAX_GROUPS) return { error: 'too_many_groups' };
  return { groups };
}

async function handleImportGroups(ctx, goHost) {
  if (typeof goHost.createUpstreamMappingGroup !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  const parsed = await readImportGroups(ctx);
  if (parsed.error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: parsed.error });
    return true;
  }

  // 先读一次现有 id：Go 的 POST 对「同 id 同内容」返回 200 且不区分新建/命中，
  // 只有先知道哪些 id 已存在，才能把 200 准确拆成 imported / skipped。
  // 读取失败不阻断导入（创建本身会给出权威结果），只是 skipped 会退化为 0。
  const existingIds = new Set();
  if (typeof goHost.listUpstreamMappingGroups === 'function') {
    const listed = await goHost.listUpstreamMappingGroups();
    if (listed && listed.ok === true) {
      const body = responseBody(listed);
      for (const group of body && Array.isArray(body.groups) ? body.groups : []) {
        const id = String(group && group.id || '').trim();
        if (id) existingIds.add(id);
      }
    }
  }

  let imported = 0;
  let skipped = 0;
  let conflicts = 0;
  const failures = [];
  for (const value of parsed.groups) {
    const group = pickGroupFields(value);
    const id = String(group.id || '').trim();
    const response = await goHost.createUpstreamMappingGroup(group);
    if (response && response.ok === true) {
      // 预读里已有同 id 且 Go 仍返回成功 → 同内容幂等命中；否则是本次新建。
      if (id && existingIds.has(id)) skipped += 1;
      else imported += 1;
      if (id) existingIds.add(id);
      continue;
    }
    if (response && response.status === 409) {
      // Go 对「同 id 但内容不同」返回 409 mapping_group_exists，直接计为冲突。
      conflicts += 1;
      continue;
    }
    failures.push({ id, error: (response && response.errorCode) || 'import_failed' });
  }

  const payload = {
    ok: failures.length === 0,
    imported,
    skipped,
    conflicts
  };
  if (failures.length) {
    payload.failed = failures.length;
    payload.errors = failures;
  }
  ctx.writeJson(ctx.res, 200, payload);
  return true;
}

async function handleWebUiUpstreamMappingGroupRelayRoutes(ctx) {
  const { method, pathname } = ctx;
  if (pathname !== COLLECTION_PATH && pathname !== IMPORT_PATH) return false;
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  if (pathname === COLLECTION_PATH) {
    if (method !== 'GET') {
      ctx.writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    return handleGetGroups(ctx, goHost);
  }
  if (method !== 'POST') {
    ctx.writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  return handleImportGroups(ctx, goHost);
}

module.exports = {
  COLLECTION_PATH,
  IMPORT_PATH,
  handleWebUiUpstreamMappingGroupRelayRoutes
};
