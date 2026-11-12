'use strict';

// Go 承接的重新认证作业在 Node 侧的进度投影。
//
// Go 是作业真相源（PKCE/state/换码/账号写入都在 Go 进程内），这里只做三件事：
//   1. 订阅 Go 的 OAuth Job 快照 SSE，把状态变化翻译成 /v0/webui/accounts/watch
//      的 auth-job 事件（不轮询）；
//   2. 在本机保留 loopback 回调捕获；浏览器命中后把完整回调原样交给 Go；
//   3. 给 WebUI 提供与 Node 本地作业同形的 job 快照（callbackCaptureStatus /
//      authProgressState / installRequired 等展示字段）。
//
// 失败语义：只有 Go 明确给出终态才改本地状态；连不上 Go 或 5xx 保留 running，
// 让用户可以重新提交同一个回调。

const { startOauthLoopbackCallbackServer } = require('./oauth-loopback-callback');
const { isLoopbackCallbackUrl } = require('./web-account-auth-oauth-browser');
const {
  serializeAuthJob,
  appendJobLog,
  setAuthProgressState,
  AUTH_PROGRESS_STATES
} = require('./web-account-auth-job');
const { emitAccountsAuthJobEvent } = require('./webui-account-live');

// 终态快照保留与 Node 本地作业一致的时间，供进度弹窗晚到的事件继续可读。
const TRACKED_JOB_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, object>} */
const trackedJobs = new Map();

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getGoHost(ctx) {
  return ctx && ctx.deps && ctx.deps.goCoreSync ? ctx.deps.goCoreSync : null;
}

function mapGoStatus(value) {
  const status = normalizeString(value).toLowerCase();
  if (status === 'pending' || status === 'processing') return 'running';
  if (status === 'completed') return 'succeeded';
  if (status === 'failed' || status === 'cancelled' || status === 'expired') return status;
  return 'running';
}

function resolveProgressState(goStatus, authMode) {
  const status = normalizeString(goStatus).toLowerCase();
  if (status === 'processing') return AUTH_PROGRESS_STATES.SUBMITTED_CODE;
  if (status === 'completed') return AUTH_PROGRESS_STATES.COMPLETED;
  if (status === 'failed') return AUTH_PROGRESS_STATES.FAILED;
  if (status === 'cancelled') return AUTH_PROGRESS_STATES.CANCELLED;
  if (status === 'expired') return AUTH_PROGRESS_STATES.EXPIRED;
  return authMode === 'oauth-device'
    ? AUTH_PROGRESS_STATES.AWAITING_CODE
    : AUTH_PROGRESS_STATES.AUTH_URL_READY;
}

function resolveFailureMessage(code) {
  const normalized = normalizeString(code);
  if (normalized === 'provider_unavailable') return '上游授权服务暂时不可用，请稍后重试。';
  if (normalized === 'provider_rejected') return '上游拒绝了本次授权请求，请重新发起登录。';
  if (normalized === 'invalid_callback' || normalized === 'state_mismatch') {
    return '回调地址与本次授权不匹配，请重新复制完整的回调地址。';
  }
  if (normalized === 'expired') return '授权已超时，请重新发起登录。';
  if (normalized === 'reauthentication_identity_mismatch') return '登录身份与目标账号不一致，未覆盖原账号。';
  return normalized || '重新认证失败。';
}

function deriveRedirectUri(authorizationUrl) {
  const raw = normalizeString(authorizationUrl);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return normalizeString(parsed.searchParams.get('redirect_uri'))
      || normalizeString(parsed.searchParams.get('redirectUri'));
  } catch (_error) {
    return '';
  }
}

function emitJob(ctx, tracker) {
  if (!ctx || !ctx.state || !tracker) return;
  try {
    emitAccountsAuthJobEvent({ state: ctx.state }, serializeAuthJob(tracker));
  } catch (_error) {
    // 事件投递失败不能影响作业推进。
  }
}

