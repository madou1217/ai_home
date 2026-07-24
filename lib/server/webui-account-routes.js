'use strict';

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  readAccountCredentialRecord,
  readAccountCredentials,
  writeAccountCredentials
} = require('./account-credential-store');
const { resolveEffectiveAccountStatus } = require('../account/status-file');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { ensureDirSync } = require('./fs-compat');
const {
  configureApiKeyAccount,
  getDefaultAuthMode,
  isSupportedAuthMode,
  normalizeAuthMode,
  normalizeExistingAccountRef,
  serializeAuthJob
} = require('./web-account-auth');
const {
  getClaudeCredentialType,
  writeClaudeCredentialEnv
} = require('../account/claude-credential');
const {
  buildAntigravityManagerExportPayload,
  buildSub2ApiExportPayload,
  importStandardAccountRecords
} = require('../account/standard-transfer');
const { createCliproxyapiExportService } = require('../cli/services/backup/cliproxyapi-export');
const {
  extractImportRecords,
  buildRuntimeImportTools
} = require('./web-account-transfer');
const {
  handleListAccountsFastRequest,
  refreshLiveAccountRecord,
  removeLiveAccountRecord,
  emitAccountsLiveEvent
} = require('./webui-account-live');
const { withAccountQueryListFns } = require('./account-load-args');
const {
  cleanOauthDisplayName,
  getApiKeyDisplayName
} = require('./account-display-identity');
const { createCodexDesktopHookService } = require('./codex-desktop-hook');
const { validateCodexDesktopAccount } = require('./codex-desktop-account');
const { reloadCodexDesktopRuntime } = require('./codex-desktop-runtime-reload');
const { isLoopbackUrl } = require('./http-utils');
const { supportsAihServerProfile } = require('../account/self-relay-account');
const { createAccountRemovalService } = require('../account/account-removal');
const agyWarmPool = require('./agy-warm-ls-pool');
const {
  clearDefaultAccountRef,
  writeDefaultAccountRef
} = require('../account/default-account-store');
const {
  resolveAccountRef
} = require('./account-ref-store');
const { deriveRuntimeStatus } = require('../account/runtime-view');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { evaluateDefaultAccountEligibility } = require('./account-default-eligibility');
const {
  invalidateWebUiModelsCacheAccountRefs
} = require('./webui-model-cache');

const WEBUI_ACCOUNT_IMPORT_MAX_BYTES = 80 * 1024 * 1024;
const ACCOUNT_IMPORT_JOB_RETENTION_MS = 30 * 60 * 1000;
const ACCOUNT_IMPORT_JOB_MAX = 50;
const ACCOUNT_IMPORT_PROGRESS_EVENT_MIN_MS = 250;
const ACCOUNT_REFRESH_JOB_RETENTION_MS = 10 * 60 * 1000;
const ACCOUNT_REFRESH_JOB_MAX = 200;

const accountImportJobs = new Map();
const accountRefreshJobs = new Map();

function invalidateModelCacheForAccountRefs(ctx, accountRefs) {
  if (!ctx || !ctx.state) return;
  invalidateWebUiModelsCacheAccountRefs(ctx.state, {
    fs: ctx.fs || ctx.deps && ctx.deps.fs,
    aiHomeDir: ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir
  }, accountRefs);
}

async function handleListAccountsRequest(ctx) {
  return handleListAccountsFastRequest(ctx);
}

async function handleGetAddJobRequest(ctx) {
  const { pathname, getAuthJobManager, cleanupAuthJobArtifacts, deps, state, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)$/);
  const job = getAuthJobManager(deps, state).getJob(matches[1]);
  if (!job) {
    writeJson(ctx.res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  if (job.status !== 'running' && job.status !== 'succeeded' && typeof cleanupAuthJobArtifacts === 'function') {
    cleanupAuthJobArtifacts(job, deps, state);
  }
  writeJson(ctx.res, 200, { ok: true, job: serializeAuthJob(job) });
  return true;
}

async function handleCancelAddJobRequest(ctx) {
  const { pathname, getAuthJobManager, cleanupAuthJobArtifacts, deps, state, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/cancel$/);
  const result = getAuthJobManager(deps, state).cancelJob(matches[1]);
  if (!result.ok) {
    if (result.code === 'job_not_found') {
      writeJson(ctx.res, 200, {
        ok: true,
        job: {
          id: matches[1],
          status: 'cancelled',
          authProgressState: 'cancelled',
          error: '授权流程已结束或已清理。'
        }
      });
      return true;
    }
    writeJson(ctx.res, 400, { ok: false, error: result.code || 'cancel_failed' });
    return true;
  }
  cleanupAuthJobArtifacts(result.job, deps, state);
  writeJson(ctx.res, 200, {
    ok: true,
    job: serializeAuthJob(result.job)
  });
  return true;
}

async function handleConfirmAddJobInstallRequest(ctx) {
  const { pathname, getAuthJobManager, deps, state, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/install$/);
  const manager = getAuthJobManager(deps, state);
  if (!manager || typeof manager.confirmCliInstall !== 'function') {
    writeJson(ctx.res, 500, { ok: false, error: 'cli_install_unavailable' });
    return true;
  }
  const job = manager.getJob(matches[1]);
  if (!job) {
    writeJson(ctx.res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  if (!job.installRequired || job.setupPhase !== 'awaiting-install-confirmation') {
    writeJson(ctx.res, 400, { ok: false, error: 'install_not_required', job: serializeAuthJob(job) });
    return true;
  }
  setImmediate(() => {
    manager.confirmCliInstall(matches[1]).catch(() => {});
  });
  writeJson(ctx.res, 202, { ok: true, job: serializeAuthJob(job) });
  return true;
}

async function handleCompleteAddJobCallbackRequest(ctx) {
  const { pathname, getAuthJobManager, cleanupAuthJobArtifacts, deps, state, readRequestBody, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)\/callback$/);
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const callbackUrl = String(payload && payload.callbackUrl || '').trim();
  if (!callbackUrl) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_callback_url' });
    return true;
  }

  const manager = getAuthJobManager(deps, state);
  if (!manager || typeof manager.completeBrowserOauthCallback !== 'function') {
    writeJson(ctx.res, 500, { ok: false, error: 'callback_forward_unavailable' });
    return true;
  }

  const result = await manager.completeBrowserOauthCallback(matches[1], callbackUrl);
  if (result.ok) {
    writeJson(ctx.res, 200, { ok: true, job: serializeAuthJob(result.job) });
    return true;
  }
  if (
    result.job
    && result.job.status !== 'running'
    && result.job.status !== 'succeeded'
    && typeof cleanupAuthJobArtifacts === 'function'
  ) {
    cleanupAuthJobArtifacts(result.job, deps, state);
  }

  const code = String(result.code || 'callback_forward_failed');
  const statusCode = code === 'job_not_found'
    ? 404
    : (code === 'callback_forward_failed' ? 502 : 400);
  writeJson(ctx.res, statusCode, {
    ok: false,
    error: code,
    code,
    message: buildCallbackErrorMessage(code),
    job: serializeAuthJob(result.job)
  });
  return true;
}

function buildPendingOauthResponse(started, authMode) {
  return {
    ok: true,
    provider: started.provider,
    accountRef: started.accountRef || '',
    authMode,
    status: 'pending',
    jobId: started.jobId,
    expiresAt: Number.isFinite(started.expiresAt) ? started.expiresAt : null,
    pollIntervalMs: Number.isFinite(started.pollIntervalMs) ? started.pollIntervalMs : null,
    authorizationUrl: started.authorizationUrl || '',
    redirectUri: started.redirectUri || '',
    callbackCaptureStatus: started.callbackCaptureStatus || '',
    callbackListeningUrl: started.callbackListeningUrl || '',
    callbackCaptureError: started.callbackCaptureError || '',
    authProgressState: started.authProgressState || '',
    setupPhase: started.setupPhase || '',
    installRequired: Boolean(started.installRequired)
  };
}

function reloadRuntimeAccountsIfNeeded(ctx) {
  const {
    fs,
    deps,
    state,
    accountStateIndex,
    getProfileDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus
  } = ctx;
  if (typeof loadServerRuntimeAccounts !== 'function' || typeof applyReloadState !== 'function') {
    return false;
  }
  const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
    fs,
    accountStateIndex,
    getProfileDir,
    checkStatus,
    aiHomeDir: deps && deps.aiHomeDir || '',
    serverPort: ctx.options && ctx.options.port
  }, ctx));
  applyReloadState(state, runtimeAccounts);
  return true;
}

