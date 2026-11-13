'use strict';

// WebUI 数据面：账号「窗口激活」开关与间隔的读写薄壳。
//
// 设置本身（账号/Provider 校验、间隔上下限、app_kv 落盘、账本视图）已经划给 Go
// （internal/transport/http/webuiwindowactivationapi）。Node 只剩两件事：
//   1. Provider 能力闸门：窗口激活依赖 Node 的探测规格注册表（probe-specs），
//      只有登记了探测规格的 Provider 才能配置——这是能力事实，仍由 Node 判定；
//   2. 合并运行中的调度器全局状态（global，见 window-activation-scheduler.js），
//      并把它上报的 minIntervalMs 作为本次写入的间隔下限交给 Go。
//
// 持久化在 app_kv 键 account:window-activation:<ref>
// 与 account:window-activation-state:<ref>，由 Go 独占读写。
//
// 与 /update 路由分开：那条路由针对凭据编辑，与「是否参与某个后台调度」不是一回事，
// 单独一条路由语义更干净（与 zcode 出口绑定同样的取舍）。

const { listProbeProviders } = require('./window-activation/probe-specs');
const { readServerConfig } = require('./server-config-store');
const { callGoHost, writeGoFailure } = require('./webui-go-proxy');

const WINDOW_ACTIVATION_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/window-activation$/;
// 间隔下限的兜底值（= 调度器默认 windowActivationMinIntervalMs，1 小时）。运行时优先用
// 调度器上报的 minIntervalMs：两侧同源，填更小的值会被明确拒绝，而不是被静默抬升。
// 上限与入参校验在 Go，这里只负责把运行态下限带过去。
const DEFAULT_MIN_INTERVAL_MS = 60 * 60 * 1000;

// 支持的 provider 以探测规格注册表为准（当前 codex / agy），新增 spec 自动放开。
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
    || env.AIH_HOME_DIR
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

// 读 Go 的账号视图；宿主缺失/调用抛错都归一成 response:null，由调用方决定落笔。
async function loadAccountView(ctx, provider, accountRef) {
  return callGoHost(ctx, 'getWindowActivation', [provider, accountRef]);
}

function hasAccountView(view) {
  return Boolean(view && view.response && view.response.ok === true && view.response.data);
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

  const method = String((ctx.req && ctx.req.method) || '').toUpperCase();
  const globalState = readGlobalState(ctx, aiHomeDir);

  if (method === 'GET') {
    const view = await loadAccountView(ctx, provider, accountRef);
    if (!hasAccountView(view)) {
      // 成功原样回 data；400/404/409 由 proxy 透传，宿主缺失/其余失败回 503。
      writeGoFailure(ctx, view.response, { message: 'Go Core 未就绪，窗口激活不可读' });
      return true;
    }
    writeJson(ctx.res, 200, { ...view.response.data, global: globalState });
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

  // 下限与调度器同源：用运行态上报的 minIntervalMs（未上报时用 1 小时兜底）。
  // 入参本体（enabled / intervalMs）原样交给 Go：校验与持久化都在 Go。
  const minIntervalMs = Number.isFinite(Number(globalState.minIntervalMs)) && Number(globalState.minIntervalMs) > 0
    ? Math.floor(Number(globalState.minIntervalMs))
    : DEFAULT_MIN_INTERVAL_MS;

  const write = await callGoHost(ctx, 'saveWindowActivationConfig',
    [provider, accountRef, { ...payload, minIntervalMs }]);
  if (!write.available) {
    writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，窗口激活设置不可写' });
    return true;
  }
  const saved = write.response;
  if (!saved || saved.ok !== true) {
    // 写失败固定成一个码（与改动前一致）：入参问题由 Go 的 400 透传，其余细节不外抛。
    writeGoFailure(ctx, saved, {
      passStatuses: [400, 404, 409],
      fallbackStatus: 500,
      fallbackCode: 'window_activation_write_failed'
    });
    return true;
  }

  const view = await loadAccountView(ctx, provider, accountRef);
  if (!hasAccountView(view)) {
    // 写后读回失败也固定成一个码：写入已成功，但视图不可读，仍回 500。
    writeGoFailure(ctx, { ok: false }, {
      passStatuses: [],
      fallbackStatus: 500,
      fallbackCode: 'window_activation_read_failed'
    });
    return true;
  }
  writeJson(ctx.res, 200, { ...view.response.data, global: globalState });
  return true;
}

module.exports = {
  WINDOW_ACTIVATION_ROUTE_PATTERN,
  DEFAULT_MIN_INTERVAL_MS,
  handleWindowActivationRequest,
  matchWindowActivationRoute,
  parseWindowActivationRoute,
  presentGlobalState
};
