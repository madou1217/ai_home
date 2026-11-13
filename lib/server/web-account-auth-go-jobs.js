'use strict';

const net = require('node:net');

// Go account-auth-jobs 的接线与失败映射。
//
// 承接范围（固定行为，不是开关）：
//   * codex：浏览器登录固定由 Go 执行；Node 只保留 loopback 回调捕获并把完整
//     回调转发给 Go，本地不再生成 PKCE/state，也不再向 OpenAI 换码。
//   * zcode：Node 策略文件已删除，登录固定由 Go 执行（手填回调）。
//   * opencode：Node 策略文件已删除，登录固定由 Go 的设备码作业执行；Node 不发
//     Begin 之外的写请求，只读 Go 的作业快照等终态（没有回调可转发）。
//
// Node 只做三件事：
//   1. Begin：向 Go 申请 job_id + authorization_url（PKCE/state 只存在 Go 进程内存里）；
//   2. 回调：把浏览器拿到的完整回调 URL 原样交给 Go（state 校验以 Go 为权威）；
//   3. 收尾：用 Go 返回的 account_ref / cli_account_id 结束本地 job，并立刻对账一次。
//
// 失败原因原样沿用 Go 的错误码（见 accountauthapi/error_mapping.go）：provider_rejected
// 是上游明确拒绝，重试同一个回调不会改变结论；provider_unavailable / 5xx / 连不上 Go
// 属于可重试。这里只标注 retryable，不代替调用方重试——旧路径的重试语义不参与。

// 明确属于「重试同一个回调也不会变」的 Go 错误码。其余 4xx 同理由状态码兜底。
const NON_RETRYABLE_GO_AUTH_JOB_CODES = new Set([
  'provider_rejected',
  'invalid_callback',
  'state_mismatch',
  'invalid_request',
  'invalid_query',
  'unsupported_provider',
  'job_not_found',
  'job_expired',
  'job_not_pending',
  'account_conflict',
  'cli_account_id_exhausted',
  'reauthentication_target_not_found',
  'reauthentication_unsupported',
  'reauthentication_identity_mismatch',
  'reauthentication_conflict',
  'invalid_reauthentication',
  'invalid_artifacts'
]);

// 明确可重试：上游/宿主暂时不可用，换一个时间点重发同一请求有意义。
const RETRYABLE_GO_AUTH_JOB_CODES = new Set([
  'provider_unavailable',
  'job_capacity_exhausted',
  'internal_error',
  'go_auth_job_unavailable',
  'go_auth_job_unreachable'
]);

/**
 * 判断一个 Go OAuth Job 失败是否可重试。
 *
 * 先看错误码白名单/黑名单，再退回 HTTP 状态码类别：5xx 与「没有响应」可重试，
 * 4xx 视为请求本身有问题（同一个回调重发也一样）。
 */
function isGoAuthJobFailureRetryable(code, status) {
  const normalized = String(code || '').trim();
  if (NON_RETRYABLE_GO_AUTH_JOB_CODES.has(normalized)) return false;
  if (RETRYABLE_GO_AUTH_JOB_CODES.has(normalized)) return true;
  const statusCode = Number(status) || 0;
  if (statusCode === 0) return true;
  return statusCode >= 500;
}

/**
 * 把 Go 客户端的原始响应（{ ok, status, data, errorCode }）映射成 job 失败原因。
 *
 * 响应为空表示管理客户端不可用（Go Core 未就绪 / management key 缺失），
 * 这不是 Go 的错误码，单独命名并标记可重试。
 */
function toGoAuthJobFailure(response, fallbackCode = 'go_auth_job_failed') {
  if (!response || typeof response !== 'object') {
    return {
      ok: false,
      code: 'go_auth_job_unavailable',
      status: 0,
      retryable: true
    };
  }
  const status = Number(response.status) || 0;
  const code = String(response.errorCode || '').trim()
    || (status ? `http_${status}` : fallbackCode);
  return {
    ok: false,
    code,
    status,
    retryable: isGoAuthJobFailureRetryable(code, status)
  };
}

// 环境代理只认这四个标准变量（与 Go 的 http.ProxyFromEnvironment 对齐）。
const ENV_PROXY_VARIABLES = Object.freeze(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
const LOOPBACK_PROXY_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);

function firstEnvProxyUrl(env) {
  for (const name of ENV_PROXY_VARIABLES) {
    const value = String((env && env[name]) || '').trim();
    if (value) return value;
  }
  return '';
}

/**
 * 探测「环境变量里配的本机代理」是否还在监听。
 *
 * 返回 true=可达、false=链路层拒绝/超时、null=不是本机代理（不判定）。
 * 只看回环地址：远端代理不可达可能只是本次网络抖动，不值得给用户下结论。
 */
