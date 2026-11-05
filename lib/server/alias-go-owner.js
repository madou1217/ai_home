'use strict';

// 别名的「Go 拥有」实现：写入口直接落到 Go，Node 只维护读投影。
//
// 为什么写入口必须唯一：别名会编译成路由规则，两个写者同时改会让「谁生效」取决于
// 最后一次推送——真机上已经出现过 Go 侧新建的别名被 Node 的整体重推覆盖。
//
// 读投影怎么维持：每次写成功后从 Go 拉一次列表写回本地库。这样即使以后关掉 Go，
// Node 也保有最后一致的那份，不会退回翻转前的旧数据。

const { loadAliases, saveAliases } = require('./model-alias-store');

// aliasRoutesGoOwned 判断是否由 Go 接管别名写入口。
//
// 条件是「Go Core 已启用」而不是某个开关：写入口只有一份，要么 Go 要么 Node，
// 中间态（双写）会产生两套事实。Go 不可用时写请求直接 503，不做本地写。
function aliasRoutesGoOwned(deps) {
  const goHost = deps && deps.goCoreSync;
  if (!goHost || typeof goHost.createModelAlias !== 'function') return false;
  return typeof goHost.isEnabled === 'function' ? goHost.isEnabled() === true : false;
}

const LIST_PATH = '/v0/webui/model-aliases';
const REPLACE_PATH = '/v0/webui/model-aliases/replace';
const ITEM_PATTERN = /^\/v0\/webui\/model-aliases\/([A-Za-z0-9_-]+)(?:\/(toggle))?$/;

function writeJson(ctx, status, payload) {
  const write = ctx.writeJson || (ctx.deps && ctx.deps.writeJson);
  write(ctx.res, status, payload);
}

// mapGoFailure 把 Go 的状态码与错误码映射成 WebUI 的既有语义。
function mapGoFailure(status, errorCode) {
  if (status === 404) return { status: 404, error: errorCode || 'not_found' };
  if (status === 409) return { status: 409, error: errorCode || 'alias_conflict' };
  if (status === 400) return { status: 400, error: errorCode || 'invalid_alias' };
  if (status === 0) return { status: 503, error: 'go_core_unavailable' };
  return { status: 502, error: errorCode || 'alias_write_failed' };
}

// refreshProjection 用 Go 的当前列表覆盖 Node 的读投影。
async function refreshProjection(ctx) {
  const { deps = {}, state } = ctx;
  const response = await deps.goCoreSync.listModelAliases();
  if (!response || response.ok !== true) return;
  const payload = response.data && typeof response.data === 'object' ? response.data : {};
  const aliases = Array.isArray(payload.aliases) ? payload.aliases : [];
  const next = { aliases };
  if (state) state.modelAliases = next;
  const fs = deps.fs || require('node:fs');
  const aiHomeDir = deps.aiHomeDir || ctx.aiHomeDir || '';
  if (aiHomeDir) {
    try {
      await saveAliases(fs, aiHomeDir, next);
    } catch (_error) {
      // 投影写失败不影响已经落库的事实；下一次写或下次启动会再对齐。
    }
  }
}

