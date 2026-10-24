'use strict';

const crypto = require('node:crypto');
const { resolveZcodeRegion, rewriteZcodeAuthorizeOrigin } = require('./zcode-region');

// ZCode CLI 的 OAuth 是**服务端中介的设备码式流程**（不是 loopback 回调）：
//
//   1. 本地生成随机 poll_token（32 字节 hex）；
//   2. POST /api/v1/oauth/cli/init  （Authorization: Bearer <poll_token>, body {provider}）
//      → { flow_id, authorize_url, expires_at, poll_interval_sec }
//   3. 用户打开 authorize_url（它的 redirect_uri 指向 zcode.z.ai 自己的 HTTPS 回调）；
//   4. GET /api/v1/oauth/cli/poll/<flow_id> 轮询，status: pending → ready | failed。
//
// 为什么必须用它而不是桌面端的浏览器回调：Z.ai 收紧了该 client
// （client_P8X5CMWmlaRO9gyO-KSqtg）的 redirect_uri 白名单，只保留
// `zcode://oauth/callback`（自定义协议，需在用户机器注册协议处理器）与官方
// `https://zcode.z.ai/api/v1/oauth/cli/callback/<provider>` 两条。任何 loopback
// 地址都会被拒（登录后显示 "Redirect URI not registered for this client"）。
// 这条流程不需要注册任何本地地址、不需要自定义协议处理器、也不需要本机浏览器
// —— 手机扫码/异地授权同样可用，是三条路里唯一无本地注册依赖的。
//
// 本模块只负责协议本身（请求构造 + 响应校验 + 状态归一），不碰账号/凭据/任务。

const ZCODE_CLI_API_BASE = 'https://zcode.z.ai/api/v1';
const POLL_TOKEN_BYTES = 32;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 30000;
// code 3004：flow 不存在/已过期/poll_token 不匹配 —— 与其它业务错误区分开，
// 调用方据此提示「重新发起」而不是「稍后重试」。
const ZCODE_CLI_INVALID_FLOW_CODE = 3004;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildZcodeCliPollToken(cryptoImpl = crypto) {
  return cryptoImpl.randomBytes(POLL_TOKEN_BYTES).toString('hex');
}

function cliLoginError(code, message, extra = {}) {
  const error = new Error(message || code);
  error.code = code;
  return Object.assign(error, extra);
}

/** 业务包装响应 { code, msg, data }：code != 0 即使 HTTP 200 也是失败。 */
function unwrapEnvelope(payload) {
  if (!isPlainObject(payload)) return { code: -1, msg: '', data: null };
  return {
    code: Number.isFinite(Number(payload.code)) ? Number(payload.code) : -1,
    msg: normalizeString(payload.msg),
    data: isPlainObject(payload.data) ? payload.data : null
  };
}

