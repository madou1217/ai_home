'use strict';

const {
  generateMappingId,
  readUpstreamErrorMappingGroups,
  saveUpstreamErrorMappingGroups,
  normalizeGroup
} = require('./upstream-error-mapping-store');
const { withAccountQueryListFns } = require('./account-load-args');

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
    serverPort: ctx.options && ctx.options.port
  }, ctx));
  apply(state, runtimeAccounts);
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

async function handleWebUiUpstreamErrorMappingRoutes(ctx) {
  const { method, pathname, fs, deps, readRequestBody, writeJson } = ctx;
  if (pathname !== '/v0/webui/upstream-error-mappings' && !pathname.startsWith('/v0/webui/upstream-error-mappings/')) return false;
  const aiHomeDir = String((deps && deps.aiHomeDir) || ctx.aiHomeDir || '').trim();
  if (!fs || !aiHomeDir) {
    writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
    return true;
  }
  const current = readUpstreamErrorMappingGroups(fs, aiHomeDir);

  if (pathname === '/v0/webui/upstream-error-mappings' && method === 'GET') {
    writeJson(ctx.res, 200, { ok: true, version: current.version, groups: current.groups });
    return true;
  }

  if (pathname === '/v0/webui/upstream-error-mappings' && method === 'POST') {
    try {
      const payload = await parseBody({ ...ctx, readRequestBody });
      const group = normalizeGroup({ ...payload, id: generateMappingId() });
      const latest = readUpstreamErrorMappingGroups(fs, aiHomeDir);
      const saved = saveUpstreamErrorMappingGroups(fs, aiHomeDir, { groups: [...latest.groups, group] });
      reloadRuntimePool(ctx);
      writeJson(ctx.res, 200, { ok: true, group: saved.groups.find((item) => item.id === group.id), groups: saved.groups });
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
  const index = current.groups.findIndex((group) => group.id === id);
  if (index < 0) {
    writeJson(ctx.res, 404, { ok: false, error: 'mapping_group_not_found' });
    return true;
  }
  if (method === 'POST' && pathname.endsWith('/toggle')) {
    current.groups[index].enabled = current.groups[index].enabled === false;
    const saved = saveUpstreamErrorMappingGroups(fs, aiHomeDir, current);
    reloadRuntimePool(ctx);
    writeJson(ctx.res, 200, { ok: true, group: saved.groups[index], groups: saved.groups });
    return true;
  }
  if (method === 'DELETE' && !pathname.endsWith('/toggle')) {
    current.groups.splice(index, 1);
    saveUpstreamErrorMappingGroups(fs, aiHomeDir, current);
    reloadRuntimePool(ctx);
    writeJson(ctx.res, 200, { ok: true });
    return true;
  }
  if (method === 'PUT' && !pathname.endsWith('/toggle')) {
    try {
      const payload = await parseBody({ ...ctx, readRequestBody });
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
      writeJson(ctx.res, 200, { ok: true, group, groups: saved.groups });
    } catch (error) {
      writeJson(ctx.res, 400, { ok: false, error: error.code || 'invalid_mapping_group', message: error.message });
    }
    return true;
  }
  writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

module.exports = { handleWebUiUpstreamErrorMappingRoutes };
