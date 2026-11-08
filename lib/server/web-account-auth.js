'use strict';

const path = require('node:path');
const { registerProviderAuthProjection } = require('../account/native-auth-projection');
const { prepareKiroIdentityProjection } = require('../account/kiro-native-login');
const { normalizeKiroLoginProvider } = require('../account/kiro-login-provider');
const { registerAccountIdentity } = require('../account/account-registration');
const { resolveIdentitySeedFromAccount } = require('../account/account-identity');
const { isAccountRef, resolveAccountRef } = require('./account-ref-store');
const { resolveLoginRuntimeDir } = require('../runtime/aih-storage-layout');
const crypto = require('node:crypto');

const { AI_CLI_CONFIGS } = require('../cli/services/ai-cli/provider-registry');
const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime
} = require('../cli/services/ai-cli/provider-runtime-env');
const {
  ensureNativeCliAvailable,
  installNativeCliWithProgress,
  buildCliNotFoundMessage,
  resolveProviderCliPath
} = require('../cli/services/ai-cli/ensure-native-cli');
const {
  CLAUDE_CREDENTIAL_TYPES,
  writeClaudeCredentialEnv
} = require('../account/claude-credential');
const {
  CLI_SPEC,
  normalizeCredentialConfig
} = require('../profile/credential-config');
const {
  readAccountNativeAuth,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('./account-credential-store');
const { mergeOpenCodeNativeAuth } = require('../account/opencode-native-auth');
const { PROVIDER_IDS, getProviderAuthOptions } = require('../provider-catalog');
const {
  getProviderAuthArtifacts,
  getProviderStoragePolicy
} = require('../runtime/provider-storage-policy');
const { buildUpstreamProfileEnv } = require('./upstream-account-profile');
const { resolveNativeCliPath } = require('../runtime/native-cli-resolver');
const { loadNodePty: loadRuntimeNodePty } = require('../runtime/node-pty-loader');
const { buildPtyLaunch, resolveWindowsBatchLaunch } = require('../runtime/pty-launch');
const { resolveCodexSqliteHome } = require('../runtime/codex-home');
const { hasUsableKimiOAuth } = require('../account/kimi-auth');
const { startOauthLoopbackCallbackServer } = require('./oauth-loopback-callback');
const { resolveLoginStrategy } = require('./oauth-login-strategies');
const {
  AGY_GOOGLE_CLIENT_ID,
  AGY_GOOGLE_CLIENT_SECRET,
  AGY_GOOGLE_CLIENT_CREDENTIALS
} = require('./oauth-strategies/agy');
const { resolveProviderCliExecutable } = require('../runtime/provider-cli-executable');
const {
  OAUTH_PENDING_FALLBACK_STALE_MS,
  resolveOauthJobDeadline
} = require('./oauth-pending-state');
// Go 承接 codex/zcode/opencode 登录的失败映射。
const { toGoAuthJobFailure } = require('./web-account-auth-go-jobs');

const { DEVICE_CODE_DURATION_UNITS_MS, loadNodePty, createLazyPtyAdapter, createAnsiStripper, stripAnsi, normalizeString, base64Url, createPkcePair, createOauthState, normalizeAuthMode, compactLogText, parseDeviceCodeExpiryMs, parseDeviceCodePollIntervalMs, isProcessAlive } = require('./web-account-auth-utils');
const { deriveProviderAuthModes, DERIVED_PROVIDER_AUTH, PROVIDER_AUTH_MODE_MATRIX, PROVIDER_DEFAULT_AUTH_MODE, normalizeExistingAccountRef, isSupportedAuthMode, isSupportedAuthStrategy, getDefaultAuthMode } = require('./web-account-auth-auth-mode');
const { JOB_LOG_LIMIT, AUTH_PROGRESS_STATES, appendLogText, appendLog, notifyAuthJobChanged, appendJobLog, setAuthProgressState, serializeAuthJob, resolveInitialAuthProgressState, resolveFinishedAuthProgressState, isAgyGoogleOAuthPrompt, maybeSelectAgyGoogleOAuth } = require('./web-account-auth-job');
const { applyAliasPoolPreference } = require('../account/alias-pool-preference');
const { hasCodexOauthTokens, hasGeminiOauthTokens, hasAgyOauthTokens, hasGrokOauthTokens, hasKimiOauthTokens, OAUTH_ARTIFACT_PATH_OVERRIDES, getOauthArtifactPath, readOauthArtifactSignature, hasGenericOauthArtifact, hasOauthCompletionArtifacts } = require('./web-account-auth-oauth-tokens');
const { BROWSER_CAPTURE_UNIX, BROWSER_CAPTURE_WIN, extractOAuthChallenge, getUrlPrefix, isUrlContinuationLine, collectWrappedHttpUrls, collectHttpUrls, extractBrowserOAuthHints, isLoopbackCallbackUrl, buildBrowserCaptureCommand, parseBrowserCallbackInput, isSameCallbackEndpoint, parseAuthorizationCodeInput } = require('./web-account-auth-oauth-browser');
const { buildLoginArgs, resolveProviderConfigDir, ensureLoginRuntime, configureApiKeyAccount, hashSecret, configureVertexAiAccount } = require('./web-account-auth-account-config');
const {
  beginKiroDeviceLogin,
  beginKiroSocialDeviceLogin,
  buildKiroAuthRow,
  importKiroRefreshToken,
  pollKiroDeviceLogin,
  pollKiroSocialDeviceLogin,
  writeKiroCredentialDatabase
} = require('../account/kiro-device-login');
const FINISHED_JOB_TTL_MS = 15 * 60 * 1000;
// 登录作业不能只靠「有人来读」推进：CodeBuddy 家族登录成功后 CLI 直接进 TUI、
// 永不退出，既没有 onExit 也没有产物回调。没有心跳时，凭据已经落地也不会入库 ——
// 真机事故：`aih codebuddy login` 22:19 发起、22:20 凭据写进假 HOME，账号至今没留存。
// 心跳只做「把产物落地翻译成收尾」，与 UI 轮询走的是同一条 refreshJobState。
const JOB_HEARTBEAT_INTERVAL_MS = 2_000;
// 设备码作业的状态轮询间隔。Go 在后台按上游给出的间隔轮询设备码，Node 只读
// 作业快照；2s 足够跟上用户完成授权的节奏，也不会把管理 API 打出压力。
const GO_DEVICE_STATUS_POLL_INTERVAL_MS = 2_000;
// 认证方式的事实来源是 Go 契约（core/providers/builtins.go 的 authOptions，
// 经 provider-catalog 读取）。这里只做派生，不再手维护 provider 列表：
// 新增 provider 后认证方式自动生效，避免出现「目录里有、网关不认」的漂移。
// - 支持的模式 = 该 provider 声明的全部 authOptions（含已停用项，保持历史行为）；
// - 默认模式 = 第一个非停用的 oauth 选项，否则第一个非停用选项。
const RFC8628_DEFAULT_POLL_INTERVAL_MS = 5000;
const MANUAL_CALLBACK_OAUTH_TTL_MS = OAUTH_PENDING_FALLBACK_STALE_MS;
// zcode 登录整体由 Go 的 account-auth-jobs 承接（Node 策略文件已删除）。
// 这里只描述 Node 侧作业记录需要的最小形态：自定义协议没有 loopback，只能手填回调；
// 授权入口、state、PKCE 与换码都只在 Go 进程里，Node 不生成也不持有。
const ZCODE_GO_NATIVE_OAUTH = Object.freeze({
  logLabel: 'ZCode',
  loopbackRedirectUri: 'zcode://oauth/callback',
  requiresGoAuthJob: true
});
// codex 浏览器登录固定由 Go 承接：Node 不再生成 PKCE/state，也不再向 OpenAI 发换码请求。
// loopback 回调捕获仍留在 Node（监听 1455），拿到的完整回调原样转给 Go。
const CODEX_GO_NATIVE_OAUTH = Object.freeze({
  logLabel: 'Codex',
  loopbackRedirectUri: 'http://localhost:1455/auth/callback',
  requiresGoAuthJob: true
});
// claude 浏览器登录同样固定由 Go 承接（Node 策略文件已删除）。
// 54545 是 Node 生产路径一直在用的 loopback 回调端口，Go 的授权请求与换码参数
// 已按同一组值对齐；Node 只负责监听并把完整回调转发给 Go。
const CLAUDE_GO_NATIVE_OAUTH = Object.freeze({
  logLabel: 'Claude',
  loopbackRedirectUri: 'http://localhost:54545/callback',
  requiresGoAuthJob: true
});
// agy 的 Google 直连登录固定由 Go 承接（Node 的直连策略分支已删除）。
// 与 Node 原行为一致：不监听 51121，用户完成授权后把回调地址粘回来。
const AGY_GO_NATIVE_OAUTH = Object.freeze({
  logLabel: 'Antigravity',
  loopbackRedirectUri: 'http://localhost:51121/oauth-callback',
  requiresGoAuthJob: true,
  autoCaptureCallback: false
});
// opencode 登录同样固定由 Go 承接（Node 策略文件已删除）。
// Console 的设备码流程没有回调、也不依赖本机 CLI：Go 自己申请设备码、按上游间隔
// 轮询，ready 后直接写账号。Node 只展示 user_code + 验证地址，并轮询 Go 的作业状态。
const OPENCODE_GO_DEVICE_OAUTH = Object.freeze({
  logLabel: 'OpenCode',
  authMode: 'oauth-device',
  requiresGoAuthJob: true,
  deviceCode: true,
  manualCallback: false,
  autoCaptureCallback: false
});
function createAuthJobManager(options = {}) {
  const {
    fs,
    processObj = process,
    ptyImpl = createLazyPtyAdapter(),
    // Prefer provider-aware resolution (binaryName + auto-install). Legacy tests
    // may inject resolveCliPathImpl; that still wins when provided.
    resolveCliPathImpl = null,
    ensureNativeCliImpl = ensureNativeCliAvailable,
    installNativeCliImpl = installNativeCliWithProgress,
    buildPtyLaunchImpl = buildPtyLaunch,
    resolveWindowsBatchLaunchImpl = resolveWindowsBatchLaunch,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    startLoopbackCallbackServerImpl = startOauthLoopbackCallbackServer,
    aiHomeDir,
    hostHomeDir = '',
    onOauthJobFinished,
    onJobChanged,
    verifyOauthJobCompleted,
    // Go account-auth-jobs 的接线（见 web-account-auth-go-jobs）。
    // 形态：{ client: { start, complete, cancel, status }, reconcile }；缺省＝无 client。
    goAuthJobs = null
  } = options;

  // client 只要宿主装配了 Go 门面就存在：codex/zcode/opencode 都固定走 Go 作业，
  // 不存在第二套本地换码路径。
  const goAuthJobClient = goAuthJobs && goAuthJobs.client ? goAuthJobs.client : null;
  // Go 与 Node 的账号引用派生规则不同（zcode 的区域参与 Node 身份）：Begin 的目标要
  // 翻成 Go 键，Complete 返回的 account_ref 要翻回 Node 键，否则收尾会找不到账号。
  const resolveGoAccountRef = goAuthJobs && typeof goAuthJobs.resolveGoAccountRef === 'function'
    ? goAuthJobs.resolveGoAccountRef
    : null;
  const resolveNodeAccountRef = goAuthJobs && typeof goAuthJobs.resolveNodeAccountRef === 'function'
    ? goAuthJobs.resolveNodeAccountRef
    : null;
  const reconcileGoAccountsImpl = goAuthJobClient && typeof goAuthJobs.reconcile === 'function'
    ? goAuthJobs.reconcile
    : null;

  const jobs = new Map();
  const runningProviders = new Map();

  function createInstallConfirmationJob(provider, authMode, options = {}) {
    const jobId = String(options.jobId || crypto.randomUUID());
    const job = attachJobChangeNotifier({
      id: jobId,
      provider,
      accountRef: normalizeExistingAccountRef(options.accountRef),
      authMode,
      authStrategy: String(options.authStrategy || ''),
      reauth: Boolean(options.accountRef),
      status: 'running',
      authProgressState: AUTH_PROGRESS_STATES.AWAITING_INSTALL_CONFIRMATION,
      setupPhase: 'awaiting-install-confirmation',
      installRequired: true,
      installAttempts: [],
      logs: '',
      exitCode: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOutputAt: Date.now(),
      pid: null,
      expiresAt: null,
      pollIntervalMs: null,
      _previousAccountState: options.previousAccountState || null
    });
    appendJobLog(job, `检测到未安装 ${provider} CLI，等待用户确认安装。`);
    jobs.set(jobId, job);
    runningProviders.set(provider, jobId);
    notifyAuthJobChanged(job);
    return {
      jobId,
      provider,
      accountRef: job.accountRef,
      authProgressState: job.authProgressState,
      setupPhase: job.setupPhase,
      installRequired: true
    };
  }

  async function confirmCliInstall(jobId) {
    const job = jobs.get(String(jobId || '').trim()) || null;
    if (!job) return { ok: false, code: 'job_not_found', job: null };
    if (job.status !== 'running') return { ok: false, code: 'job_not_running', job };
    if (!job.installRequired || job.setupPhase !== 'awaiting-install-confirmation') {
      return { ok: false, code: 'install_not_required', job };
    }
    job.setupPhase = 'installing';
    job.authProgressState = AUTH_PROGRESS_STATES.INSTALLING_CLI;
    appendJobLog(job, `开始安装 ${job.provider} CLI。`);
    notifyAuthJobChanged(job);
    const result = await installNativeCliImpl(job.provider, {
      fs,
      processObj,
      onPlanStart(plan) {
        appendJobLog(job, `正在执行：${plan.label}`);
      },
      onOutput(chunk) {
        appendLog(job, chunk);
        job.updatedAt = Date.now();
        notifyAuthJobChanged(job);
      },
      onPlanFinish(attempt) {
        job.installAttempts.push(attempt);
        appendJobLog(job, attempt.ok ? `${attempt.label} 安装成功。` : `${attempt.label} 安装失败：${compactLogText(attempt.error)}`);
      }
    });
    if (!result || !result.cliPath) {
      finalizeJob(job, 'failed', buildCliNotFoundMessage(job.provider, result || {}), null);
      return { ok: false, code: 'cli_install_failed', job };
    }
    appendJobLog(job, 'CLI 安装完成，正在自动继续授权流程。');
    const resumeOptions = {
      jobId: job.id,
      accountRef: job.accountRef,
      previousAccountState: job._previousAccountState,
      authStrategy: job.authStrategy,
      installConfirmed: true,
      // 安装确认作业被删掉、换一个新作业继续：新增时的「不入池」偏好要一起带过去。
      aliasPoolParticipates: job.aliasPoolParticipates
    };
    jobs.delete(job.id);
    runningProviders.delete(job.provider);
    const started = startOauthJob(job.provider, job.authMode, resumeOptions);
    return { ok: true, job: jobs.get(started.jobId) || null };
  }

  /**
   * 把「新增账号时是否进入别名自动选号池」的偏好挂到刚创建的作业上。
   *
   * 账号要等作业成功才注册，所以偏好只能在 finalizeJob 里落库；这里只把布尔挂到作业对象。
   * 只在显式「不参与」时挂——缺省＝参与，读侧没有记录就是参与，不必留痕。
   */
  function withAliasPoolPreference(started, jobOptions) {
    if (jobOptions && jobOptions.aliasPoolParticipates === false) {
      const job = jobs.get(String((started && started.jobId) || '').trim());
      if (job) job.aliasPoolParticipates = false;
    }
    return started;
  }

  /**
   * 账号注册成功后落「不入池」偏好。创建已经成功，偏好写入失败不该把作业判失败，
   * 因此只写进作业日志（账号级「别名选号」弹窗仍可再改）。
   */
  function applyAliasPoolPreferenceToJob(job) {
    if (!job || job.aliasPoolParticipates !== false) return;
    const result = applyAliasPoolPreference(fs, aiHomeDir, job.accountRef, false);
    if (result.error) appendJobLog(job, `别名选号偏好写入失败：${result.error}`);
  }

  function armJobHeartbeat(job) {
    if (!job || job._heartbeatTimer) return;
    const timer = setInterval(() => {
      if (job.status !== 'running') {
        clearInterval(timer);
        job._heartbeatTimer = null;
        return;
      }
      try {
        refreshJobState(job);
      } catch (_error) {
        // 心跳绝不能把服务打挂：单次刷新失败下一拍再来。
      }
    }, JOB_HEARTBEAT_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    job._heartbeatTimer = timer;
  }

  function attachJobChangeNotifier(job) {
    armJobHeartbeat(job);
    if (!job || typeof onJobChanged !== 'function') return job;
    Object.defineProperty(job, '_onChanged', {
      value: onJobChanged,
      writable: true,
      configurable: true,
      enumerable: false
    });
    return job;
  }

  // 需求：授权 job 结束、取消或过期时必须释放临时 callback server，避免端口 1455 被残留占用。
  function closeJobLoopbackCallback(job) {
    if (!job || !job._loopbackCallbackServer) return;
    try {
      job._loopbackCallbackServer.close();
    } catch (_error) {
      // best effort cleanup
    }
    job._loopbackCallbackServer = null;
    if (job.callbackCaptureStatus === 'starting' || job.callbackCaptureStatus === 'listening') {
      job.callbackCaptureStatus = 'closed';
    }
  }

  function terminateAuthPty(job) {
    if (!job || job._processTerminationRequested) return;
    job._processTerminationRequested = true;
    const ptyProcess = job._ptyProcess;
    if (!ptyProcess) return;
    const pid = Number(job.pid || (ptyProcess && ptyProcess.pid));
    const platform = String(processObj.platform || process.platform).toLowerCase();

    try {
      if (ptyProcess && typeof ptyProcess.kill === 'function') {
        if (platform === 'win32') ptyProcess.kill();
        else ptyProcess.kill('SIGHUP');
      }
    } catch (_error) {
      // The PTY may already have exited; process-group cleanup below is best effort.
    }

    if (platform === 'win32' || !Number.isFinite(pid) || pid <= 0
      || !processObj || typeof processObj.kill !== 'function') {
      return;
    }

    try {
      // node-pty creates a dedicated session/process group on POSIX. Signalling
      // the negative leader PID closes the CLI and any provider child it spawned,
      // while leaving other accounts and unrelated tmux servers untouched.
      processObj.kill(-pid, 'SIGTERM');
    } catch (_error) {
      // The group may already be gone after the PTY kill.
    }

    const forceKill = setTimeout(() => {
      if (!isProcessAlive(pid, processObj)) return;
      try {
        processObj.kill(-pid, 'SIGKILL');
      } catch (_error) {
        // best effort escalation
      }
    }, 250);
    if (typeof forceKill.unref === 'function') forceKill.unref();
  }

  function notifyOauthJobFinishedOnce(job) {
    if (!job || job.status !== 'succeeded') return Promise.resolve();
    if (job._finishedNotifyPromise) return job._finishedNotifyPromise;
    if (job._finishedNotified) return Promise.resolve();
    job._finishedNotified = true;
    if (typeof onOauthJobFinished === 'function') {
      job._finishedNotifyPromise = Promise.resolve(onOauthJobFinished(job)).catch((error) => {
        appendJobLog(job, `状态同步异常：${compactLogText((error && error.message) || error || 'unknown_error')}`);
      });
      return job._finishedNotifyPromise;
    }
    return Promise.resolve();
  }

  function cleanupFinishedJobs() {
    const now = Date.now();
    Array.from(jobs.entries()).forEach(([jobId, job]) => {
      if (job.status === 'running') return;
      if ((now - job.updatedAt) > FINISHED_JOB_TTL_MS) {
        jobs.delete(jobId);
      }
    });
  }

  function getJob(jobId) {
    cleanupFinishedJobs();
    const job = jobs.get(String(jobId || '').trim()) || null;
    if (!job) return null;
    return refreshJobState(job);
  }

  function getRunningJob(provider) {
    cleanupFinishedJobs();
    const normalizedProvider = normalizeString(provider).toLowerCase();
    const jobId = runningProviders.get(normalizedProvider);
    if (!jobId) return null;
    const job = jobs.get(jobId) || null;
    if (!job) return null;
    return refreshJobState(job);
  }

  function finalizeJob(job, nextStatus, errorMessage = '', exitCode = null) {
    if (!job) return;
    if (job._heartbeatTimer) {
      clearInterval(job._heartbeatTimer);
      job._heartbeatTimer = null;
    }
    // Kiro 原生登录是定时器驱动的（没有 PTY），收尾时必须一起停掉，否则轮询会继续打上游。
    if (job._kiroPollTimer) {
      clearTimeout(job._kiroPollTimer);
      job._kiroPollTimer = null;
    }
    // Go 设备码作业的状态轮询同理：终态后不能再读 Go 快照。
    if (job._goDeviceTimer) {
      clearTimeout(job._goDeviceTimer);
      job._goDeviceTimer = null;
    }
    terminateAuthPty(job);
    if (nextStatus === 'succeeded' && job.provider === 'kiro' && !job._kiroIdentityMetadata) {
      if (job._identityVerification) return job._identityVerification;
      // The job remains running while identity is verified, and cancellation
      // wins over a late response. No account is registered from token bytes.
      const controller = new AbortController();
      job._identityAbort = controller;
      job._identityVerification = prepareKiroIdentityProjection(fs, job.runtimeDir, {
        path, aiHomeDir, request: fetchImpl, signal: controller.signal
      }).then(metadata => {
        if (job.status !== 'running' || job._cancelRequested) return;
        job._kiroIdentityMetadata = metadata.projectionMetadata;
        job._kiroExpectedVersions = metadata.expectedKiroVersions;
        return finalizeJob(job, 'succeeded', '', exitCode);
      }).catch(error => {
        if (job.status !== 'running' || job._cancelRequested) return;
        return finalizeJob(job, 'failed', `OAuth 身份核验失败: ${error.code || 'kiro_identity_unverifiable'}`, exitCode);
      });
      return job._identityVerification;
    }
    if (nextStatus !== 'succeeded') job._identityAbort?.abort();
    if (nextStatus === 'succeeded') {
      if (job._goAuthCompleted) {
        // Go 已经完成 token 交换与账号写入：本地不再注册一次。
        // 这条路径上 runtimeDir 里没有 artifact，重复注册只会失败，而且会绕过
        // Go 分配的 account_ref / cli_account_id —— 同一个身份会被算成两个账号。
        job.accountRef = String(job._goAuthAccountRef || '');
        job.cliAccountId = Number(job._goAuthCliAccountId) || 0;
        applyAliasPoolPreferenceToJob(job);
      } else {
        try {
          const registration = registerProviderAuthProjection(fs, job.runtimeDir, job.provider, {
            path,
            aiHomeDir,
            accountRef: job._reauthTargetRef,
            projectionMetadata: job._kiroIdentityMetadata,
            expectedKiroVersions: job._kiroExpectedVersions
          });
          if (!registration.registered) {
            nextStatus = 'failed';
            errorMessage = `OAuth 凭据未写入账号数据库: ${registration.reason}`;
          } else {
            job.accountRef = registration.accountRef;
            // 数字别名由账号注册分配；随快照持久化，重启后回放也有结果。
            job.cliAccountId = Number(registration.cliAccountId) || 0;
            // 站点归属由 token 的 realm 决定：CodeBuddy 同一支 CLI 首启会让用户选国内站 /
            // 国际站 / 企业域名，所以作业上的 provider 只是「用户点的是哪个入口」。
            if (registration.provider && registration.provider !== job.provider) {
              appendJobLog(job, `凭据属于 ${registration.provider} 站点，账号已按该 Provider 登记。`);
            }
            applyAliasPoolPreferenceToJob(job);
          }
        } catch (error) {
          nextStatus = 'failed';
          errorMessage = `OAuth 凭据入库失败: ${error.message}`;
        }
      }
    }
    closeJobLoopbackCallback(job);
    // 作业提前结束（取消/失败/过期）时释放 Go 的 pending Job，否则下一次 Begin
    // 会撞上 active_job_exists，一直卡到它自己过期。
    cancelGoAuthJobQuietly(job);
    // 进入终态的时间单独留痕，不与 updatedAt 的后续写入混淆；重复收尾保留第一次。
    if (!job.finishedAt) job.finishedAt = Date.now();
    job.status = nextStatus;
    const finishedProgressState = resolveFinishedAuthProgressState(nextStatus);
    if (finishedProgressState) job.authProgressState = finishedProgressState;
    job.error = errorMessage ? String(errorMessage) : job.error;
    job.exitCode = Number.isInteger(exitCode) ? exitCode : job.exitCode;
    job.updatedAt = Date.now();
    if (runningProviders.get(job.provider) === job.id) {
      runningProviders.delete(job.provider);
    }
    notifyAuthJobChanged(job);
    const finishedPromise = notifyOauthJobFinishedOnce(job);
    return Promise.resolve(finishedPromise).finally(() => {
      notifyAuthJobChanged(job);
    });
  }

  function cancelJob(jobId) {
    const job = getJob(jobId);
    if (!job) return { ok: false, code: 'job_not_found' };
    if (job.status !== 'running') {
      return { ok: true, job };
    }

    job._cancelRequested = true;
    job._terminationReason = 'user_cancelled';
    finalizeJob(job, 'cancelled', '用户取消了 OAuth 授权流程', null);
    return { ok: true, job };
  }

  function refreshJobState(job) {
    if (!job) return null;
    if (job.status !== 'running') return job;

    const now = Date.now();
    const deadline = resolveOauthJobDeadline(job);
    if (Number.isFinite(deadline) && deadline > 0 && now >= deadline) {
      job._terminationReason = 'expired';
      finalizeJob(job, 'expired', job.authMode === 'oauth-device'
        ? '设备码已过期，请重新发起授权。'
        : 'OAuth 授权已超时，请重新发起授权。', null);
      return job;
    }

    // The native process may already have exited while its identity request
    // is pending; polling must not turn a valid in-flight verification into failure.
    if (job._identityVerification && !job._kiroIdentityMetadata) return job;

    // Go 设备码作业由状态轮询推进。这里不能按「本机进程是否存活」判断：
    // 设备码作业没有 PTY，2s 心跳会把一个正常等待授权的作业判失败。
    if (job._goDeviceFlow === true) return job;

    if (hasOauthCompletionArtifacts(job, fs)) {
      job._terminationReason = 'completed';
      if (job.provider === 'agy') {
        const match = String(job.logs || '').match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
        const email = match ? match[1].trim() : '';
        if (email) {
          job.email = email;
          job.displayName = email;
        }
      }
      finalizeJob(job, 'succeeded', '', 0);
      return job;
    }

    if (job._manualCallbackOauth) {
      return job;
    }

    if (!isProcessAlive(job.pid, processObj)) {
      job._processTerminationRequested = true;
      job._ptyProcess = null;
      finalizeJob(job, 'failed', job.error || '授权进程已结束，请重新发起授权。', job.exitCode);
      return job;
    }

    return job;
  }

  /**
   * 让 Go 取消仍在等待的 OAuth Job。
   *
   * 只处理「已拿到 job_id、还没完成」的那一个。取消失败只记日志：Go 侧还有 TTL
   * 兜底，本地不能因为清理失败把作业判失败。
   */
  function cancelGoAuthJobQuietly(job) {
    if (!goAuthJobClient || !job || job._goAuthJobWired !== true) return;
    const jobId = String(job._goAuthJobId || '');
    if (!jobId || job._goAuthCompleted) return;
    job._goAuthJobId = '';
    try {
      Promise.resolve(goAuthJobClient.cancel(jobId)).catch((error) => {
        appendJobLog(
          job,
          `Go OAuth Job 取消失败：${compactLogText((error && (error.code || error.message)) || error || 'unknown_error')}`
        );
      });
    } catch (_error) {
      // 清理是 best effort，Go 的 pending Job 有自己的 TTL。
    }
  }

  /**
   * 向 Go 申请一个 OAuth Job，并把 authorization_url 交给界面。
   *
   * 这里不生成 PKCE / state：两者只存在于 Go 进程内，Node 拿不到也不需要。
   * 失败按 Go 的错误码结束本地作业，不做本地重试（旧路径的重试语义不参与）。
   */
  async function beginGoAuthJob(job) {
    appendJobLog(job, `${job.provider} 登录：向 Go 申请 OAuth Job。`);
    const reauthTargetRef = job._reauthTargetRef
      ? (resolveGoAccountRef ? resolveGoAccountRef(job._reauthTargetRef) : job._reauthTargetRef)
      : '';
    let response = null;
    try {
      response = await goAuthJobClient.start({
        providerId: job.provider,
        targetAccountRef: reauthTargetRef
      });
    } catch (_error) {
      response = { ok: false, status: 0, errorCode: 'go_auth_job_unreachable' };
    }
    if (!response || response.ok !== true) {
      const failure = toGoAuthJobFailure(response);
      if (job.status !== 'running' || job._cancelRequested) return { ...failure, job };
      appendJobLog(
        job,
        `Go OAuth Job 创建失败：${failure.code}（status=${failure.status || '-'}，retryable=${failure.retryable}）`
      );
      finalizeJob(job, 'failed', failure.code);
      return { ...failure, job };
    }
    const data = response.data && typeof response.data === 'object' ? response.data : {};
    const jobId = normalizeString(data.job_id);
    const authorizationUrl = normalizeString(data.authorization_url);
    if (!jobId || !authorizationUrl) {
      if (job.status !== 'running' || job._cancelRequested) return { ok: false, code: 'job_not_running', job };
      appendJobLog(job, 'Go OAuth Job 响应缺少 job_id 或 authorization_url。');
      finalizeJob(job, 'failed', 'go_auth_job_invalid_response');
      return { ok: false, code: 'go_auth_job_invalid_response', status: 0, retryable: false, job };
    }
    if (job.status !== 'running' || job._cancelRequested) {
      // 用户在 Begin 返回前就取消了：Go 刚建出来的 Job 必须立刻释放。
      job._goAuthJobId = jobId;
      cancelGoAuthJobQuietly(job);
      return { ok: false, code: 'job_not_running', job };
    }
    job._goAuthJobId = jobId;
    job.authorizationUrl = authorizationUrl;
    // Go 的 TTL 是权威：界面倒计时跟它对齐，避免本地先过期把还在等的 Job 掐掉。
    const expiresAt = Date.parse(String(data.expires_at || ''));
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) job.expiresAt = expiresAt;
    if (job._goDeviceFlow === true) {
      // 设备码没有回调可转发：把 Go 给的短码与验证地址交给界面，然后开始读快照。
      const userCode = normalizeString(data.user_code);
      if (userCode) job.userCode = userCode;
      job.verificationUriComplete = authorizationUrl;
      job.verificationUri = stripQueryAndHash(authorizationUrl);
      setAuthProgressState(job, AUTH_PROGRESS_STATES.AWAITING_CODE);
      appendJobLog(job, `Go 设备码 Job 已创建：${jobId}`);
      appendJobLog(job, userCode
        ? `请在任意设备打开 ${authorizationUrl} 并确认代码 ${userCode}。`
        : `请在任意设备打开 ${authorizationUrl} 完成授权。`);
      job.updatedAt = Date.now();
      notifyAuthJobChanged(job);
      scheduleGoDeviceStatusPoll(job);
      return { ok: true, jobId, authorizationUrl, userCode, job };
    }
    setAuthProgressState(job, AUTH_PROGRESS_STATES.AUTH_URL_READY);
    appendJobLog(job, `Go OAuth Job 已创建：${jobId}`);
    appendJobLog(job, '回调 state 由 Go 校验，本地只负责把浏览器回调原样转发。');
    job.updatedAt = Date.now();
    notifyAuthJobChanged(job);
    return { ok: true, jobId, authorizationUrl, job };
  }

  /** 异步起 Go Begin：界面先拿到 jobId，URL 随 job 变更事件补上（与 CLI 打印 URL 同构）。 */
  function startGoAuthJob(job) {
    const pending = beginGoAuthJob(job);
    Object.defineProperty(job, '_goAuthJobBeginPromise', {
      value: pending,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  /**
   * 登录成功后立刻拉一轮对账，不等 15s 定时器。
   *
   * Go 是这次登录的写入方：账号先落在 Go 的库里，Node 侧要等对账才看得到。
   * 对账失败只记日志——账号仍在 Go，下一轮定时对账会补上，不能因此把登录判失败。
   */
  async function reconcileGoAccountsAfterLogin(job) {
    if (!reconcileGoAccountsImpl) {
      appendJobLog(job, '未装配 Go 账号对账，跳过即时对账。');
      return null;
    }
    try {
      const result = await reconcileGoAccountsImpl();
      if (result && result.failed) {
        appendJobLog(job, `Go 账号对账失败：${compactLogText(result.error)}`);
      } else {
        appendJobLog(job, '已触发 Go 账号对账（不等定时器）。');
      }
      return result;
    } catch (error) {
      appendJobLog(
        job,
        `Go 账号对账异常：${compactLogText((error && (error.code || error.message)) || error || 'unknown_error')}`
      );
      return null;
    }
  }

  /**
   * 把浏览器的完整回调 URL 交给 Go 完成换码与账号写入。
   *
   * Node 不做 state 校验，也不解析 code：Go 持有 PKCE verifier 与 state，是唯一权威。
   * 成功后用 Go 返回的 account_ref / cli_account_id 收尾，并立刻对账一次。
   */
  async function completeGoAuthJobCallback(job, rawCallbackUrl) {
    const callbackUrl = normalizeString(rawCallbackUrl);
    if (!callbackUrl) return { ok: false, code: 'invalid_callback_url', job };
    // 手填可能抢在 Begin 返回之前：等这一次 Begin 的结论，避免拿空 job_id 去调 Go。
    if (job._goAuthJobBeginPromise) {
      const begun = await job._goAuthJobBeginPromise;
      if (!begun || begun.ok !== true) {
        return {
          ok: false,
          code: (begun && begun.code) || 'go_auth_job_not_started',
          retryable: Boolean(begun && begun.retryable),
          job
        };
      }
    }
    if (job.status !== 'running' || job._cancelRequested) return { ok: false, code: 'job_not_running', job };
    if (!job._goAuthJobId) return { ok: false, code: 'go_auth_job_not_started', job };
    setAuthProgressState(job, AUTH_PROGRESS_STATES.SUBMITTED_CODE);
    appendJobLog(job, '回调已转发给 Go（state 由 Go 校验）。');
    let response = null;
    try {
      response = await goAuthJobClient.complete(job._goAuthJobId, callbackUrl);
    } catch (_error) {
      response = { ok: false, status: 0, errorCode: 'go_auth_job_unreachable' };
    }
    if (!response || response.ok !== true) {
      const failure = toGoAuthJobFailure(response, 'go_auth_job_callback_failed');
      if (job.status !== 'running' || job._cancelRequested) return { ...failure, job };
      appendJobLog(
        job,
        `Go 完成登录失败：${failure.code}（status=${failure.status || '-'}，retryable=${failure.retryable}）`
      );
      finalizeJob(job, 'failed', failure.code);
      return { ...failure, job };
    }
    const data = response.data && typeof response.data === 'object' ? response.data : {};
    // Go 对「已经失败/过期的旧 Job」也回 200：这里的 status 才是真相，不能只看 HTTP。
    const goStatus = normalizeString(data.status);
    if (goStatus && goStatus !== 'completed') {
      const failure = toGoAuthJobFailure({
        ok: false,
        status: 200,
        errorCode: normalizeString(data.failure_code) || `go_auth_job_${goStatus}`
      }, 'go_auth_job_not_completed');
      if (job.status !== 'running' || job._cancelRequested) return { ...failure, job };
      appendJobLog(job, `Go OAuth Job 未完成：${failure.code}（retryable=${failure.retryable}）`);
      finalizeJob(job, 'failed', failure.code);
      return { ...failure, job };
    }
    job.browserCallbackForwardedAt = Date.now();
    return finishGoAuthJobFromSnapshot(job, data);
  }

  /**
   * 用 Go 的作业快照完成本地登录：账号已经由 Go 写入，这里只做引用映射与收尾。
   *
   * 两条路径共用：手填回调（Complete 的响应就是快照）与设备码轮询
   * （读到 status=completed 的持久化快照）。Go 是唯一写账号方，Node 不重复注册。
   */
  async function finishGoAuthJobFromSnapshot(job, data) {
    if (!job || job.status !== 'running') return { ok: false, code: 'job_not_running', job };
    let accountRef = normalizeString(data.account_ref);
    if (!accountRef) {
      appendJobLog(job, 'Go 完成登录但响应缺少 account_ref。');
      finalizeJob(job, 'failed', 'go_auth_job_missing_account_ref');
      return { ok: false, code: 'go_auth_job_missing_account_ref', status: 200, retryable: false, job };
    }
    job._goAuthCompleted = true;
    job._goAuthAccountRef = accountRef;
    job._goAuthCliAccountId = Number(data.cli_account_id) || 0;
    appendJobLog(
      job,
      `Go 已写入账号：${accountRef}${job._goAuthCliAccountId ? `（别名 ${job._goAuthCliAccountId}）` : ''}`
    );
    await reconcileGoAccountsAfterLogin(job);
    // Go 账号被对账收养后，Node 侧的 accountRef 由 Node 的身份规则派生；登录作业
    // 的收尾与状态同步必须用 Node 键，否则会报 oauth_account_registration_missing。
    if (resolveNodeAccountRef) {
      const nodeAccountRef = normalizeString(resolveNodeAccountRef(accountRef));
      if (nodeAccountRef && nodeAccountRef !== accountRef) {
        appendJobLog(job, `Go 账号引用已映射为 Node 账号：${nodeAccountRef}`);
        accountRef = nodeAccountRef;
        job._goAuthAccountRef = nodeAccountRef;
      }
    }
    await finalizeJob(job, 'succeeded');
    return { ok: true, job };
  }

  /** 展示用的验证地址：去掉查询串与锚点。 */
  function stripQueryAndHash(rawUrl) {
    const text = normalizeString(rawUrl);
    if (!text) return '';
    try {
      const parsed = new URL(text);
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    } catch (_error) {
      return text;
    }
  }

  /**
   * 轮询 Go 的设备码作业快照，直到终态。
   *
   * 设备码没有回调可以让 Node 立即完成，授权进度只在 Go 那边推进；Node 每 2s 读
   * 一次持久化快照，completed 时走与回调路径相同的收尾。读快照失败不判失败：
   * 本地 TTL 与 Go 的作业 TTL 会兜底，短暂不可用不该把已完成的授权丢掉。
   */
  function scheduleGoDeviceStatusPoll(job) {
    if (!job || job._goDeviceTimer || job.status !== 'running' || job._cancelRequested) return;
    if (!goAuthJobClient) return;
    const timer = setTimeout(async () => {
      job._goDeviceTimer = null;
      if (job.status !== 'running' || job._cancelRequested) return;
      const jobId = String(job._goAuthJobId || '');
      if (!jobId) return scheduleGoDeviceStatusPoll(job);
      let response = null;
      try {
        response = await goAuthJobClient.status(jobId);
      } catch (_error) {
        response = { ok: false, status: 0, errorCode: 'go_auth_job_unreachable' };
      }
      if (job.status !== 'running' || job._cancelRequested) return;
      if (!response || response.ok !== true) {
        const failure = toGoAuthJobFailure(response, 'go_auth_job_status_failed');
        if (failure.retryable) {
          appendJobLog(job, `读取 Go 登录状态失败，稍后重试：${failure.code}`);
          return scheduleGoDeviceStatusPoll(job);
        }
        appendJobLog(job, `Go 登录状态查询失败：${failure.code}`);
        finalizeJob(job, 'failed', failure.code);
        return;
      }
      const data = response.data && typeof response.data === 'object' ? response.data : {};
      const status = normalizeString(data.status).toLowerCase();
      if (status === 'completed') {
        try {
          await finishGoAuthJobFromSnapshot(job, data);
        } catch (error) {
          if (job.status !== 'running') return;
          finalizeJob(job, 'failed', `go_auth_job_finalize_failed: ${(error && error.message) || 'unknown_error'}`);
        }
        return;
      }
      if (status === 'failed' || status === 'expired' || status === 'cancelled') {
        // 持久化快照用 error_code；内存响应（Complete）用 failure_code，两个都认。
        const code = normalizeString(data.failure_code)
          || normalizeString(data.error_code)
          || `go_auth_job_${status}`;
        appendJobLog(job, `Go 登录终态：${status}（${code}）`);
        finalizeJob(job, status === 'expired' ? 'expired' : 'failed', code);
        return;
      }
      scheduleGoDeviceStatusPoll(job);
    }, GO_DEVICE_STATUS_POLL_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    job._goDeviceTimer = timer;
  }

  // 需求：Codex browser OAuth 默认自动监听 localhost callback；失败时只降级到手填，不中断授权任务。
  function attachManualCallbackLoopback(job) {
    if (!job || !job._manualCallbackOauth || typeof startLoopbackCallbackServerImpl !== 'function') {
      return;
    }
    // 只有**可监听的 http(s) loopback 地址**才启动本地服务。
    // 自定义协议（zcode://oauth/callback）不是 HTTP，监听必然 EADDRNOTAVAIL ——
    // 真机表现：日志留一行「本地 OAuth callback 服务不可用」，job 却停在
    // auth_url_ready 等用户手填，界面上看不到「请粘贴回调」的明确指引。
    // 这类地址的正确形态是「纯手填」：不启动服务、直接把手填入口作为唯一路径。
    if (!isLoopbackCallbackUrl(job.redirectUri)) {
      job.callbackCaptureStatus = 'manual_only';
      job.callbackCaptureError = '';
      job.callbackListeningUrl = '';
      return;
    }
    job.callbackCaptureStatus = 'starting';
    job.callbackCaptureError = '';
    job.callbackListeningUrl = job.redirectUri;
    try {
      const loopback = startLoopbackCallbackServerImpl({
        redirectUri: job.redirectUri,
        onListening(info = {}) {
          if (job.status !== 'running') return;
          job.callbackCaptureStatus = 'listening';
          job.callbackListeningUrl = normalizeString(info.url) || job.redirectUri;
          job.updatedAt = Date.now();
          appendJobLog(job, `本地 OAuth callback 服务已监听：${job.callbackListeningUrl}`);
        },
        onUnavailable(error) {
          if (job.status !== 'running') return;
          job.callbackCaptureStatus = 'unavailable';
          job.callbackCaptureError = compactLogText((error && (error.code || error.message)) || error || 'callback_server_unavailable');
          job.updatedAt = Date.now();
          appendJobLog(job, `本地 OAuth callback 服务不可用，保留手动提交回调兜底：${job.callbackCaptureError || 'unknown_error'}`);
        },
        onCallback(callbackUrl) {
          return completeBrowserOauthCallback(job.id, callbackUrl);
        }
      });
      Object.defineProperty(job, '_loopbackCallbackServer', {
        value: loopback,
        writable: true,
        configurable: true,
        enumerable: false
      });
    } catch (error) {
      job.callbackCaptureStatus = 'unavailable';
      job.callbackCaptureError = compactLogText((error && (error.code || error.message)) || error || 'callback_server_unavailable');
      job.updatedAt = Date.now();
      appendJobLog(job, `本地 OAuth callback 服务启动失败，保留手动提交回调兜底：${job.callbackCaptureError || 'unknown_error'}`);
    }
  }

  // Generic "aih runs the OAuth itself" job: aih builds the authorization URL,
  // runs its own loopback server to auto-capture the callback on the same machine
  // (manual paste as a fallback for remote sessions), exchanges the code, and
  // writes the provider's credential file. Per-provider specifics come from the
  // strategy's nativeOauth descriptor; nothing here is provider-conditional.
  function startNativeOauthJob(provider, nativeOauth, authStrategy, jobId, runtimeDir, configDir, existingAccountRef, previousAccountState = null) {
    // Go 承接的登录：codex/zcode/opencode 都固定走 Go。
    // PKCE 与 state 都留在 Go，Node 本地不生成也不需要。
    const useGoAuthJob = Boolean(goAuthJobClient && nativeOauth.requiresGoAuthJob === true);
    const pkce = useGoAuthJob ? { codeVerifier: '', codeChallenge: '' } : createPkcePair();
    const state = useGoAuthJob ? '' : createOauthState();
    const redirectUri = nativeOauth.loopbackRedirectUri;
    const authorizationUrl = useGoAuthJob ? '' : nativeOauth.buildAuthorizationUrl({
      redirectUri,
      codeChallenge: pkce.codeChallenge,
      state,
      deps: strategyDeps
    });
    const label = nativeOauth.logLabel || provider;
    // 设备码登录的 authMode 必须如实是 oauth-device：界面据此展示验证码卡片，
    // 也据此不显示「粘贴回调」入口。
    const jobAuthMode = nativeOauth.deviceCode === true ? 'oauth-device' : 'oauth-browser';
    const job = {
      id: jobId,
      provider,
      accountRef: '',
      authMode: jobAuthMode,
      authStrategy: String(authStrategy || ''),
      reauth: Boolean(existingAccountRef),
      runtimeDir,
      configDir,
      status: 'running',
      authProgressState: resolveInitialAuthProgressState(provider, jobAuthMode, authorizationUrl, authStrategy),
      logs: '',
      exitCode: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOutputAt: Date.now(),
      pid: null,
      expiresAt: Date.now() + MANUAL_CALLBACK_OAUTH_TTL_MS,
      pollIntervalMs: jobAuthMode === 'oauth-device' ? GO_DEVICE_STATUS_POLL_INTERVAL_MS : 1000,
      verificationUri: '',
      verificationUriComplete: '',
      userCode: '',
      authorizationUrl,
      redirectUri,
      oauthState: state,
      email: String((previousAccountState && previousAccountState.email) || ''),
      // 重新授权时先把**目标账号**的名字带进 job：授权弹窗/重开进度页都能显示
      // 「正在为 旅行者0378 授权」，避免用户用错手机号/账号（2026-11-03 需求）。
      displayName: String((previousAccountState && (previousAccountState.displayName || previousAccountState.email)) || ''),
      planType: '',
      browserCaptureCommand: '',
      browserCallbackForwardedAt: 0,
      callbackCaptureStatus: '',
      callbackCaptureError: '',
      callbackListeningUrl: '',
      _cancelRequested: false,
      _terminationReason: '',
      _finishedNotified: false,
      _finishedNotifyPromise: null,
      _ptyProcess: null,
      _preserveExistingAccount: Boolean(existingAccountRef),
      _requireFreshOauthArtifacts: Boolean(existingAccountRef),
      _previousAccountState: previousAccountState,
      _oauthArtifactSignatureAtStart: '',
      _manualCallbackOauth: nativeOauth.manualCallback !== false,
      _autoCaptureCallback: nativeOauth.autoCaptureCallback !== false,
      _codeVerifier: pkce.codeVerifier,
      _reauthTargetRef: existingAccountRef || '',
      // Go 承接的登录：job_id 由 Go 分配，回调与收尾都以 Go 为准。
      // 未走 Go 的 provider 整组字段都不存在——旧作业对象保持原形状。
      ...(useGoAuthJob ? {
        _goAuthJobWired: true,
        _goAuthJobId: '',
        _goAuthCompleted: false,
        _goAuthAccountRef: '',
        _goAuthCliAccountId: 0
      } : {}),
      // 设备码作业没有回调，收尾只能靠轮询 Go 快照；标记位与定时器一起建。
      ...(useGoAuthJob && nativeOauth.deviceCode === true ? {
        _goDeviceFlow: true,
        _goDeviceTimer: null
      } : {})
    };
    attachJobChangeNotifier(job);
    if (job._requireFreshOauthArtifacts) {
      job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
    }
    appendJobLog(job, `${label} OAuth 流程已创建。`);
    // 设备码流程没有回调地址（redirectUri 为空），不要打一行 undefined 误导排查。
    if (redirectUri) appendJobLog(job, `回调地址：${redirectUri}`);
    appendJobLog(job, `授权任务：provider=${provider}${existingAccountRef ? ` reauth=${existingAccountRef}` : ''}`);
    jobs.set(jobId, job);
    runningProviders.set(provider, jobId);
    if (job._manualCallbackOauth && job._autoCaptureCallback) {
      attachManualCallbackLoopback(job);
    }
    notifyAuthJobChanged(job);
    if (useGoAuthJob) {
      // loopback 先挂好再 Begin：浏览器可能比响应先到（用户秒点授权链接）。
      startGoAuthJob(job);
    }
    return {
      jobId,
      provider,
      accountRef: '',
      expiresAt: job.expiresAt,
      pollIntervalMs: job.pollIntervalMs,
      authorizationUrl,
      redirectUri,
      callbackCaptureStatus: job.callbackCaptureStatus,
      callbackListeningUrl: job.callbackListeningUrl,
      callbackCaptureError: job.callbackCaptureError,
      authProgressState: job.authProgressState,
      authStrategy: String(authStrategy || '')
    };
  }

  // Kiro 原生登录：不 spawn 任何本地 CLI（这正是「不依赖 CLI」的落点）。
  //   * oauth-device        —— aih 直接注册 public client 并走 RFC 8628 设备码；
  //   * oauth-refresh-token —— 等用户在授权弹窗里粘贴 refresh_token（Kiro Desktop / social）。
  // 两者都把投影写进 job.runtimeDir，再交给 finalizeJob 走既有注册路径。
  function startKiroNativeAuthJob({ provider, authMode, existingAccountRef, jobOptions }) {
    const jobId = String(jobOptions.jobId || crypto.randomUUID());
    const { runtimeDir, configDir } = ensureLoginRuntime({ fs, provider, aiHomeDir, jobId });
    const job = {
      id: jobId,
      provider,
      accountRef: '',
      authMode,
      authStrategy: String(jobOptions.authStrategy || ''),
      reauth: Boolean(existingAccountRef),
      runtimeDir,
      configDir,
      status: 'running',
      authProgressState: AUTH_PROGRESS_STATES.STARTING,
      logs: '',
      exitCode: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOutputAt: Date.now(),
      pid: null,
      expiresAt: null,
      pollIntervalMs: authMode === 'oauth-device' ? RFC8628_DEFAULT_POLL_INTERVAL_MS : null,
      verificationUri: '',
      verificationUriComplete: '',
      userCode: '',
      authorizationUrl: '',
      redirectUri: '',
      oauthState: '',
      browserCaptureCommand: '',
      browserCallbackForwardedAt: 0,
      _cancelRequested: false,
      _terminationReason: '',
      _finishedNotified: false,
      _finishedNotifyPromise: null,
      _ptyProcess: null,
      _processTerminationRequested: true,
      _preserveExistingAccount: Boolean(existingAccountRef),
      _requireFreshOauthArtifacts: false,
      _previousAccountState: jobOptions.previousAccountState || null,
      _oauthArtifactSignatureAtStart: '',
      _agyGoogleOAuthSelected: false,
      _reauthTargetRef: existingAccountRef || '',
      _kiroPollTimer: null,
      _kiroFlow: null,
      // WebUI 显式选择登录方式：'builder-id' → 空（AWS SSO OIDC），Google / Github → social 设备流。
      _kiroLoginProvider: normalizeKiroLoginProvider(jobOptions.loginProvider),
      _kiroSocialFlow: false
    };
    attachJobChangeNotifier(job);
    jobs.set(jobId, job);
    runningProviders.set(provider, jobId);
    appendJobLog(job, authMode === 'oauth-device'
      ? (job._kiroLoginProvider
        ? `Kiro 原生登录：等待 ${job._kiroLoginProvider} 账号完成设备码授权（不需要本地 kiro CLI）。`
        : 'Kiro 原生登录：等待 Builder ID 完成 AWS SSO OIDC 设备码授权（不需要本地 kiro CLI）。')
      : 'Kiro 原生登录：等待粘贴 refresh_token（Kiro Desktop / Google / GitHub 账号）。');
    if (authMode === 'oauth-refresh-token') {
      setAuthProgressState(job, AUTH_PROGRESS_STATES.AWAITING_CODE);
      notifyAuthJobChanged(job);
      return {
        jobId,
        provider,
        accountRef: '',
        expiresAt: job.expiresAt,
        pollIntervalMs: job.pollIntervalMs,
        authProgressState: job.authProgressState
      };
    }
    notifyAuthJobChanged(job);
    startKiroDeviceAuthorization(job);
    return {
      jobId,
      provider,
      accountRef: '',
      expiresAt: job.expiresAt,
      pollIntervalMs: job.pollIntervalMs,
      authProgressState: job.authProgressState
    };
  }

  /**
   * 开始 kiro 设备码授权。
   *
   * **两条协议**（jobOptions.loginProvider 决定走哪条）：
   *   * 缺省 / 'builder-id' —— AWS SSO OIDC（Builder ID / IdC），`oidc.<region>.amazonaws.com`；
   *   * 'Google' / 'Github' —— Kiro social 认证服务，`prod.<region>.auth.desktop.kiro.dev`。
   *
   * 为什么 social 也要走设备流：它的浏览器 PKCE 流程要求 localhost 回调（`--use-device-flow`
   * 只对 Builder ID / IdC 生效），远程机器上回调打不通 —— 这正是「换台电脑就报错」的原因。
   * 设备流没有回调，任意机器都能完成授权。
   */
  function startKiroDeviceAuthorization(job) {
    const loginProvider = String(job._kiroLoginProvider || '').trim();
    const begin = loginProvider ? beginKiroSocialDeviceLogin : beginKiroDeviceLogin;
    const beginOptions = loginProvider
      ? { loginProvider, request: fetchImpl }
      : { request: fetchImpl };
    begin(beginOptions).then((flow) => {
      if (job.status !== 'running' || job._cancelRequested) return;
      job._kiroFlow = flow;
      job._kiroSocialFlow = Boolean(loginProvider);
      job.userCode = flow.userCode;
      job.verificationUri = flow.verificationUri;
      job.verificationUriComplete = flow.verificationUriComplete;
      job.expiresAt = flow.expiresAtMs;
      const intervalMs = Math.max(1000, Number(flow.intervalSeconds) * 1000);
      job.pollIntervalMs = Number.isFinite(intervalMs) ? intervalMs : RFC8628_DEFAULT_POLL_INTERVAL_MS;
      setAuthProgressState(job, AUTH_PROGRESS_STATES.AWAITING_CODE);
      appendJobLog(job, loginProvider
        ? `请用 ${loginProvider} 账号打开 ${flow.verificationUriComplete} 并确认代码 ${flow.userCode}（任意设备均可，无需本机浏览器回调）。`
        : `请在任意设备打开 ${flow.verificationUriComplete} 并输入代码 ${flow.userCode}（无需在本机安装 kiro CLI）。`);
      notifyAuthJobChanged(job);
      scheduleKiroDevicePoll(job);
    }).catch((error) => {
      if (job.status !== 'running') return;
      finalizeJob(job, 'failed', `设备码获取失败: ${(error && (error.code || error.message)) || 'unknown'}`);
    });
  }

  function scheduleKiroDevicePoll(job) {
    if (job.status !== 'running' || job._cancelRequested) return;
    const intervalMs = Math.max(1000, Number(job.pollIntervalMs) || RFC8628_DEFAULT_POLL_INTERVAL_MS);
    job._kiroPollTimer = setTimeout(async () => {
      job._kiroPollTimer = null;
      if (job.status !== 'running' || job._cancelRequested) return;
      let polled;
      try {
        // 两条协议各有各的轮询实现：social 的 pending 是 200+status 字段，
        // OIDC 是 400+error 字段，语义也不同（见各自模块的注释）。
        polled = job._kiroSocialFlow
          ? await pollKiroSocialDeviceLogin(job._kiroFlow, { request: fetchImpl })
          : await pollKiroDeviceLogin(job._kiroFlow, { request: fetchImpl });
      } catch (error) {
        finalizeJob(job, 'failed', `设备码轮询失败: ${(error && (error.code || error.message)) || 'unknown'}`);
        return;
      }
      if (job.status !== 'running' || job._cancelRequested) return;
      if (polled.status === 'pending') {
        scheduleKiroDevicePoll(job);
        return;
      }
      if (polled.status === 'slow_down') {
        // RFC 8628：被要求放慢时按 5s 递增，避免继续打上游。
        job.pollIntervalMs = Math.min(30000, intervalMs + 5000);
        scheduleKiroDevicePoll(job);
        return;
      }
      if (polled.status === 'denied') {
        finalizeJob(job, 'failed', '授权被拒绝：请在浏览器中确认后再重新发起。');
        return;
      }
      if (polled.status !== 'authorized') {
        finalizeJob(job, 'expired', '设备码已过期，请重新发起授权。');
        return;
      }
      // social 分支已在 pollKiroSocialDeviceLogin 里组装好同构的 auth 行（含 social 标记），
      // 这里不再重复拼装 —— 两条路径的产物形状一致，下游注册链路不需要分支。
      await finishKiroNativeLogin(job, job._kiroSocialFlow
        ? { registration: null, auth: polled.auth }
        : { registration: job._kiroFlow && job._kiroFlow.registration, auth: buildKiroAuthRow(polled.grant) });
    }, intervalMs);
  }

  /** 写投影 → 身份核验 → 交给 finalizeJob（账号注册/去重/并发保护全在既有路径里）。 */
  async function finishKiroNativeLogin(job, { registration, auth }) {
    return finishNativeLogin(job, { registration, auth });
  }

  /**
   * 原生登录的统一收尾：投影 → 身份核验 → finalizeJob。
   *
   * 两条投影形态：
   *   * kiro —— sqlite（`data.sqlite3`），由这里写入后走网络身份核验（GetUsageLimits）；
   *   * 其它 provider —— 来源实现已把宿主登录态物化进 job.runtimeDir，这里直接交给 finalizeJob
   *     （它读投影 → 既有注册链路 → 身份来自凭据本身）。
   */
  async function finishNativeLogin(job, { registration, auth }) {
    try {
      if (job.provider === 'kiro') {
        writeKiroCredentialDatabase(fs, path.join(job.runtimeDir, 'data.sqlite3'), { registration, auth });
        const metadata = await prepareKiroIdentityProjection(fs, job.runtimeDir, {
          path,
          aiHomeDir,
          request: fetchImpl
        });
        if (job.status !== 'running' || job._cancelRequested) return;
        job._kiroIdentityMetadata = metadata.projectionMetadata;
        job._kiroExpectedVersions = metadata.expectedKiroVersions;
      }
      appendJobLog(job, '授权成功，正在写入账号。');
      finalizeJob(job, 'succeeded');
    } catch (error) {
      if (job.status !== 'running') return;
      finalizeJob(job, 'failed', `OAuth 身份核验失败: ${(error && error.code) || 'kiro_identity_unverifiable'}`);
    }
  }

  /**
   * 从**本机登录态**完成一次等待中的登录任务（不需要用户粘贴任何东西）。
   *
   * 来源由认证来源链解析（lib/account/auth-sources.js）：界面把 sourceId 递进来，这里只消费
   * 「该来源在这台机器上可用吗、它的实现是什么」——任务链路不自己判断环境。
   */
  async function completeLocalAuthImport(jobId, sourceId) {
    const job = getJob(jobId);
    if (!job) return { ok: false, code: 'job_not_found' };
    if (job.status !== 'running') return { ok: false, code: 'job_not_running', job };

    const { resolveAuthSources } = require('../account/auth-sources');
    const resolved = resolveAuthSources(job.provider, {
      fs,
      aiHomeDir,
      hostCapabilitiesOptions: { hostHomeDir }
    });
    const requested = String(sourceId || '').trim();
    const source = (resolved.sources || []).find((item) => item.id === requested) || null;
    if (!source) return { ok: false, code: 'auth_source_unknown', job };
    // 已在账号池里的本机登录态：界面本就不显示该入口，这里再兜一层，绝不导入重复账号。
    if (source.alreadyImported) return { ok: false, code: 'auth_source_already_imported', job };
    if (!source.available) return { ok: false, code: `auth_source_unavailable:${source.reason}`, job };
    if (typeof source.implementation !== 'function') {
      // host-account-scan 类来源本来就没有「单账号导入」实现：它的语义是「本机登录态整批入库」，
      // 与 `aih <provider> detect` 是同一条链路（lib/account/host-account-detector）。
      // 报 auth_source_impl_missing 会让人以为是 aih 的 bug，这里给一条能照做的指引。
      if (source.handler === 'host-account-scan') {
        return {
          ok: false,
          code: 'auth_source_requires_host_scan',
          message: `该来源由「扫描本机账号」整批入库：请先在本机登录对应客户端，再执行 aih ${job.provider} detect。`,
          job
        };
      }
      return { ok: false, code: 'auth_source_impl_missing', job };
    }

    setAuthProgressState(job, AUTH_PROGRESS_STATES.SUBMITTED_CODE);
    appendJobLog(job, `从本机导入登录态（${source.id}）。`);
    let result;
    try {
      const importOptions = { fs, hostHomeDir, runtimeDir: job.runtimeDir, request: fetchImpl };
      const implementation = source.implementation(importOptions);
      result = await implementation.import(importOptions);
    } catch (error) {
      const code = (error && error.code) || 'local_auth_import_failed';
      finalizeJob(job, 'failed', `本机导入失败: ${code}`);
      return { ok: false, code, job };
    }
    if (!result || !result.ok) {
      const code = (result && result.reason) || 'local_auth_import_failed';
      finalizeJob(job, 'failed', `本机导入失败: ${code}`);
      return { ok: false, code, job };
    }
    await finishNativeLogin(job, { registration: null, auth: result.auth });
    return { ok: true, job: refreshJobState(job) };
  }

  function startOauthJob(provider, authMode, jobOptions = {}) {
    cleanupFinishedJobs();
    const normalizedProvider = normalizeString(provider).toLowerCase();
    const normalizedMode = normalizeAuthMode(authMode);
    const authStrategy = String(jobOptions.authStrategy || '').trim();
    const existingAccountRef = normalizeExistingAccountRef(jobOptions.accountRef);
    const cliConfig = AI_CLI_CONFIGS[normalizedProvider];

    if (!cliConfig) {
      const error = new Error('unsupported_provider');
      error.code = 'unsupported_provider';
      throw error;
    }
    if (!normalizedMode || normalizedMode === 'api-key') {
      const error = new Error('invalid_auth_mode');
      error.code = 'invalid_auth_mode';
      throw error;
    }
    if (!isSupportedAuthMode(normalizedProvider, normalizedMode)) {
      const error = new Error('unsupported_auth_mode');
      error.code = 'unsupported_auth_mode';
      throw error;
    }
    if (!isSupportedAuthStrategy(normalizedProvider, normalizedMode, authStrategy)) {
      const error = new Error('unsupported_auth_strategy');
      error.code = 'unsupported_auth_strategy';
      throw error;
    }
    if (normalizedProvider === 'gemini' && normalizedMode === 'oauth-browser') {
      const error = new Error('Google 登录已关闭：Gemini Code Assist 个人版已停用，请改用 Gemini API Key 或 Antigravity。');
      error.code = 'gemini_google_oauth_disabled';
      throw error;
    }
    if (runningProviders.has(normalizedProvider)) {
      const existingJob = getRunningJob(normalizedProvider);
      if (existingJob && existingJob.status === 'running') {
        const error = new Error('oauth_job_already_running');
        error.code = 'oauth_job_already_running';
        error.jobId = runningProviders.get(normalizedProvider) || '';
        throw error;
      }
    }
    if (existingAccountRef) {
      const existingAccount = resolveAccountRef(fs, aiHomeDir, existingAccountRef, { bestEffort: true });
      if (!existingAccount || existingAccount.provider !== normalizedProvider) {
        const error = new Error('account_not_found');
        error.code = 'account_not_found';
        throw error;
      }
    }

    // Kiro 的原生登录（设备码 / refresh_token 导入）**完全不需要本地 kiro CLI**：
    // 由 aih 自己走 AWS SSO OIDC 设备码 / Kiro Desktop refreshToken，产出的投影与 CLI 登录
    // 逐字段同构，因此身份核验与账号注册仍复用既有路径（见 finishKiroNativeLogin）。
    if (normalizedProvider === 'kiro'
      && (normalizedMode === 'oauth-device' || normalizedMode === 'oauth-refresh-token')) {
      return withAliasPoolPreference(startKiroNativeAuthJob({
        provider: normalizedProvider,
        authMode: normalizedMode,
        existingAccountRef,
        jobOptions
      }), jobOptions);
    }

    // 策略表不再提供 nativeOauth：浏览器登录要么在这里按 provider 覆盖成 Go 作业
    // 描述符（codex/claude/agy/zcode/opencode），要么走 CLI（agy native-cli 等）。
    let nativeOauth = null;
    if (normalizedProvider === 'codex' && normalizedMode === 'oauth-browser') {
      nativeOauth = CODEX_GO_NATIVE_OAUTH;
    }
    if (normalizedProvider === 'claude' && normalizedMode === 'oauth-browser') {
      nativeOauth = CLAUDE_GO_NATIVE_OAUTH;
    }
    // agy 只迁移直连 Google 登录（aih-google-oauth / 缺省）；native-cli 仍走 CLI 策略。
    if (normalizedProvider === 'agy'
      && normalizedMode === 'oauth-browser'
      && (authStrategy === '' || authStrategy === 'aih-google-oauth')) {
      nativeOauth = AGY_GO_NATIVE_OAUTH;
    }
    if (normalizedProvider === 'zcode') nativeOauth = ZCODE_GO_NATIVE_OAUTH;
    if (normalizedProvider === 'opencode' && normalizedMode === 'oauth-device') {
      nativeOauth = OPENCODE_GO_DEVICE_OAUTH;
    }
    // Go 门面未就绪时明确失败：Node 已经没有这两个 provider 的策略，不能悄悄退回 CLI。
    if (nativeOauth && nativeOauth.requiresGoAuthJob === true && !goAuthJobClient) {
      const error = new Error(`${nativeOauth.logLabel || normalizedProvider} 登录需要 Go account-auth-jobs 就绪`);
      error.code = 'go_auth_job_unavailable';
      throw error;
    }
    const usesNativeOauth = Boolean(nativeOauth && (
      normalizedMode === 'oauth-browser'
      || (nativeOauth.deviceCode === true && normalizedMode === 'oauth-device')
    ));

    // Native OAuth providers (for example ZCode Desktop) do not require a
    // provider CLI. Other login modes retain the closed-loop CLI resolution.
    let cliPath = '';
    let ensureResult = null;
    if (!usesNativeOauth) {
      // 1) injected resolver (tests / custom wiring)
      // 2) provider-aware resolve + non-interactive auto-install (WebUI closed loop)
      // 3) legacy native PATH lookup by provider id (only when ensure is unavailable)
      if (typeof resolveCliPathImpl === 'function') {
        cliPath = String(resolveCliPathImpl(normalizedProvider, {
          fs,
          env: processObj.env || process.env || {},
          platform: processObj.platform || process.platform,
          cwd: typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd()
        }) || '').trim();
      }
      if (!cliPath && typeof ensureNativeCliImpl === 'function') {
        ensureResult = ensureNativeCliImpl(normalizedProvider, {
          fs,
          processObj,
          autoInstall: false
        });
        cliPath = String(ensureResult && ensureResult.cliPath || '').trim();
        // ensure already searched strategy roots + ran install plans. Fail closed
        // with installAttempts rather than falling back to a weaker PATH lookup
        // that could pick a cross-region alias (e.g. global qoder for qodercn).
        if (!cliPath) {
          if (jobOptions.deferInstallConfirmation && !jobOptions.installConfirmed) {
            return withAliasPoolPreference(
              createInstallConfirmationJob(normalizedProvider, normalizedMode, jobOptions),
              jobOptions
            );
          }
          const error = new Error(buildCliNotFoundMessage(normalizedProvider, ensureResult || {}));
          error.code = 'cli_not_found';
          if (ensureResult && ensureResult.installAttempts) {
            error.installAttempts = ensureResult.installAttempts;
          }
          throw error;
        }
      }
      if (!cliPath) {
        cliPath = String(resolveProviderCliPath(normalizedProvider, {
          fs,
          processObj
        }) || resolveNativeCliPath(normalizedProvider, {
          fs,
          env: processObj.env || process.env || {},
          platform: processObj.platform || process.platform,
          cwd: typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd()
        }) || '').trim();
      }
      if (!cliPath) {
        const error = new Error(buildCliNotFoundMessage(normalizedProvider, ensureResult || {}));
        error.code = 'cli_not_found';
        throw error;
      }
      cliPath = resolveProviderCliExecutable(normalizedProvider, cliPath, {
        fs, path, platform: processObj.platform || process.platform
      });
    }

    const jobId = String(jobOptions.jobId || crypto.randomUUID());
    const { runtimeDir, configDir, workspaceDir } = ensureLoginRuntime({
      fs,
      provider: normalizedProvider,
      aiHomeDir,
      jobId
    });

    if (usesNativeOauth) {
      return withAliasPoolPreference(startNativeOauthJob(
        normalizedProvider,
        nativeOauth,
        authStrategy,
        jobId,
        runtimeDir,
        configDir,
        existingAccountRef,
        jobOptions.previousAccountState || null
      ), jobOptions);
    }

    try {
      prepareProviderRuntime(normalizedProvider, runtimeDir, processObj.env, {
        path,
        fs,
        platform: processObj.platform,
        aiHomeDir,
        isLogin: true,
        accountRef: existingAccountRef,
        requireNativeAuth: Boolean(existingAccountRef)
      });
    } catch (error) {
      const message = String((error && error.message) || error || 'provider_prepare_failed');
      const prepareError = new Error(`provider_prepare_failed: ${message}`);
      prepareError.code = 'provider_prepare_failed';
      throw prepareError;
    }

    const envOverrides = buildProviderRuntimeEnv(normalizedProvider, runtimeDir, processObj.env, {
      path,
      fs,
      platform: processObj.platform,
      aiHomeDir,
      isLogin: true,
      accountRef: existingAccountRef
    });
    const spawnCwd = workspaceDir;
    // Per-provider pre-spawn setup (sandbox seeding, env tweaks) lives in each
    // provider's login strategy rather than as branches here.
    resolveLoginStrategy(normalizedProvider, authStrategy).prepareLogin({
      profileDir: runtimeDir,
      configDir,
      envOverrides,
      fs,
      spawnCwd,
      deps: strategyDeps
    });

    let browserCaptureCommand = '';
    if (normalizedMode === 'oauth-browser') {
      browserCaptureCommand = buildBrowserCaptureCommand(fs, runtimeDir, processObj.platform);
      envOverrides.BROWSER = browserCaptureCommand;
    }

    const argsToRun = buildLoginArgs(normalizedProvider, normalizedMode, { authStrategy });
    const batchLaunch = resolveWindowsBatchLaunchImpl(
      normalizedProvider,
      cliPath,
      envOverrides,
      processObj.platform
    );
    const launch = buildPtyLaunchImpl(
      batchLaunch.launchBin || cliPath,
      argsToRun,
      { platform: processObj.platform }
    );

    const ptyProcess = ptyImpl.spawn(launch.command, launch.args, {
      name: 'xterm-color',
      cols: 120,
      rows: 32,
      cwd: spawnCwd,
      env: {
        ...envOverrides,
        ...(batchLaunch.envPatch || {})
      }
    });

    const job = {
      id: jobId,
      provider: normalizedProvider,
      accountRef: '',
      authMode: normalizedMode,
      authStrategy,
      reauth: Boolean(existingAccountRef),
      runtimeDir,
      configDir,
      status: 'running',
      authProgressState: resolveInitialAuthProgressState(normalizedProvider, normalizedMode, '', authStrategy),
      logs: '',
      exitCode: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOutputAt: Date.now(),
      pid: Number(ptyProcess && ptyProcess.pid) || null,
      expiresAt: null,
      pollIntervalMs: normalizedMode === 'oauth-device' ? RFC8628_DEFAULT_POLL_INTERVAL_MS : null,
      verificationUri: '',
      verificationUriComplete: '',
      userCode: '',
      authorizationUrl: '',
      redirectUri: '',
      oauthState: '',
      browserCaptureCommand,
      browserCallbackForwardedAt: 0,
      _cancelRequested: false,
      _terminationReason: '',
      _finishedNotified: false,
      _finishedNotifyPromise: null,
      _ptyProcess: ptyProcess,
      _processTerminationRequested: false,
      _preserveExistingAccount: Boolean(existingAccountRef),
      _requireFreshOauthArtifacts: Boolean(existingAccountRef),
      _previousAccountState: jobOptions.previousAccountState || null,
      _oauthArtifactSignatureAtStart: '',
      _agyGoogleOAuthSelected: false,
      _reauthTargetRef: existingAccountRef || ''
    };
    attachJobChangeNotifier(job);

    if (job._requireFreshOauthArtifacts) {
      job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
    }

    jobs.set(jobId, job);
    runningProviders.set(normalizedProvider, jobId);
    notifyAuthJobChanged(job);

    ptyProcess.onData((chunk) => {
      appendLog(job, chunk);
      const strategy = resolveLoginStrategy(job.provider, job.authStrategy);
      if (typeof strategy.handlePrompt === 'function') {
        strategy.handlePrompt({ job, deps: strategyDeps });
      }
      const hints = extractOAuthChallenge(job.logs);
      if (hints.verificationUri) job.verificationUri = hints.verificationUri;
      if (hints.verificationUriComplete) job.verificationUriComplete = hints.verificationUriComplete;
      if (hints.userCode) job.userCode = hints.userCode;
      if (job.authMode === 'oauth-browser') {
        const browserHints = extractBrowserOAuthHints(job.logs);
        if (browserHints.authorizationUrl) job.authorizationUrl = browserHints.authorizationUrl;
        if (browserHints.redirectUri) job.redirectUri = browserHints.redirectUri;
        if (browserHints.state) job.oauthState = browserHints.state;
        strategy.updateProgress({ job, hints: browserHints, deps: strategyDeps });
      }
      if (job.authMode === 'oauth-device' && !Number.isFinite(job.expiresAt)) {
        const expiresInMs = parseDeviceCodeExpiryMs(job.logs);
        if (Number.isFinite(expiresInMs) && expiresInMs > 0) {
          job.expiresAt = job.createdAt + expiresInMs;
        }
      }
      if (job.authMode === 'oauth-device') {
        const pollIntervalMs = parseDeviceCodePollIntervalMs(job.logs);
        if (Number.isFinite(pollIntervalMs) && pollIntervalMs > 0) {
          job.pollIntervalMs = pollIntervalMs;
        }
      }
      job.updatedAt = Date.now();
      notifyAuthJobChanged(job);
    });

    ptyProcess.onExit(({ exitCode }) => {
      job._processTerminationRequested = true;
      job._ptyProcess = null;
      job.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
      if (job.status !== 'running') {
        notifyAuthJobChanged(job);
        notifyOauthJobFinishedOnce(job);
        return;
      }
      if (job._terminationReason === 'user_cancelled' || job._cancelRequested) {
        finalizeJob(job, 'cancelled', '用户取消了 OAuth 授权流程', job.exitCode);
        return;
      }
      const completed = hasOauthCompletionArtifacts(job, fs);
      finalizeJob(
        job,
        job.exitCode === 0 && completed ? 'succeeded' : 'failed',
        job.exitCode === 0 && completed
          ? ''
          : (job.error || (job.exitCode === 0
            ? '授权进程已结束，但未检测到新的授权结果。'
            : `OAuth 登录失败，退出码 ${job.exitCode}`)),
        job.exitCode
      );
    });

    return withAliasPoolPreference({
      jobId,
      provider: normalizedProvider,
      accountRef: '',
      expiresAt: job.expiresAt,
      pollIntervalMs: job.pollIntervalMs,
      authProgressState: job.authProgressState
    }, jobOptions);
  }

  function startOauthJobWithInstallConfirmation(provider, authMode, jobOptions = {}) {
    return startOauthJob(provider, authMode, {
      ...jobOptions,
      deferInstallConfirmation: true
    });
  }

  // Collaborators handed to the per-provider login strategies. Bundling them here
  // (dependency injection) keeps oauth-login-strategies.js free of any dependency
  // on this module, so the strategies stay pure and independently testable.
  const strategyDeps = {
    states: AUTH_PROGRESS_STATES,
    aiHomeDir,
    path,
    fs,
    fetchImpl,
    normalizeString,
    stripAnsi,
    compactLogText,
    appendJobLog,
    setAuthProgressState,
    finalizeJob,
    refreshJobState,
    parseAuthorizationCodeInput,
    parseBrowserCallbackInput,
    isSameCallbackEndpoint,
    isLoopbackCallbackUrl,
    resolveCodexSqliteHome
  };

  async function completeBrowserOauthCallback(jobId, rawCallbackUrl) {
    const job = getJob(jobId);
    if (!job) return { ok: false, code: 'job_not_found' };
    if (job.status !== 'running') return { ok: false, code: 'job_not_running', job };

    // kiro 的 refresh_token 导入复用同一个「粘贴并提交」入口：这里收到的是 refresh_token 本身，
    // 不是回调地址（认证方式决定语义，见 core/providers/builtins.go 的 authOptions）。
    if (job.authMode === 'oauth-refresh-token') {
      if (job.provider !== 'kiro') return { ok: false, code: 'callback_not_supported', job };
      const refreshToken = String(rawCallbackUrl || '').trim();
      if (!refreshToken) return { ok: false, code: 'invalid_refresh_token', job };
      setAuthProgressState(job, AUTH_PROGRESS_STATES.SUBMITTED_CODE);
      let imported;
      try {
        imported = await importKiroRefreshToken({ refreshToken, request: fetchImpl });
      } catch (error) {
        finalizeJob(job, 'failed', `refresh_token 导入失败: ${(error && (error.code || error.message)) || 'unknown'}`);
        return { ok: false, code: (error && error.code) || 'refresh_token_import_failed', job };
      }
      await finishKiroNativeLogin(job, { registration: null, auth: imported.auth });
      return { ok: true, job: refreshJobState(job) };
    }

    if (job.authMode !== 'oauth-browser') return { ok: false, code: 'callback_not_supported', job };

    // Go 承接的登录（codex/zcode）：整段回调原样交给 Go，本地不解析、不校验 state。
    if (job._goAuthJobWired === true) {
      const result = await completeGoAuthJobCallback(job, rawCallbackUrl);
      return { ...result, job: refreshJobState(result.job || job) };
    }

    // How the pasted code/URL becomes a completed login is provider-specific
    // (Codex exchanges it, Claude/Antigravity paste it into the CLI, others
    // forward to a loopback server). Each provider's login strategy owns that.
    const result = await resolveLoginStrategy(job.provider, job.authStrategy).submitCallback({
      job,
      rawInput: rawCallbackUrl,
      deps: strategyDeps
    });
    return { ...result, job: refreshJobState(result.job || job) };
  }

  return {
    getJob,
    getRunningJob,
    cancelJob,
    startOauthJob,
    startOauthJobWithInstallConfirmation,
    completeBrowserOauthCallback,
    completeLocalAuthImport,
    confirmCliInstall
  };
}

module.exports = {
  stripAnsi,
  parseDeviceCodeExpiryMs,
  parseDeviceCodePollIntervalMs,
  isProcessAlive,
  normalizeAuthMode,
  normalizeExistingAccountRef,
  PROVIDER_AUTH_MODE_MATRIX,
  PROVIDER_DEFAULT_AUTH_MODE,
  isSupportedAuthMode,
    isSupportedAuthStrategy,
  getDefaultAuthMode,
  extractOAuthChallenge,
  extractBrowserOAuthHints,
  getOauthArtifactPath,
  hasOauthCompletionArtifacts,
  configureApiKeyAccount,
  configureVertexAiAccount,
  serializeAuthJob,
  createAuthJobManager
};