// handleAliasRouteViaGo 处理别名 CRUD；返回 false 表示这条路不归 Go（例如 targets）。
async function handleAliasRouteViaGo(ctx) {
  const { method, pathname, deps = {}, state } = ctx;
  const goHost = deps.goCoreSync;

  if (pathname === LIST_PATH) {
    if (method === 'GET') {
      const response = await goHost.listModelAliases();
      if (!response || response.ok !== true) {
        const failure = mapGoFailure(response && response.status, response && response.errorCode);
        writeJson(ctx, failure.status, { ok: false, error: failure.error });
        return true;
      }
      const payload = response.data && typeof response.data === 'object' ? response.data : {};
      const aliases = Array.isArray(payload.aliases) ? payload.aliases : [];
      if (state) state.modelAliases = { aliases };
      writeJson(ctx, 200, { ok: true, aliases });
      return true;
    }
    if (method === 'POST') {
      const payload = await readJsonBody(ctx);
      if (!payload) return true;
      const response = await goHost.createModelAlias(payload);
      return respondWithAlias(ctx, response);
    }
  }

  if (pathname === REPLACE_PATH && method === 'POST') {
    const payload = await readJsonBody(ctx);
    if (!payload) return true;
    const response = await goHost.replaceModelAliases(payload.replaceIds, payload.records);
    if (!response || response.ok !== true) {
      const failure = mapGoFailure(response && response.status, response && response.errorCode);
      writeJson(ctx, failure.status, { ok: false, error: failure.error });
      return true;
    }
    const data = response.data || {};
    await refreshProjection(ctx);
    writeJson(ctx, 200, {
      ok: true,
      removed: Number(data.removed) || 0,
      aliases: Array.isArray(data.aliases) ? data.aliases : []
    });
    return true;
  }

  // 目标候选仍由 Node 算（它基于能力索引，覆盖范围比 Go 的路由目录更广）。
  if (pathname === LIST_PATH + '/targets') return false;

  const match = String(pathname || '').match(ITEM_PATTERN);
  if (!match) return false;
  const id = match[1];
  const isToggle = match[2] === 'toggle';

  if (method === 'DELETE') {
    const response = await goHost.deleteModelAlias(id);
    if (!response || response.ok !== true) {
      const failure = mapGoFailure(response && response.status, response && response.errorCode);
      writeJson(ctx, failure.status, { ok: false, error: failure.error });
      return true;
    }
    await refreshProjection(ctx);
    writeJson(ctx, 200, { ok: true });
    return true;
  }
  if (method === 'PUT' && !isToggle) {
    const payload = await readJsonBody(ctx);
    if (!payload) return true;
    const response = await goHost.updateModelAlias(id, payload);
    return respondWithAlias(ctx, response);
  }
  if (method === 'POST' && isToggle) {
    // toggle 需要「当前值」才能取反：先看进程内投影（写成功后就是最新的），
    // 没有再读库——库里可能是上一次启动时的快照。
    const inMemory = (state && state.modelAliases && Array.isArray(state.modelAliases.aliases)
      ? state.modelAliases.aliases
      : []).find((alias) => alias.id === id) || null;
    let current = inMemory;
    if (!current) {
      try {
        const loaded = await loadAliases(deps.fs || require('node:fs'), deps.aiHomeDir || ctx.aiHomeDir || '');
        current = loaded.aliases.find((alias) => alias.id === id) || null;
      } catch (_error) {
        current = null;
      }
    }
    if (!current) {
      writeJson(ctx, 404, { ok: false, error: 'not_found' });
      return true;
    }
    const response = await goHost.setModelAliasEnabled(id, !current.enabled);
    return respondWithAlias(ctx, response);
  }
  writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
  return true;
}

async function respondWithAlias(ctx, response) {
  if (!response || response.ok !== true) {
    const failure = mapGoFailure(response && response.status, response && response.errorCode);
    writeJson(ctx, failure.status, { ok: false, error: failure.error });
    return true;
  }
  const data = response.data || {};
  await refreshProjection(ctx);
  writeJson(ctx, 200, { ok: true, alias: data.alias || null });
  return true;
}

async function readJsonBody(ctx) {
  const deps = ctx.deps || {};
  const result = await deps.readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .catch(() => null);
  if (!result) {
    writeJson(ctx, 400, { ok: false, error: 'invalid_request_body' });
    return null;
  }
  try {
    return JSON.parse(result.toString('utf8'));
  } catch (_error) {
    writeJson(ctx, 400, { ok: false, error: 'invalid_json' });
    return null;
  }
}

module.exports = { aliasRoutesGoOwned, handleAliasRouteViaGo };

