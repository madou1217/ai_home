'use strict';

const {
  generateMappingId,
  readUpstreamErrorMappingGroups,
  saveUpstreamErrorMappingGroups,
  normalizeGroup
} = require('./upstream-error-mapping-store');
const { withAccountQueryListFns } = require('./account-load-args');
const { notifyGoCoreProjection } = require('./go-core-projection-sync');

const COLLECTION_PATH = '/v0/webui/upstream-error-mappings';

// Go 的组接口用 DisallowUnknownFields 解码：position/version/createdAtMs 是 Go 自己
// 返回的元数据，前端编辑时可能原样带回，不能让它们把整组打成 400。
const GO_GROUP_FIELDS = Object.freeze(['id', 'name', 'description', 'provider', 'enabled', 'rules']);

function reloadRuntimePool(ctx) {
  const load = ctx && (ctx.loadServerRuntimeAccounts || ctx.deps && ctx.deps.loadServerRuntimeAccounts);
  const apply = ctx && (ctx.applyReloadState || ctx.deps && ctx.deps.applyReloadState);
  const state = ctx && ctx.state;
  if (typeof load !== 'function' || typeof apply !== 'function' || !state) return false;
  const deps = ctx.deps || {};
  const runtimeAccounts = load(withAccountQueryListFns({
    fs: ctx.fs || deps.fs,
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
    accountStateIndex: ctx.accountStateIndex || deps.accountStateIndex,
    getToolConfigDir: ctx.getToolConfigDir || deps.getToolConfigDir,
    getProfileDir: ctx.getProfileDir || deps.getProfileDir,
    checkStatus: ctx.checkStatus || deps.checkStatus,
    serverPort: ctx.options && ctx.options.port,
    accountRuntimeGate: ctx.deps && ctx.deps.accountRuntimeGate
  }, ctx));
  apply(state, runtimeAccounts);
  // 分组规则会被合并进成员账号的有效规则（accounts.js 的 readEffectiveUpstreamErrorRules），
  // 所以分组的增删改同样改变规则投影，必须立刻重推 Go。
  notifyGoCoreProjection(ctx, 'upstreamErrorRules');
  return true;
}

async function parseBody(ctx) {
  const buffer = await ctx.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 });
  const payload = buffer && JSON.parse(buffer.toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new Error('invalid_mapping_group');
    error.code = 'invalid_mapping_group';
    throw error;
  }
  return payload;
}

function groupIdFromPath(pathname) {
  const match = String(pathname || '').match(/^\/v0\/webui\/upstream-error-mappings\/([A-Za-z0-9_-]+)(?:\/toggle)?$/);
  return match ? match[1] : '';
}

// Go 的 POST/PUT 只认识组内容字段；其余元数据由 Go 自己生成，不能回灌。
function pickGoGroupFields(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const group = {};
  for (const field of GO_GROUP_FIELDS) {
    if (source[field] !== undefined) group[field] = source[field];
  }
  return group;
}

// 只在 Go Core 真正启用时返回宿主：未启用、旧宿主缺方法都算不可用，
// 与别名切流（alias-go-owner）同一判据——能力只有一份所有者，不做双写。
function goMappingHost(ctx) {
  const host = ctx.deps && ctx.deps.goCoreSync;
  if (!host) return null;
  if (typeof host.isEnabled === 'function' && host.isEnabled() !== true) return null;
  return host;
}

// 管理客户端在响应带 data 包装时返回内层，否则返回整份 JSON；两种形状都接受。
function goResponseBody(response) {
  const data = response && response.data;
  if (!data || typeof data !== 'object') return null;
  return data.data && typeof data.data === 'object' ? data.data : data;
}

function isGoConflict(response) {
  return Boolean(response) && response.ok !== true && Number(response.status) === 409;
}

// 409 不回落 Node，原样透传。
//
// 为什么：409 是「用户读到的版本已经不是最新」的可解决冲突。Node 的 app-state
// 没有组级 CAS（版本号固定为文档版本 1），回落会把这份旧版本直接写下去，
// 把「请刷新后重试」伪装成保存成功——冲突信息丢失，用户以为改动生效了。
function writeGoConflict(ctx, response) {
  const body = goResponseBody(response);
  const payload = body && typeof body === 'object'
    ? body
    : { ok: false, error: (response && response.errorCode) || 'mapping_group_conflict' };
  ctx.writeJson(ctx.res, 409, payload);
}

