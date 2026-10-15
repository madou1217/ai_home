'use strict';

// WebUI 的 kiro 原生登录入口（A 设备码 / B refresh_token）—— 不经过本地 kiro CLI / Kiro IDE。
//
// 形状与 kimi 的 desktop-session 一致：start 返回给用户看的东西，poll 由浏览器驱动推进。
// 区别在于**状态必须留在服务端**：设备码轮询要带着 device-registration（含 client_secret），
// 而 client_secret 绝不允许下发到浏览器 —— 所以 start 只回一个不透明 flowId，
// registration / deviceCode 存在进程内的短期注册表里（TTL 与设备码有效期一致）。

const crypto = require('node:crypto');
const {
  beginKiroDeviceLogin,
  buildKiroAuthRow,
  commitKiroCredential,
  importKiroRefreshToken,
  pollKiroDeviceLogin
} = require('../account/kiro-device-login');
const { resolveLoginRuntimeDir } = require('../runtime/aih-storage-layout');

const FLOW_TTL_MS = 15 * 60 * 1000;
const MAX_FLOWS = 16;
// 必须显式给 fetchWithTimeout 一个正整数超时（见 resolveRequest）。
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

/** 短期流程注册表：只放内存（登录是分钟级交互，服务重启后重新发起即可）。 */
function createKiroNativeLoginStore(options = {}) {
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : FLOW_TTL_MS;
  const maxFlows = Number(options.maxFlows) > 0 ? Number(options.maxFlows) : MAX_FLOWS;
  const now = options.now || Date.now;
  const flows = new Map();

  function prune() {
    const current = now();
    for (const [id, flow] of flows) {
      if (!flow || current - flow.createdAtMs > ttlMs) flows.delete(id);
    }
    // 上限兜底：最旧的先丢，避免有人无限开流程把内存撑住。
    while (flows.size >= maxFlows) {
      const oldest = flows.keys().next();
      if (oldest.done) break;
      flows.delete(oldest.value);
    }
  }

  return {
    put(flow) {
      prune();
      const flowId = crypto.randomUUID();
      flows.set(flowId, { ...flow, createdAtMs: now() });
      return flowId;
    },
    get(flowId) {
      const id = String(flowId || '').trim();
      if (!id) return null;
      const flow = flows.get(id);
      if (!flow) return null;
      if (now() - flow.createdAtMs > ttlMs) {
        flows.delete(id);
        return null;
      }
      return flow;
    },
    delete(flowId) {
      flows.delete(String(flowId || '').trim());
    },
    get size() {
      return flows.size;
    }
  };
}

const defaultStore = createKiroNativeLoginStore();

function resolveStore(ctx) {
  const injected = ctx && ctx.deps && ctx.deps.kiroNativeLoginStore;
  return injected || defaultStore;
}

