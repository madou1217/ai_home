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
const { normalizeKiroLoginProvider } = require('../account/kiro-login-provider');

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

function resolveFailureMessage(code, purpose) {
  const normalized = normalizeString(code);
  if (normalized === 'provider_unavailable') return '上游授权服务暂时不可用，请稍后重试。';
  if (normalized === 'provider_rejected') return '上游拒绝了本次授权请求，请重新发起登录。';
  if (normalized === 'invalid_callback' || normalized === 'state_mismatch') {
    return '回调地址与本次授权不匹配，请重新复制完整的回调地址。';
  }
  if (normalized === 'expired') return '授权已超时，请重新发起登录。';
  if (normalized === 'reauthentication_identity_mismatch') return '登录身份与目标账号不一致，未覆盖原账号。';
  return normalized || (purpose === 'register' ? '登录失败。' : '重新认证失败。');
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

// deriveOauthState 从授权地址里取 state，仅用于把 zcode:// 协议回调归属到 Go 作业。
// state 的生成与校验仍然只在 Go；这里只做与本地作业相同的归属判断。
function deriveOauthState(authorizationUrl) {
  const raw = normalizeString(authorizationUrl);
  if (!raw) return '';
  try {
    return normalizeString(new URL(raw).searchParams.get('state'));
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
    : resolveFailureMessage(options.failureCode || tracker.error, tracker.purpose);
  const progressState = resolveProgressState(
    status === 'succeeded' ? 'completed' : status,
    tracker.authMode
  );
  setAuthProgressState(tracker, progressState);
  appendJobLog(
    tracker,
    status === 'succeeded'
      ? (tracker.purpose === 'register'
        ? 'Go 已完成登录并写入账号。'
        : 'Go 已完成重新认证并写入账号。')
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
      // 新增账号的本地收尾（别名选号偏好等）必须先于 onFinished：onFinished 会
      // 重载 runtime pool，偏好晚落库会让「不入池」的账号先被拉进池。失败只记日志，
      // 不改写作业结论。
      if (tracker.purpose !== 'register' || typeof tracker._onSucceeded !== 'function') return null;
      try {
        return Promise.resolve(tracker._onSucceeded(tracker)).catch((error) => {
          appendJobLog(
            tracker,
            `本地收尾失败：${normalizeString((error && (error.code || error.message)) || error) || 'unknown_error'}`
          );
          emitJob(ctx, tracker);
        });
      } catch (error) {
        appendJobLog(
          tracker,
          `本地收尾失败：${normalizeString((error && (error.code || error.message)) || error) || 'unknown_error'}`
        );
        emitJob(ctx, tracker);
        return null;
      }
    }).then(() => {
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

// readGoJobSnapshot 读取 Go 作业快照的关键字段。
//
// 两个 Go 入口的形状不同：accountauthapi（SSE / reauth 回调）用 snake_case，
// webuiaccountaddapi（新增作业）用 camelCase。这里统一成内部字段，
// 状态优先取 goStatus（camelCase 入口把 Node 词汇放在 status 里）。
function readGoJobSnapshot(payload) {
  const job = payload && payload.job && typeof payload.job === 'object' ? payload.job : (payload || {});
  const rawStatus = normalizeString(job.goStatus || job.go_status || job.status).toLowerCase();
  const finished = job.finished_at || job.finishedAt;
  return {
    status: rawStatus,
    failureCode: normalizeString(job.failure_code || job.failureCode),
    finishedAt: typeof finished === 'number' ? finished : (Date.parse(String(finished || '')) || 0),
    accountRef: normalizeString(job.account_ref || job.accountRef),
    cliAccountId: Number(job.cli_account_id || job.cliAccountId) || 0,
    authMode: normalizeString(job.auth_mode || job.authMode),
    authorizationUrl: normalizeString(job.authorization_url || job.authorizationUrl),
    userCode: normalizeString(job.user_code || job.userCode),
    redirectUri: normalizeString(job.redirect_uri || job.redirectUri)
  };
}

function applyGoSnapshot(ctx, tracker, payload) {
  if (!tracker || !payload) return tracker;
  const snapshot = readGoJobSnapshot(payload);
  const goStatus = snapshot.status;
  if (!goStatus) return tracker;
  const mappedStatus = mapGoStatus(goStatus);
  if (tracker.status !== 'running') return tracker;
  if (snapshot.accountRef) tracker.accountRef = snapshot.accountRef;
  if (snapshot.cliAccountId) tracker.cliAccountId = snapshot.cliAccountId;
  if (snapshot.authMode) tracker.authMode = snapshot.authMode;
  if (snapshot.authorizationUrl) tracker.authorizationUrl = snapshot.authorizationUrl;
  if (snapshot.userCode) tracker.userCode = snapshot.userCode;
  if (snapshot.redirectUri) tracker.redirectUri = snapshot.redirectUri;
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
    failureCode: snapshot.failureCode || goStatus,
    finishedAt: snapshot.finishedAt || Date.now()
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
    // 自定义协议（zcode://）没有 loopback：协议处理器回来时靠 state 判断是不是这个作业。
    oauthState: deriveOauthState(result.authorizationUrl),
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

/**
 * 开始跟踪一个由 Go 创建的「新增账号」作业。
 *
 * 与重新认证共用同一张 trackedJobs 表：作业 id 是 Go 分配的，后续 GET / callback /
 * cancel 都按 id 找到同一条 tracker。新增作业的差异只有三处：purpose=register、
 * 成功后的本地收尾（别名选号偏好），以及安装确认对 Go 作业恒为「不需要」。
 */
function startGoAddTracking(ctx, options = {}) {
  pruneTrackedJobs();
  const result = options.result && typeof options.result === 'object' ? options.result : {};
  const jobId = normalizeString(result.jobId || result.job_id);
  if (!jobId) return null;
  const existing = trackedJobs.get(jobId);
  if (existing) {
    return { tracker: existing, response: buildGoAddResponse(existing) };
  }
  const now = Date.now();
  const authMode = normalizeString(result.authMode || options.authMode) || 'oauth-browser';
  const tracker = {
    id: jobId,
    provider: normalizeString(options.provider || result.provider).toLowerCase(),
    accountRef: '',
    authMode,
    authStrategy: normalizeString(result.authStrategy || options.authStrategy),
    purpose: 'register',
    reauth: false,
    status: 'running',
    authProgressState: normalizeString(result.authProgressState)
      || resolveProgressState('pending', authMode),
    authorizationUrl: normalizeString(result.authorizationUrl),
    userCode: normalizeString(result.userCode),
    redirectUri: normalizeString(result.redirectUri) || deriveRedirectUri(result.authorizationUrl),
    oauthState: deriveOauthState(result.authorizationUrl),
    expiresAt: Number(result.expiresAt) || null,
    pollIntervalMs: Number(result.pollIntervalMs) || (authMode === 'oauth-device' ? 2000 : 1000),
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
    email: '',
    displayName: '',
    planType: '',
    aliasPoolParticipates: options.aliasPoolParticipates !== false,
    _onSucceeded: typeof options.onSucceeded === 'function' ? options.onSucceeded : null
  };
  trackedJobs.set(jobId, tracker);
  appendJobLog(tracker, '已由 Go 承接新增账号作业。');
  attachLoopbackCapture(ctx, tracker);
  emitJob(ctx, tracker);
  scheduleCleanup(tracker);
  consumeJobStream(ctx, tracker).catch(() => {});
  return { tracker, response: buildGoAddResponse(tracker) };
}

// buildGoAddResponse 与 Node 的 buildPendingOauthResponse 同形，前端不需要区分执行者。
function buildGoAddResponse(tracker) {
  if (!tracker) return null;
  return {
    ok: true,
    provider: tracker.provider,
    accountRef: '',
    authMode: tracker.authMode,
    authStrategy: tracker.authStrategy,
    status: 'pending',
    jobId: tracker.id,
    authorizationUrl: tracker.authorizationUrl,
    ...(tracker.userCode ? { userCode: tracker.userCode } : {}),
    expiresAt: tracker.expiresAt,
    pollIntervalMs: tracker.pollIntervalMs,
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
  if (!goHost) {
    return { ok: false, code: 'go_auth_job_unavailable', retryable: true, job: tracker ? serializeAuthJob(tracker) : null };
  }
  // 新增账号与重新认证的作业共用 Go 的作业服务，但公开入口不同：
  // 新增走 /webui/accounts/add/jobs/:id/callback（Node 侧契约），重新认证走通用作业路径。
  // 只要求当前这条作业真正需要的调用存在，避免新增路径被重新认证方法绑死。
  const isAddJob = Boolean(tracker && tracker.purpose === 'register');
  const complete = isAddJob && typeof goHost.completeAddAccountJob === 'function'
    ? goHost.completeAddAccountJob
    : goHost.completeAccountAuthJob;
  if (typeof complete !== 'function') {
    return { ok: false, code: 'go_auth_job_unavailable', retryable: true, job: tracker ? serializeAuthJob(tracker) : null };
  }
  const response = await complete(id, callback).catch(() => null);
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
  // 两个入口的响应形状不同：重新认证是 job 快照本身，新增是 { ok, job }。
  // readGoJobSnapshot 会优先读 `.job`，这里直接把整个 data 交进去。
  const data = response.data && typeof response.data === 'object' ? response.data : {};
  if (tracker) {
    applyGoSnapshot(ctx, tracker, data);
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
  const finalStatus = normalizeString(data.goStatus || data.status).toLowerCase();
  const completed = finalStatus === 'completed' || finalStatus === 'succeeded';
  return {
    ok: completed,
    ...(completed
      ? {}
      : { code: normalizeString(data.failure_code || data.failureCode) || 'go_auth_job_not_completed' })
  };
}

/**
 * 取消 Go 作业；返回与本地 cancelJob 同形的结果。
 */
async function cancelGoReauthJob(ctx, jobId) {
  const id = normalizeString(jobId);
  const tracker = trackedJobs.get(id) || null;
  const goHost = getGoHost(ctx);
  if (!goHost) {
    return { ok: false, code: 'go_auth_job_unavailable', job: tracker ? serializeAuthJob(tracker) : null };
  }
  const isAddJob = Boolean(tracker && tracker.purpose === 'register');
  const cancel = isAddJob && typeof goHost.cancelAddAccountJob === 'function'
    ? goHost.cancelAddAccountJob
    : goHost.cancelAccountAuthJob;
  if (typeof cancel !== 'function') {
    return { ok: false, code: 'go_auth_job_unavailable', job: tracker ? serializeAuthJob(tracker) : null };
  }
  const response = await cancel(id).catch(() => null);
  if (response && response.ok === true && response.data) {
    if (tracker) {
      const data = response.data;
      // 两个入口的快照形状不同（camelCase / snake_case），统一交给 applyGoSnapshot
      // 判定终态；它只在 Go 明确给出终态时改状态。
      applyGoSnapshot(ctx, tracker, data);
      if (tracker.status === 'running') {
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
 * 本机来源链是否为「当前认证方式」提供了可直接导入的来源。
 *
 * 判定与 WebUI 的 AuthProgressModal 完全同源：界面只在来源 kind=local、不是整批扫描、
 * 且 authMode 与作业一致时渲染「从本机导入」（可安装时渲染「安装客户端」）。
 * 只要这条入口存在，新增作业就必须留在 Node——Go 的 OAuth 作业没有本机导入实现。
 */
function hasLocalImportOption(ctx, provider, authMode) {
  try {
    const { resolveAuthSources } = require('../account/auth-sources');
    const resolved = resolveAuthSources(provider, {
      fs: ctx && ctx.fs,
      aiHomeDir: ctx && ctx.deps && ctx.deps.aiHomeDir,
      hostCapabilitiesOptions: { hostHomeDir: ctx && ctx.deps && ctx.deps.hostHomeDir }
    });
    return (resolved.sources || []).some((source) => source
      && source.kind === 'local'
      && source.handler !== 'host-account-scan'
      && String(source.authMode || '') === authMode
      && (source.available === true || source.installable === true));
  } catch (_error) {
    // 解析失败按「有本机入口」保守处理：宁可留在 Node，也不能让导入按钮失效。
    return true;
  }
}

/** 找到该 Provider 上仍在运行的 Go 作业（新增或重新认证共用一张表）。 */
function findTrackedJobByProvider(provider) {
  pruneTrackedJobs();
  const normalized = normalizeString(provider).toLowerCase();
  if (!normalized) return null;
  for (const job of trackedJobs.values()) {
    if (job.status === 'running' && String(job.provider || '').toLowerCase() === normalized) return job;
  }
  return null;
}

/**
 * 找到与自定义协议回调 state 匹配的 Go 作业。
 *
 * zcode:// 协议处理器只带 URL/state：本地 Node 作业匹配不上时，用它判断是不是
 * Go 承接中的新增/重新认证作业。state 的来源与校验仍以 Go 为准，这里只做归属。
 */
function findTrackedJobByState(provider, state) {
  pruneTrackedJobs();
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const normalizedState = normalizeString(state);
  if (!normalizedProvider || !normalizedState) return null;
  for (const job of trackedJobs.values()) {
    if (job.status !== 'running') continue;
    if (String(job.provider || '').toLowerCase() !== normalizedProvider) continue;
    if (normalizeString(job.oauthState) === normalizedState) return job;
  }
  return null;
}

/**
 * 取消该 Provider 上仍在运行的 Go 作业（replaceExisting / 切换登录方式时使用）。
 *
 * 不做全量清理：只处理调用方点名的那一个 Provider；没有 Go 作业时返回 null。
 */
async function cancelTrackedGoJobForProvider(ctx, provider) {
  const tracker = findTrackedJobByProvider(provider);
  if (!tracker) return null;
  return cancelGoReauthJob(ctx, tracker.id);
}

/**
 * 尝试让 Go 承接一次新增账号的 OAuth 作业。
 *
 * handled=false 表示这次请求必须留在 Node：Go 未装配、Provider 没有 Go 登录流程、
 * 认证方式/策略是 Node 专有，或本机存在可用的导入来源（Go 作业没有导入实现）。
 * handled=true 时响应已经写出。
 */
async function tryGoAddAccount(ctx, options = {}) {
  const goHost = getGoHost(ctx);
  if (!goHost || typeof goHost.startAddAccountJob !== 'function') return { handled: false };
  const provider = normalizeString(options.provider).toLowerCase();
  const authMode = normalizeString(options.authMode).toLowerCase();
  if (!provider || (authMode !== 'oauth-browser' && authMode !== 'oauth-device')) {
    return { handled: false };
  }
  if (hasLocalImportOption(ctx, provider, authMode)) return { handled: false };

  // kiro 的 Builder ID 在 Node 归一后是空串；直接把 UI 的 'builder-id' 送进 Go
  // 会被当成 Node 专有的 social 登录而回落，设备码作业就永远迁不过来。
  const loginProvider = provider === 'kiro'
    ? normalizeKiroLoginProvider(options.loginProvider)
    : normalizeString(options.loginProvider);
  const response = await goHost.startAddAccountJob({
    provider,
    authMode,
    authStrategy: normalizeString(options.authStrategy),
    loginProvider
  }).catch(() => null);
  if (!response) return { handled: false };

  if (response.ok === true && response.data) {
    const tracked = startGoAddTracking(ctx, {
      provider,
      authMode,
      authStrategy: normalizeString(options.authStrategy),
      aliasPoolParticipates: options.aliasPoolParticipates,
      onSucceeded: options.onSucceeded,
      result: response.data
    });
    if (!tracked) return { handled: false };
    ctx.writeJson(ctx.res, 200, tracked.response);
    return { handled: true };
  }

  const body = response.data && typeof response.data === 'object' ? response.data : {};
  const code = normalizeString(body.code) || normalizeString(body.error) || normalizeString(response.errorCode);
  const status = Number(response.status) || 0;
  // 这些结论说明 Go 没有承接能力或这次请求必须由 Node 执行：回落本地作业。
  if (
    status === 0
    || status === 404
    || status === 501
    || code === 'unsupported_provider'
    || code === 'unsupported_auth_mode'
    || code === 'unsupported_auth_strategy'
    || code === 'unsupported_login_provider'
    || code === 'go_core_unavailable'
    || code === 'network_error'
    || code === 'http_404'
    || code === 'http_501'
  ) {
    return { handled: false };
  }

  // 明确失败（容量 / 已有运行中的作业 / 上游不可用）：原样映射，
  // 与重新认证一致，不在这里替用户重试。
  // 运行中的作业可能是 Node 本地起的（先于 Go 占用 Provider），调用方会把它传进来；
  // 带回 jobId，前端才能直接打开现有进度而不是只看到一条 409。
  const localJob = options.runningJob && typeof options.runningJob === 'object'
    ? options.runningJob
    : null;
  const runningJob = localJob || findTrackedJobByProvider(provider);
  const jobId = normalizeString(body.jobId) || normalizeString(runningJob && runningJob.id);
  const accountRef = normalizeString(runningJob && runningJob.accountRef);
  ctx.writeJson(ctx.res, status || 500, {
    ok: false,
    error: normalizeString(body.error) || 'add_account_failed',
    ...(code ? { code } : {}),
    ...(normalizeString(body.message) ? { message: normalizeString(body.message) } : {}),
    ...(jobId ? { jobId } : {}),
    ...(accountRef ? { accountRef } : {})
  });
  return { handled: true };
}

/**
 * 让 Go 对新增作业执行本机导入。
 *
 * 目前 Go 的 OAuth 作业没有导入实现（返回 local_import_unsupported），桥接层只会把
 * 「本机没有可用来源」的作业交给 Go，正常 UI 路径不会走到这里；保留这条转发是为了
 * 让直接调用管理 API 的客户端拿同一个稳定结论，而不是拿到 404。
 */
async function localImportGoAddJob(ctx, jobId, sourceId) {
  const id = normalizeString(jobId);
  const source = normalizeString(sourceId);
  const tracker = trackedJobs.get(id) || null;
  const goHost = getGoHost(ctx);
  if (!goHost || typeof goHost.importAddAccountJob !== 'function') {
    return { ok: false, code: 'go_auth_job_unavailable', status: 503, job: tracker ? serializeAuthJob(tracker) : null };
  }
  const response = await goHost.importAddAccountJob(id, source).catch(() => null);
  if (response && response.ok === true) {
    const data = response.data && typeof response.data === 'object' ? response.data : {};
    if (tracker) {
      applyGoSnapshot(ctx, tracker, { job: data.job || data });
      return { ok: true, job: serializeAuthJob(tracker) };
    }
    return { ok: true, job: null };
  }
  const body = response && response.data && typeof response.data === 'object' ? response.data : {};
  return {
    ok: false,
    code: normalizeString(body.code) || normalizeString(body.error)
      || normalizeString(response && response.errorCode) || 'local_import_failed',
    status: Number(response && response.status) || 0,
    message: normalizeString(body.message),
    job: body.job || (tracker ? serializeAuthJob(tracker) : null)
  };
}

/**
 * 安装确认：Go 作业不依赖本地 CLI，结论固定为 install_not_required。
 *
 * 结论由 Go 给出（而不是 Node 直接拼 400），Node 只负责把稳定错误码映射成 HTTP 状态。
 */
async function confirmGoAddJobInstall(ctx, jobId) {
  const id = normalizeString(jobId);
  const tracker = trackedJobs.get(id) || null;
  const goHost = getGoHost(ctx);
  if (!goHost || typeof goHost.confirmAddAccountJobInstall !== 'function') {
    return { ok: false, code: 'go_auth_job_unavailable', job: tracker ? serializeAuthJob(tracker) : null };
  }
  const response = await goHost.confirmAddAccountJobInstall(id).catch(() => null);
  const body = response && response.data && typeof response.data === 'object' ? response.data : {};
  if (response && response.ok === true && body.ok === true) {
    return { ok: true, job: body.job || (tracker ? serializeAuthJob(tracker) : null) };
  }
  return {
    ok: false,
    code: normalizeString(body.code) || normalizeString(body.error)
      || normalizeString(response && response.errorCode) || 'install_failed',
    message: normalizeString(body.message),
    job: body.job || (tracker ? serializeAuthJob(tracker) : null)
  };
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
  startGoAddTracking,
  getTrackedJob,
  findTrackedJobByProvider,
  findTrackedJobByState,
  cancelTrackedGoJobForProvider,
  completeGoReauthCallback,
  cancelGoReauthJob,
  confirmGoAddJobInstall,
  localImportGoAddJob,
  tryGoReauth,
  tryGoAddAccount
};