function parseAccountRoute(pathname, pattern) {
  const matches = String(pathname || '').match(pattern);
  if (!matches) return null;
  const provider = String(matches[1] || '').trim().toLowerCase();
  const accountRef = normalizeExistingAccountRef(matches[2]);
  if (!provider || !accountRef) return null;
  return { provider, accountRef };
}

function isSelfRelayBaseUrl(provider, baseUrl, ctx) {
  const p = String(provider || '').trim().toLowerCase();
  const url = String(baseUrl || '').trim();
  const port = Number(ctx && ctx.options && ctx.options.port);
  return supportsAihServerProfile(p) && url && Number.isFinite(port) && port > 0 && isLoopbackUrl(url, port);
}

function writeSelfRelayAccountRejected(ctx, provider) {
  ctx.writeJson(ctx.res, 400, {
    ok: false,
    error: 'self_relay_account_not_allowed',
    detail: `local AIH server is built in; use aih ${provider} without adding a numeric account`
  });
}

function resolveAiHomeDir(ctx) {
  const explicit = String((ctx.deps && ctx.deps.aiHomeDir) || ctx.aiHomeDir || '').trim();
  return explicit;
}

function resolveCodexDesktopHookService(ctx) {
  const deps = ctx.deps || {};
  if (deps.codexDesktopHookService) return deps.codexDesktopHookService;
  return createCodexDesktopHookService({
    fs: ctx.fs,
    path,
    processObj: deps.processObj,
    spawnSync: deps.spawnSync,
    aiHomeDir: resolveAiHomeDir(ctx),
    hostHomeDir: String(deps.hostHomeDir || '').trim()
  });
}

function queueCodexDesktopAccountSync(changed) {
  return { ok: true, queued: changed === true };
}

function setCodexDesktopAccount(ctx, accountRef) {
  const service = resolveCodexDesktopHookService(ctx);
  const result = service.setDesktopAccountRef(accountRef);
  if (!result || !result.ok) return result || { ok: false, reason: 'unknown_error' };
  const reload = result.changed ? reloadCodexDesktopRuntime(service) : { ok: true, restarted: false };
  return {
    ...result,
    sync: queueCodexDesktopAccountSync(result.changed),
    reload
  };
}

function clearCodexDesktopAccount(ctx, accountRef) {
  const service = resolveCodexDesktopHookService(ctx);
  const result = service.clearDesktopAccountRef(accountRef);
  if (!result || !result.ok) return result || { ok: false, reason: 'unknown_error' };
  const reload = result.changed ? reloadCodexDesktopRuntime(service) : { ok: true, restarted: false };
  return {
    ...result,
    sync: queueCodexDesktopAccountSync(result.changed),
    reload
  };
}

function detectStoredApiKeyMode(ctx, provider, accountRef, stateRow) {
  if (stateRow && stateRow.apiKeyMode) return true;
  const { fs } = ctx;
  const aiHomeDir = resolveAiHomeDir(ctx);
  const dbCredentials = aiHomeDir
    ? (readAccountCredentials(fs, aiHomeDir, accountRef) || {})
    : {};

  if (provider === 'codex') {
    return Boolean(String(dbCredentials.OPENAI_API_KEY || '').trim());
  }
  if (provider === 'gemini') {
    return Boolean(String(dbCredentials.GEMINI_API_KEY || dbCredentials.GOOGLE_API_KEY || '').trim());
  }
  if (provider === 'agy') {
    return false;
  }
  if (provider === 'claude') {
    return Boolean(String(dbCredentials.ANTHROPIC_API_KEY || dbCredentials.ANTHROPIC_AUTH_TOKEN || '').trim());
  }
  return false;
}

function resolveAccountStatus(stateRow) {
  return String(stateRow && stateRow.status || 'up').trim().toLowerCase() === 'down' ? 'down' : 'up';
}

function readStateBoolean(stateRow, key) {
  if (!stateRow || typeof stateRow !== 'object') return false;
  const value = stateRow[key];
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return false;
  return Number(value) === 1;
}

function buildPersistedAccountState(ctx, provider, accountRef, stateRow, overrides = {}) {
  const liveStatus = ctx.checkStatus(provider, accountRef) || {};
  const configured = typeof overrides.configured === 'boolean'
    ? overrides.configured
    : (stateRow && Object.prototype.hasOwnProperty.call(stateRow, 'configured')
        ? readStateBoolean(stateRow, 'configured')
        : Boolean(liveStatus.configured));
  const apiKeyMode = typeof overrides.apiKeyMode === 'boolean'
    ? overrides.apiKeyMode
    : detectStoredApiKeyMode(ctx, provider, accountRef, stateRow);
  const authMode = overrides.authMode != null
    ? overrides.authMode
    : (stateRow && stateRow.authMode);
  const rawDisplayName = String(
    overrides.displayName != null
      ? overrides.displayName
      : (
          (stateRow && stateRow.displayName)
          || (liveStatus.accountName && liveStatus.accountName !== 'Unknown' ? liveStatus.accountName : '')
          || ''
        )
  ).trim();
  const displayName = apiKeyMode
    ? getApiKeyDisplayName(provider, overrides)
    : cleanOauthDisplayName(rawDisplayName);
  const remainingPct = overrides.remainingPct !== undefined
    ? overrides.remainingPct
    : (stateRow ? stateRow.remainingPct : null);
  const status = overrides.status != null
    ? String(overrides.status).trim().toLowerCase() === 'down' ? 'down' : 'up'
    : resolveEffectiveAccountStatus(resolveAccountStatus(stateRow));

  return {
    status,
    configured,
    apiKeyMode,
    authMode,
    remainingPct,
    displayName
  };
}

function accountExists(ctx, provider, accountRef) {
  const aiHomeDir = resolveAiHomeDir(ctx);
  const account = resolveAccountRef(ctx.fs, aiHomeDir, accountRef, { bestEffort: true });
  if (!account || account.provider !== provider) return false;
  return Boolean(readAccountCredentialRecord(ctx.fs, aiHomeDir, accountRef));
}

function inferReauthAuthMode(provider, stateRow) {
  const storedAuthMode = normalizeAuthMode(stateRow && stateRow.authMode);
  if (storedAuthMode && storedAuthMode !== 'api-key' && isSupportedAuthMode(provider, storedAuthMode)) {
    return storedAuthMode;
  }
  if (provider === 'codex') return 'oauth-browser';
  if (provider === 'claude') return 'oauth-browser';
  if (provider === 'gemini') return 'oauth-browser';
  if (provider === 'agy') return 'oauth-browser';
  return '';
}

