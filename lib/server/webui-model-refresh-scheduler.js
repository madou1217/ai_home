'use strict';

// WebUI 模型刷新的进程内入口。
//
// 旧的逐账号调度器（优先级插队 / 活跃窗口 / 启动补课 / 到期索引）已于 2026-11-07 退役，
// 见 docs/plans/2026-11-06-harness-models-parity.md「调度器退役」。当前语义：
//
//   go-batch（默认）→ 启动后一次 + 每 6 小时读一次 Go 的 account_models
//                     （节奏由 webui-model-cache-go-sync 负责）；
//   scheduler（legacy）→ 不创建任何定时器/轮询，只在显式触发时把账号标成 stale，
//                        由 WebUI 的按需读取或单账号刷新作业再探测。
//
// 保留 'scheduler' 枚举值是为了配置回退时不用改文件；它不再代表旧调度器。

const {
  ensureWebUiModelsCacheLoaded,
  markWebUiModelsCacheStale
} = require('./webui-model-cache');
const {
  MODEL_CACHE_SYNC_GO_BATCH,
  ensureWebUiModelCacheGoSync,
  resolveWebUiModelCacheSyncMode,
  runWebUiModelCacheGoSync
} = require('./webui-model-cache-go-sync');

function resolveDeps(ctx) {
  return ctx && ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
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
// 「待探测」，下一次 go-batch 批量同步或按需探测会把它补回来。
function markStale(ctx, refs) {
  if (!ctx || !ctx.state || !Array.isArray(refs) || refs.length === 0) return;
  try {
    markWebUiModelsCacheStale(ctx.state, resolveCacheDeps(ctx), refs);
  } catch (_error) {
    // 标记 stale 是尽力而为：持久化失败不能影响账号生命周期事件链。
  }
}

/**
 * 在 server 启动与每个 WebUI 请求上调用。
 *
 * - 两种模式都把持久化快照读进内存（路由/能力判定直接读 state.webUiModelsCache）；
 * - go-batch 只确保批量同步的 6 小时节奏已排上；
 * - legacy 不创建任何定时器。
 */
function ensureWebUiModelRefreshScheduler(ctx) {
  if (!ctx || !ctx.state) return;
  try {
    ensureWebUiModelsCacheLoaded(ctx.state, resolveCacheDeps(ctx));
  } catch (_error) {}
  if (resolveWebUiModelCacheSyncMode(ctx) === MODEL_CACHE_SYNC_GO_BATCH) {
    ensureWebUiModelCacheGoSync(ctx);
  }
}

/**
 * 显式触发模型目录刷新（账号启用/导入/凭据变更、模型页全局刷新）。
 *
 * accountRefs 为空表示全局刷新：
 *   - go-batch：立即单飞批量读一次 Go（不排下一次定时器）；
 *   - legacy：把运行池里的账号全部标成 stale，等按需探测。
 * 传入 ref 时逐个调用 Go 的 POST /v1/management/accounts/{ref}/models/refresh；
 * Go 不可用或失败只把对应账号标成 stale，绝不抛错、绝不创建定时器。
 */
async function triggerWebUiModelRefreshSoon(ctx, accountRefs = null) {
  if (!ctx || !ctx.state) return null;
  const refs = normalizeAccountRefs(accountRefs);

  if (refs.length === 0) {
    if (resolveWebUiModelCacheSyncMode(ctx) === MODEL_CACHE_SYNC_GO_BATCH) {
      const result = await runWebUiModelCacheGoSync(ctx, { scheduleNext: false });
      if (result) return { mode: 'go-batch', refreshed: true, stale: [] };
    }
    const liveRefs = listLiveAccountRefs(ctx.state);
    markStale(ctx, liveRefs);
    return { mode: 'stale', refreshed: false, stale: liveRefs };
  }

  const refresh = resolveDeps(ctx).refreshAccountModels;
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
