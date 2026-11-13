'use strict';

// WebUI 模型刷新的进程内入口（Go-first）。
//
// 旧的逐账号 Node 调度器及 'scheduler' 切换开关已彻底退役：
//   - 启动与请求入口：先加载持久化快照，再无条件挂上 6 小时 Go 批量同步（webui-model-cache-go-sync）；
//   - 显式全局刷新：优先调用 Go refreshWebUiModelCatalog（若可用），再通过 runWebUiModelCacheGoSync
//     把 Go 的 account_models 投影回 state.webUiModelsCache；
//   - 显式单账号刷新：并行调用 Go POST /v1/management/accounts/{ref}/models/refresh，
//     成功后同步刷新本地快照；Go 不可用或失败时只将对应账号标成 stale，绝不启动 Node 轮询。

const {
  ensureWebUiModelsCacheLoaded,
  markWebUiModelsCacheStale
} = require('./webui-model-cache');
const {
  ensureWebUiModelCacheGoSync,
  runWebUiModelCacheGoSync
} = require('./webui-model-cache-go-sync');

function resolveDeps(ctx) {
  return ctx && ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
}

function resolveOptions(ctx) {
  return ctx && ctx.options && typeof ctx.options === 'object' ? ctx.options : {};
}

function resolveCacheDeps(ctx) {
  const deps = resolveDeps(ctx);
  return {
    fs: ctx.fs || deps.fs,
    aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir
  };
}

function normalizeAccountRefs(accountRefs) {
  const list = Array.isArray(accountRefs) ? accountRefs : [accountRefs];
  return Array.from(new Set(list
    .map((ref) => String(ref || '').trim())
    .filter(Boolean)));
}

function listLiveAccountRefs(state) {
  const refs = [];
  const accounts = state && state.accounts;
  if (!accounts || typeof accounts !== 'object') return refs;
  for (const list of Object.values(accounts)) {
    for (const account of Array.isArray(list) ? list : []) {
      const ref = String(account && account.accountRef || '').trim();
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

// 只清 accountUpdatedAt（保留已发现目录）：页面继续显示旧模型，但账号回到
// 「待探测」，下一次 go-batch 批量同步或按需读取 Go 会把它补回来。
function markStale(ctx, refs) {
  if (!ctx || !ctx.state || !Array.isArray(refs) || refs.length === 0) return;
  try {
    markWebUiModelsCacheStale(ctx.state, resolveCacheDeps(ctx), refs);
  } catch (_error) {
    // 标记 stale 是尽力而为：持久化失败不能影响账号生命周期事件链。
  }
}

/**
 * 在 server 启动与 WebUI 路由入口调用：
 *   1. 载入磁盘持久化的模型快照到内存；
 *   2. 无条件启动 Go account_models 的批量同步调度。
 */
function ensureWebUiModelRefreshScheduler(ctx) {
  if (!ctx || !ctx.state) return;
  try {
    ensureWebUiModelsCacheLoaded(ctx.state, resolveCacheDeps(ctx));
  } catch (_error) {}
  ensureWebUiModelCacheGoSync(ctx);
}

/**
 * 显式触发模型目录刷新（账号启用/导入/凭据变更、模型页全局刷新）。
 *
 * accountRefs 为空表示全局刷新：Go-first 触发 refreshWebUiModelCatalog（若提供）并
 * 立即单飞批量同步 Go account_models（不接管 6 小时定时器）。
 * 传入 ref 时逐个调用 Go 的 refreshAccountModels，并在成功后回填本地快照；
 * Go 不可用或失败只把对应账号标成 stale，绝不抛错、绝不创建定时器。
 */
async function triggerWebUiModelRefreshSoon(ctx, accountRefs = null) {
  if (!ctx || !ctx.state) return null;
  const refs = normalizeAccountRefs(accountRefs);
  const deps = resolveDeps(ctx);
  const opts = resolveOptions(ctx);
  const readAccountModels = deps.readAccountModels
    || deps.goAccountModels
    || opts.readAccountModels
    || opts.goAccountModels;

  if (refs.length === 0) {
    const refreshCatalog = typeof deps.refreshWebUiModelCatalog === 'function'
      ? deps.refreshWebUiModelCatalog
      : (typeof opts.refreshWebUiModelCatalog === 'function' ? opts.refreshWebUiModelCatalog : null);
    let catalogTriggered = false;
    if (refreshCatalog) {
      try {
        const res = await refreshCatalog();
        catalogTriggered = Boolean(res && res.ok !== false);
      } catch (_error) {}
    }
    const result = await runWebUiModelCacheGoSync(ctx, {
      scheduleNext: false,
      forceFull: catalogTriggered
    });
    if (result) return { mode: 'go-batch', refreshed: true, stale: [] };

    const liveRefs = listLiveAccountRefs(ctx.state);
    markStale(ctx, liveRefs);
    return { mode: 'stale', refreshed: false, stale: liveRefs };
  }

  const refresh = typeof deps.refreshAccountModels === 'function'
    ? deps.refreshAccountModels
    : (typeof opts.refreshAccountModels === 'function' ? opts.refreshAccountModels : null);
  if (typeof refresh !== 'function') {
    markStale(ctx, refs);
    return { mode: 'stale', refreshed: false, stale: refs };
  }

  const settled = await Promise.allSettled(refs.map((ref) => Promise.resolve().then(() => refresh(ref))));
  const failed = [];
  settled.forEach((result, index) => {
    const response = result.status === 'fulfilled' ? result.value : null;
    if (result.status !== 'fulfilled' || !response || response.ok !== true) failed.push(refs[index]);
  });
  if (failed.length > 0) markStale(ctx, failed);
  if (failed.length === refs.length) {
    return { mode: 'stale', refreshed: false, stale: failed };
  }
  if (typeof readAccountModels === 'function') {
    await runWebUiModelCacheGoSync(ctx, { scheduleNext: false, forceFull: true }).catch(() => null);
  }
  return {
    mode: 'go',
    refreshed: true,
    stale: failed
  };
}

module.exports = {
  ensureWebUiModelRefreshScheduler,
  triggerWebUiModelRefreshSoon
};