function readBooleanStateValue(row, key) {
  if (!row || typeof row !== 'object') return false;
  const value = row[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true' || value.trim() === '1';
  return false;
}

function isPendingOauthStateRow(provider, stateRow) {
  if (!stateRow || typeof stateRow !== 'object') return false;
  const configured = readBooleanStateValue(stateRow, 'configured');
  const apiKeyMode = readBooleanStateValue(stateRow, 'apiKeyMode');
  const authMode = normalizeAuthMode(stateRow.authMode);
  return !configured && !apiKeyMode && authMode && authMode !== 'api-key' && isSupportedAuthMode(provider, authMode);
}

function buildCallbackErrorMessage(code) {
  if (code === 'oauth_redirect_not_ready') return '授权链接尚未准备好，请稍等日志输出后再提交回调。';
  if (code === 'invalid_callback_redirect') return '回调地址不属于当前授权任务，请确认使用的是本次生成的授权链接。';
  if (code === 'invalid_callback_state') return '回调 state 与当前授权任务不一致，请确认粘贴的是本次授权的回调地址。';
  if (code === 'job_not_running') return '授权任务已经结束，请重新发起登录。';
  if (code === 'callback_not_supported') return '当前授权方式不需要提交浏览器回调。';
  if (code === 'callback_forward_failed') return '回调转发失败，请确认授权任务仍在运行。';
  if (code === 'token_exchange_failed') return '服务器换取 Codex token 失败，请重新发起授权。';
  if (code === 'token_exchange_missing_tokens') return '服务器未收到完整 Codex token，请重新发起授权。';
  if (code === 'invalid_authorization_code') return '授权码格式不正确，请粘贴 Google 授权页返回的完整授权码。';
  if (code === 'authorization_code_forward_unavailable') return '授权码无法写回原生 CLI，请重新发起登录。';
  if (code === 'oauth_artifact_verification_failed') return 'OAuth 文件写入后本地校验失败，请查看授权日志。';
  if (code === 'oauth_completion_verification_failed') return 'OAuth 写入后账号状态识别失败，请查看授权日志。';
  if (code === 'oauth_provider_error') return '授权服务返回错误，请重新发起登录。';
  return '回调地址无效。';
}

async function handleAddAccountRequest(ctx) {
  const {
    fs,
    deps,
    state,
    readRequestBody,
    accountStateService,
    getAuthJobManager,
    cleanupAuthJobArtifacts,
    writeJson
  } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload || !payload.provider) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const provider = String(payload.provider || '').trim().toLowerCase();
  const defaultAuthMode = (payload.config && payload.config.apiKey) ? 'api-key' : getDefaultAuthMode(provider);
  const authMode = normalizeAuthMode(payload.authMode || defaultAuthMode);
  const config = payload.config || {};
  const replaceExisting = Boolean(payload.replaceExisting);
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!authMode) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_auth_mode' });
    return true;
  }
  if (!isSupportedAuthMode(provider, authMode)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_auth_mode' });
    return true;
  }
  try {
    if (authMode === 'api-key' || authMode === 'auth-token') {
      if (isSelfRelayBaseUrl(provider, config.baseUrl, ctx)) {
        writeSelfRelayAccountRejected(ctx, provider);
        return true;
      }
      const configuredAccount = configureApiKeyAccount({
        fs,
        provider,
        aiHomeDir: resolveAiHomeDir(ctx),
        config: provider === 'claude'
          ? { ...config, credentialType: authMode }
          : config,
        accountArtifactHooks: ctx.deps && ctx.deps.accountArtifactHooks
      });
      const accountRef = configuredAccount.accountRef;
      const baseState = {
        status: 'up',
        configured: true,
        apiKeyMode: true,
        authMode,
        displayName: getApiKeyDisplayName(provider, config)
      };
      if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
        accountStateService.syncAccountBaseState(accountRef, provider, baseState);
      }
      try {
        reloadRuntimeAccountsIfNeeded(ctx, provider);
      } catch (_error) {}
      const account = await refreshLiveAccountRecord(ctx, provider, accountRef, { skipUsageRefresh: true });
      writeJson(ctx.res, 200, { ok: true, provider, accountRef, authMode, status: 'configured', account });
      return true;
    }

    const manager = getAuthJobManager(deps, state);
    if (replaceExisting) {
      const activeJob = manager.getRunningJob(provider);
      if (activeJob) {
        manager.cancelJob(activeJob.id);
        cleanupAuthJobArtifacts(activeJob, deps, state);
      }
    }
    const started = typeof manager.startOauthJobWithInstallConfirmation === 'function'
      ? manager.startOauthJobWithInstallConfirmation(provider, authMode)
      : manager.startOauthJob(provider, authMode);
    writeJson(ctx.res, 200, buildPendingOauthResponse(started, authMode));
    return true;
  } catch (error) {
    const msg = String((error && error.message) || error || 'unknown');
    const code = String(error && error.code || '');
    const statusCode = (
      code === 'unsupported_provider'
      || code === 'unknown_cli'
      || code === 'missing_credential'
      || code === 'base_url_unsupported'
      || code === 'invalid_base_url'
      || code === 'invalid_auth_mode'
      || code === 'unsupported_auth_mode'
    ) ? 400 : (code === 'oauth_job_already_running' ? 409 : 500);
    const response = { ok: false, error: 'add_account_failed', code, message: msg };
    if (code === 'oauth_job_already_running') {
      const activeJob = getAuthJobManager(deps, state).getRunningJob(provider);
      response.jobId = String((error && error.jobId) || (activeJob && activeJob.id) || '');
      response.accountRef = String((activeJob && activeJob.accountRef) || '');
    }
    // Surface auto-install attempts so WebUI can show closed-loop progress.
    if (code === 'cli_not_found' && error && Array.isArray(error.installAttempts)) {
      response.installAttempts = error.installAttempts.map((item) => ({
        id: String(item && item.id || ''),
        label: String(item && item.label || ''),
        ok: Boolean(item && item.ok),
        error: String(item && item.error || '').slice(0, 500)
      }));
    }
    writeJson(ctx.res, statusCode, response);
    return true;
  }
}

async function handleReauthAccountRequest(ctx) {
  const {
    pathname,
    accountStateIndex,
    getAuthJobManager,
    deps,
    state,
    writeJson
  } = ctx;

  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/reauth$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  if (detectStoredApiKeyMode(ctx, provider, accountRef, stateRow)) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'reauth_unsupported',
      code: 'api_key_reauth_unsupported',
      message: 'API Key 账号不支持重新认证，请直接更新密钥。'
    });
    return true;
  }

  let authMode = inferReauthAuthMode(provider, stateRow);
  if (!authMode) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'reauth_unsupported',
      code: 'unsupported_auth_mode',
      message: '当前账号无法推断认证方式，请删除后重新添加。'
    });
    return true;
  }
  if (hasActiveNativeAccountRun(ctx, provider, accountRef)) {
    writeJson(ctx.res, 409, {
      ok: false,
      error: 'account_runtime_active',
      message: '请先停止该账号正在运行的会话，再删除账号。'
    });
    return true;
  }
  if (provider === 'agy' && !(await agyWarmPool.evict(accountRef))) {
    writeJson(ctx.res, 409, {
      ok: false,
      error: 'account_runtime_active',
      message: 'Antigravity 后台进程尚未退出，请稍后重试。'
    });
    return true;
  }
  try {
    const started = getAuthJobManager(deps, state).startOauthJob(provider, authMode, { accountRef });
    writeJson(ctx.res, 200, buildPendingOauthResponse(started, authMode));
    return true;
  } catch (error) {
    const msg = String((error && error.message) || error || 'unknown');
    const code = String(error && error.code || '');
    const statusCode = code === 'oauth_job_already_running' ? 409 : 500;
    const response = { ok: false, error: 'reauth_account_failed', code, message: msg };
    if (code === 'oauth_job_already_running') {
      const activeJob = getAuthJobManager(deps, state).getRunningJob(provider);
      response.jobId = String((error && error.jobId) || (activeJob && activeJob.id) || '');
      response.accountRef = String((activeJob && activeJob.accountRef) || '');
    }
    writeJson(ctx.res, statusCode, response);
    return true;
  }
}

