'use strict';

// WebUI 模型缓存的「批量读 Go」调度。
//
// 背景：旧的 webui-model-refresh-scheduler 是逐账号 GET/PROBE（3 个/批、60–120s 间隔），
// 万级账号要 55 小时才能轮一遍，永远追不上 6 小时的过期窗口。Go 侧已经有启动恢复、
// 6 小时 sweep 与生命周期刷新，Node 只需要把 Go 已经算好的整池目录投影回
// state.webUiModelsCache。
//
// 开关：config:server.modelCacheSync
//   'scheduler'（默认）→ 完全沿用旧调度器（webui-model-refresh-scheduler）
//   'go-batch'         → 旧调度器停用，改用本模块
// 开关在进程内只读一次（首次调用时记忆在模块内），切换后需要重启 server 才生效。

const { refreshWebUiModelsCacheFromGo } = require('./webui-model-cache');

const MODEL_CACHE_SYNC_SCHEDULER = 'scheduler';
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

function readServerConfigFor(ctx) {
  const deps = ctx && ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const read = (ctx && typeof ctx.readServerConfig === 'function' && ctx.readServerConfig)
    || (typeof deps.readServerConfig === 'function' ? deps.readServerConfig : null);
  if (read) {
    try {
      return read() || {};
    } catch (_error) {
      return {};
    }
  }
  try {
    return require('./server-config-store').readServerConfig({
      fs: ctx && (ctx.fs || deps.fs),
      aiHomeDir: ctx && (ctx.aiHomeDir || deps.aiHomeDir)
    }) || {};
  } catch (_error) {
    return {};
  }
}

// 开关只在进程内解析一次：用 WeakMap 记账，配置变更要重启 server 才生效。
// 不写进 state：scheduler 默认路径的 state 形状与接线前保持逐字节一致。
const syncModes = new WeakMap();
function resolveWebUiModelCacheSyncMode(ctx) {
  const state = ctx && ctx.state;
  if (state && syncModes.has(state)) return syncModes.get(state);
  const config = readServerConfigFor(ctx);
  const mode = config.modelCacheSync === MODEL_CACHE_SYNC_GO_BATCH
    ? MODEL_CACHE_SYNC_GO_BATCH
    : MODEL_CACHE_SYNC_SCHEDULER;
  if (state) syncModes.set(state, mode);
  return mode;
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
function runWebUiModelCacheGoSync(ctx) {
  const state = ctx && ctx.state;
  if (!state) return Promise.resolve(null);
  const sync = getWebUiModelCacheGoSyncState(state);
  if (sync.running) return sync.running;

  const deps = ctx.deps && typeof ctx.deps === 'object' ? ctx.deps : {};
  const readAccountModels = deps.readAccountModels || deps.goAccountModels;
  const attemptAt = nowFor(ctx);
  sync.lastAttemptAt = attemptAt;

  const promise = (async () => {
    try {
      if (typeof readAccountModels !== 'function') {
        sync.lastError = 'go_model_catalog_reader_missing';
        return null;
      }
      const result = await refreshWebUiModelsCacheFromGo(state, ctx.options || {}, {
        fs: ctx.fs || deps.fs,
        aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
        readAccountModels,
        nodeAccountRefFor: deps.nodeAccountRefFor,
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
      scheduleNextGoSync(ctx, GO_SYNC_INTERVAL_MS);
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

/** 启动后一次：go-batch 模式下由旧调度器的入口分派到这里。 */
function ensureWebUiModelCacheGoSync(ctx) {
  if (!ctx || !ctx.state) return;
  const sync = getWebUiModelCacheGoSyncState(ctx.state);
  if (sync.timer || sync.running) return;
  scheduleNextGoSync(ctx, GO_SYNC_STARTUP_DELAY_MS);
}

/** 手动「刷新模型」（全局）在 go-batch 模式下等价于重新批量读一次 Go。 */
function triggerWebUiModelCacheGoSync(ctx) {
  return runWebUiModelCacheGoSync(ctx);
}

/**
 * 别名保存 / 候选读取前的缓存新鲜度检查：超过 30 秒才再拉一次。
 *
 * 同时看三个时间戳：本模块的上次成功/尝试时刻与快照自身的 updatedAt。后者让 Node
 * 显式刷新（单账号探测）刚写出的新目录也能命中，不必再整池读一遍 Go。
 */
async function syncWebUiModelsCacheFromGoIfStale(ctx) {
  if (!ctx || !ctx.state) return false;
  if (resolveWebUiModelCacheSyncMode(ctx) !== MODEL_CACHE_SYNC_GO_BATCH) return false;
  const sync = getWebUiModelCacheGoSyncState(ctx.state);
  const now = nowFor(ctx);
  const cacheUpdatedAt = Number(ctx.state.webUiModelsCache && ctx.state.webUiModelsCache.updatedAt) || 0;
  const lastFreshAt = Math.max(
    Number(sync.lastSyncAt) || 0,
    Number(sync.lastAttemptAt) || 0,
    cacheUpdatedAt
  );
  if (lastFreshAt > 0 && now - lastFreshAt < GO_SYNC_FRESH_MS) return false;
  if (sync.running) {
    await sync.running;
    return true;
  }
  await runWebUiModelCacheGoSync(ctx);
  return true;
}

module.exports = {
  GO_SYNC_INTERVAL_MS,
  GO_SYNC_FRESH_MS,
  MODEL_CACHE_SYNC_GO_BATCH,
  MODEL_CACHE_SYNC_SCHEDULER,
  ensureWebUiModelCacheGoSync,
  getWebUiModelCacheGoSyncState,
  resolveWebUiModelCacheSyncMode,
  runWebUiModelCacheGoSync,
  syncWebUiModelsCacheFromGoIfStale,
  triggerWebUiModelCacheGoSync
};
