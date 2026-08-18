'use strict';

const path = require('node:path');
const { registerProviderAuthProjection } = require('../account/native-auth-projection');
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
const { resolveLoginStrategy } = require('./oauth-login-strategies');
const {
  OAUTH_PENDING_FALLBACK_STALE_MS,
  resolveOauthJobDeadline
} = require('./oauth-pending-state');

const { DEVICE_CODE_DURATION_UNITS_MS, loadNodePty, createLazyPtyAdapter, createAnsiStripper, stripAnsi, normalizeString, base64Url, createPkcePair, createOauthState, normalizeAuthMode, compactLogText, parseDeviceCodeExpiryMs, parseDeviceCodePollIntervalMs, isProcessAlive } = require('./web-account-auth-utils');
const { deriveProviderAuthModes, DERIVED_PROVIDER_AUTH, PROVIDER_AUTH_MODE_MATRIX, PROVIDER_DEFAULT_AUTH_MODE, normalizeExistingAccountRef, isSupportedAuthMode, getDefaultAuthMode } = require('./web-account-auth-auth-mode');
const { JOB_LOG_LIMIT, AUTH_PROGRESS_STATES, appendLogText, appendLog, notifyAuthJobChanged, appendJobLog, setAuthProgressState, serializeAuthJob, resolveInitialAuthProgressState, resolveFinishedAuthProgressState, isAgyGoogleOAuthPrompt, maybeSelectAgyGoogleOAuth } = require('./web-account-auth-job');
const { hasCodexOauthTokens, hasClaudeOauthTokens, hasGeminiOauthTokens, hasAgyOauthTokens, hasOpenCodeAuthTokens, hasGrokOauthTokens, hasKimiOauthTokens, OAUTH_ARTIFACT_PATH_OVERRIDES, getOauthArtifactPath, readOauthArtifactSignature, hasGenericOauthArtifact, hasOauthCompletionArtifacts } = require('./web-account-auth-oauth-tokens');
const { BROWSER_CAPTURE_UNIX, BROWSER_CAPTURE_WIN, extractOAuthChallenge, getUrlPrefix, isUrlContinuationLine, collectWrappedHttpUrls, collectHttpUrls, extractBrowserOAuthHints, isLoopbackCallbackUrl, buildBrowserCaptureCommand, parseBrowserCallbackInput, isSameCallbackEndpoint, parseAuthorizationCodeInput } = require('./web-account-auth-oauth-browser');
const { CODEX_OAUTH_AUTHORIZE_URL, CODEX_OAUTH_CLIENT_ID, CODEX_OAUTH_SCOPE, CLAUDE_OAUTH_AUTHORIZE_URL, CLAUDE_OAUTH_CLIENT_ID, CLAUDE_OAUTH_SCOPE, ZCODE_OAUTH_AUTHORIZE_URL, ZCODE_OAUTH_CLIENT_ID, buildCodexAuthorizationUrl, buildClaudeAuthorizationUrl, buildZcodeAuthorizationUrl, buildClaudeCredentialsFromTokenResponse, decodeJwtPayloadUnsafe, resolveCodexUpstreamAccountId, buildCodexAuthJsonFromTokenResponse } = require('./web-account-auth-oauth-urls');
const { buildLoginArgs, resolveProviderConfigDir, ensureLoginRuntime, configureApiKeyAccount, hashSecret, configureVertexAiAccount } = require('./web-account-auth-account-config');
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
      installConfirmed: true
    };
    jobs.delete(job.id);
    runningProviders.delete(job.provider);
    const started = startOauthJob(job.provider, job.authMode, resumeOptions);
    return { ok: true, job: jobs.get(started.jobId) || null };
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
    terminateAuthPty(job);
    if (nextStatus === 'succeeded') {
      try {
        const registration = registerProviderAuthProjection(fs, job.runtimeDir, job.provider, {
          path,
          aiHomeDir,
          accountRef: job._reauthTargetRef
        });
        if (!registration.registered) {
          nextStatus = 'failed';
          errorMessage = `OAuth 凭据未写入账号数据库: ${registration.reason}`;
        } else {
          job.accountRef = registration.accountRef;
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

  // Z.ai 的 token 交换走桌面版同款业务包装响应：{ code, msg, data }。
  // data.token 是 zcode JWT（zcodejwttoken），data.zai.access_token 才是
  // provider access token；两者缺一即视为交换失败。写盘格式与 ZCode 原生运行时
  // 的 saveZaiLoginCredentials 完全一致（值经 encryptZcodeCredentialValue
  // 加密），这样 CLI / aih 的读取路径无需任何适配。
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
  function startNativeOauthJob(provider, nativeOauth, jobId, runtimeDir, configDir, existingAccountRef, previousAccountState = null) {
    const pkce = createPkcePair();
    const state = createOauthState();
    const redirectUri = nativeOauth.loopbackRedirectUri;
    const authorizationUrl = nativeOauth.buildAuthorizationUrl({
      redirectUri,
      codeChallenge: pkce.codeChallenge,
      state,
      deps: strategyDeps
    });
    const label = nativeOauth.logLabel || provider;
    const job = {
      id: jobId,
      provider,
      accountRef: '',
      authMode: 'oauth-browser',
      reauth: Boolean(existingAccountRef),
      runtimeDir,
      configDir,
      status: 'running',
      authProgressState: resolveInitialAuthProgressState(provider, 'oauth-browser', authorizationUrl),
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
      _manualCallbackOauth: true,
      _codeVerifier: pkce.codeVerifier,
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
    attachManualCallbackLoopback(job);
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
      authProgressState: job.authProgressState
    };
  }

  function startOauthJob(provider, authMode, jobOptions = {}) {
    cleanupFinishedJobs();
    const normalizedProvider = normalizeString(provider).toLowerCase();
    const normalizedMode = normalizeAuthMode(authMode);
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

    const loginStrategy = resolveLoginStrategy(normalizedProvider);
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
            return createInstallConfirmationJob(normalizedProvider, normalizedMode, jobOptions);
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
    }

    const jobId = String(jobOptions.jobId || crypto.randomUUID());
    const { runtimeDir, configDir, workspaceDir } = ensureLoginRuntime({
      fs,
      provider: normalizedProvider,
      aiHomeDir,
      jobId
    });

    if (usesNativeOauth) {
      return startNativeOauthJob(
        normalizedProvider,
        loginStrategy.nativeOauth,
        jobId,
        runtimeDir,
        configDir,
        existingAccountRef,
        jobOptions.previousAccountState || null
      );
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
    resolveLoginStrategy(normalizedProvider).prepareLogin({
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

    const argsToRun = buildLoginArgs(normalizedProvider, normalizedMode);
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
      reauth: Boolean(existingAccountRef),
      runtimeDir,
      configDir,
      status: 'running',
      authProgressState: resolveInitialAuthProgressState(normalizedProvider, normalizedMode),
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
      const strategy = resolveLoginStrategy(job.provider);
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

    return {
      jobId,
      provider: normalizedProvider,
      accountRef: '',
      expiresAt: job.expiresAt,
      pollIntervalMs: job.pollIntervalMs,
      authProgressState: job.authProgressState
    };
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
    exchangeManualCallbackCodexCode,
    exchangeClaudeOauthCode,
    exchangeZcodeOauthCode,
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
    if (job.authMode !== 'oauth-browser') return { ok: false, code: 'callback_not_supported', job };

    // How the pasted code/URL becomes a completed login is provider-specific
    // (Codex exchanges it, Claude/Antigravity paste it into the CLI, others
    // forward to a loopback server). Each provider's login strategy owns that.
    const result = await resolveLoginStrategy(job.provider).submitCallback({
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
