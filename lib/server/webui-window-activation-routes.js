'use strict';

// WebUI 数据面：账号「窗口激活」开关与间隔的读写，以及该账号的窗口状态。
//
// 背景见 window-activation-scheduler.js：滚动限额窗口只在账号被使用时才前进，
// 调度器在窗口关闭后补一个极小探测让窗口继续滚动。本路由只负责这一项账号级设置的
// HTTP 边界：解析路径、校验入参、调 store、回 JSON。
// 持久化在 lib/account/window-activation-store.js（app_kv 键 account:window-activation:<ref>
// 与 account:window-activation-state:<ref>）。
//
// 窗口状态（window 字段）直接复用调度器的 describeWindowView：展示与决策同源，
// 避免账号页说「窗口运行中」而调度器其实认为该续窗了。
//
// 与 /update 路由分开：那条路由针对凭据编辑，与「是否参与某个后台调度」不是一回事，
// 单独一条路由语义更干净（与 zcode 出口绑定同样的取舍，见 webui-zcode-egress-routes.js）。

const {
  readWindowActivationConfig,
  readWindowActivationState,
  writeWindowActivationConfig
} = require('../account/window-activation-store');
const { listProbeProviders } = require('./window-activation/probe-specs');
const { describeWindowView } = require('./window-activation/window-ledger');
const { resolveAccountRef } = require('./account-ref-store');
const { readServerConfig } = require('./server-config-store');

const WINDOW_ACTIVATION_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/window-activation$/;
// 间隔下限的兜底值（= 调度器默认 windowActivationMinIntervalMs，1 小时）。运行时优先用
// 调度器上报的 minIntervalMs：两侧同源，填更小的值会被明确拒绝，而不是被静默抬升。
const MIN_INTERVAL_MS = 60 * 60 * 1000;
const MAX_INTERVAL_MS = 365 * 24 * 60 * 60 * 1000;

// 支持的 provider 以探测规格注册表为准（当前仅 codex），新增 spec 自动放开。
const SUPPORTED_PROVIDERS = new Set(listProbeProviders());

function parseWindowActivationRoute(pathname) {
  const match = WINDOW_ACTIVATION_ROUTE_PATTERN.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return {
      provider: decodeURIComponent(match[1]).trim().toLowerCase(),
      accountRef: decodeURIComponent(match[2]).trim()
    };
  } catch {
    return null;
  }
}

function resolveAiHomeDir(ctx) {
  const processObj = (ctx && ctx.processObj) || process;
  const env = processObj.env || {};
  return String(
    (ctx && ctx.aiHomeDir)
    || (ctx && ctx.state && ctx.state.aiHomeDir)
    || env.AI_HOME_DIR
    || env.AIH_HOME
    || ''
  ).trim();
}

function matchWindowActivationRoute(method, pathname) {
  const verb = String(method || '').toUpperCase();
  return WINDOW_ACTIVATION_ROUTE_PATTERN.test(String(pathname || '')) && (verb === 'GET' || verb === 'POST');
}

function resolveRouteDependency(ctx, name, fallback) {
  const injected = ctx && ctx.deps && ctx.deps[name];
  return typeof injected === 'function' ? injected : fallback;
}

function presentSetting(config) {
  return {
    enabled: Boolean(config && config.enabled === true),
    intervalMs: config && Number.isFinite(Number(config.intervalMs)) && Number(config.intervalMs) > 0
      ? Math.floor(Number(config.intervalMs))
      : null
  };
}

/**
 * 全局闸门状态：逐账号开关之外还有一道全局 opt-in（默认关）。
 * 两道闸门都开着才会真正探测，所以账号页必须能看见它，否则开关看起来「开了但没反应」。
 *
 * @param {object|null} running 运行中的调度器状态（getState()），未装配/未启动时为 null
 * @param {object} savedConfig  保存的 server 配置（`aih server config set` 的落盘形态）
 */