function probeLoopbackProxy(proxyUrl, timeoutMs = 300) {
  return new Promise((resolve) => {
    let parsed = null;
    try {
      parsed = new URL(String(proxyUrl || ''));
    } catch (_error) {
      resolve(null);
      return;
    }
    const host = String(parsed.hostname || '').replace(/^\[|\]$/g, '');
    if (!LOOPBACK_PROXY_HOSTS.includes(host)) {
      resolve(null);
      return;
    }
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * 登录失败时给一条「环境代理已死」的提示；没有可说的原因就返回空串。
 *
 * Go 的出站请求只认 HTTP(S)_PROXY：宿主换了代理软件、端口变了、或本机代理没启动时，
 * 每个请求都会立刻被拒，而 Job 失败码永远是 provider_unavailable。用户看不出
 * 「该去开代理」还是「代码坏了」，所以把这条结论直接写进 Job 日志。
 */
async function describeEnvProxyHint(options = {}) {
  const env = options.env || process.env;
  const proxyUrl = firstEnvProxyUrl(env);
  if (!proxyUrl) return '';
  const reachable = await probeLoopbackProxy(proxyUrl, options.timeoutMs);
  if (reachable !== false) return '';
  return `环境代理 ${proxyUrl} 拒绝连接：Go 的出站请求（含 OAuth 换码）都会立即失败；`
    + '请启动该本机代理，或清掉 HTTP(S)_PROXY 后重启 server。';
}

/** Go 门面是否具备承接一次完整登录所需的三个调用。 */
/** Go 门面是否具备家族 CLI 登录作业的三个调用。 */
function hasGoLoginJobClient(goCoreSync) {
  return Boolean(goCoreSync
    && typeof goCoreSync.startLoginJob === 'function'
    && typeof goCoreSync.getLoginJob === 'function'
    && typeof goCoreSync.cancelLoginJob === 'function');
}

/** 家族 CLI 登录作业的 Go 客户端（create / status / cancel + 收尾对账）。 */
function createGoLoginJobsOption(options = {}) {
  const { goCoreSync } = options;
  if (!hasGoLoginJobClient(goCoreSync)) return null;
  return Object.freeze({
    start: (providerId) => goCoreSync.startLoginJob(String(providerId || '')),
    status: (jobId) => goCoreSync.getLoginJob(String(jobId || '')),
    cancel: (jobId) => goCoreSync.cancelLoginJob(String(jobId || '')),
    reconcile: typeof goCoreSync.reconcileAccounts === 'function'
      ? () => goCoreSync.reconcileAccounts()
      : null
  });
}

function hasGoAuthJobClient(goCoreSync) {
  return Boolean(goCoreSync
    && typeof goCoreSync.startAccountAuthJob === 'function'
    && typeof goCoreSync.completeAccountAuthJob === 'function'
    && typeof goCoreSync.cancelAccountAuthJob === 'function'
    // 设备码作业没有回调，只能读持久化快照判断终态（opencode 固定走这条）。
    && typeof goCoreSync.getOAuthJob === 'function');
}

/**
 * 从 WebUI 宿主依赖构造状态机用的 Go OAuth Job 选项。
 *
 * codex/zcode/opencode 的登录都固定走 Go，没有开关。Go 门面不可用时返回冻结的
 * disabled 形态，调用方对这三家明确报错（Node 侧已没有对应策略，不做本地降级）。
 */
function createGoAuthJobsOption(options = {}) {
  const { goCoreSync } = options;
  if (!hasGoAuthJobClient(goCoreSync)) {
    return Object.freeze({
      client: null,
      reconcile: null,
      resolveNodeAccountRef: null,
      resolveGoAccountRef: null
    });
  }
  const client = Object.freeze({
    start: ({ providerId, targetAccountRef } = {}) => goCoreSync.startAccountAuthJob({
      provider_id: String(providerId || ''),
      ...(targetAccountRef ? { target_account_ref: String(targetAccountRef) } : {})
    }),
    complete: (jobId, callbackUrl) => goCoreSync.completeAccountAuthJob(String(jobId || ''), String(callbackUrl || '')),
    cancel: (jobId) => goCoreSync.cancelAccountAuthJob(String(jobId || '')),
    // 设备码作业的状态：读 Go 持久化的公开快照（status / account_ref / failure_code）。
    status: (jobId) => goCoreSync.getOAuthJob(String(jobId || ''))
  });
  return Object.freeze({
    client,
    // 主动对账：Go 已经写过账号，Node 不等 15s 定时器，登录收尾后立刻拉一轮。
    reconcile: typeof goCoreSync.reconcileAccounts === 'function'
      ? () => goCoreSync.reconcileAccounts()
      : null,
    // 引用翻译：Go 与 Node 的身份派生规则不同（zcode 的区域参与 Node 身份），
    // 登录完成后的 account_ref 必须翻回 Node 键；reauth 的 target 必须翻成 Go 键。
    resolveNodeAccountRef: typeof goCoreSync.nodeAccountRefFor === 'function'
      ? (goRef) => String(goCoreSync.nodeAccountRefFor(goRef) || '')
      : null,
    resolveGoAccountRef: typeof goCoreSync.goRefsByNodeRef === 'function'
      ? (nodeRef) => {
        const normalized = String(nodeRef || '');
        try {
          const links = goCoreSync.goRefsByNodeRef() || {};
          return links[normalized] ? String(links[normalized]) : normalized;
        } catch (_error) {
          return normalized;
        }
      }
      : null
  });
}

module.exports = {
  describeEnvProxyHint,
  isGoAuthJobFailureRetryable,
  probeLoopbackProxy,
  toGoAuthJobFailure,
  createGoAuthJobsOption,
  createGoLoginJobsOption
};