async function handleRefreshAccountUsageRequest(ctx) {
  const {
    pathname,
    accountStateIndex,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/refresh-usage$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  if (detectStoredApiKeyMode(ctx, provider, accountRef, stateRow)) {
    enqueueAuthInvalidReconcileIfNeeded(ctx, provider, accountRef, stateRow);
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'refresh_usage_unsupported',
      code: 'api_key_usage_refresh_unsupported',
      message: 'API Key 账号不支持额度刷新。'
    });
    return true;
  }

  try {
    const started = startAccountRefreshJob(ctx, provider, accountRef);
    writeJson(ctx.res, 202, {
      ok: true,
      accepted: true,
      alreadyRunning: started.alreadyRunning,
      job: serializeAccountRefreshJob(started.job)
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'refresh_usage_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

function enqueueAuthInvalidReconcileIfNeeded(ctx, provider, accountRef, stateRow) {
  if (provider !== 'codex') return false;
  const runtimeStatus = pickAuthInvalidRuntimeStatus(
    deriveRuntimeStatus(stateRow || {}),
    deriveAccountRuntimeStatus(findRuntimeAccount(ctx, provider, accountRef))
  );
  if (!runtimeStatus || runtimeStatus.status !== 'auth_invalid') return false;
  const reason = String(runtimeStatus.reason || '').trim();
  if (!reason.toLowerCase().includes('auth_invalid_reauth_required')) return false;
  if (!ctx.codexAuthInvalidReconciler || typeof ctx.codexAuthInvalidReconciler.enqueueAuthInvalidReauthRequired !== 'function') {
    return false;
  }
  return ctx.codexAuthInvalidReconciler.enqueueAuthInvalidReauthRequired(provider, accountRef, reason);
}

function findRuntimeAccount(ctx, provider, accountRef) {
  const accountsByProvider = ctx && ctx.state && ctx.state.accounts && ctx.state.accounts[provider];
  const accounts = Array.isArray(accountsByProvider) ? accountsByProvider : [];
  return accounts.find((account) => (
    String(account && account.accountRef || '') === String(accountRef)
  )) || null;
}

function pickAuthInvalidRuntimeStatus(...statuses) {
  return statuses.find((status) => status && status.status === 'auth_invalid') || statuses[0] || null;
}

function pickBlockingStatusValue(allowedStatus, ...values) {
  const normalized = values
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return normalized.find((value) => value !== allowedStatus) || normalized[0] || '';
}

function makeAccountRefreshJobId(provider, accountRef) {
  return [
    'acct-refresh',
    String(provider || '').trim().toLowerCase(),
    String(accountRef || '').trim(),
    Date.now().toString(36),
    crypto.randomBytes(4).toString('hex')
  ].filter(Boolean).join('-');
}

function isAccountRefreshJobActive(job) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function pruneAccountRefreshJobs() {
  const now = Date.now();
  for (const [jobId, job] of accountRefreshJobs.entries()) {
    if (!isAccountRefreshJobActive(job) && now - Number(job.updatedAt || 0) > ACCOUNT_REFRESH_JOB_RETENTION_MS) {
      accountRefreshJobs.delete(jobId);
    }
  }

  const removable = Array.from(accountRefreshJobs.values())
    .filter((job) => !isAccountRefreshJobActive(job))
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
  while (accountRefreshJobs.size > ACCOUNT_REFRESH_JOB_MAX && removable.length > 0) {
    const job = removable.shift();
    if (job && job.id) accountRefreshJobs.delete(job.id);
  }
}

function findActiveAccountRefreshJob(provider, accountRef) {
  pruneAccountRefreshJobs();
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedAccountRef = String(accountRef || '').trim();
  return Array.from(accountRefreshJobs.values()).find((job) => (
    isAccountRefreshJobActive(job)
    && job.provider === normalizedProvider
    && job.accountRef === normalizedAccountRef
  )) || null;
}

function serializeAccountRefreshJob(job) {
  if (!job) return null;
  return {
    id: String(job.id || ''),
    provider: String(job.provider || ''),
    accountRef: String(job.accountRef || ''),
    status: String(job.status || 'queued'),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null,
    error: String(job.error || '')
  };
}

function emitAccountRefreshJobEvent(ctx, job) {
  emitAccountsLiveEvent(ctx, {
    type: 'account-refresh-job',
    job: serializeAccountRefreshJob(job)
  });
}

function startAccountRefreshJob(ctx, provider, accountRef) {
  const active = findActiveAccountRefreshJob(provider, accountRef);
  if (active) {
    emitAccountRefreshJobEvent(ctx, active);
    return { job: active, alreadyRunning: true };
  }

  const now = Date.now();
  const job = {
    id: makeAccountRefreshJobId(provider, accountRef),
    provider: String(provider || '').trim().toLowerCase(),
    accountRef: String(accountRef || '').trim(),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    finishedAt: 0,
    error: ''
  };
  accountRefreshJobs.set(job.id, job);
  emitAccountRefreshJobEvent(ctx, job);

  const run = async () => {
    job.status = 'running';
    job.updatedAt = Date.now();
    emitAccountRefreshJobEvent(ctx, job);
    try {
      await refreshLiveAccountRecord(ctx, job.provider, job.accountRef);
      job.status = 'succeeded';
      job.updatedAt = Date.now();
      job.finishedAt = job.updatedAt;
      emitAccountRefreshJobEvent(ctx, job);
    } catch (error) {
      job.status = 'failed';
      job.error = String((error && error.message) || error || 'unknown').slice(0, 500);
      job.updatedAt = Date.now();
      job.finishedAt = job.updatedAt;
      emitAccountRefreshJobEvent(ctx, job);
    }
  };

  const timer = setTimeout(() => {
    run().catch(() => {});
  }, 0);
  if (typeof timer.unref === 'function') timer.unref();

  return { job, alreadyRunning: false };
}

async function handleUpdateAccountStatusRequest(ctx) {
  const {
    pathname,
    accountStateIndex,
    accountStateService,
    readRequestBody,
    loadServerRuntimeAccounts,
    applyReloadState,
    state,
    fs,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/status$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const nextStatus = String(payload && payload.status || '').trim().toLowerCase();
  if (nextStatus !== 'up' && nextStatus !== 'down') {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_status' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  let updated = false;
  if (accountStateService && typeof accountStateService.setOperationalStatus === 'function') {
    const nextState = buildPersistedAccountState(ctx, provider, accountRef, stateRow, { status: nextStatus });
    updated = accountStateService.setOperationalStatus(accountRef, provider, nextStatus, nextState);
  }
  if (!updated) {
    writeJson(ctx.res, 500, { ok: false, error: 'update_status_failed' });
    return true;
  }

  try {
    reloadRuntimeAccountsIfNeeded(ctx, provider);
  } catch (_error) {}

  const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  writeJson(ctx.res, 200, { ok: true, account });
  return true;
}

async function handleUpdateAccountRequest(ctx) {
  const {
    pathname,
    accountStateIndex,
    accountStateService,
    readRequestBody,
    loadServerRuntimeAccounts,
    applyReloadState,
    state,
    fs,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/update$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  if (!detectStoredApiKeyMode(ctx, provider, accountRef, stateRow)) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'update_account_unsupported',
      code: 'oauth_config_edit_unsupported',
      message: 'OAuth 账号不支持编辑 API Key 配置，请使用重新登录。'
    });
    return true;
  }

  const apiKey = String(payload && payload.apiKey || '').trim();
  const baseUrl = String(payload && payload.baseUrl || '').trim();
  const requestedClaudeCredentialType = provider === 'claude'
    ? getClaudeCredentialType({
        credentialType: payload && (payload.credentialType || payload.authType || payload.authMode)
      })
    : '';

  // Validate URL if provided
  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch (_error) {
      writeJson(ctx.res, 400, { ok: false, error: 'invalid_base_url' });
      return true;
    }
  }
  if (isSelfRelayBaseUrl(provider, baseUrl, ctx)) {
    writeSelfRelayAccountRejected(ctx, provider);
    return true;
  }

  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!aiHomeDir) {
    writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
    return;
  }
  const credentialEnv = readAccountCredentials(fs, aiHomeDir, accountRef) || {};
  const effectiveBaseUrl = payload && 'baseUrl' in payload
    ? baseUrl
    : (
        provider === 'codex'
          ? String(credentialEnv.OPENAI_BASE_URL || '').trim()
          : provider === 'claude'
          ? String(credentialEnv.ANTHROPIC_BASE_URL || '').trim()
          : provider === 'agy'
          ? String(credentialEnv.AGY_BASE_URL || '').trim()
          : provider === 'gemini'
          ? String(credentialEnv.GEMINI_BASE_URL || '').trim()
          : ''
      );
  if (isSelfRelayBaseUrl(provider, effectiveBaseUrl, ctx)) {
    writeSelfRelayAccountRejected(ctx, provider);
    return true;
  }

  const accountArtifactHooks = ctx.deps && ctx.deps.accountArtifactHooks;
  const authSnapshotBefore = accountArtifactHooks
    && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
    ? accountArtifactHooks.snapshotAccountAuthArtifacts(provider, accountRef)
    : null;
  let updatedClaudeCredentialType = '';
  const nextCredentialEnv = { ...credentialEnv };

  if (provider === 'codex') {
    if (apiKey) nextCredentialEnv.OPENAI_API_KEY = apiKey;
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) nextCredentialEnv.OPENAI_BASE_URL = baseUrl;
      else delete nextCredentialEnv.OPENAI_BASE_URL;
    }

  } else if (provider === 'gemini') {
    if (apiKey) {
      nextCredentialEnv.GEMINI_API_KEY = apiKey;
      nextCredentialEnv.GOOGLE_API_KEY = apiKey;
    }
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) nextCredentialEnv.GEMINI_BASE_URL = baseUrl;
      else delete nextCredentialEnv.GEMINI_BASE_URL;
    }
  } else if (provider === 'agy') {
    if (apiKey) nextCredentialEnv.AGY_ACCESS_TOKEN = apiKey;
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) nextCredentialEnv.AGY_BASE_URL = baseUrl;
      else delete nextCredentialEnv.AGY_BASE_URL;
    }
  } else if (provider === 'claude') {
    const currentCredentialType = getClaudeCredentialType({ env: nextCredentialEnv }) || 'api-key';
    const nextCredentialType = requestedClaudeCredentialType || currentCredentialType;
    if (requestedClaudeCredentialType && requestedClaudeCredentialType !== currentCredentialType && !apiKey) {
      writeJson(ctx.res, 400, {
        ok: false,
        error: 'credential_required_for_auth_type_switch',
        message: '切换 Claude 认证方式时需要重新输入密钥。'
      });
      return true;
    }
    const credentialPatch = {
      credentialType: nextCredentialType,
      token: apiKey
    };
    if (payload && 'baseUrl' in payload) credentialPatch.baseUrl = baseUrl;
    const nextEnvJson = writeClaudeCredentialEnv(nextCredentialEnv, credentialPatch);
    Object.keys(nextCredentialEnv).forEach((key) => {
      delete nextCredentialEnv[key];
    });
    Object.assign(nextCredentialEnv, nextEnvJson);
    updatedClaudeCredentialType = getClaudeCredentialType({ env: nextCredentialEnv }) || nextCredentialType;
  }

  writeAccountCredentials(fs, aiHomeDir, accountRef, nextCredentialEnv);
  if (authSnapshotBefore && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged === 'function') {
    accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
      provider,
      accountRef,
      before: authSnapshotBefore,
      source: 'webui_account_updated',
      reason: 'credentials_updated'
    });
  }

  try {
    reloadRuntimeAccountsIfNeeded(ctx, provider);
  } catch (_error) {}

  const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  invalidateModelCacheForAccountRefs(ctx, [accountRef]);
  if (provider === 'claude' && updatedClaudeCredentialType && account) {
    account.apiKeyMode = true;
    account.authMode = updatedClaudeCredentialType;
    account.authType = updatedClaudeCredentialType;
    account.credentialType = updatedClaudeCredentialType;
    account.baseUrl = effectiveBaseUrl;
    if (!account.displayName || account.displayName === accountRef) {
      account.displayName = getApiKeyDisplayName(provider, { baseUrl: effectiveBaseUrl });
    }
  }

  if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
    const nextStateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState(accountRef)
      : null;
    const nextState = buildPersistedAccountState(ctx, provider, accountRef, nextStateRow, {
      configured: account && account.configured,
      apiKeyMode: account && account.apiKeyMode,
      authMode: account && account.authMode,
      displayName: account && account.displayName,
      baseUrl: account && account.baseUrl,
      remainingPct: account && account.remainingPct,
      status: account && account.status
    });
    accountStateService.syncAccountBaseState(accountRef, provider, nextState);
  }

  writeJson(ctx.res, 200, { ok: true, account });
  return true;
}