function pruneTrackedJobs(now = Date.now()) {
  for (const [jobId, job] of trackedJobs) {
    if (job.status === 'running') continue;
    const finishedAt = Number(job.finishedAt) || Number(job.updatedAt) || 0;
    if (finishedAt > 0 && (now - finishedAt) > TRACKED_JOB_TTL_MS) {
      trackedJobs.delete(jobId);
    }
  }
}

function scheduleCleanup(tracker) {
  if (!tracker || tracker._cleanupTimer) return;
  const timer = setTimeout(() => {
    const current = trackedJobs.get(tracker.id);
    if (current === tracker) trackedJobs.delete(tracker.id);
  }, TRACKED_JOB_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  tracker._cleanupTimer = timer;
}

function closeLoopback(tracker) {
  if (!tracker || !tracker._loopback) return;
  try {
    tracker._loopback.close();
  } catch (_error) {
    // best effort shutdown
  }
  tracker._loopback = null;
  if (tracker.callbackCaptureStatus === 'starting' || tracker.callbackCaptureStatus === 'listening') {
    tracker.callbackCaptureStatus = 'closed';
  }
}

function abortStream(tracker) {
  if (!tracker || typeof tracker._sseAbort !== 'function') return;
  const abort = tracker._sseAbort;
  tracker._sseAbort = null;
  try {
    abort();
  } catch (_error) {
    // best effort shutdown
  }
}

function finishTracking(ctx, tracker, options = {}) {
  if (!tracker || tracker.status !== 'running') return tracker;
  const status = normalizeString(options.status) || 'failed';
  tracker.status = status;
  tracker.failureCode = status === 'succeeded' ? '' : normalizeString(options.failureCode);
  tracker.finishedAt = Number(options.finishedAt) || Date.now();
  tracker.updatedAt = tracker.finishedAt;
  tracker.error = status === 'succeeded'
    ? ''
    : resolveFailureMessage(options.failureCode || tracker.error);
  const progressState = resolveProgressState(
    status === 'succeeded' ? 'completed' : status,
    tracker.authMode
  );
  setAuthProgressState(tracker, progressState);
  appendJobLog(
    tracker,
    status === 'succeeded'
      ? 'Go 已完成重新认证并写入账号。'
      : `Go 作业结束：${status}${tracker.error ? `（${tracker.error}）` : ''}`
  );
  closeLoopback(tracker);
  abortStream(tracker);
  scheduleCleanup(tracker);
  emitJob(ctx, tracker);
  if (status === 'succeeded') {
    // Go 已经写完账号；Node 先对账收养新凭据，再补展示投影与运行态收尾
    // （与本地作业同一条顺序，避免用旧凭据重载 runtime pool）。
    const onFinished = typeof ctx.onGoReauthJobFinished === 'function'
      ? ctx.onGoReauthJobFinished
      : null;
    const goHost = getGoHost(ctx);
    const reconciled = goHost && typeof goHost.reconcileAccounts === 'function'
      ? Promise.resolve(goHost.reconcileAccounts()).catch(() => null)
      : Promise.resolve(null);
    reconciled.then(() => {
      if (!onFinished) return null;
      return Promise.resolve(onFinished(tracker)).catch((error) => {
        appendJobLog(
          tracker,
          `状态同步异常：${normalizeString((error && (error.code || error.message)) || error) || 'unknown_error'}`
        );
        emitJob(ctx, tracker);
      });
    }).catch(() => {});
  }
  return tracker;
}

function applyGoSnapshot(ctx, tracker, payload) {
  if (!tracker || !payload) return tracker;
  const job = payload.job && typeof payload.job === 'object' ? payload.job : payload;
  const goStatus = normalizeString(job.status).toLowerCase();
  if (!goStatus) return tracker;
  const mappedStatus = mapGoStatus(goStatus);
  if (tracker.status !== 'running') return tracker;
  if (mappedStatus === 'running') {
    const progress = payload.progress && typeof payload.progress === 'object'
      ? normalizeString(payload.progress.auth_progress_state)
      : '';
    const nextState = progress || resolveProgressState(goStatus, tracker.authMode);
    if (tracker.authProgressState !== nextState) {
      setAuthProgressState(tracker, nextState);
      emitJob(ctx, tracker);
    }
    return tracker;
  }
  return finishTracking(ctx, tracker, {
    status: mappedStatus,
    failureCode: normalizeString(job.failure_code) || goStatus,
    finishedAt: Date.parse(job.finished_at) || Date.now()
  });
}

function parseSseFrame(frame) {
  const lines = String(frame || '').split('\n');
  const data = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  try {
    return JSON.parse(data.join('\n'));
  } catch (_error) {
    return null;
  }
}

async function consumeJobStream(ctx, tracker) {
  const goHost = getGoHost(ctx);
  if (!goHost || typeof goHost.watchAccountAuthJob !== 'function') return;
  const stream = await goHost.watchAccountAuthJob(tracker.id).catch(() => null);
  if (!stream || !stream.ok || !stream.body) {
    if (tracker.status === 'running') {
      appendJobLog(tracker, 'Go 作业事件流不可用，改为等待回调结果。');
      emitJob(ctx, tracker);
    }
    return;
  }
  tracker._sseAbort = stream.abort;
  if (tracker.status !== 'running') {
    abortStream(tracker);
    return;
  }
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (tracker.status === 'running') {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = parseSseFrame(frame);
        if (payload) applyGoSnapshot(ctx, tracker, payload);
        if (tracker.status !== 'running') break;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (_error) {
    // 流断开不改变作业状态：回调提交/取消仍能推进终态。
  } finally {
    abortStream(tracker);
  }
}

function attachLoopbackCapture(ctx, tracker) {
  const redirectUri = tracker.redirectUri;
  if (!redirectUri || !isLoopbackCallbackUrl(redirectUri)) {
    tracker.callbackCaptureStatus = 'manual_only';
    tracker.callbackCaptureError = '';
    tracker.callbackListeningUrl = '';
    return;
  }
  tracker.callbackCaptureStatus = 'starting';
  tracker.callbackListeningUrl = redirectUri;
  try {
    tracker._loopback = startOauthLoopbackCallbackServer({
      redirectUri,
      onListening(info = {}) {
        if (tracker.status !== 'running') return;
        tracker.callbackCaptureStatus = 'listening';
        tracker.callbackListeningUrl = normalizeString(info.url) || redirectUri;
        appendJobLog(tracker, `本地 OAuth callback 服务已监听：${tracker.callbackListeningUrl}`);
        emitJob(ctx, tracker);
      },
      onUnavailable(error) {
        if (tracker.status !== 'running') return;
        tracker.callbackCaptureStatus = 'unavailable';
        tracker.callbackCaptureError = normalizeString(
          (error && (error.code || error.message)) || error
        ) || 'callback_server_unavailable';
        appendJobLog(tracker, `本地 OAuth callback 服务不可用，保留手动提交回调兜底：${tracker.callbackCaptureError}`);
        emitJob(ctx, tracker);
      },
      onCallback(callbackUrl) {
        return completeGoReauthCallback(ctx, tracker.id, callbackUrl);
      }
    });
  } catch (error) {
    tracker.callbackCaptureStatus = 'unavailable';
    tracker.callbackCaptureError = normalizeString(
      (error && (error.code || error.message)) || error
    ) || 'callback_server_unavailable';
  }
}

/**
 * 开始跟踪一个由 Go 创建的重新认证作业。
 *
 * @returns {{tracker: object, response: object}}
 */
function startGoReauthTracking(ctx, options = {}) {
  pruneTrackedJobs();
  const result = options.result && typeof options.result === 'object' ? options.result : {};
  const jobId = normalizeString(result.jobId || result.job_id);
  if (!jobId) return null;
  const existing = trackedJobs.get(jobId);
  if (existing) {
    const response = buildGoReauthResponse(existing, options.accountLabel);
    response.alreadyRunning = true;
    return { tracker: existing, response };
  }
  const now = Date.now();
  const tracker = {
    id: jobId,
    provider: normalizeString(options.provider || result.provider).toLowerCase(),
    accountRef: normalizeString(options.accountRef || result.accountRef),
    authMode: normalizeString(result.authMode || options.authMode) || 'oauth-browser',
    authStrategy: normalizeString(result.authStrategy || options.authStrategy),
    reauth: true,
    status: 'running',
    authProgressState: resolveProgressState('pending', normalizeString(result.authMode || options.authMode) || 'oauth-browser'),
    authorizationUrl: normalizeString(result.authorizationUrl),
    userCode: normalizeString(result.userCode),
    redirectUri: normalizeString(result.redirectUri) || deriveRedirectUri(result.authorizationUrl),
    expiresAt: Number(result.expiresAt) || null,
    pollIntervalMs: Number(result.pollIntervalMs) || 1000,
    createdAt: now,
    updatedAt: now,
    lastOutputAt: now,
    exitCode: null,
    setupPhase: '',
    installRequired: false,
    installAttempts: [],
    callbackCaptureStatus: '',
    callbackListeningUrl: '',
    callbackCaptureError: '',
    logs: '',
    error: '',
    email: normalizeString(options.previousAccountState && options.previousAccountState.email),
    displayName: normalizeString(options.previousAccountState && options.previousAccountState.displayName)
  };
  trackedJobs.set(jobId, tracker);
  appendJobLog(tracker, '已由 Go 承接重新认证作业。');
  attachLoopbackCapture(ctx, tracker);
  emitJob(ctx, tracker);
  scheduleCleanup(tracker);
  consumeJobStream(ctx, tracker).catch(() => {});
  return { tracker, response: buildGoReauthResponse(tracker, options.accountLabel) };
}

function buildGoReauthResponse(tracker, accountLabel) {
  if (!tracker) return null;
  return {
    ok: true,
    provider: tracker.provider,
    accountRef: tracker.accountRef,
    accountLabel: normalizeString(accountLabel) || tracker.displayName || tracker.email || tracker.accountRef,
    purpose: 'reauth',
    authMode: tracker.authMode,
    authStrategy: tracker.authStrategy,
    pollIntervalMs: tracker.pollIntervalMs,
    status: 'pending',
    jobId: tracker.id,
    authorizationUrl: tracker.authorizationUrl,
    ...(tracker.userCode ? { userCode: tracker.userCode } : {}),
    expiresAt: tracker.expiresAt,
    alreadyRunning: false,
    redirectUri: tracker.redirectUri,
    callbackCaptureStatus: tracker.callbackCaptureStatus,
    callbackListeningUrl: tracker.callbackListeningUrl,
    callbackCaptureError: tracker.callbackCaptureError,
    authProgressState: tracker.authProgressState,
    setupPhase: '',
    installRequired: false
  };
}

/** 读取仍在跟踪的 Go 重新认证作业；未知返回 null。 */
function getTrackedJob(jobId) {
  pruneTrackedJobs();
  return trackedJobs.get(normalizeString(jobId)) || null;
}

/**
 * 把浏览器回调交给 Go 完成换码；Go 返回的快照直接推进本地进度。
 *
 * 返回 { ok, code?, retryable?, job? }，与本地 completeBrowserOauthCallback 同形。
 */
async function completeGoReauthCallback(ctx, jobId, callbackUrl) {
  const id = normalizeString(jobId);
  const tracker = trackedJobs.get(id) || null;
  const callback = normalizeString(callbackUrl);
  if (!id || !callback) {
    return { ok: false, code: 'invalid_callback_url', job: tracker ? serializeAuthJob(tracker) : null };
  }
  if (tracker && tracker.status !== 'running') {
    return { ok: false, code: 'job_not_running', job: serializeAuthJob(tracker) };
  }
  const goHost = getGoHost(ctx);
  if (!goHost || typeof goHost.completeAccountAuthJob !== 'function') {
    return { ok: false, code: 'go_auth_job_unavailable', retryable: true, job: tracker ? serializeAuthJob(tracker) : null };
  }
  const response = await goHost.completeAccountAuthJob(id, callback).catch(() => null);
  if (!response) {
    return { ok: false, code: 'go_auth_job_unreachable', retryable: true, job: tracker ? serializeAuthJob(tracker) : null };
  }
  if (response.ok !== true) {
    const failureBody = response.data && typeof response.data === 'object' ? response.data : {};
    const code = normalizeString(failureBody.code)
      || normalizeString(failureBody.error)
      || normalizeString(response.errorCode)
      || `http_${Number(response.status) || 0}`;
    // 5xx / 网络层失败时 Go 作业可能还在等待重试；保留 running，让用户重新提交。
    const retryable = Number(response.status) === 0 || Number(response.status) >= 500;
    if (tracker) {
      appendJobLog(tracker, `Go 完成登录失败：${code}${retryable ? '（可重试）' : ''}`);
      if (!retryable) finishTracking(ctx, tracker, { status: 'failed', failureCode: code });
      else emitJob(ctx, tracker);
    }
    return { ok: false, code, retryable, job: tracker ? serializeAuthJob(tracker) : null };
  }
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  if (tracker) {
    applyGoSnapshot(ctx, tracker, { job: data });
    if (tracker.status === 'succeeded') {
      return { ok: true, job: serializeAuthJob(tracker) };
    }
    return {
      ok: false,
      code: normalizeString(data.failure_code)
        || normalizeString(data.error_code)
        || tracker.failureCode
        || 'go_auth_job_not_completed',
      job: serializeAuthJob(tracker)
    };
  }
  return {
    ok: normalizeString(data.status).toLowerCase() === 'completed',
    ...(normalizeString(data.status).toLowerCase() === 'completed'
      ? {}
      : { code: normalizeString(data.failure_code) || 'go_auth_job_not_completed' })
  };
}

/**
 * 取消 Go 作业；返回与本地 cancelJob 同形的结果。
 */
async function cancelGoReauthJob(ctx, jobId) {
  const id = normalizeString(jobId);
  const tracker = trackedJobs.get(id) || null;
  const goHost = getGoHost(ctx);
  if (!goHost || typeof goHost.cancelAccountAuthJob !== 'function') {
    return { ok: false, code: 'go_auth_job_unavailable', job: tracker ? serializeAuthJob(tracker) : null };
  }
  const response = await goHost.cancelAccountAuthJob(id).catch(() => null);
  if (response && response.ok === true && response.data) {
    if (tracker) {
      const data = response.data;
      const status = normalizeString(data.status).toLowerCase();
      if (status === 'cancelled' || status === 'expired' || status === 'failed') {
        finishTracking(ctx, tracker, {
          status: status === 'failed' ? 'failed' : status,
          failureCode: status === 'expired' ? 'expired' : 'cancelled'
        });
      } else {
        // 作业已经被回调消费者领取：取消不会中断，保持 running 等终态。
        appendJobLog(tracker, 'Go 作业已进入处理阶段，取消未生效。');
        emitJob(ctx, tracker);
      }
      return { ok: true, job: serializeAuthJob(tracker) };
    }
    return { ok: true, job: null };
  }
  const failureBody = response && response.data && typeof response.data === 'object'
    ? response.data
    : {};
  const code = normalizeString(failureBody.code)
    || normalizeString(failureBody.error)
    || normalizeString(response && response.errorCode)
    || 'cancel_failed';
  if (tracker) {
    // 与本地 cancelJob 对齐：已进入处理阶段不算取消失败；作业已经消失
    // （Go 重启清理）也按结束处理，避免弹窗一直挂在 running。
    if (code === 'job_not_pending') {
      return { ok: true, job: serializeAuthJob(tracker) };
    }
    if (code === 'job_expired' || code === 'job_not_found') {
      finishTracking(ctx, tracker, {
        status: code === 'job_expired' ? 'expired' : 'cancelled',
        failureCode: code
      });
      return { ok: true, job: serializeAuthJob(tracker) };
    }
  }
  return { ok: false, code, job: tracker ? serializeAuthJob(tracker) : null };
}

/**
 * 尝试让 Go 承接一次重新认证。
 *
 * handled=false 表示 Go 没有这条能力（未装配 / 该 Provider 还没迁 Go），
 * 调用方应回落到 Node 本地流程；handled=true 时响应已经写出。
 */
async function tryGoReauth(ctx, options = {}) {
  const goHost = getGoHost(ctx);
  if (!goHost || typeof goHost.reauthAccount !== 'function') return { handled: false };
  const provider = normalizeString(options.provider).toLowerCase();
  const accountRef = normalizeString(options.accountRef);
  if (!provider || !accountRef) return { handled: false };

  const response = await goHost.reauthAccount(provider, accountRef).catch(() => null);
  if (!response) return { handled: false };

  if (response.ok === true && response.data) {
    const tracked = startGoReauthTracking(ctx, {
      provider,
      accountRef,
      authMode: options.authMode,
      authStrategy: options.authStrategy,
      previousAccountState: options.previousAccountState,
      accountLabel: options.accountLabel,
      result: response.data
    });
    if (!tracked) return { handled: false };
    ctx.writeJson(ctx.res, 200, tracked.response);
    return { handled: true };
  }

  const body = response.data && typeof response.data === 'object' ? response.data : {};
  // Go 的 reauth 错误把稳定错误族放在 error，具体原因放在 code；管理客户端对
  // 字符串 error 只能给出 http_404 之类的状态码兜底，所以先读 body。
  const code = normalizeString(body.code)
    || normalizeString(body.error)
    || normalizeString(response.errorCode);
  // 这些分支说明 Go 还没承接该 Provider / 路由或作业服务未装配：
  // Node 仍然是这部分登录的执行者，回落本地流程。
  if (
    code === 'reauth_unsupported'
    || code === 'unsupported_provider'
    || code === 'unsupported_auth_mode'
    || code === 'reauth_unavailable'
    || (Number(response.status) === 404 && code === 'account_not_found')
    || Number(response.status) === 501
  ) {
    return { handled: false };
  }

  // 其余是明确失败（运行态冲突、身份不匹配等）：不本地重试，原样映射。
  // 同一 Provider 的进行中作业可能是 Node 本地起的，Go 不知道它的 ID；
  // 这时用本地 manager 的运行中作业补齐，前端才能直接打开当前进度。
  const status = Number(response.status) || 500;
  const runningJob = options.runningJob && typeof options.runningJob === 'object'
    ? options.runningJob
    : null;
  const jobId = normalizeString(body.jobId) || normalizeString(runningJob && runningJob.id);
  const activeAccountRef = normalizeString(body.accountRef)
    || normalizeString(runningJob && runningJob.accountRef);
  ctx.writeJson(ctx.res, status, {
    ok: false,
    error: normalizeString(body.error) || 'reauth_account_failed',
    ...(code ? { code } : {}),
    ...(normalizeString(body.message) ? { message: normalizeString(body.message) } : {}),
    ...(jobId ? { jobId } : {}),
    ...(activeAccountRef ? { accountRef: activeAccountRef } : {})
  });
  return { handled: true };
}

module.exports = {
  startGoReauthTracking,
  getTrackedJob,
  completeGoReauthCallback,
  cancelGoReauthJob,
  tryGoReauth
};
