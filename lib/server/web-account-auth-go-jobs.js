'use strict';

// Go account-auth-jobs 的接线与失败映射。
//
// 承接范围（固定行为，不是开关）：
//   * zcode：Node 策略文件已删除，登录固定由 Go 执行；无论 codexBrowserAuthViaGo
//     取什么值，zcode 的 Begin / Callback 都走这里。
//   * codex：仍受 config:server 的 codexBrowserAuthViaGo（默认关）控制。关闭时
//     登录继续走 Node 本地 PKCE + token 交换，与接线前完全一致。
//
// Node 只做三件事：
//   1. Begin：向 Go 申请 job_id + authorization_url（PKCE/state 只存在 Go 进程内存里）；
//   2. 回调：把浏览器拿到的完整回调 URL 原样交给 Go（state 校验以 Go 为权威）；
//   3. 收尾：用 Go 返回的 account_ref / cli_account_id 结束本地 job，并立刻对账一次。
//
// 失败原因原样沿用 Go 的错误码（见 accountauthapi/error_mapping.go）：provider_rejected
// 是上游明确拒绝，重试同一个回调不会改变结论；provider_unavailable / 5xx / 连不上 Go
// 属于可重试。这里只标注 retryable，不代替调用方重试——旧路径的重试语义不参与。

// 开关名与 config:server 的键一致（DEFAULT_SERVER_CONFIG.codexBrowserAuthViaGo）。
// 它只决定 codex 是否走 Go；zcode 的迁移是直接替换，不读这个键。
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

/** Go 门面是否具备承接一次完整登录所需的三个调用。 */
function hasGoAuthJobClient(goCoreSync) {
  return Boolean(goCoreSync
    && typeof goCoreSync.startAccountAuthJob === 'function'
    && typeof goCoreSync.completeAccountAuthJob === 'function'
    && typeof goCoreSync.cancelAccountAuthJob === 'function');
}

/**
 * 从 WebUI 宿主依赖构造状态机用的 Go OAuth Job 选项。
 *
 * client 只要 Go 门面可用就会装配：zcode 已固定走 Go，不能因为 codex 的实验开关关着
 * 就没有 client。codexEnabled 单独表达 codex 的开关状态，供调用方决定 codex 走哪条路。
 * Go 门面不可用时返回冻结的 disabled 形态，调用方据此走旧路径（zcode 会明确报错，
 * 不做本地降级——Node 侧已经没有 zcode 策略）。
 */
function createGoAuthJobsOption(options = {}) {
  const { readServerConfig, goCoreSync } = options;
  let codexEnabled = false;
  try {
    const config = typeof readServerConfig === 'function' ? readServerConfig() : null;
    codexEnabled = Boolean(config && config[GO_AUTH_JOB_SWITCH_KEY] === true);
  } catch (_error) {
    codexEnabled = false;
  }
  if (!hasGoAuthJobClient(goCoreSync)) {
    return Object.freeze({
      codexEnabled,
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
    cancel: (jobId) => goCoreSync.cancelAccountAuthJob(String(jobId || ''))
  });
  return Object.freeze({
    codexEnabled,
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
  GO_AUTH_JOB_SWITCH_KEY,
  GO_AUTH_JOB_PROVIDER,
  isGoAuthJobFailureRetryable,
  toGoAuthJobFailure,
  createGoAuthJobsOption
};