async function handleSetDefaultAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    accountStateIndex,
    getProfileDir,
    ensureSessionStoreLinks,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/set-default$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(accountRef)
    : null;
  const accountState = buildPersistedAccountState(ctx, provider, accountRef, stateRow);
  let liveAccount = null;
  try {
    liveAccount = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
  } catch (_error) {}
  const runtimeAccount = findRuntimeAccount(ctx, provider, accountRef);
  const runtimeStatus = deriveAccountRuntimeStatus(runtimeAccount);
  const eligibility = evaluateDefaultAccountEligibility({
    ...accountState,
    ...(liveAccount || {}),
    authPending: isPendingOauthStateRow(provider, stateRow),
    runtimeStatus: pickBlockingStatusValue(
      'healthy',
      liveAccount && liveAccount.runtimeStatus,
      runtimeAccount && runtimeAccount.runtimeStatus,
      runtimeStatus.status
    ),
    schedulableStatus: pickBlockingStatusValue(
      'schedulable',
      liveAccount && liveAccount.schedulableStatus,
      runtimeAccount && runtimeAccount.schedulableStatus,
      stateRow && stateRow.schedulableStatus
    )
  });
  if (!eligibility.allowed) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'set_default_unsupported',
      code: eligibility.code,
      message: eligibility.message
    });
    return true;
  }

  const syncGlobalConfigToHost = deps && deps.syncGlobalConfigToHost;
  if (typeof syncGlobalConfigToHost !== 'function') {
    writeJson(ctx.res, 500, { ok: false, error: 'set_default_unavailable' });
    return true;
  }

  try {
    if (typeof ensureSessionStoreLinks === 'function') {
      ensureSessionStoreLinks(provider, accountRef);
    }
    const syncResult = syncGlobalConfigToHost(provider, accountRef);
    if (!syncResult || !syncResult.ok) {
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'set_default_sync_failed',
        reason: syncResult && syncResult.reason ? syncResult.reason : 'unknown_error'
      });
      return true;
    }
    const aiHomeDir = resolveAiHomeDir(ctx);
    if (!aiHomeDir) {
      writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
      return true;
    }
    writeDefaultAccountRef(fs, aiHomeDir, provider, accountRef);
    const desktopRuntime = provider === 'codex'
      ? reloadCodexDesktopRuntime(resolveCodexDesktopHookService(ctx))
      : null;
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, { ok: true, provider, accountRef, account, ...(desktopRuntime ? { desktopRuntime } : {}) });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'set_default_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleClearDefaultAccountRequest(ctx) {
  const {
    pathname,
    fs,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/clear-default$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  try {
    const aiHomeDir = resolveAiHomeDir(ctx);
    if (!aiHomeDir) {
      writeJson(ctx.res, 500, { ok: false, error: 'ai_home_dir_unavailable' });
      return true;
    }
    clearDefaultAccountRef(fs, aiHomeDir, provider, accountRef);
    const desktopRuntime = provider === 'codex'
      ? reloadCodexDesktopRuntime(resolveCodexDesktopHookService(ctx))
      : null;
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, { ok: true, provider, accountRef, account, ...(desktopRuntime ? { desktopRuntime } : {}) });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'clear_default_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleSetMobileAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/set-mobile$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (provider !== 'codex') {
    writeJson(ctx.res, 400, { ok: false, error: 'mobile_account_unsupported' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const validation = validateCodexDesktopAccount(ctx.fs, {
    accountRef,
    aiHomeDir: resolveAiHomeDir(ctx),
    processObj: deps && deps.processObj
  });
  if (!validation.ok) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'mobile_account_invalid',
      code: validation.code,
      message: 'Codex App 账号需要可用的 ChatGPT OAuth 授权。'
    });
    return true;
  }

  try {
    const result = setCodexDesktopAccount(ctx, accountRef);
    if (!result || !result.ok) {
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'set_mobile_failed',
        reason: result && result.reason ? result.reason : 'unknown_error'
      });
      return true;
    }
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountRef,
      account,
      hotSyncQueued: Boolean(result.sync && result.sync.queued),
      desktopRuntime: result.reload
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'set_mobile_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleClearMobileAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/clear-mobile$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }

  const { provider, accountRef } = parsed;
  if (provider !== 'codex') {
    writeJson(ctx.res, 400, { ok: false, error: 'mobile_account_unsupported' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  try {
    const result = clearCodexDesktopAccount(ctx, accountRef);
    if (!result || !result.ok) {
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'clear_mobile_failed',
        reason: result && result.reason ? result.reason : 'unknown_error'
      });
      return true;
    }
    const account = await refreshLiveAccountRecord(ctx, provider, accountRef, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountRef,
      account,
      hotSyncQueued: Boolean(result.sync && result.sync.queued),
      desktopRuntime: result.reload
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'clear_mobile_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function evictAgyWarmWriterBeforeDelete(ctx, provider, accountRef) {
  if (provider !== 'agy') return;
  const warmPool = ctx.agyWarmPool || agyWarmPool;
  let evicted = false;
  try {
    evicted = await warmPool.evict(accountRef);
  } catch (cause) {
    const error = new Error('account_runtime_active:agy_warm_writer');
    error.code = 'account_runtime_active';
    error.cause = cause;
    throw error;
  }
  if (evicted) return;
  const error = new Error('account_runtime_active:agy_warm_writer');
  error.code = 'account_runtime_active';
  throw error;
}

function hasActiveNativeAccountRun(ctx, provider, accountRef) {
  const listRuns = typeof ctx.listNativeChatRuns === 'function'
    ? ctx.listNativeChatRuns
    : () => [];
  return listRuns().some((run) => (
    String(run && run.provider || '').trim() === provider
    && String(run && run.accountRef || '').trim() === accountRef
  ));
}

function assertNoActiveNativeRunBeforeDelete(ctx, provider, accountRef) {
  if (!hasActiveNativeAccountRun(ctx, provider, accountRef)) return;
  const error = new Error('account_runtime_active:native_session');
  error.code = 'account_runtime_active';
  throw error;
}

async function handleDeleteAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    accountStateService,
    writeJson
  } = ctx;
  const parsed = parseAccountRoute(pathname, /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)$/);
  if (!parsed) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  const { provider, accountRef } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountExists(ctx, provider, accountRef)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }
  try {
    assertNoActiveNativeRunBeforeDelete(ctx, provider, accountRef);
    await evictAgyWarmWriterBeforeDelete(ctx, provider, accountRef);
    const aiHomeDir = resolveAiHomeDir(ctx);
    const accountRemovalService = createAccountRemovalService({
      fs,
      aiHomeDir,
      path,
      processObj: deps && deps.processObj,
      hostHomeDir: deps && deps.hostHomeDir,
      ensureSessionStoreLinks: ctx.ensureSessionStoreLinks
        || (deps && deps.ensureSessionStoreLinks),
      accountStateService
    });
    const removal = accountRemovalService.deleteAccountByRef(provider, accountRef);
    if (!removal.deleted) {
      throw new Error('account_ref_delete_failed');
    }
    try {
      reloadRuntimeAccountsIfNeeded(ctx, provider);
    } catch (_error) {}
    removeLiveAccountRecord(ctx, provider, accountRef, 'manual_delete');
    writeJson(ctx.res, 200, { ok: true });
    return true;
  } catch (error) {
    const runtimeActive = error && error.code === 'account_runtime_active';
    writeJson(ctx.res, runtimeActive ? 409 : 500, {
      ok: false,
      error: runtimeActive ? 'account_runtime_active' : 'delete_account_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleExportAccountsRequest(ctx) {
  const { fs, aiHomeDir, url } = ctx;
  try {
    const requestedFormat = url && url.searchParams && url.searchParams.get('format');
    if (isRemovedWebExportFormat(requestedFormat)) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'unsupported_export_format' });
      return true;
    }
    const format = normalizeWebExportFormat(requestedFormat);

    const payload = buildWebExportPayload({
      fs,
      aiHomeDir,
      format
    });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${webExportFileName(format)}"`
    });
    ctx.res.end(`${JSON.stringify(payload, null, 2)}\n`);
    return true;
  } catch (_error) {
    ctx.writeJson(ctx.res, 500, { ok: false, error: 'export_failed' });
    return true;
  }
}