function presentGlobalState(running, savedConfig = {}) {
  const savedEnabled = savedConfig.windowActivation === true;
  const runningEnabled = running && typeof running.enabled === 'boolean' ? running.enabled : null;
  const toMsOrNull = (value) => (
    Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : null
  );
  return {
    // 当前生效（本进程）；null 表示宿主没有上报（旧版本 / 未装配）。
    enabled: runningEnabled,
    // 已保存的配置：重启后生效。
    savedEnabled,
    restartRequired: runningEnabled !== null && runningEnabled !== savedEnabled,
    defaultIntervalMs: running ? toMsOrNull(running.defaultIntervalMs) : null,
    minIntervalMs: running ? toMsOrNull(running.minIntervalMs) : null
  };
}

function presentLastProbe(state) {
  const at = state && Number.isFinite(Number(state.lastProbeAt)) ? Math.floor(Number(state.lastProbeAt)) : 0;
  return {
    at: at > 0 ? at : 0,
    outcome: state && typeof state.lastOutcome === 'string' ? state.lastOutcome.trim() : ''
  };
}

/**
 * 窗口状态：把账本翻成「现在窗口开着没开、下一次什么时候动作、上一次为什么没探」。
 * 视图来源与调度器完全一致（describeWindowView），账号页不会与调度器分叉。
 *
 * kind: open=运行中 / closed=已过关闭时刻待续窗 / absent=没有活跃窗口待补窗 / unknown=观察不出
 */
function presentWindowState(state, nowMs = Date.now()) {
  const view = describeWindowView({
    windowAnchorAtMs: state && state.windowAnchorAtMs,
    windowMinutes: state && state.windowMinutes,
    windowCloseAtMs: state && state.windowCloseAtMs,
    windowSource: state && state.windowSource,
    windowObservedAtMs: state && state.windowObservedAtMs,
    probeFailureCount: state && state.probeFailureCount
  }, nowMs);
  const failureCount = Number(state && state.probeFailureCount);
  const decisionAt = Number(state && state.lastDecisionAtMs);
  return {
    kind: view.kind,
    anchorAtMs: view.anchorAtMs,
    closeAtMs: view.closeAtMs,
    windowMinutes: view.windowMinutes,
    remainingMs: view.remainingMs,
    source: view.source,
    observedAtMs: view.observedAtMs,
    nextActionAtMs: view.nextActionAtMs,
    probeFailureCount: Number.isFinite(failureCount) && failureCount > 0 ? Math.floor(failureCount) : 0,
    lastDecision: {
      action: state && typeof state.lastDecisionAction === 'string' ? state.lastDecisionAction.trim() : '',
      reason: state && typeof state.lastDecisionReason === 'string' ? state.lastDecisionReason.trim() : '',
      at: Number.isFinite(decisionAt) && decisionAt > 0 ? Math.floor(decisionAt) : 0
    }
  };
}

// 全局状态是「提示性」数据：任何一路读不到都不能让账号设置的读写失败。
function readGlobalState(ctx, aiHomeDir) {
  let running = null;
  const getState = resolveRouteDependency(ctx, 'getWindowActivationState', null);
  if (typeof getState === 'function') {
    try {
      running = getState() || null;
    } catch (_stateError) {
      running = null;
    }
  }
  let saved = {};
  const injectedRead = ctx && ctx.deps ? ctx.deps.readServerConfig : null;
  try {
    // 宿主注入的 reader 是零参闭包（server.js 的 WebUI deps）；没有注入时直读 store。
    saved = (typeof injectedRead === 'function'
      ? injectedRead()
      : readServerConfig({ fs: ctx.fs, aiHomeDir })) || {};
  } catch (_configError) {
    saved = {};
  }
  return presentGlobalState(running, saved);
}

// 账号状态是「提示性」数据：读不到 / 损坏一律按「无记录」展示，绝不影响设置的读写。
function readAccountStateSafe(ctx, aiHomeDir, accountRef) {
  const readState = resolveRouteDependency(ctx, 'readWindowActivationState', readWindowActivationState);
  try {
    return readState(ctx.fs, aiHomeDir, accountRef) || null;
  } catch (_stateError) {
    return null;
  }
}