async function readJsonResponse(response) {
  const rawText = await response.text().catch(() => '');
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

/**
 * 发起一次 CLI 登录流程。返回的 authorizeUrl 已经带好官方 redirect_uri，
 * 调用方**不要**改写它的查询参数。
 */
async function beginZcodeCliLogin({ request, provider, authorizeOrigin = '', cryptoImpl = crypto, nowMs = Date.now() } = {}) {
  if (typeof request !== 'function') {
    throw cliLoginError('zcode_cli_login_unavailable', '缺少 HTTP 客户端');
  }
  // 区域决定授权入口（zai → chat.z.ai / bigmodel → bigmodel.cn），由上游按 provider 字段选择。
  const region = resolveZcodeRegion(provider);
  const pollToken = buildZcodeCliPollToken(cryptoImpl);
  const response = await request(`${ZCODE_CLI_API_BASE}/oauth/cli/init`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${pollToken}`
    },
    body: JSON.stringify({ provider: region.provider })
  });
  if (!response || response.ok === false) {
    throw cliLoginError('zcode_cli_init_failed', `OAuth flow 初始化失败（HTTP ${Number(response && response.status) || 0}）`);
  }
  const { code, msg, data } = unwrapEnvelope(await readJsonResponse(response));
  if (code !== 0 || !data) {
    throw cliLoginError('zcode_cli_init_rejected', msg || 'OAuth flow 初始化响应无效', { upstreamCode: code });
  }
  const flowId = normalizeString(data.flow_id);
  // 镜像域名仅在客户端改写授权入口 origin，回调与 token 交换仍走官方地址。
  const authorizeUrl = rewriteZcodeAuthorizeOrigin(normalizeString(data.authorize_url), authorizeOrigin);
  const expiresAtMs = Number(data.expires_at) * 1000;
  const intervalSeconds = Number(data.poll_interval_sec);
  if (!flowId || !authorizeUrl || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs
    || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw cliLoginError('zcode_cli_init_invalid', 'OAuth flow 初始化响应无效');
  }
  return {
    flowId,
    pollToken,
    region,
    authorizeUrl,
    // 桌面端从 authorize_url 的 state 里取状态；这里保持同源，便于回调/日志对账。
    state: normalizeString(new URL(authorizeUrl).searchParams.get('state')),
    expiresAtMs,
    pollIntervalMs: Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, intervalSeconds * 1000))
  };
}

/**
 * 轮询一次。归一成 { status }：
 *   pending | ready（带 tokenSet/profile）| failed | expired | slow_down
 *
 * 网络/5xx/408/429 抛错由调用方决定重试；4xx（flow 已死）归一成 expired，
 * 避免把一个不会恢复的 flow 一直轮询下去。
 */
async function pollZcodeCliLogin(flow, { request, nowMs = Date.now() } = {}) {
  const flowId = normalizeString(flow && flow.flowId);
  const pollToken = normalizeString(flow && flow.pollToken);
  if (!flowId || !pollToken) {
    throw cliLoginError('zcode_cli_flow_invalid', 'OAuth flow 参数无效');
  }
  const expiresAtMs = Number(flow.expiresAtMs);
  if (Number.isFinite(expiresAtMs) && expiresAtMs > 0 && nowMs >= expiresAtMs) {
    return { status: 'expired', message: 'OAuth flow 已过期，请重新发起授权。' };
  }

  let response;
  try {
    response = await request(
      `${ZCODE_CLI_API_BASE}/oauth/cli/poll/${encodeURIComponent(flowId)}`,
      { headers: { accept: 'application/json', authorization: `Bearer ${pollToken}` } }
    );
  } catch (error) {
    throw cliLoginError('zcode_cli_poll_failed', normalizeString(error && error.message) || 'OAuth flow 查询失败');
  }

  const status = Number(response && response.status) || 0;
  if (status === 429 || status === 408) return { status: 'slow_down' };
  if (status >= 400 && status < 500) {
    return { status: 'expired', message: 'OAuth flow 已失效，请重新发起授权。' };
  }
  if (!response || response.ok === false) {
    throw cliLoginError('zcode_cli_poll_failed', `OAuth flow 查询失败（HTTP ${status}）`);
  }

  const { code, msg, data } = unwrapEnvelope(await readJsonResponse(response));
  if (code === ZCODE_CLI_INVALID_FLOW_CODE) {
    return { status: 'expired', message: msg || 'OAuth flow 已失效，请重新发起授权。' };
  }
  if (code !== 0 || !data) {
    throw cliLoginError('zcode_cli_poll_rejected', msg || 'OAuth flow 查询响应无效', { upstreamCode: code });
  }

  const flowStatus = normalizeString(data.status);
  if (flowStatus === 'pending') return { status: 'pending' };
  if (flowStatus === 'failed') return { status: 'failed', message: msg || '授权失败，请重新发起。' };
  if (flowStatus !== 'ready') {
    throw cliLoginError('zcode_cli_poll_invalid', 'OAuth flow 查询响应无效');
  }

  // ready 的载荷形状与桌面端一致：data.token 是 zcode JWT，data.zai.access_token
  // 是 provider access token，data.user 是身份。三者缺一即视为响应无效。
  const flowRegion = flow && flow.region ? flow.region : null;
  const providerTokens = flowRegion
    ? (isPlainObject(data[flowRegion.provider]) ? data[flowRegion.provider] : {})
    : (isPlainObject(data.zai) ? data.zai : (isPlainObject(data.bigmodel) ? data.bigmodel : {}));
  const zcodeJwtToken = normalizeString(data.token);
  const accessToken = normalizeString(providerTokens.access_token || providerTokens.accessToken);
  const refreshToken = normalizeString(providerTokens.refresh_token || providerTokens.refreshToken);
  const user = isPlainObject(data.user) ? data.user : null;
  const userId = normalizeString(user && user.user_id);
  if (!zcodeJwtToken || !accessToken || !userId) {
    throw cliLoginError('zcode_cli_poll_invalid', 'OAuth flow 查询响应无效');
  }
  return {
    status: 'ready',
    tokenSet: { accessToken, zcodeJwtToken, refreshToken },
    user,
    profile: {
      id: userId,
      username: normalizeString(user.name) || normalizeString(user.email) || userId,
      displayName: normalizeString(user.name) || normalizeString(user.email) || userId
    }
  };
}

// ── 服务端中介流程的轮询驱动 ────────────────────────────────────────────────
//
// 职责：开 flow → 展示 authorize_url → 定时轮询 → 交给策略落盘。
// 不认识任何 provider 名；协议由 strategy.session.begin/poll 提供，
// 落盘由 strategy.applyResult 负责。与 kiro 设备码轮询同构。

const SESSION_DEFAULT_POLL_INTERVAL_MS = 1000;
const SESSION_MAX_POLL_INTERVAL_MS = 30_000;
const SESSION_SLOW_DOWN_STEP_MS = 5_000;

function createSessionFlowDriver(deps = {}) {
  const { appendJobLog, setAuthProgressState, finalizeJob, notifyAuthJobChanged, states } = deps;

  function clearTimer(job) {
    if (job && job._sessionPollTimer) {
      clearTimeout(job._sessionPollTimer);
      job._sessionPollTimer = null;
    }
  }

  function begin(job, authStrategy) {
    Promise.resolve()
      .then(() => authStrategy.session.begin({ job, deps }))
      .then((flow) => {
        if (job.status !== 'running' || job._cancelRequested) return;
        job._sessionFlow = flow;
        job.authorizationUrl = flow.authorizeUrl;
        job.oauthState = flow.state || job.oauthState;
        if (Number.isFinite(flow.expiresAtMs) && flow.expiresAtMs > 0) job.expiresAt = flow.expiresAtMs;
        job.pollIntervalMs = Number(flow.pollIntervalMs) || job.pollIntervalMs;
        job.updatedAt = Date.now();
        if (setAuthProgressState && states && states.AUTH_URL_READY) {
          setAuthProgressState(job, states.AUTH_URL_READY);
        }
        appendJobLog(job, '请在浏览器中完成授权（本机或任意设备均可，无需回调本机）。');
        if (notifyAuthJobChanged) notifyAuthJobChanged(job);
        schedule(job, authStrategy);
      })
      .catch((error) => {
        if (job.status !== 'running') return;
        finalizeJob(job, 'failed', `OAuth flow 初始化失败: ${(error && (error.code || error.message)) || 'unknown'}`);
      });
  }

  function schedule(job, authStrategy) {
    if (job.status !== 'running' || job._cancelRequested) return;
    const intervalMs = Math.max(SESSION_DEFAULT_POLL_INTERVAL_MS, Number(job.pollIntervalMs) || SESSION_DEFAULT_POLL_INTERVAL_MS);
    job._sessionPollTimer = setTimeout(async () => {
      job._sessionPollTimer = null;
      if (job.status !== 'running' || job._cancelRequested) return;
      let polled;
      try {
        polled = await authStrategy.session.poll({ job, flow: job._sessionFlow, deps });
      } catch (error) {
        finalizeJob(job, 'failed', `OAuth flow 轮询失败: ${(error && (error.code || error.message)) || 'unknown'}`);
        return;
      }
      if (job.status !== 'running' || job._cancelRequested) return;
      if (polled.status === 'pending') { schedule(job, authStrategy); return; }
      if (polled.status === 'slow_down') {
        job.pollIntervalMs = Math.min(SESSION_MAX_POLL_INTERVAL_MS, intervalMs + SESSION_SLOW_DOWN_STEP_MS);
        schedule(job, authStrategy);
        return;
      }
      if (polled.status === 'failed') {
        finalizeJob(job, 'failed', polled.message || '授权失败，请重新发起。');
        return;
      }
      if (polled.status !== 'ready') {
        finalizeJob(job, 'expired', polled.message || 'OAuth 授权已过期，请重新发起授权。');
        return;
      }
      if (setAuthProgressState && states && states.SUBMITTED_CODE) {
        setAuthProgressState(job, states.SUBMITTED_CODE);
      }
      await authStrategy.applyResult({ job, result: polled, deps });
    }, intervalMs);
    if (typeof job._sessionPollTimer.unref === 'function') job._sessionPollTimer.unref();
  }

  return { begin, schedule, clearTimer };
}

module.exports = {
  ZCODE_CLI_API_BASE,
  ZCODE_CLI_INVALID_FLOW_CODE,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  buildZcodeCliPollToken,
  beginZcodeCliLogin,
  pollZcodeCliLogin,
  createSessionFlowDriver
};