const REMOVED_WEB_ANTIGRAVITY_PLUGIN_EXPORT_FORMATS = new Set(['antigravity-plugin', 'antigravity-plugin-v3', 'plugin-v3']);

function normalizeWebExportFormatToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, '-');
}

function isRemovedWebExportFormat(value) {
  const normalized = normalizeWebExportFormatToken(value);
  return REMOVED_WEB_ANTIGRAVITY_PLUGIN_EXPORT_FORMATS.has(normalized);
}

function normalizeWebExportFormat(value) {
  const normalized = normalizeWebExportFormatToken(value);
  if (!normalized || normalized === 'sub2api') return 'sub2api';
  if (normalized === 'aih' || normalized === 'ai-home' || normalized === 'aihome') return 'sub2api';
  if (normalized === 'antigravity' || normalized === 'antigravity-manager') return 'antigravity';
  if (normalized === 'cliproxyapi' || normalized === 'cliproxy' || normalized === 'cpa') return 'cliproxyapi';
  return 'sub2api';
}

function webExportFileName(format) {
  if (format === 'antigravity') return 'antigravity-accounts.json';
  if (format === 'cliproxyapi') return 'cliproxyapi-data.json';
  return 'sub2api-data.json';
}

function buildWebExportPayload({
  fs,
  aiHomeDir,
  format
}) {
  if (format === 'antigravity') {
    return buildAntigravityManagerExportPayload({ fs, path, aiHomeDir, providers: ['agy'] });
  }
  if (format === 'cliproxyapi') {
    return createCliproxyapiExportService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir: ''
    }).buildCliproxyapiDataPayload({
      apiKeyProviders: ['codex', 'gemini', 'claude']
    });
  }
  return buildSub2ApiExportPayload({ fs, path, aiHomeDir });
}

function createImportSummary() {
  return {
    imported: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    invalid: 0,
    failed: 0,
    total: 0,
    providers: [],
    accounts: []
  };
}

function addImportedProvider(summary, provider) {
  if (!provider || summary.providers.includes(provider)) return;
  summary.providers.push(provider);
  summary.providers.sort();
}

function summarizeUnifiedImportResult(result) {
  const summary = createImportSummary();
  const sourceResults = Array.isArray(result && result.sourceResults) ? result.sourceResults : [];
  sourceResults.forEach((item) => {
    summary.imported += Number(item && item.imported || 0);
    summary.skipped += Number(item && item.duplicates || 0);
    summary.invalid += Number(item && item.invalid || 0);
    summary.failed += Number(item && item.failed || 0);
  });
  summary.total = summary.imported + summary.skipped + summary.invalid + summary.failed;
  const failedSources = Array.isArray(result && result.failedSources) ? result.failedSources : [];
  summary.failed += failedSources.length;
  const providers = Array.isArray(result && result.providers) ? result.providers : [];
  providers.forEach((provider) => addImportedProvider(summary, String(provider || '').trim()));
  return summary;
}