function positiveVersion(value) {
  const version = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

function requestVersion(ctx) {
  const params = ctx.url && ctx.url.searchParams;
  return params ? positiveVersion(params.get('version')) : undefined;
}

// Go 成功后把结果镜像回 Node 的 app-state。
//
// 它只是降级快照，但必须跟着 Go 走：否则 Go 不可用时回落会读到改动前的旧组，
// scripts/import-upstream-mappings.js --verify 也会报 Node/Go 不一致。
// 只更新被改动的那一组，不整体覆盖——尚未导入 Go 的 Node 存量组不能被顺手删掉。
function mirrorGroup(fs, aiHomeDir, group) {
  try {
    const normalized = normalizeGroup(group);
    const latest = readUpstreamErrorMappingGroups(fs, aiHomeDir);
    const index = latest.groups.findIndex((item) => item.id === normalized.id);
    if (index >= 0) latest.groups[index] = normalized;
    else latest.groups.push(normalized);
    saveUpstreamErrorMappingGroups(fs, aiHomeDir, latest);
  } catch (_error) {
    // Go 已经落库；本地快照失败不能让一次成功的编辑变成 500。
  }
}

function forgetGroup(fs, aiHomeDir, id) {
  try {
    const latest = readUpstreamErrorMappingGroups(fs, aiHomeDir);
    const groups = latest.groups.filter((group) => group.id !== id);
    if (groups.length === latest.groups.length) return;
    saveUpstreamErrorMappingGroups(fs, aiHomeDir, { ...latest, groups });
  } catch (_error) {
    // 同上：降级快照允许滞后，下一次成功写入会再对齐。
  }
}

// 把 Go 的写结果变成 WebUI 响应：group/groups 直接用 Go 的（含 version 等元数据），
// 同时把这一组镜像回 Node，保证降级路径读到的不是旧内容。
function respondWithGoGroup(ctx, fs, aiHomeDir, response, successStatus) {
  const body = goResponseBody(response);
  const group = body && body.group;
  if (!group) return false;
  mirrorGroup(fs, aiHomeDir, group);
  reloadRuntimePool(ctx);
  const groups = Array.isArray(body.groups)
    ? body.groups
    : readUpstreamErrorMappingGroups(fs, aiHomeDir).groups;
  ctx.writeJson(ctx.res, successStatus || 200, { ok: true, group, groups, source: 'go' });
  return true;
}

async function handleWebUiUpstreamErrorMappingRoutes(ctx) {
  const { method, pathname, fs, deps, readRequestBody, writeJson } = ctx;
  if (pathname !== COLLECTION_PATH && !pathname.startsWith(COLLECTION_PATH + '/')) return false;
  const aiHomeDir = String((deps && deps.aiHomeDir) || ctx.aiHomeDir || '').trim();
  if (!fs || !aiHomeDir) {
    writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
    return true;
  }
  const goHost = goMappingHost(ctx);

  if (pathname === COLLECTION_PATH && method === 'GET') {
    if (goHost && typeof goHost.listUpstreamMappingGroups === 'function') {
      const response = await goHost.listUpstreamMappingGroups().catch(() => null);
      const body = response && response.ok === true ? goResponseBody(response) : null;
      if (body && Array.isArray(body.groups)) {
        writeJson(ctx.res, 200, {
          ok: true,
          version: Number(body.version) || 1,
          groups: body.groups,
          source: 'go'
        });
        return true;
      }
    }
    const current = readUpstreamErrorMappingGroups(fs, aiHomeDir);
    writeJson(ctx.res, 200, { ok: true, version: current.version, groups: current.groups, source: 'node' });
    return true;
  }

  if (pathname === COLLECTION_PATH && method === 'POST') {
    let payload;
    try {
      payload = await parseBody({ ...ctx, readRequestBody });
    } catch (error) {
      writeJson(ctx.res, 400, { ok: false, error: error.code || 'invalid_mapping_group', message: error.message });
      return true;
    }
    const id = generateMappingId();
    if (goHost && typeof goHost.createUpstreamMappingGroup === 'function') {
      const response = await goHost.createUpstreamMappingGroup({ ...pickGoGroupFields(payload), id }).catch(() => null);
      if (isGoConflict(response)) {
        writeGoConflict(ctx, response);
        return true;
      }
      if (respondWithGoGroup(ctx, fs, aiHomeDir, response)) return true;
    }
    try {
      const group = normalizeGroup({ ...payload, id });
      const latest = readUpstreamErrorMappingGroups(fs, aiHomeDir);
      const saved = saveUpstreamErrorMappingGroups(fs, aiHomeDir, { groups: [...latest.groups, group] });
      reloadRuntimePool(ctx);
      writeJson(ctx.res, 200, {
        ok: true,
        group: saved.groups.find((item) => item.id === group.id),
        groups: saved.groups,
        source: 'node'
      });
    } catch (error) {
      writeJson(ctx.res, 400, { ok: false, error: error.code || 'invalid_mapping_group', message: error.message });
    }
    return true;
  }

  const id = groupIdFromPath(pathname);
  if (!id) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_mapping_group_path' });
    return true;
  }
  const isToggle = pathname.endsWith('/toggle');

  if (method === 'POST' && isToggle) {
    if (goHost
      && typeof goHost.getUpstreamMappingGroup === 'function'
      && typeof goHost.updateUpstreamMappingGroup === 'function') {
      // toggle 需要「当前值」才能取反；读 Go 的 group 顺带拿到 version，
      // 更新时作为 CAS 传回去，避免与另一个标签页的修改互相覆盖。
      const got = await goHost.getUpstreamMappingGroup(id).catch(() => null);
      const gotBody = got && got.ok === true ? goResponseBody(got) : null;
      if (gotBody && gotBody.group) {
        const response = await goHost.updateUpstreamMappingGroup(
          id,
          { enabled: gotBody.group.enabled !== true },
          positiveVersion(gotBody.group.version)
        ).catch(() => null);
        if (isGoConflict(response)) {
          writeGoConflict(ctx, response);
          return true;
        }
        if (respondWithGoGroup(ctx, fs, aiHomeDir, response)) return true;
      }
    }
    const current = readUpstreamErrorMappingGroups(fs, aiHomeDir);
    const index = current.groups.findIndex((group) => group.id === id);
    if (index < 0) {
      writeJson(ctx.res, 404, { ok: false, error: 'mapping_group_not_found' });
      return true;
    }
    current.groups[index].enabled = current.groups[index].enabled === false;
    const saved = saveUpstreamErrorMappingGroups(fs, aiHomeDir, current);
    reloadRuntimePool(ctx);
    writeJson(ctx.res, 200, { ok: true, group: saved.groups[index], groups: saved.groups, source: 'node' });
    return true;
  }

  if (method === 'DELETE' && !isToggle) {
    if (goHost && typeof goHost.deleteUpstreamMappingGroup === 'function') {
      const response = await goHost.deleteUpstreamMappingGroup(id, requestVersion(ctx)).catch(() => null);
      if (isGoConflict(response)) {
        writeGoConflict(ctx, response);
        return true;
      }
      if (response && response.ok === true) {
        forgetGroup(fs, aiHomeDir, id);
        reloadRuntimePool(ctx);
        writeJson(ctx.res, 200, { ok: true, source: 'go' });
        return true;
      }
    }
    const current = readUpstreamErrorMappingGroups(fs, aiHomeDir);
    const index = current.groups.findIndex((group) => group.id === id);
    if (index < 0) {
      writeJson(ctx.res, 404, { ok: false, error: 'mapping_group_not_found' });
      return true;
    }
    current.groups.splice(index, 1);
    saveUpstreamErrorMappingGroups(fs, aiHomeDir, current);
    reloadRuntimePool(ctx);
    writeJson(ctx.res, 200, { ok: true, source: 'node' });
    return true;
  }

  if (method === 'PUT' && !isToggle) {
    let payload;
    try {
      payload = await parseBody({ ...ctx, readRequestBody });
    } catch (error) {
      writeJson(ctx.res, 400, { ok: false, error: error.code || 'invalid_mapping_group', message: error.message });
      return true;
    }
    if (goHost && typeof goHost.updateUpstreamMappingGroup === 'function') {
      const version = positiveVersion(payload.version) || requestVersion(ctx);
      const response = await goHost.updateUpstreamMappingGroup(id, pickGoGroupFields(payload), version).catch(() => null);
      if (isGoConflict(response)) {
        writeGoConflict(ctx, response);
        return true;
      }
      if (respondWithGoGroup(ctx, fs, aiHomeDir, response)) return true;
    }
    try {
      // 读取正文期间可能已有其它请求保存；用最新记录合并，避免覆盖并发修改。
      const latest = readUpstreamErrorMappingGroups(fs, aiHomeDir);
      const latestIndex = latest.groups.findIndex((group) => group.id === id);
      if (latestIndex < 0) {
        writeJson(ctx.res, 404, { ok: false, error: 'mapping_group_not_found' });
        return true;
      }
      // URL 是资源身份，客户端传来的 id 不得把既有账号挂载悄悄改成新组。
      const group = normalizeGroup({ ...payload, id }, latest.groups[latestIndex]);
      latest.groups[latestIndex] = group;
      const saved = saveUpstreamErrorMappingGroups(fs, aiHomeDir, latest);
      reloadRuntimePool(ctx);
      writeJson(ctx.res, 200, { ok: true, group, groups: saved.groups, source: 'node' });
    } catch (error) {
      writeJson(ctx.res, 400, { ok: false, error: error.code || 'invalid_mapping_group', message: error.message });
    }
    return true;
  }
  writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

module.exports = { handleWebUiUpstreamErrorMappingRoutes };
