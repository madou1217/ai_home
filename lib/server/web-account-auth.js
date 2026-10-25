'use strict';

const path = require('node:path');
const { registerProviderAuthProjection } = require('../account/native-auth-projection');
const { prepareKiroIdentityProjection } = require('../account/kiro-native-login');
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
const {
  extractCodexMetadata,
  normalizeCodexRefreshToken
} = require('../account/codex-auth-metadata');
const { hasUsableKimiOAuth } = require('../account/kimi-auth');
const {
  ZCODE_CREDENTIAL_KEYS,
  encryptZcodeCredentialValue
} = require('../account/zcode-credential');
const { startOauthLoopbackCallbackServer } = require('./oauth-loopback-callback');
const { createSessionFlowDriver } = require('./zcode-cli-login');
const { resolveZcodeRegionFromStrategy } = require('./oauth-strategies/zcode');
const { resolveZcodeRegion } = require('./zcode-region');
const { resolveZcodeProjectKeyLocation } = require('./zcode-project-key-location');
const { createBusinessTokenResolver } = require('./business-token-resolver');
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

const { DEVICE_CODE_DURATION_UNITS_MS, loadNodePty, createLazyPtyAdapter, createAnsiStripper, stripAnsi, normalizeString, base64Url, createPkcePair, createOauthState, normalizeAuthMode, compactLogText, parseDeviceCodeExpiryMs, parseDeviceCodePollIntervalMs, isProcessAlive } = require('./web-account-auth-utils');
const { deriveProviderAuthModes, DERIVED_PROVIDER_AUTH, PROVIDER_AUTH_MODE_MATRIX, PROVIDER_DEFAULT_AUTH_MODE, normalizeExistingAccountRef, isSupportedAuthMode, isSupportedAuthStrategy, getDefaultAuthMode } = require('./web-account-auth-auth-mode');
const { JOB_LOG_LIMIT, AUTH_PROGRESS_STATES, appendLogText, appendLog, notifyAuthJobChanged, appendJobLog, setAuthProgressState, serializeAuthJob, resolveInitialAuthProgressState, resolveFinishedAuthProgressState, isAgyGoogleOAuthPrompt, maybeSelectAgyGoogleOAuth } = require('./web-account-auth-job');
const { applyAliasPoolPreference } = require('../account/alias-pool-preference');
const { hasCodexOauthTokens, hasClaudeOauthTokens, hasGeminiOauthTokens, hasAgyOauthTokens, hasOpenCodeAuthTokens, hasGrokOauthTokens, hasKimiOauthTokens, OAUTH_ARTIFACT_PATH_OVERRIDES, getOauthArtifactPath, readOauthArtifactSignature, hasGenericOauthArtifact, hasOauthCompletionArtifacts } = require('./web-account-auth-oauth-tokens');
const { BROWSER_CAPTURE_UNIX, BROWSER_CAPTURE_WIN, extractOAuthChallenge, getUrlPrefix, isUrlContinuationLine, collectWrappedHttpUrls, collectHttpUrls, extractBrowserOAuthHints, isLoopbackCallbackUrl, buildBrowserCaptureCommand, parseBrowserCallbackInput, isSameCallbackEndpoint, parseAuthorizationCodeInput } = require('./web-account-auth-oauth-browser');
const { CODEX_OAUTH_AUTHORIZE_URL, CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_SCOPE, CLAUDE_OAUTH_AUTHORIZE_URL, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_SCOPE, ZCODE_OAUTH_AUTHORIZE_URL, ZCODE_OAUTH_CLIENT_ID, buildCodexAuthorizationUrl, buildClaudeAuthorizationUrl, buildZcodeAuthorizationUrl, buildClaudeCredentialsFromTokenResponse, decodeJwtPayloadUnsafe, resolveCodexUpstreamAccountId, buildCodexAuthJsonFromTokenResponse } = require('./web-account-auth-oauth-urls');
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
// 认证方式的事实来源是 Go 契约（core/providers/builtins.go 的 authOptions，
// 经 provider-catalog 读取）。这里只做派生，不再手维护 provider 列表：
// 新增 provider 后认证方式自动生效，避免出现「目录里有、网关不认」的漂移。
// - 支持的模式 = 该 provider 声明的全部 authOptions（含已停用项，保持历史行为）；
// - 默认模式 = 第一个非停用的 oauth 选项，否则第一个非停用选项。
const RFC8628_DEFAULT_POLL_INTERVAL_MS = 5000;
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const ZCODE_OAUTH_TOKEN_URL = 'https://zcode.z.ai/api/v1/oauth/token';
const AGY_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// 业务 token(PAT) 换取端点（与桌面端 businessLoginUrl 同源）。
// 登录时用它把 access_token 换成长期凭据再落盘 —— 见 writeZcodeOauthCredentials。
const ZCODE_BUSINESS_LOGIN_URL = 'https://api.z.ai/api/auth/z/login';
const MANUAL_CALLBACK_OAUTH_TTL_MS = OAUTH_PENDING_FALLBACK_STALE_MS;
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
    verifyOauthJobCompleted
  } = options;

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

  function attachJobChangeNotifier(job) {
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
    // Kiro 原生登录是定时器驱动的（没有 PTY），收尾时必须一起停掉，否则轮询会继续打上游。
    if (job._kiroPollTimer) {
      clearTimeout(job._kiroPollTimer);
      job._kiroPollTimer = null;
    }
    sessionFlowDriver.clearTimer(job);
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
          applyAliasPoolPreferenceToJob(job);
        }
      } catch (error) {
        nextStatus = 'failed';
        errorMessage = `OAuth 凭据入库失败: ${error.message}`;
      }
    }
    closeJobLoopbackCallback(job);
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

    if (job._manualCallbackOauth || job._sessionFlowJob) {
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

  async function exchangeManualCallbackCodexCode(job, code, redirectUri) {
    if (!job || !job._manualCallbackOauth) {
      return { ok: false, code: 'callback_not_supported', job };
    }
    const authCode = normalizeString(code);
    if (!authCode) return { ok: false, code: 'invalid_callback_url', job };
    const tokenRedirectUri = normalizeString(redirectUri);
    if (!tokenRedirectUri) return { ok: false, code: 'invalid_callback_redirect', job };
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'callback_forward_unavailable', job };
    }
    appendJobLog(job, '开始向 OpenAI token endpoint 换取 Codex OAuth token。');

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('client_id', CODEX_OAUTH_CLIENT_ID);
    body.set('code', authCode);
    body.set('redirect_uri', tokenRedirectUri);
    body.set('code_verifier', job._codeVerifier);

    try {
      const response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded'
        },
        body: body.toString()
      });
      const rawText = await response.text().catch(() => '');
      appendJobLog(job, `OpenAI token endpoint 返回 HTTP ${response.status || 0}。`);
      if (!response.ok) {
        job.error = rawText || `token_exchange_failed_${response.status}`;
        job.updatedAt = Date.now();
        appendJobLog(job, `token exchange 失败：${compactLogText(job.error) || 'empty_response'}`);
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_failed', statusCode: response.status, job };
      }
      const payload = rawText ? JSON.parse(rawText) : {};
      const authJson = buildCodexAuthJsonFromTokenResponse(payload, Date.now());
      appendJobLog(
        job,
        `token 响应字段：access=${Boolean(authJson.tokens.access_token)} refresh=${Boolean(authJson.tokens.refresh_token)} id=${Boolean(authJson.tokens.id_token)} expiresIn=${Number(payload && payload.expires_in) || 0}`
      );
      if (!authJson.tokens.access_token || !authJson.tokens.refresh_token) {
        job.error = 'token_exchange_missing_tokens';
        job.updatedAt = Date.now();
        appendJobLog(job, 'token exchange 成功但响应缺少 access_token 或 refresh_token。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_missing_tokens', job };
      }
      fs.mkdirSync(job.configDir, { recursive: true });
      fs.writeFileSync(path.join(job.configDir, 'auth.json'), `${JSON.stringify(authJson, null, 2)}\n`, 'utf8');
      const metadata = extractCodexMetadata(authJson);
      job.email = metadata.email || '';
      job.displayName = metadata.email || '';
      job.planType = metadata.planType || '';
      appendJobLog(job, `auth.json 已写入：${path.join(job.configDir, 'auth.json')}`);
      if (job.email) appendJobLog(job, `已解析账号邮箱：${job.email}`);
      if (!hasOauthCompletionArtifacts(job, fs)) {
        job.error = 'oauth_artifact_verification_failed';
        job.updatedAt = Date.now();
        appendJobLog(job, '写入后未通过本地 OAuth artifact 校验。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'oauth_artifact_verification_failed', job };
      }
      if (typeof verifyOauthJobCompleted === 'function') {
        appendJobLog(job, '开始执行账号状态识别校验。');
        const verified = await Promise.resolve(verifyOauthJobCompleted(job, authJson));
        if (!verified || verified.ok === false) {
          const reason = String(verified && (verified.message || verified.code) || 'oauth_completion_verification_failed');
          job.error = reason;
          job.updatedAt = Date.now();
          appendJobLog(job, `账号状态识别失败：${compactLogText(reason)}`);
          finalizeJob(job, 'failed', reason, 1);
          return { ok: false, code: 'oauth_completion_verification_failed', job };
        }
        if (verified.email) job.email = String(verified.email || '').trim();
        if (verified.displayName) job.displayName = String(verified.displayName || '').trim();
        appendJobLog(job, '账号状态识别通过。');
      }
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      appendJobLog(job, 'Codex OAuth 授权完成。');
      await finalizeJob(job, 'succeeded', '', 0);
      return { ok: true, job };
    } catch (error) {
      job.error = String((error && error.message) || error || 'token_exchange_failed');
      job.updatedAt = Date.now();
      appendJobLog(job, `token exchange 异常：${compactLogText(job.error)}`);
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
  }

  async function exchangeClaudeOauthCode(job, code, redirectUri) {
    if (!job || !job._manualCallbackOauth) {
      return { ok: false, code: 'callback_not_supported', job };
    }
    const authCode = normalizeString(code);
    if (!authCode) return { ok: false, code: 'invalid_callback_url', job };
    const tokenRedirectUri = normalizeString(redirectUri);
    if (!tokenRedirectUri) return { ok: false, code: 'invalid_callback_redirect', job };
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'callback_forward_unavailable', job };
    }
    appendJobLog(job, '开始向 Claude token endpoint 换取 OAuth token。');

    try {
      const response = await fetchImpl(CLAUDE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: tokenRedirectUri,
          client_id: CLAUDE_OAUTH_CLIENT_ID,
          code_verifier: job._codeVerifier,
          state: job.oauthState
        })
      });
      const rawText = await response.text().catch(() => '');
      appendJobLog(job, `Claude token endpoint 返回 HTTP ${response.status || 0}。`);
      if (!response.ok) {
        job.error = rawText || `token_exchange_failed_${response.status}`;
        job.updatedAt = Date.now();
        appendJobLog(job, `token exchange 失败：${compactLogText(job.error) || 'empty_response'}`);
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_failed', statusCode: response.status, job };
      }
      const payload = rawText ? JSON.parse(rawText) : {};
      const credentials = buildClaudeCredentialsFromTokenResponse(payload, Date.now());
      const oauth = credentials.claudeAiOauth;
      appendJobLog(
        job,
        `token 响应字段：access=${Boolean(oauth.accessToken)} refresh=${Boolean(oauth.refreshToken)} scopes=${oauth.scopes.length} expiresIn=${Number(payload && payload.expires_in) || 0}`
      );
      if (!oauth.accessToken || !oauth.refreshToken) {
        job.error = 'token_exchange_missing_tokens';
        job.updatedAt = Date.now();
        appendJobLog(job, 'token exchange 成功但响应缺少 access_token 或 refresh_token。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_missing_tokens', job };
      }
      fs.mkdirSync(job.configDir, { recursive: true });
      fs.writeFileSync(path.join(job.configDir, '.credentials.json'), `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
      appendJobLog(job, `.credentials.json 已写入：${path.join(job.configDir, '.credentials.json')}`);
      if (!hasOauthCompletionArtifacts(job, fs)) {
        job.error = 'oauth_artifact_verification_failed';
        job.updatedAt = Date.now();
        appendJobLog(job, '写入后未通过本地 OAuth artifact 校验。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'oauth_artifact_verification_failed', job };
      }
      if (typeof verifyOauthJobCompleted === 'function') {
        appendJobLog(job, '开始执行账号状态识别校验。');
        const verified = await Promise.resolve(verifyOauthJobCompleted(job, credentials));
        if (!verified || verified.ok === false) {
          const reason = String(verified && (verified.message || verified.code) || 'oauth_completion_verification_failed');
          job.error = reason;
          job.updatedAt = Date.now();
          appendJobLog(job, `账号状态识别失败：${compactLogText(reason)}`);
          finalizeJob(job, 'failed', reason, 1);
          return { ok: false, code: 'oauth_completion_verification_failed', job };
        }
        if (verified.email) job.email = String(verified.email || '').trim();
        if (verified.displayName) job.displayName = String(verified.displayName || '').trim();
        appendJobLog(job, '账号状态识别通过。');
      }
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      appendJobLog(job, 'Claude OAuth 授权完成。');
      await finalizeJob(job, 'succeeded', '', 0);
      return { ok: true, job };
    } catch (error) {
      job.error = String((error && error.message) || error || 'token_exchange_failed');
      job.updatedAt = Date.now();
      appendJobLog(job, `token exchange 异常：${compactLogText(job.error)}`);
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
  }

  async function exchangeAgyOauthCode(job, code, redirectUri) {
    if (!job || !job._manualCallbackOauth) return { ok: false, code: 'callback_not_supported', job };
    const authCode = normalizeString(code);
    const tokenRedirectUri = normalizeString(redirectUri);
    if (!authCode || !tokenRedirectUri || typeof fetchImpl !== 'function') {
      return { ok: false, code: !authCode ? 'invalid_callback_url' : 'callback_forward_unavailable', job };
    }
    appendJobLog(job, '开始向 Google token endpoint 换取 Antigravity OAuth token。');
    try {
      let payload = null;
      let lastResponse = null;
      let lastRawText = '';
      for (const credentials of AGY_GOOGLE_CLIENT_CREDENTIALS) {
        const body = new URLSearchParams({
          code: authCode,
          client_id: credentials.clientId || AGY_GOOGLE_CLIENT_ID,
          client_secret: credentials.clientSecret || AGY_GOOGLE_CLIENT_SECRET,
          redirect_uri: tokenRedirectUri,
          grant_type: 'authorization_code'
        });
        const response = await fetchImpl(AGY_OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
        const rawText = await response.text().catch(() => '');
        lastResponse = response;
        lastRawText = rawText;
        if (response.ok) {
          payload = rawText ? JSON.parse(rawText) : {};
          break;
        }
        let errorCode = '';
        try {
          errorCode = String((rawText ? JSON.parse(rawText) : {}).error || '').trim();
        } catch (_error) {}
        if (errorCode !== 'invalid_client') break;
      }
      if (!payload) {
        const message = lastRawText || `token_exchange_failed_${lastResponse && lastResponse.status}`;
        finalizeJob(job, 'failed', message, 1);
        return { ok: false, code: 'token_exchange_failed', statusCode: lastResponse && lastResponse.status, job };
      }
      const accessToken = normalizeString(payload.access_token);
      const refreshToken = normalizeString(payload.refresh_token);
      const idToken = normalizeString(payload.id_token);
      const expiresIn = Number(payload.expires_in) || 0;
      if (!accessToken || !refreshToken) {
        finalizeJob(job, 'failed', 'token_exchange_missing_tokens', 1);
        return { ok: false, code: 'token_exchange_missing_tokens', job };
      }
      const now = Date.now();
      const expiresAt = now + Math.max(1, expiresIn || 3600) * 1000;
      const token = {
        access_token: accessToken,
        refresh_token: refreshToken,
        ...(idToken ? { id_token: idToken } : {}),
        token_type: normalizeString(payload.token_type) || 'Bearer',
        expiry: new Date(expiresAt).toISOString(),
        expires_at_ms: expiresAt,
        refreshed_at_ms: now
      };
      fs.mkdirSync(job.configDir, { recursive: true });
      fs.writeFileSync(path.join(job.configDir, 'antigravity-oauth-token'), `${JSON.stringify({ auth_method: 'consumer', token }, null, 2)}\n`, 'utf8');
      const identityPayload = decodeJwtPayloadUnsafe(idToken) || decodeJwtPayloadUnsafe(accessToken) || {};
      let email = normalizeString(identityPayload.email || identityPayload.emailAddress);
      // Some Google responses omit an ID token even with the openid scope.
      // Resolve the same stable subject through the standard OIDC userinfo API
      // before registration; AGY account identity is email-based by contract.
      if (!email) {
        try {
          const userinfo = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
            method: 'GET',
            headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }
          });
          if (userinfo && userinfo.ok) {
            const profile = await userinfo.json().catch(() => null);
            email = normalizeString(profile && (profile.email || profile.emailAddress));
          }
        } catch (_error) {}
      }
      if (email) {
        fs.writeFileSync(path.join(job.configDir, 'email.cache'), `${email}\n`, 'utf8');
        job.email = email;
      }
      job.browserCallbackForwardedAt = now;
      appendJobLog(job, 'Antigravity OAuth 凭据已写入。');
      await finalizeJob(job, 'succeeded', '', 0);
      return { ok: true, job };
    } catch (error) {
      const message = String((error && error.message) || error || 'token_exchange_failed');
      finalizeJob(job, 'failed', message, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
  }

  // Z.ai 的 token 交换走桌面版同款业务包装响应：{ code, msg, data }。
  // data.token 是 zcode JWT（zcodejwttoken），data.zai.access_token 才是
  // provider access token；两者缺一即视为交换失败。写盘格式与 ZCode 原生运行时
  // 的 saveZaiLoginCredentials 完全一致（值经 encryptZcodeCredentialValue
  // 加密），这样 CLI / aih 的读取路径无需任何适配。
  // zcode 凭据落盘（两条登录路径共用）。
  // cli-flow（服务端中介）与 custom-scheme（zcode:// 手填回调）都走这里，
  // 保证产出的 credentials.json 逐字节一致，读取路径零适配。
  // 区域决定键前缀（zai / bigmodel）与 active_provider。
  async function writeZcodeOauthCredentials(job, result) {
    if (!job) return { ok: false, code: 'job_not_found', job };
    const tokenSet = result && result.tokenSet ? result.tokenSet : {};
    const rawAccessToken = normalizeString(tokenSet.accessToken);
    const zcodeJwtToken = normalizeString(tokenSet.zcodeJwtToken);
    const refreshToken = normalizeString(tokenSet.refreshToken);
    // **登录时就把 access_token 换成业务 token(PAT) 再落盘** —— 与桌面端一致。
    // 桌面端 exchangeToken 的返回值是
    //   { accessToken: await businessTokenResolver.resolve(data.zai.access_token), ... }
    // 即存的**不是**原始 access_token（它只有 4 小时寿命），而是换取后的长期凭据。
    // 真机对照：桌面端手工登录两天仍正常；aih 存原始 token 则 4 小时后被桌面端判
    // 「login JWT expired」并清空凭据、要求重新登录。这是本函数此前漏做的一步。
    let accessToken = rawAccessToken;
    let accessTokenKind = 'raw';
    if (rawAccessToken && typeof fetchImpl === 'function') {
      try {
        const resolver = createBusinessTokenResolver({
          loginUrl: ZCODE_BUSINESS_LOGIN_URL,
          // fetchImpl 是标准 fetch(url, init)；resolver 的 timeoutMs 由它自己的信号控制。
          request: (url, init) => fetchImpl(url, init)
        });
        const pat = await resolver.resolve(rawAccessToken);
        if (pat) { accessToken = pat; accessTokenKind = 'business_token'; }
      } catch (error) {
        // 换取失败不阻断登录：仍写入原始 token（至少额度面可用），
        // 但如实记日志，便于排查「为什么几小时后要重新登录」。
        appendJobLog(job, `业务 token 换取失败（将写入原始 access_token，寿命约 4 小时）：${compactLogText((error && error.code) || (error && error.message))}`);
      }
    }
    appendJobLog(job, `凭据形态：${accessTokenKind === 'business_token' ? '业务 token（长期）' : '原始 access_token（约 4 小时）'}`);
    const user = result && result.user && typeof result.user === 'object' ? result.user : null;
    // 缺 data.token 或 provider access_token 一律视为失败：半截凭据写盘后
    // 只会在后续请求里以更难定位的方式暴露。
    if (!zcodeJwtToken || !accessToken) {
      job.error = 'token_exchange_missing_tokens';
      job.updatedAt = Date.now();
      appendJobLog(job, '授权成功但响应缺少 data.token 或 provider access_token。');
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_missing_tokens', job };
    }
    try {
      const region = resolveZcodeRegion(
        (result && result.region && result.region.provider)
        || (job._sessionFlow && job._sessionFlow.region && job._sessionFlow.region.provider)
        || job.zcodeRegion
      );
      const credentials = {
        [ZCODE_CREDENTIAL_KEYS.ACTIVE_PROVIDER]: encryptZcodeCredentialValue(region.provider),
        [region.accessTokenKey]: encryptZcodeCredentialValue(accessToken),
        [ZCODE_CREDENTIAL_KEYS.ZCODE_JWT_TOKEN]: encryptZcodeCredentialValue(zcodeJwtToken)
      };
      if (refreshToken) credentials[region.refreshTokenKey] = encryptZcodeCredentialValue(refreshToken);
      if (user) credentials[region.userInfoKey] = encryptZcodeCredentialValue(JSON.stringify(user));
      // 项目定位键（`project-key-location:v1:…`）：记下用哪个 org/project/apiKey 签 PAT，
      // 免得每次推理重新发现一遍。桌面端手工登录后 credentials.json 里就有这个键，
      // aih 此前漏写。**它是附加产物**：拿不到就不写，登录照常成功（见下方日志）。
      const projectKeyLocation = await resolveZcodeProjectKeyLocation({
        origin: region.apiOrigin,
        family: region.provider,
        accountId: normalizeString(user && (user.id || user.user_id || user.userId)),
        // 用**原始** access_token 打 biz 面（此时 accessToken 可能已换成 PAT，
        // 而 PAT 不是 biz API 认的凭据）。
        loginToken: rawAccessToken,
        authScheme: region.bizAuthScheme,
        request: typeof fetchImpl === 'function' ? (url, init) => fetchImpl(url, init) : null,
        observe: (event) => appendJobLog(job, `项目定位键未写入：${compactLogText(event && event.code)}`)
      });
      if (projectKeyLocation) {
        credentials[projectKeyLocation.key] = encryptZcodeCredentialValue(projectKeyLocation.value);
      }
      const credentialsPath = path.join(job.configDir, 'v2', 'credentials.json');
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
      fs.writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
      appendJobLog(job, `授权区域：${region.label}（provider=${region.provider}）`);
      if (projectKeyLocation) appendJobLog(job, '已写入项目定位键（project-key-location）。');
      appendJobLog(job, `credentials.json 已写入：${credentialsPath}`);
      if (user) {
        job.email = normalizeString(user.email || user.user_id || user.userId || '');
        job.displayName = normalizeString(user.name || user.email || '');
        if (job.email) appendJobLog(job, `已解析账号标识：${job.email}`);
      }
      if (!hasOauthCompletionArtifacts(job, fs)) {
        job.error = 'oauth_artifact_verification_failed';
        job.updatedAt = Date.now();
        appendJobLog(job, '写入后未通过本地 OAuth artifact 校验。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'oauth_artifact_verification_failed', job };
      }
      if (typeof verifyOauthJobCompleted === 'function') {
        appendJobLog(job, '开始执行账号状态识别校验。');
        const verified = await Promise.resolve(verifyOauthJobCompleted(job, credentials));
        if (!verified || verified.ok === false) {
          const reason = String(verified && (verified.message || verified.code) || 'oauth_completion_verification_failed');
          job.error = reason;
          job.updatedAt = Date.now();
          appendJobLog(job, `账号状态识别失败：${compactLogText(reason)}`);
          finalizeJob(job, 'failed', reason, 1);
          return { ok: false, code: 'oauth_completion_verification_failed', job };
        }
        if (verified.email) job.email = String(verified.email || '').trim();
        if (verified.displayName) job.displayName = String(verified.displayName || '').trim();
        appendJobLog(job, '账号状态识别通过。');
      }
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      appendJobLog(job, 'ZCode OAuth 授权完成。');
      await finalizeJob(job, 'succeeded', '', 0);
      return { ok: true, job };
    } catch (error) {
      job.error = String((error && error.message) || error || 'token_exchange_failed');
      job.updatedAt = Date.now();
      appendJobLog(job, `凭据写入异常：${compactLogText(job.error)}`);
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
  }

  async function exchangeZcodeOauthCode(job, code, redirectUri) {
    if (!job || !job._manualCallbackOauth) {
      return { ok: false, code: 'callback_not_supported', job };
    }
    const authCode = normalizeString(code);
    if (!authCode) return { ok: false, code: 'invalid_callback_url', job };
    const tokenRedirectUri = normalizeString(redirectUri);
    if (!tokenRedirectUri) return { ok: false, code: 'invalid_callback_redirect', job };
    if (typeof fetchImpl !== 'function') {
      return { ok: false, code: 'callback_forward_unavailable', job };
    }
    appendJobLog(job, '开始向 Z.ai token endpoint 换取 OAuth token。');

    try {
      const response = await fetchImpl(ZCODE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          provider: 'zai',
          code: authCode,
          redirect_uri: tokenRedirectUri,
          state: job.oauthState
        })
      });
      const rawText = await response.text().catch(() => '');
      appendJobLog(job, `Z.ai token endpoint 返回 HTTP ${response.status || 0}。`);
      if (!response.ok) {
        job.error = rawText || `token_exchange_failed_${response.status}`;
        job.updatedAt = Date.now();
        appendJobLog(job, `token exchange 失败：${compactLogText(job.error) || 'empty_response'}`);
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_failed', statusCode: response.status, job };
      }
      const payload = rawText ? JSON.parse(rawText) : {};
      if (payload && payload.code !== undefined && payload.code !== 0) {
        job.error = normalizeString(payload.msg) || 'token_exchange_rejected';
        job.updatedAt = Date.now();
        appendJobLog(job, `token exchange 被拒绝：${compactLogText(job.error)}`);
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_failed', job };
      }
      const data = payload && typeof payload.data === 'object' && payload.data ? payload.data : payload;
      // bigmodel 变体与 zai 变体结构相同，仅子键名不同；兼容地取。
      const providerTokens = data.zai && typeof data.zai === 'object'
        ? data.zai
        : (data.bigmodel && typeof data.bigmodel === 'object' ? data.bigmodel : {});
      const jwtToken = normalizeString(data.token);
      const accessToken = normalizeString(providerTokens.access_token);
      const refreshToken = normalizeString(providerTokens.refresh_token);
      const user = data.user && typeof data.user === 'object' ? data.user : null;
      appendJobLog(
        job,
        `token 响应字段：jwt=${Boolean(jwtToken)} access=${Boolean(accessToken)} refresh=${Boolean(refreshToken)} user=${Boolean(user)}`
      );
      if (!jwtToken || !accessToken) {
        job.error = 'token_exchange_missing_tokens';
        job.updatedAt = Date.now();
        appendJobLog(job, 'token exchange 成功但响应缺少 data.token 或 data.zai.access_token。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'token_exchange_missing_tokens', job };
      }

      const credentials = {
        [ZCODE_CREDENTIAL_KEYS.ACTIVE_PROVIDER]: encryptZcodeCredentialValue('zai'),
        [ZCODE_CREDENTIAL_KEYS.ZAI_ACCESS_TOKEN]: encryptZcodeCredentialValue(accessToken),
        [ZCODE_CREDENTIAL_KEYS.ZCODE_JWT_TOKEN]: encryptZcodeCredentialValue(jwtToken)
      };
      if (refreshToken) {
        credentials[ZCODE_CREDENTIAL_KEYS.ZAI_REFRESH_TOKEN] = encryptZcodeCredentialValue(refreshToken);
      }
      if (user) {
        credentials[ZCODE_CREDENTIAL_KEYS.ZAI_USER_INFO] = encryptZcodeCredentialValue(JSON.stringify(user));
      }
      const credentialsPath = path.join(job.configDir, 'v2', 'credentials.json');
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
      fs.writeFileSync(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8');
      appendJobLog(job, `credentials.json 已写入：${credentialsPath}`);
      if (user) {
        job.email = normalizeString(user.email || user.user_id || user.userId || '');
        job.displayName = normalizeString(user.name || user.email || '');
        if (job.email) appendJobLog(job, `已解析账号标识：${job.email}`);
      }
      if (!hasOauthCompletionArtifacts(job, fs)) {
        job.error = 'oauth_artifact_verification_failed';
        job.updatedAt = Date.now();
        appendJobLog(job, '写入后未通过本地 OAuth artifact 校验。');
        finalizeJob(job, 'failed', job.error, 1);
        return { ok: false, code: 'oauth_artifact_verification_failed', job };
      }
      if (typeof verifyOauthJobCompleted === 'function') {
        appendJobLog(job, '开始执行账号状态识别校验。');
        const verified = await Promise.resolve(verifyOauthJobCompleted(job, credentials));
        if (!verified || verified.ok === false) {
          const reason = String(verified && (verified.message || verified.code) || 'oauth_completion_verification_failed');
          job.error = reason;
          job.updatedAt = Date.now();
          appendJobLog(job, `账号状态识别失败：${compactLogText(reason)}`);
          finalizeJob(job, 'failed', reason, 1);
          return { ok: false, code: 'oauth_completion_verification_failed', job };
        }
        if (verified.email) job.email = String(verified.email || '').trim();
        if (verified.displayName) job.displayName = String(verified.displayName || '').trim();
        appendJobLog(job, '账号状态识别通过。');
      }
      job.browserCallbackForwardedAt = Date.now();
      job.updatedAt = Date.now();
      appendJobLog(job, 'ZCode OAuth 授权完成。');
      await finalizeJob(job, 'succeeded', '', 0);
      return { ok: true, job };
    } catch (error) {
      job.error = String((error && error.message) || error || 'token_exchange_failed');
      job.updatedAt = Date.now();
      appendJobLog(job, `token exchange 异常：${compactLogText(job.error)}`);
      finalizeJob(job, 'failed', job.error, 1);
      return { ok: false, code: 'token_exchange_failed', job };
    }
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
    // 第三参是策略名（与 agy 注入方式一致）。服务端中介流程需要解析后的策略对象。
    const resolvedStrategy = authStrategy && typeof authStrategy === 'object'
      ? authStrategy
      : resolveLoginStrategy(provider, authStrategy);
    const sessionFlow = Boolean(resolvedStrategy && resolvedStrategy.sessionFlow);
    const pkce = sessionFlow ? { codeVerifier: '', codeChallenge: '' } : createPkcePair();
    const state = sessionFlow ? '' : createOauthState();
    const redirectUri = sessionFlow ? '' : nativeOauth.loopbackRedirectUri;
    // 区域（zai / bigmodel）从策略名派生一次，供授权入口与 job 共用（单一来源）。
    const zcodeRegion = normalizeString(resolveZcodeRegionFromStrategy(authStrategy));
    const authorizationUrl = sessionFlow ? '' : nativeOauth.buildAuthorizationUrl({
      redirectUri,
      codeChallenge: pkce.codeChallenge,
      state,
      // 授权入口按区域派生（custom-scheme 需要）；job 尚未构造，用局部变量传。
      zcodeRegion,
      deps: strategyDeps
    });
    const label = nativeOauth.logLabel || provider;
    const job = {
      id: jobId,
      provider,
      accountRef: '',
      authMode: 'oauth-browser',
      authStrategy: String(authStrategy || ''),
      reauth: Boolean(existingAccountRef),
      runtimeDir,
      configDir,
      status: 'running',
      authProgressState: resolveInitialAuthProgressState(provider, 'oauth-browser', authorizationUrl, authStrategy),
      logs: '',
      exitCode: null,
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastOutputAt: Date.now(),
      pid: null,
      expiresAt: Date.now() + MANUAL_CALLBACK_OAUTH_TTL_MS,
      pollIntervalMs: 1000,
      verificationUri: '',
      verificationUriComplete: '',
      userCode: '',
      authorizationUrl,
      redirectUri,
      oauthState: state,
      email: '',
      displayName: '',
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
      // 服务端中介流程没有可粘贴的回调，也不需要 loopback 收口。
      _manualCallbackOauth: !sessionFlow && nativeOauth.manualCallback !== false,
      _autoCaptureCallback: !sessionFlow && nativeOauth.autoCaptureCallback !== false,
      _sessionFlowJob: sessionFlow,
      _sessionFlow: null,
      _sessionPollTimer: null,
      _codeVerifier: pkce.codeVerifier,
      // 区域（zai / bigmodel）从策略名 `<区域>:<流程>` 派生 —— 策略名是唯一入口，
      // 不额外加参数（避免两处来源漂移）。它决定授权入口、凭据键前缀
      // （oauth:<region>:*）与套餐目录，是登录的正式维度。见 lib/server/zcode-region.js。
      zcodeRegion,
      zcodeAuthorizeOrigin: '',
      _reauthTargetRef: existingAccountRef || ''
    };
    attachJobChangeNotifier(job);
    if (job._requireFreshOauthArtifacts) {
      job._oauthArtifactSignatureAtStart = readOauthArtifactSignature(job, fs);
    }
    appendJobLog(job, `${label} OAuth 流程已创建。`);
    appendJobLog(job, `回调地址：${redirectUri}`);
    appendJobLog(job, `授权任务：provider=${provider}${existingAccountRef ? ` reauth=${existingAccountRef}` : ''}`);
    jobs.set(jobId, job);
    runningProviders.set(provider, jobId);
    if (sessionFlow) {
      sessionFlowDriver.begin(job, resolvedStrategy);
    } else if (job._manualCallbackOauth && job._autoCaptureCallback) {
      attachManualCallbackLoopback(job);
    }
    notifyAuthJobChanged(job);
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
      // social（Google / Github）走设备流时记录提供方；空 = Builder ID 的 AWS SSO OIDC 口径。
      _kiroLoginProvider: String(jobOptions.loginProvider || '').trim(),
      _kiroSocialFlow: false
    };
    attachJobChangeNotifier(job);
    jobs.set(jobId, job);
    runningProviders.set(provider, jobId);
    appendJobLog(job, authMode === 'oauth-device'
      ? 'Kiro 原生登录：由 aih 直接完成 AWS SSO OIDC 设备码授权（不需要本地 kiro CLI）。'
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
    if (typeof source.implementation !== 'function') return { ok: false, code: 'auth_source_impl_missing', job };

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

    const loginStrategy = resolveLoginStrategy(normalizedProvider, authStrategy);
    const usesNativeOauth = Boolean(loginStrategy.nativeOauth && normalizedMode === 'oauth-browser');

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
        loginStrategy.nativeOauth,
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
  const sessionFlowDriver = createSessionFlowDriver({
    fetchImpl,
    appendJobLog, setAuthProgressState, finalizeJob, notifyAuthJobChanged,
    states: AUTH_PROGRESS_STATES
  });

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
    exchangeManualCallbackCodexCode,
    exchangeClaudeOauthCode,
    exchangeAgyOauthCode,
    // 供策略读取当前任务的区域/镜像覆盖（任务级）。
    getZcodeRegion: (job) => normalizeString(job && job.zcodeRegion),
    getZcodeAuthorizeOrigin: (job) => normalizeString(job && job.zcodeAuthorizeOrigin),
    exchangeZcodeOauthCode,
    writeZcodeOauthCredentials,
    buildCodexAuthorizationUrl,
    buildClaudeAuthorizationUrl,
    buildZcodeAuthorizationUrl,
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