function safeUploadRelativePath(value, fallbackName = '') {
  const raw = String(value || fallbackName || '').trim().replace(/\\/g, '/');
  const withoutRoot = raw.replace(/^\/+/, '');
  const parts = withoutRoot
    .split('/')
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .filter((part) => part !== '.' && part !== '..');
  return parts.join('/') || String(fallbackName || 'upload.json');
}

function decodeBase64UploadContent(value) {
  const text = String(value || '');
  const normalized = text.includes(',') && /^data:/i.test(text) ? text.slice(text.indexOf(',') + 1) : text;
  return Buffer.from(normalized, 'base64');
}

function normalizeUploadedFiles(payload) {
  const source = Array.isArray(payload && payload.files)
    ? payload.files
    : (payload && (payload.file || payload.content) ? [payload] : []);
  return source
    .map((item, index) => {
      const file = item && typeof item === 'object' ? item : {};
      const name = safeUploadRelativePath(file.relativePath || file.webkitRelativePath || file.name, `upload-${index + 1}.json`);
      const base64 = file.contentBase64 || file.base64 || (file.encoding === 'base64' ? file.content : '');
      const content = base64 ? decodeBase64UploadContent(base64) : Buffer.from(String(file.content || ''), 'utf8');
      return {
        name,
        content
      };
    })
    .filter((item) => item.name && item.content.length > 0);
}

function writeUploadedFilesToTempDir({ fs, files }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-import-'));
  files.forEach((file) => {
    const targetPath = path.join(root, safeUploadRelativePath(file.name));
    ensureDirSync(fs, path.dirname(targetPath));
    fs.writeFileSync(targetPath, file.content);
  });
  return root;
}

function summarizeRecordImportResult(result) {
  const summary = createImportSummary();
  summary.total = Number(result && result.total || 0);
  summary.imported = Number(result && result.imported || 0);
  summary.created = Number(result && result.imported || 0);
  summary.skipped = Number(result && result.duplicates || 0);
  summary.invalid = Number(result && result.invalid || 0);
  summary.failed = Number(result && result.failed || 0);
  const accounts = Array.isArray(result && result.accounts) ? result.accounts : [];
  summary.accounts = accounts.map((account) => ({
    provider: account.provider,
    accountRef: String(account.accountRef || ''),
    status: account.status,
    reason: account.reason,
    authMode: account.authMode
  }));
  accounts.forEach((account) => addImportedProvider(summary, String(account.provider || '').trim()));
  return summary;
}

function isImportJobActive(job) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function pruneAccountImportJobs(now = Date.now()) {
  for (const [jobId, job] of accountImportJobs.entries()) {
    if (isImportJobActive(job)) continue;
    const finishedAt = Number(job.finishedAt || job.updatedAt || job.createdAt || 0);
    if (finishedAt > 0 && now - finishedAt > ACCOUNT_IMPORT_JOB_RETENTION_MS) {
      accountImportJobs.delete(jobId);
    }
  }
  if (accountImportJobs.size <= ACCOUNT_IMPORT_JOB_MAX) return;
  const removable = Array.from(accountImportJobs.values())
    .filter((job) => !isImportJobActive(job))
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));
  while (accountImportJobs.size > ACCOUNT_IMPORT_JOB_MAX && removable.length > 0) {
    const job = removable.shift();
    if (job && job.id) accountImportJobs.delete(job.id);
  }
}

function findActiveAccountImportJob() {
  pruneAccountImportJobs();
  return Array.from(accountImportJobs.values()).find(isImportJobActive) || null;
}

function appendAccountImportJobLog(job, line) {
  if (!job) return;
  const text = String(line || '').trim();
  if (!text) return;
  const nextLogs = `${String(job.logs || '')}${text}\n`;
  job.logs = nextLogs.length > 20000 ? nextLogs.slice(nextLogs.length - 20000) : nextLogs;
  job.updatedAt = Date.now();
}

function serializeAccountImportJob(job) {
  if (!job) return null;
  return {
    id: String(job.id || ''),
    status: String(job.status || 'running'),
    mode: String(job.mode || ''),
    createdAt: Number(job.createdAt || 0),
    updatedAt: Number(job.updatedAt || 0),
    finishedAt: Number(job.finishedAt || 0) || null,
    summary: job.summary || createImportSummary(),
    result: job.result || null,
    error: String(job.error || ''),
    logs: String(job.logs || ''),
    progress: job.progress || null
  };
}

function emitAccountImportJobEvent(ctx, job) {
  if (typeof emitAccountsLiveEvent !== 'function') return;
  emitAccountsLiveEvent(ctx, {
    type: 'import-job',
    job: serializeAccountImportJob(job)
  });
}

function emitAccountImportJobProgressEvent(ctx, job) {
  const now = Date.now();
  const progress = job && job.progress;
  const current = Number(progress && progress.current || 0);
  const total = Number(progress && progress.total || 0);
  const complete = total > 0 && current >= total;
  if (!complete && now - Number(job.lastProgressEventAt || 0) < ACCOUNT_IMPORT_PROGRESS_EVENT_MIN_MS) return;
  job.lastProgressEventAt = now;
  emitAccountImportJobEvent(ctx, job);
}

function buildImportJobContext(ctx) {
  return {
    fs: ctx.fs,
    deps: ctx.deps,
    state: ctx.state,
    accountStateIndex: ctx.accountStateIndex,
    getProfileDir: ctx.getProfileDir,
    loadServerRuntimeAccounts: ctx.loadServerRuntimeAccounts,
    applyReloadState: ctx.applyReloadState,
    checkStatus: ctx.checkStatus,
    options: ctx.options || {}
  };
}

function buildImportJobResponse(job) {
  return {
    ok: true,
    status: job.status,
    jobId: job.id,
    imported: Number(job.summary && job.summary.imported || 0),
    summary: job.summary,
    result: job.result,
    job: serializeAccountImportJob(job)
  };
}

function createImportJobProgressUpdater(ctx, job) {
  return (current, total, label) => {
    const safeTotal = Math.max(1, Number(total) || 1);
    const safeCurrent = Math.max(0, Math.min(safeTotal, Number(current) || 0));
    job.progress = {
      current: safeCurrent,
      total: safeTotal,
      percent: Math.round((safeCurrent / safeTotal) * 100),
      label: String(label || '').trim()
    };
    job.updatedAt = Date.now();
    emitAccountImportJobProgressEvent(ctx, job);
  };
}