function buildAccountPayload(ctx, aiHomeDir, accountRef, provider, setting, globalState) {
  const accountState = readAccountStateSafe(ctx, aiHomeDir, accountRef);
  return {
    ok: true,
    provider,
    accountRef,
    setting,
    global: globalState,
    lastProbe: presentLastProbe(accountState),
    window: presentWindowState(accountState)
  };
}

/**
 * GET  /v0/webui/accounts/:provider/:accountRef/window-activation  读当前设置
 * POST /v0/webui/accounts/:provider/:accountRef/window-activation  写入设置
 *
 * POST body: { enabled: boolean, intervalMs?: number|null }
 *   intervalMs 为 null/缺省表示「跟随全局默认间隔」。
 *
 * @returns {Promise<boolean>} 是否已处理该请求
 */
async function handleWindowActivationRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const parsed = parseWindowActivationRoute(pathname);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'window_activation_unsupported_provider' });
    return true;
  }
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 503, { ok: false, error: 'ai_home_dir_unavailable' });
    return true;
  }

  let account = null;
  try {
    account = resolveAccountRef(ctx.fs, aiHomeDir, accountRef, { bestEffort: true });
  } catch {
    account = null;
  }
  if (!account) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  if (String(account.provider || '').trim().toLowerCase() !== provider) {
    writeJson(ctx.res, 409, { ok: false, error: 'account_provider_mismatch' });
    return true;
  }

  const readConfig = resolveRouteDependency(ctx, 'readWindowActivationConfig', readWindowActivationConfig);
  const writeConfig = resolveRouteDependency(ctx, 'writeWindowActivationConfig', writeWindowActivationConfig);
  const method = String(ctx.req && ctx.req.method || '').toUpperCase();

  if (method === 'GET') {
    let config;
    try {
      config = readConfig(ctx.fs, aiHomeDir, accountRef);
    } catch {
      writeJson(ctx.res, 500, { ok: false, error: 'window_activation_read_failed' });
      return true;
    }
    writeJson(ctx.res, 200, buildAccountPayload(
      ctx,
      aiHomeDir,
      accountRef,
      provider,
      presentSetting(config),
      readGlobalState(ctx, aiHomeDir)
    ));
    return true;
  }

  let payload;
  try {
    const body = await ctx.readRequestBody(ctx.req, { maxBytes: 16 * 1024 });
    payload = body ? JSON.parse(body.toString('utf8')) : {};
  } catch {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }

  const enabled = payload.enabled === true;
  // 下限与调度器同源：用运行态上报的 minIntervalMs（未上报时用 1 小时兜底）。
  const globalState = readGlobalState(ctx, aiHomeDir);
  const minIntervalMs = Number.isFinite(Number(globalState.minIntervalMs)) && Number(globalState.minIntervalMs) > 0
    ? Math.floor(Number(globalState.minIntervalMs))
    : MIN_INTERVAL_MS;
  let intervalMs = null;
  if (payload.intervalMs !== null && payload.intervalMs !== undefined && payload.intervalMs !== '') {
    const value = Number(payload.intervalMs);
    if (!Number.isFinite(value) || value < minIntervalMs || value > MAX_INTERVAL_MS) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_interval_ms', minIntervalMs });
      return true;
    }
    intervalMs = Math.floor(value);
  }

  try {
    writeConfig(ctx.fs, aiHomeDir, accountRef, { enabled, intervalMs });
  } catch {
    writeJson(ctx.res, 500, { ok: false, error: 'window_activation_write_failed' });
    return true;
  }

  let config;
  try {
    config = readConfig(ctx.fs, aiHomeDir, accountRef);
  } catch {
    writeJson(ctx.res, 500, { ok: false, error: 'window_activation_read_failed' });
    return true;
  }
  writeJson(ctx.res, 200, buildAccountPayload(
    ctx,
    aiHomeDir,
    accountRef,
    provider,
    presentSetting(config),
    globalState
  ));
  return true;
}

module.exports = {
  WINDOW_ACTIVATION_ROUTE_PATTERN,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  handleWindowActivationRequest,
  matchWindowActivationRoute,
  parseWindowActivationRoute,
  presentGlobalState,
  presentLastProbe,
  presentWindowState
};