function resolveRequest(ctx) {
  const deps = (ctx && ctx.deps) || {};
  if (typeof deps.fetchWithTimeout === 'function') {
    // 服务器注入的是 `fetchWithTimeout(url, init, timeoutMs, egressOptions)`（lib/server/http-utils-utils.js），
    // 而登录模块要的是普通 `(url, init)`。**必须显式补上超时**：漏了的话 setTimeout(..., undefined)
    // 会立刻 abort，表现是「设备码请求莫名失败」——单测注入的替身看不见，只有真实 HTTP 会暴露。
    const fetchWithTimeout = deps.fetchWithTimeout;
    const timeoutMs = Number(deps.kiroNativeLoginTimeoutMs) > 0
      ? Number(deps.kiroNativeLoginTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    return (url, init) => fetchWithTimeout(url, init, timeoutMs);
  }
  if (typeof deps.fetchImpl === 'function') return deps.fetchImpl;
  return globalThis.fetch;
}

function resolveAiHomeDir(ctx) {
  const options = (ctx && ctx.options) || {};
  const deps = (ctx && ctx.deps) || {};
  return String(options.aiHomeDir || deps.aiHomeDir || '').trim();
}

function errorMessage(error) {
  return String((error && (error.code || error.message)) || error || 'unknown').slice(0, 160);
}

/** 落库/注册选项：允许 deps 注入（测试替身与复用），默认走真实实现。 */
function commitOptions(ctx, extra) {
  const deps = (ctx && ctx.deps) || {};
  return {
    aiHomeDir: resolveAiHomeDir(ctx),
    request: resolveRequest(ctx),
    ...(deps.registerKiroNativeLogin ? { registerKiroNativeLogin: deps.registerKiroNativeLogin } : {}),
    ...extra
  };
}

// POST /v0/webui/accounts/kiro/login/start {region?, startUrl?}
// 发起设备码登录：返回给用户看的 code 与验证地址，以及后续轮询用的 flowId。
async function handleKiroNativeLoginStartRequest(ctx) {
  const { writeJson } = ctx;
  const store = resolveStore(ctx);
  const payload = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const runtimeDir = resolveLoginRuntimeDir(resolveAiHomeDir(ctx), 'kiro', `auth-${crypto.randomUUID()}`);
  if (!runtimeDir) {
    writeJson(ctx.res, 500, { ok: false, error: 'invalid_login_runtime' });
    return true;
  }

  let flow;
  try {
    flow = await beginKiroDeviceLogin({
      region: payload && payload.region,
      startUrl: payload && payload.startUrl,
      request: resolveRequest(ctx)
    });
  } catch (error) {
    writeJson(ctx.res, 502, { ok: false, error: `device_login_start_failed:${errorMessage(error)}` });
    return true;
  }

  const flowId = store.put({
    runtimeDir,
    registration: flow.registration,
    deviceCode: flow.deviceCode,
    startUrl: flow.startUrl,
    expiresAtMs: flow.expiresAtMs
  });
  // 只回用户需要的东西：registration / deviceCode 一律不出服务端。
  writeJson(ctx.res, 200, {
    ok: true,
    flowId,
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
    verificationUriComplete: flow.verificationUriComplete,
    intervalSeconds: flow.intervalSeconds,
    expiresAtMs: flow.expiresAtMs
  });
  return true;
}

// POST /v0/webui/accounts/kiro/login/poll {flowId}
// 推进一次设备码授权：pending / slow_down 只是状态；授权成功后落投影并注册账号。
async function handleKiroNativeLoginPollRequest(ctx) {
  const { writeJson } = ctx;
  const store = resolveStore(ctx);
  const payload = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const flowId = String((payload && payload.flowId) || '').trim();
  if (!flowId) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_flow_id' });
    return true;
  }
  const flow = store.get(flowId);
  if (!flow) {
    // 过期 / 服务重启：fail closed，让前端重新发起，绝不用残缺状态去猜。
    writeJson(ctx.res, 404, { ok: false, error: 'login_flow_not_found' });
    return true;
  }

  let polled;
  try {
    polled = await pollKiroDeviceLogin(flow, { request: resolveRequest(ctx) });
  } catch (error) {
    // 上游硬错误（invalid_client 等）：流程作废，别让前端无限轮询一个不可能成功的流程。
    store.delete(flowId);
    writeJson(ctx.res, 502, { ok: false, error: `device_login_poll_failed:${errorMessage(error)}` });
    return true;
  }

  if (polled.status === 'pending' || polled.status === 'slow_down') {
    writeJson(ctx.res, 200, { ok: true, status: polled.status });
    return true;
  }
  if (polled.status !== 'authorized') {
    store.delete(flowId);
    writeJson(ctx.res, 200, { ok: true, status: polled.status });
    return true;
  }

  const committed = await commitKiroCredential(ctx.fs, commitOptions(ctx, {
    runtimeDir: flow.runtimeDir,
    registration: flow.registration,
    auth: buildKiroAuthRow(polled.grant)
  }));
  store.delete(flowId);
  if (!committed.ok) {
    // 授权成功但账号没能登记（身份核验不通过 / 并发更新）：明确回报，不谎报成功。
    writeJson(ctx.res, 409, { ok: false, status: 'authorized', error: committed.reason });
    return true;
  }
  writeJson(ctx.res, 200, {
    ok: true,
    status: 'authorized',
    accountRef: committed.accountRef,
    cliAccountId: committed.cliAccountId
  });
  return true;
}

// POST /v0/webui/accounts/kiro/login/refresh-token {refreshToken, profileArn?, region?}
// B 入口：Kiro Desktop / social（Google / GitHub）账号只有一个 refresh_token。
async function handleKiroRefreshTokenImportRequest(ctx) {
  const { writeJson } = ctx;
  const payload = await ctx.readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
  const refreshToken = String((payload && payload.refreshToken) || '').trim();
  if (!refreshToken) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_refresh_token' });
    return true;
  }

  const runtimeDir = resolveLoginRuntimeDir(resolveAiHomeDir(ctx), 'kiro', `auth-${crypto.randomUUID()}`);
  if (!runtimeDir) {
    writeJson(ctx.res, 500, { ok: false, error: 'invalid_login_runtime' });
    return true;
  }

  let imported;
  try {
    imported = await importKiroRefreshToken({
      refreshToken,
      profileArn: payload && payload.profileArn,
      region: payload && payload.region,
      provider: payload && payload.provider,
      request: resolveRequest(ctx)
    });
  } catch (error) {
    writeJson(ctx.res, 502, { ok: false, error: `refresh_token_import_failed:${errorMessage(error)}` });
    return true;
  }

  const committed = await commitKiroCredential(ctx.fs, commitOptions(ctx, {
    runtimeDir,
    registration: null,
    auth: imported.auth
  }));
  if (!committed.ok) {
    writeJson(ctx.res, 409, { ok: false, error: committed.reason });
    return true;
  }
  writeJson(ctx.res, 200, { ok: true, accountRef: committed.accountRef, cliAccountId: committed.cliAccountId });
  return true;
}

module.exports = {
  createKiroNativeLoginStore,
  handleKiroNativeLoginPollRequest,
  handleKiroNativeLoginStartRequest,
  handleKiroRefreshTokenImportRequest
};