async function executeAccountImportPayload(ctx, payload, job) {
  const {
    fs,
    deps,
    accountStateIndex,
    getProfileDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus
  } = ctx;
  const aiHomeDir = deps.aiHomeDir || '';
  const runtimeImportTools = buildRuntimeImportTools({
    fs,
    aiHomeDir,
    hostHomeDir: deps.hostHomeDir,
    accountArtifactHooks: deps.accountArtifactHooks
  });
  const onProgress = createImportJobProgressUpdater(ctx, job);
  let summary = createImportSummary();
  let viaCliSources = null;

  if (payload.mode === 'cliproxyapi') {
    const result = await runtimeImportTools.runUnifiedImport(['cliproxyapi'], {
      provider: String(payload.provider || '').trim().toLowerCase() || '',
      log: (line) => appendAccountImportJobLog(job, line),
      error: (line) => appendAccountImportJobLog(job, line),
      renderStageProgress: onProgress
    });
    summary = summarizeUnifiedImportResult(result);
    viaCliSources = result;
  } else if (payload.mode === 'upload') {
    const uploaded = await importUploadedAccountFiles({
      fs,
      aiHomeDir,
      payload,
      runtimeImportTools,
      accountArtifactHooks: deps.accountArtifactHooks,
      onProgress
    });
    summary = uploaded.summary;
    viaCliSources = uploaded.result;
  } else if (payload.mode === 'path') {
    const importPath = String(payload.path || '').trim();
    if (!importPath) {
      const error = new Error('missing_import_path');
      error.statusCode = 400;
      throw error;
    }
    const result = await runtimeImportTools.runUnifiedImport([importPath], {
      provider: String(payload.provider || '').trim().toLowerCase() || '',
      log: (line) => appendAccountImportJobLog(job, line),
      error: (line) => appendAccountImportJobLog(job, line),
      renderStageProgress: onProgress
    });
    summary = summarizeUnifiedImportResult(result);
    viaCliSources = result;
  } else {
    const records = extractImportRecords(payload);
    if (!records) {
      const error = new Error('unsupported_import_payload');
      error.statusCode = 400;
      throw error;
    }
    const result = importStandardRecordsForWeb({
      fs,
      aiHomeDir,
      records,
      accountArtifactHooks: deps.accountArtifactHooks
    });
    summary = summarizeRecordImportResult(result);
    viaCliSources = {
      sourceResults: [{
        type: 'json',
        source: 'manual-json',
        imported: summary.imported,
        duplicates: summary.skipped,
        invalid: summary.invalid,
        failed: summary.failed,
        providers: summary.providers
      }],
      failedSources: []
    };
    onProgress(1, 1, `records ${records.length}`);
  }

  try {
    reloadRuntimeAccountsIfNeeded({
      ...ctx,
      fs,
      deps,
      accountStateIndex,
      getProfileDir,
      loadServerRuntimeAccounts,
      applyReloadState,
      checkStatus
    });
  } catch (_error) {}

  return {
    ok: true,
    imported: summary.imported,
    summary,
    result: viaCliSources
  };
}

function startAccountImportJob(ctx, payload) {
  pruneAccountImportJobs();
  const now = Date.now();
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    mode: String(payload && payload.mode || (payload && payload.content ? 'text' : 'json')),
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    summary: createImportSummary(),
    result: null,
    error: '',
    logs: '',
    progress: null,
    lastProgressEventAt: 0
  };
  accountImportJobs.set(job.id, job);
  const jobCtx = buildImportJobContext(ctx);
  emitAccountImportJobEvent(jobCtx, job);

  Promise.resolve()
    .then(async () => {
      job.status = 'running';
      job.updatedAt = Date.now();
      appendAccountImportJobLog(job, '导入任务已开始。');
      emitAccountImportJobEvent(jobCtx, job);
      const response = await executeAccountImportPayload(jobCtx, payload, job);
      job.summary = response.summary || createImportSummary();
      job.result = response.result || null;
      job.status = 'succeeded';
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      appendAccountImportJobLog(job, `导入完成：写入 ${Number(job.summary.imported || 0)}，失败 ${Number(job.summary.failed || 0) + Number(job.summary.invalid || 0)}。`);
      emitAccountImportJobEvent(jobCtx, job);
    })
    .catch((error) => {
      job.status = 'failed';
      job.error = String((error && error.message) || error || 'import_failed');
      job.finishedAt = Date.now();
      job.updatedAt = job.finishedAt;
      appendAccountImportJobLog(job, `导入失败：${job.error}`);
      emitAccountImportJobEvent(jobCtx, job);
    });

  return job;
}

async function handleGetImportJobRequest(ctx) {
  const { pathname, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/import\/jobs\/([^/]+)$/);
  const job = matches ? accountImportJobs.get(matches[1]) : null;
  if (!job) {
    writeJson(ctx.res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  writeJson(ctx.res, 200, { ok: true, job: serializeAccountImportJob(job) });
  return true;
}

function importStandardRecordsForWeb({ fs, aiHomeDir, records, accountArtifactHooks }) {
  return importStandardAccountRecords({
    fs,
    path,
    aiHomeDir,
    records,
    accountArtifactHooks,
    source: 'webui_account_import'
  });
}

async function importUploadedAccountFiles({ fs, aiHomeDir, payload, runtimeImportTools, accountArtifactHooks, onProgress }) {
  const files = normalizeUploadedFiles(payload);
  if (files.length === 0) {
    const error = new Error('missing_upload_files');
    error.statusCode = 400;
    throw error;
  }

  const jsonRecords = [];
  const archiveOrLayoutFiles = [];
  const isFolderUpload = String(payload.uploadKind || '').trim().toLowerCase() === 'folder';
  files.forEach((file) => {
    if (!isFolderUpload && /\.(json|jsonl|txt)$/i.test(file.name)) {
      const records = extractImportRecords({ content: file.content.toString('utf8') });
      if (records) jsonRecords.push(...records);
      return;
    }
    archiveOrLayoutFiles.push(file);
  });

  const sourceResults = [];
  const failedSources = [];
  let summary = createImportSummary();
  if (jsonRecords.length > 0) {
    const result = importStandardRecordsForWeb({
      fs,
      aiHomeDir,
      records: jsonRecords,
      accountArtifactHooks
    });
    summary = summarizeRecordImportResult(result);
    sourceResults.push({
      type: 'json',
      source: 'uploaded-json',
      imported: summary.imported,
      duplicates: summary.skipped,
      invalid: summary.invalid,
      failed: summary.failed,
      providers: summary.providers
    });
  }

  if (archiveOrLayoutFiles.length > 0) {
    const tempDir = writeUploadedFilesToTempDir({ fs, files: archiveOrLayoutFiles });
    try {
      const sources = archiveOrLayoutFiles
        .filter((file) => /\.zip$/i.test(file.name))
        .map((file) => path.join(tempDir, safeUploadRelativePath(file.name)));
      if (sources.length === 0) sources.push(tempDir);
      const result = await runtimeImportTools.runUnifiedImport(sources, {
        provider: String(payload.provider || '').trim().toLowerCase() || '',
        log: () => {},
        error: () => {},
        renderStageProgress: onProgress
      });
      const cliSummary = summarizeUnifiedImportResult(result);
      summary.imported += cliSummary.imported;
      summary.created += cliSummary.imported;
      summary.skipped += cliSummary.skipped;
      summary.invalid += cliSummary.invalid;
      summary.failed += cliSummary.failed;
      summary.total += cliSummary.total;
      cliSummary.providers.forEach((provider) => addImportedProvider(summary, provider));
      sourceResults.push(...(Array.isArray(result.sourceResults) ? result.sourceResults : []));
      failedSources.push(...(Array.isArray(result.failedSources) ? result.failedSources : []));
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_error) {}
    }
  }

  return {
    summary,
    result: {
      sourceResults,
      failedSources
    }
  };
}

async function handleImportAccountsRequest(ctx) {
  const {
    readRequestBody,
    writeJson
  } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: WEBUI_ACCOUNT_IMPORT_MAX_BYTES })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_import_data' });
    return true;
  }
  const activeJob = findActiveAccountImportJob();
  if (activeJob) {
    writeJson(ctx.res, 409, {
      ok: false,
      error: 'import_job_already_running',
      jobId: activeJob.id,
      job: serializeAccountImportJob(activeJob)
    });
    return true;
  }
  const job = startAccountImportJob(ctx, payload);
  writeJson(ctx.res, 202, buildImportJobResponse(job));
  return true;
}

module.exports = {
  handleListAccountsRequest,
  handleGetImportJobRequest,
  handleGetAddJobRequest,
  handleCancelAddJobRequest,
  handleConfirmAddJobInstallRequest,
  handleCompleteAddJobCallbackRequest,
  handleAddAccountRequest,
  handleRefreshAccountUsageRequest,
  handleUpdateAccountStatusRequest,
  handleUpdateAccountRequest,
  handleSetDefaultAccountRequest,
  handleClearDefaultAccountRequest,
  handleSetMobileAccountRequest,
  handleClearMobileAccountRequest,
  handleReauthAccountRequest,
  handleDeleteAccountRequest,
  handleExportAccountsRequest,
  handleImportAccountsRequest,
  inferReauthAuthMode
};
