'use strict';

// WebUI 模型缓存的「批量读 Go」调度（Go-first，无条件启用）。
//
// 背景：旧的逐账号调度器（3 个/批、60–120s 间隔）在万级账号下追不上 6 小时过期窗口。
// Go 侧已经有启动恢复、6 小时 sweep 与生命周期刷新，Node 无条件把 Go 算好的整池
// account_models 投影回 state.webUiModelsCache（启动后一次 + 每 6 小时一次 +
// 别名保存/候选读取前 30 秒节流校验）。

const { refreshWebUiModelsCacheFromGo } = require('./webui-model-cache');

const MODEL_CACHE_SYNC_GO_BATCH = 'go-batch';
// 与 Go 的 6 小时全量重扫同节奏：Node 只负责读取投影，不额外制造刷新压力。
const GO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 别名保存 / 候选读取前的缓存新鲜度门槛：30 秒内的重复读取直接命中内存快照。
const GO_SYNC_FRESH_MS = 30 * 1000;
// 启动后先让账号池与 Go 完成对账，再拉第一份目录。
const GO_SYNC_STARTUP_DELAY_MS = 1000;

function getWebUiModelCacheGoSyncState(state) {
  if (!state.webUiModelCacheGoSync || typeof state.webUiModelCacheGoSync !== 'object') {
    state.webUiModelCacheGoSync = {
      timer: null,
      running: null,
      lastSyncAt: 0,
      lastAttemptAt: 0,
      lastError: ''
    };
  }
  return state.webUiModelCacheGoSync;
}

// 统一收敛为 go-batch（Go-first），不再保留切换回 legacy scheduler 的分支。
function resolveWebUiModelCacheSyncMode(_ctx) {
  return MODEL_CACHE_SYNC_GO_BATCH;
}

function nowFor(ctx) {
  const deps = ctx && ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  if (typeof deps.now === 'function') {
    const value = Number(deps.now());
    if (Number.isFinite(value)) return value;
  }
  return Date.now();
}

function scheduleNextGoSync(ctx, delayMs) {
  const state = ctx && ctx.state;
  if (!state) return;
  const sync = getWebUiModelCacheGoSyncState(state);
  if (sync.timer) clearTimeout(sync.timer);
  sync.timer = setTimeout(() => {
    sync.timer = null;
    runWebUiModelCacheGoSync(ctx).catch(() => {});
  }, Math.max(1, Math.round(Number(delayMs) || GO_SYNC_INTERVAL_MS)));
  if (sync.timer && typeof sync.timer.unref === 'function') sync.timer.unref();
}

/**
 * 立即批量读一次 Go，并把结果写回 state.webUiModelsCache。
 *
 * 单飞：同一进程同时只允许一个批量读。Go 不可用/失败时保留旧缓存并返回 null，
 * 绝不抛错（调用方包含 WebUI 请求路径，失败不能升级成 500）。
 */
function runWebUiModelCacheGoSync(ctx, options = {}) {
  const state = ctx && ctx.state;
  if (!state) return Promise.resolve(null);
  const sync = getWebUiModelCacheGoSyncState(state);
  if (sync.running) return sync.running;

  const deps = ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const ctxOptions = ctx.options && typeof ctx.options === 'object' ? ctx.options : {};
  const readAccountModels = deps.readAccountModels
    || deps.goAccountModels
    || ctxOptions.readAccountModels
    || ctxOptions.goAccountModels;
  const nodeAccountRefFor = typeof deps.nodeAccountRefFor === 'function'
    ? deps.nodeAccountRefFor
    : (typeof ctxOptions.nodeAccountRefFor === 'function' ? ctxOptions.nodeAccountRefFor : null);
  const attemptAt = nowFor(ctx);
  sync.lastAttemptAt = attemptAt;

  const promise = (async () => {
    try {
      if (typeof readAccountModels !== 'function') {
        sync.lastError = 'go_model_catalog_reader_missing';
        return null;
      }
      const result = await refreshWebUiModelsCacheFromGo(state, ctxOptions, {
        fs: ctx.fs || deps.fs,
        aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
        readAccountModels,
        nodeAccountRefFor,
        forceFull: options.forceFull === true,
        // 用同一次尝试的时间戳写 updatedAt：失败遗留的旧快照不会被误判成「刚同步过」。
        now: () => attemptAt
      });
      if (!result) {
        sync.lastError = 'go_model_catalog_unavailable';
        return null;
      }
      sync.lastSyncAt = attemptAt;
      sync.lastError = '';
      return result;
    } catch (error) {
      sync.lastError = String((error && error.message) || error || 'go_model_cache_sync_failed');
      return null;
    } finally {
      // 手动触发（triggerWebUiModelRefreshSoon）只读一次，不接管 6 小时节奏；
      // 节奏只由 ensureWebUiModelCacheGoSync / 上一轮定时同步负责。
      if (options.scheduleNext !== false) scheduleNextGoSync(ctx, GO_SYNC_INTERVAL_MS);
    }
  })();

  sync.running = promise;
  promise.then(() => {
    if (sync.running === promise) sync.running = null;
  }, () => {
    if (sync.running === promise) sync.running = null;
  });
  return promise;
}

/** 启动后一次：由 webui-model-refresh-scheduler 入口无条件分派到这里。 */
function ensureWebUiModelCacheGoSync(ctx) {
  if (!ctx || !ctx.state) return;
  const sync = getWebUiModelCacheGoSyncState(ctx.state);
  if (sync.timer || sync.running) return;
  scheduleNextGoSync(ctx, GO_SYNC_STARTUP_DELAY_MS);
}

/** 手动「刷新模型」（全局）在 Go-first 模式下直接触发批量读一次 Go。 */
function triggerWebUiModelCacheGoSync(ctx, options = {}) {
  return runWebUiModelCacheGoSync(ctx, options);
}

/**
 * 别名保存 / 候选读取前的缓存新鲜度检查：超过 30 秒才再拉一次 Go。
 *
 * 同时看三个时间戳：本模块的上次成功/尝试时刻与快照自身的 updatedAt。
 */
async function syncWebUiModelsCacheFromGoIfStale(ctx, options = {}) {
  if (!ctx || !ctx.state) return false;
  const sync = getWebUiModelCacheGoSyncState(ctx.state);
  const now = nowFor(ctx);
  const cacheUpdatedAt = Number(ctx.state.webUiModelsCache && ctx.state.webUiModelsCache.updatedAt) || 0;
  const lastFreshAt = Math.max(
    Number(sync.lastSyncAt) || 0,
    Number(sync.lastAttemptAt) || 0,
    cacheUpdatedAt
  );
  if (options.force !== true && lastFreshAt > 0 && now - lastFreshAt < GO_SYNC_FRESH_MS) return false;
  if (sync.running) {
    await sync.running;
    return true;
  }
  await runWebUiModelCacheGoSync(ctx, options);
  return true;
}

module.exports = {
  GO_SYNC_INTERVAL_MS,
  GO_SYNC_FRESH_MS,
  MODEL_CACHE_SYNC_GO_BATCH,
  ensureWebUiModelCacheGoSync,
  getWebUiModelCacheGoSyncState,
  resolveWebUiModelCacheSyncMode,
  runWebUiModelCacheGoSync,
  syncWebUiModelsCacheFromGoIfStale,
  triggerWebUiModelCacheGoSync
};
