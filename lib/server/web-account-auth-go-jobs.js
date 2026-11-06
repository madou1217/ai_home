'use strict';

// Codex 浏览器登录接 Go account-auth-jobs 的实验开关与失败映射。
//
// 开关是 config:server 的 codexBrowserAuthViaGo（默认关）。关闭时登录仍走 Node 本地
// PKCE + token 交换，与接线前完全一致；打开后 Node 只做三件事：
//   1. Begin：向 Go 申请 job_id + authorization_url（PKCE/state 只存在 Go 进程内存里）；
//   2. 回调：把浏览器拿到的完整回调 URL 原样交给 Go（state 校验以 Go 为权威）；
//   3. 收尾：用 Go 返回的 account_ref / cli_account_id 结束本地 job，并立刻对账一次。
//
// 失败原因原样沿用 Go 的错误码（见 accountauthapi/error_mapping.go）：provider_rejected
// 是上游明确拒绝，重试同一个回调不会改变结论；provider_unavailable / 5xx / 连不上 Go
// 属于可重试。这里只标注 retryable，不代替调用方重试——旧路径的重试语义不参与。

// 开关名与 config:server 的键一致（DEFAULT_SERVER_CONFIG.codexBrowserAuthViaGo）。
const GO_AUTH_JOB_SWITCH_KEY = 'codexBrowserAuthViaGo';
const GO_AUTH_JOB_PROVIDER = 'codex';

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

const DISABLED_GO_AUTH_JOBS = Object.freeze({
  enabled: false,
  client: null,
  reconcile: null
});

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

/**
 * 从 WebUI 宿主依赖构造状态机用的 Go OAuth Job 选项。
 *
 * 开关关闭（默认）时返回冻结的 disabled 形态：调用方据此完全走旧路径，
 * 不会产生任何 Go 调用。开关打开但宿主没有装配 Go 管理 API 时同样退化为 disabled——
 * 实验开关不该让「登录」这条主路径因为 Go 未就绪而整体不可用。
 */
function createGoAuthJobsOption(options = {}) {
  const { readServerConfig, goCoreSync } = options;
  let enabled = false;
  try {
    const config = typeof readServerConfig === 'function' ? readServerConfig() : null;
    enabled = Boolean(config && config[GO_AUTH_JOB_SWITCH_KEY] === true);
  } catch (_error) {
    enabled = false;
  }
  if (!enabled) return DISABLED_GO_AUTH_JOBS;
  if (!goCoreSync
    || typeof goCoreSync.startAccountAuthJob !== 'function'
    || typeof goCoreSync.completeAccountAuthJob !== 'function'
    || typeof goCoreSync.cancelAccountAuthJob !== 'function') {
    return DISABLED_GO_AUTH_JOBS;
  }
  const client = Object.freeze({
    start: ({ providerId, targetAccountRef } = {}) => goCoreSync.startAccountAuthJob({
      provider_id: String(providerId || ''),
      ...(targetAccountRef ? { target_account_ref: String(targetAccountRef) } : {})
    }),
    complete: (jobId, callbackUrl) => goCoreSync.completeAccountAuthJob(String(jobId || ''), String(callbackUrl || '')),
    cancel: (jobId) => goCoreSync.cancelAccountAuthJob(String(jobId || ''))
  });
  return Object.freeze({
    enabled: true,
    client,
    // 主动对账：Go 已经写过账号，Node 不等 15s 定时器，登录收尾后立刻拉一轮。
    reconcile: typeof goCoreSync.reconcileAccounts === 'function'
      ? () => goCoreSync.reconcileAccounts()
      : null
  });
}

module.exports = {
  GO_AUTH_JOB_SWITCH_KEY,
  GO_AUTH_JOB_PROVIDER,
  isGoAuthJobFailureRetryable,
  toGoAuthJobFailure,
  createGoAuthJobsOption
};
