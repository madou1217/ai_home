'use strict';

// GET /v0/webui/provider-cli-upgrade —— provider CLI 自动升级的只读状态面。
//
// 只读是刻意的，不是暂缺：这条路由不提供「立刻跑一轮」。一轮 cycle 会 spawn 真二进制
// （codex 的强判据要起一次 app-server，十几秒）并走 npm 网络查询，挂在 HTTP 处理器里
// 要么让调用方干等十几秒，要么撞上 state.cycling 拿一个 already_running —— 两种都不是
// 按钮该有的语义。手动触发如果要做，得走 app-install 那套异步作业队列，是另一件事。
//
// 数据有两个来源，可用性不同，所以分开取：
//   - 账本（~/.ai_home/run/provider-cli-upgrade.json）：只要 fs + aiHomeDir 就能读，
//     routeCtx 天然带着，不需要 server.js 额外接线，也让这条路由能脱离 server 单测。
//   - 调度器实例：只有 startLocalServer 起来的进程里才有，缺席时报 scheduler: null，
//     而不是让整条路由 500。
//
// provider 列表取「调度器候选 ∪ 账本已有键」的并集：server 刚起的头 5 分钟账本还是空的
// （readLedger 对 ENOENT 回落空账本），此时若只按账本枚举，页面会是一片空白而不是
// 「待首轮检查」。空白看起来像功能没生效，是最糟的那种默认视图。

const { readLedger, readProviderRecord } = require('./provider-cli-upgrade/upgrade-ledger');
const { listUpgradeCandidateProviders } = require('./provider-cli-upgrade/upgrade-deps');

const ROUTE_PATH = '/v0/webui/provider-cli-upgrade';
const HISTORY_LIMIT = 5;

function writeJson(ctx, status, payload) {
  if (typeof ctx.writeJson === 'function') {
    ctx.writeJson(ctx.res, status, payload);
    return;
  }
  ctx.res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  ctx.res.end(JSON.stringify(payload));
}

function resolveScheduler(ctx) {
  const deps = ctx.deps || {};
  const scheduler = ctx.providerCliUpgradeScheduler || deps.providerCliUpgradeScheduler;
  return scheduler && typeof scheduler.getState === 'function' ? scheduler : null;
}

function safeSchedulerState(scheduler) {
  if (!scheduler) return null;
  try {
    const state = scheduler.getState() || {};
    return {
      running: Boolean(state.running),
      cycling: Boolean(state.cycling),
      enabled: Boolean(state.enabled),
      applyEnabled: Boolean(state.applyEnabled),
      intervalMs: Number(state.intervalMs) || 0,
      startDelayMs: Number(state.startDelayMs) || 0,
      tickCount: Number(state.tickCount) || 0,
      providers: Array.isArray(state.providers) ? state.providers.slice() : [],
      lastResult: state.lastResult || null,
      lastError: String(state.lastError || '')
    };
  } catch (_error) {
    // 状态面读不出来不该盖掉账本那半边。
    return null;
  }
}

function listCandidateProviders() {
  try {
    return listUpgradeCandidateProviders();
  } catch (_error) {
    return [];
  }
}

function collectProviders(schedulerState, ledger) {
  const fromScheduler = schedulerState && schedulerState.providers.length
    ? schedulerState.providers
    : listCandidateProviders();
  const fromLedger = Object.keys((ledger && ledger.providers) || {});
  return Array.from(new Set([...fromScheduler, ...fromLedger]));
}

/**
 * 「有新版可用」= 远端版本与本地不同，且没被拉黑。
 * 已拉黑的版本闭环永远不会再装，把它显示成「有新版」只会让人白等。
 */
function isUpdateAvailable(record) {
  const latest = String(record.latestVersion || '').trim();
  const installed = String(record.installedVersion || '').trim();
  if (!latest || !installed) return false;
  if (latest === installed) return false;
  return !record.blockedVersions.includes(latest);
}

function projectProvider(provider, ledger, schedulerState) {
  const record = readProviderRecord(ledger, provider);
  const tick = (schedulerState && schedulerState.lastResult && schedulerState.lastResult.providers) || {};
  const lastTick = tick[provider] || null;
  return {
    provider,
    state: record.state,
    channel: record.channel,
    enabled: record.enabled,
    disabledReason: record.disabledReason,
    installedVersion: record.installedVersion,
    latestVersion: record.latestVersion,
    targetVersion: record.targetVersion,
    knownGoodVersion: record.knownGoodVersion,
    knownGoodRollbackable: record.knownGoodRollbackable,
    baselineHealthy: record.baselineHealthy,
    updateAvailable: isUpdateAvailable(record),
    blockedVersions: record.blockedVersions,
    shadowedNpmInstall: record.shadowedNpmInstall,
    resolvedPath: record.resolvedPath,
    lastCheckAt: record.lastCheckAt,
    lastCheckError: record.lastCheckError,
    lastApplyAt: record.lastApplyAt,
    lastApplyError: record.lastApplyError,
    lastDeferReason: record.lastDeferReason,
    consecutiveFailures: record.consecutiveFailures,
    consecutiveDefers: record.consecutiveDefers,
    consecutiveQuiescentTicks: record.consecutiveQuiescentTicks,
    soakUnknownCount: record.soakUnknownCount,
    lastTickState: lastTick ? String(lastTick.state || '') : '',
    lastTickReason: lastTick ? String(lastTick.reason || '') : '',
    // 完整 history 最多 20 条，面板只需要最近几条就够看出趋势。
    history: record.history.slice(-HISTORY_LIMIT)
  };
}

function buildProviderCliUpgradeStatus(ctx = {}) {
  const deps = ctx.deps || {};
  const fs = ctx.fs || deps.fs;
  const aiHomeDir = ctx.aiHomeDir || deps.aiHomeDir;
  const schedulerState = safeSchedulerState(resolveScheduler(ctx));
  const ledger = readLedger(aiHomeDir, { fs });
  const providers = collectProviders(schedulerState, ledger);
  return {
    ok: true,
    scheduler: schedulerState,
    global: {
      enabled: (ledger.global || {}).enabled !== false,
      disabledReason: String((ledger.global || {}).disabledReason || '')
    },
    providers: providers.map((provider) => projectProvider(provider, ledger, schedulerState))
  };
}

async function handleProviderCliUpgradeRoutes(ctx = {}) {
  if (ctx.pathname !== ROUTE_PATH) return false;
  if (ctx.method !== 'GET') {
    writeJson(ctx, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  writeJson(ctx, 200, buildProviderCliUpgradeStatus(ctx));
  return true;
}

module.exports = {
  ROUTE_PATH,
  HISTORY_LIMIT,
  buildProviderCliUpgradeStatus,
  handleProviderCliUpgradeRoutes
};
