'use strict';

const path = require('node:path');
const {
  readAccountStatusFile,
  writeAccountStatusFile,
  resolveEffectiveAccountStatus
} = require('../account/status-file');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { ensureDirSync } = require('./fs-compat');
const {
  configureApiKeyAccount,
  getDefaultAuthMode,
  getNextAccountIdFromIds,
  isSupportedAuthMode,
  normalizeAuthMode,
  normalizeExistingAccountId
} = require('./web-account-auth');
const {
  normalizeCodexAuthPayload,
  readAccountExportRecord,
  extractImportRecords,
  inferImportProvider,
  buildCodexAuthIdentityKey,
  buildRuntimeImportTools
} = require('./web-account-transfer');
const {
  handleListAccountsFastRequest,
  refreshLiveAccountRecord
} = require('./webui-account-live');
const { withAccountQueryListFns } = require('./account-load-args');
const {
  cleanOauthDisplayName,
  getApiKeyDisplayName
} = require('./account-display-identity');
const { createCodexDesktopHookService } = require('./codex-desktop-hook');
const { validateCodexDesktopAccount } = require('./codex-desktop-account');
const { isLoopbackUrl } = require('./http-utils');
const { supportsAihServerProfile } = require('../account/self-relay-account');

async function handleListAccountsRequest(ctx) {
  return handleListAccountsFastRequest(ctx);
}

async function handleGetAddJobRequest(ctx) {
  const { pathname, getAuthJobManager, deps, state, writeJson } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/add\/jobs\/([^/]+)$/);
  const job = getAuthJobManager(deps, state).getJob(matches[1]);
  if (!job) {
    writeJson(ctx.res, 404, { ok: false, error: 'job_not_found' });
    return true;
  }
  writeJson(ctx.res, 200, { ok: true, job });
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
    job: {
      id: result.job.id,
      provider: result.job.provider,
      accountId: result.job.accountId,
      authMode: result.job.authMode,
      status: result.job.status,
      error: result.job.error,
      updatedAt: result.job.updatedAt
    }
  });
  return true;
}

async function handleCompleteAddJobCallbackRequest(ctx) {
  const { pathname, getAuthJobManager, deps, state, readRequestBody, writeJson } = ctx;
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
    writeJson(ctx.res, 200, { ok: true, job: result.job });
    return true;
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
    job: result.job || null
  });
  return true;
}

function buildPendingOauthResponse(started, authMode) {
  return {
    ok: true,
    provider: started.provider,
    accountId: started.accountId,
    authMode,
    status: 'pending',
    jobId: started.jobId,
    expiresAt: Number.isFinite(started.expiresAt) ? started.expiresAt : null,
    pollIntervalMs: Number.isFinite(started.pollIntervalMs) ? started.pollIntervalMs : null,
    authorizationUrl: started.authorizationUrl || '',
    redirectUri: started.redirectUri || '',
    callbackCaptureStatus: started.callbackCaptureStatus || '',
    callbackListeningUrl: started.callbackListeningUrl || '',
    callbackCaptureError: started.callbackCaptureError || ''
  };
}

function buildPendingOauthState(provider, accountId, authMode, displayName = '') {
  return {
    status: 'down',
    configured: false,
    apiKeyMode: false,
    authMode,
    displayName: cleanOauthDisplayName(displayName)
  };
}

function parseAccountRoute(pathname, pattern) {
  const matches = String(pathname || '').match(pattern);
  if (!matches) return null;
  const provider = String(matches[1] || '').trim().toLowerCase();
  const accountId = normalizeExistingAccountId(matches[2]);
  if (!provider || !accountId) return null;
  return { provider, accountId };
}

function parseJsonFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
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

function resolveAiHomeDir(ctx, provider, accountId) {
  const explicit = String((ctx.deps && ctx.deps.aiHomeDir) || ctx.aiHomeDir || '').trim();
  if (explicit) return explicit;
  const profileDir = typeof ctx.getProfileDir === 'function' ? String(ctx.getProfileDir(provider, accountId) || '') : '';
  return profileDir ? path.dirname(path.dirname(path.dirname(profileDir))) : '';
}

function resolveProviderProfilesDir(ctx, provider, accountId) {
  const aiHomeDir = resolveAiHomeDir(ctx, provider, accountId);
  if (aiHomeDir) return path.join(aiHomeDir, 'profiles', provider);
  const profileDir = typeof ctx.getProfileDir === 'function' ? String(ctx.getProfileDir(provider, accountId) || '') : '';
  return profileDir ? path.dirname(profileDir) : '';
}

function detectStoredApiKeyMode(ctx, provider, accountId, stateRow) {
  if (stateRow && (stateRow.apiKeyMode || stateRow.api_key_mode)) return true;
  const { fs, getProfileDir, getToolConfigDir } = ctx;
  const profileDir = getProfileDir(provider, accountId);
  const configDir = getToolConfigDir(provider, accountId);
  const envJson = parseJsonFileSafe(fs, path.join(profileDir, '.aih_env.json')) || {};

  if (provider === 'codex') {
    if (String(envJson.OPENAI_API_KEY || '').trim()) return true;
    const authJson = parseJsonFileSafe(fs, path.join(configDir, 'auth.json')) || {};
    return Boolean(String(authJson.OPENAI_API_KEY || '').trim());
  }
  if (provider === 'gemini') {
    return Boolean(String(envJson.GEMINI_API_KEY || envJson.GOOGLE_API_KEY || '').trim());
  }
  if (provider === 'agy') {
    return false;
  }
  if (provider === 'claude') {
    return Boolean(String(envJson.ANTHROPIC_API_KEY || envJson.ANTHROPIC_AUTH_TOKEN || '').trim());
  }
  return false;
}

function resolveAccountStatus(stateRow) {
  return String(stateRow && stateRow.status || 'up').trim().toLowerCase() === 'down' ? 'down' : 'up';
}

function buildPersistedAccountState(ctx, provider, accountId, stateRow, overrides = {}) {
  const profileDir = ctx.getProfileDir(provider, accountId);
  const fileStatus = readAccountStatusFile(ctx.fs, profileDir);
  const liveStatus = ctx.checkStatus(provider, profileDir) || {};
  const configured = typeof overrides.configured === 'boolean'
    ? overrides.configured
    : Boolean(stateRow && typeof stateRow.configured === 'boolean' ? stateRow.configured : liveStatus.configured);
  const apiKeyMode = typeof overrides.apiKeyMode === 'boolean'
    ? overrides.apiKeyMode
    : detectStoredApiKeyMode(ctx, provider, accountId, stateRow);
  const authMode = overrides.authMode != null
    ? overrides.authMode
    : (stateRow && stateRow.auth_mode);
  const rawDisplayName = String(
    overrides.displayName != null
      ? overrides.displayName
      : (
          (stateRow && stateRow.display_name)
          || (liveStatus.accountName && liveStatus.accountName !== 'Unknown' ? liveStatus.accountName : '')
          || ''
        )
  ).trim();
  const displayName = apiKeyMode
    ? getApiKeyDisplayName(provider, overrides)
    : cleanOauthDisplayName(rawDisplayName);
  const remainingPct = overrides.remainingPct !== undefined
    ? overrides.remainingPct
    : (stateRow ? stateRow.remaining_pct : null);
  const status = overrides.status != null
    ? String(overrides.status).trim().toLowerCase() === 'down' ? 'down' : 'up'
    : resolveEffectiveAccountStatus(resolveAccountStatus(stateRow), fileStatus);

  return {
    status,
    configured,
    apiKeyMode,
    authMode,
    remainingPct,
    displayName
  };
}

function accountArtifactsExist(ctx, provider, accountId) {
  const { fs, getProfileDir, getToolConfigDir, getToolAccountIds, accountStateIndex } = ctx;
  const profileDir = getProfileDir(provider, accountId);
  const configDir = getToolConfigDir(provider, accountId);
  if (profileDir && fs.existsSync(profileDir)) return true;
  if (configDir && fs.existsSync(configDir)) return true;
  if (accountStateIndex && typeof accountStateIndex.getAccountState === 'function') {
    if (accountStateIndex.getAccountState(provider, accountId)) return true;
  }
  const accountIds = typeof getToolAccountIds === 'function' ? getToolAccountIds(provider) : [];
  return Array.isArray(accountIds) && accountIds.includes(accountId);
}

function inferReauthAuthMode(provider, stateRow) {
  const storedAuthMode = normalizeAuthMode(
    stateRow && (stateRow.authMode || stateRow.auth_mode)
  );
  if (storedAuthMode && storedAuthMode !== 'api-key' && isSupportedAuthMode(provider, storedAuthMode)) {
    return storedAuthMode;
  }
  if (provider === 'codex') return 'oauth-browser';
  if (provider === 'claude') return 'oauth-browser';
  if (provider === 'gemini') return 'oauth-browser';
  if (provider === 'agy') return 'oauth-browser';
  return '';
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
  if (code === 'token_exchange_unusable_refresh_token') return '服务器收到的 Codex refresh token 不可用于账号池，请重新发起授权。';
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
    accountStateIndex,
    accountStateService,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus,
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
    if (authMode === 'api-key') {
      if (isSelfRelayBaseUrl(provider, config.baseUrl, ctx)) {
        writeSelfRelayAccountRejected(ctx, provider);
        return true;
      }
      const accountId = getNextAccountIdFromIds(getToolAccountIds(provider));
      configureApiKeyAccount({
        fs,
        provider,
        accountId,
        config,
        getProfileDir,
        getToolConfigDir,
        accountArtifactHooks: ctx.deps && ctx.deps.accountArtifactHooks
      });
      const baseState = {
        status: 'up',
        configured: true,
        apiKeyMode: true,
        displayName: getApiKeyDisplayName(provider, config)
      };
      if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
        accountStateService.syncAccountBaseState(provider, accountId, baseState);
      }
      writeAccountStatusFile(fs, getProfileDir(provider, accountId), 'up');
      const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
        fs,
        accountStateIndex,
        getToolAccountIds,
        getToolConfigDir,
        getProfileDir,
        checkStatus,
        serverPort: ctx.options && ctx.options.port
      }, ctx));
      applyReloadState(state, runtimeAccounts);
      writeJson(ctx.res, 200, { ok: true, provider, accountId, authMode: 'api-key', status: 'configured' });
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
    const started = manager.startOauthJob(provider, authMode);
    const pendingStatus = readAccountStatusFile(fs, getProfileDir(provider, started.accountId)) || 'down';
    const pendingState = {
      ...buildPendingOauthState(provider, started.accountId, authMode),
      status: pendingStatus
    };
    if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
      accountStateService.syncAccountBaseState(provider, started.accountId, pendingState);
    }
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
      response.accountId = String((activeJob && activeJob.accountId) || '');
    }
    writeJson(ctx.res, statusCode, response);
    return true;
  }
}

async function handleReauthAccountRequest(ctx) {
  const {
    pathname,
    accountStateIndex,
    accountStateService,
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

  const { provider, accountId } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(provider, accountId)
    : null;
  if (!accountArtifactsExist(ctx, provider, accountId)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  if (detectStoredApiKeyMode(ctx, provider, accountId, stateRow)) {
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
  try {
    const currentStatus = resolveEffectiveAccountStatus(
      stateRow && (stateRow.status || stateRow.status),
      readAccountStatusFile(ctx.fs, ctx.getProfileDir(provider, accountId))
    );
    const started = getAuthJobManager(deps, state).startOauthJob(provider, authMode, { accountId });
    const pendingState = {
      ...buildPendingOauthState(
        provider,
        accountId,
        authMode,
        stateRow && (stateRow.displayName || stateRow.display_name)
      ),
      status: currentStatus
    };
    if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
      accountStateService.syncAccountBaseState(provider, accountId, pendingState);
    }
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
      response.accountId = String((activeJob && activeJob.accountId) || '');
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

  const { provider, accountId } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountArtifactsExist(ctx, provider, accountId)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(provider, accountId)
    : null;
  if (detectStoredApiKeyMode(ctx, provider, accountId, stateRow)) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'refresh_usage_unsupported',
      code: 'api_key_usage_refresh_unsupported',
      message: 'API Key 账号不支持额度刷新。'
    });
    return true;
  }

  try {
    const account = await refreshLiveAccountRecord(ctx, provider, accountId);
    writeJson(ctx.res, 200, { ok: true, account });
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
    getToolAccountIds,
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

  const { provider, accountId } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountArtifactsExist(ctx, provider, accountId)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? accountStateIndex.getAccountState(provider, accountId)
    : null;
  let updated = false;
  if (accountStateService && typeof accountStateService.setOperationalStatus === 'function') {
    const nextState = buildPersistedAccountState(ctx, provider, accountId, stateRow, { status: nextStatus });
    updated = accountStateService.setOperationalStatus(provider, accountId, nextStatus, nextState);
  }
  if (!updated) {
    writeJson(ctx.res, 500, { ok: false, error: 'update_status_failed' });
    return true;
  }

  try {
    const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
      fs,
      accountStateIndex,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      checkStatus,
      serverPort: ctx.options && ctx.options.port
    }, ctx));
    applyReloadState(state, runtimeAccounts);
  } catch (_error) {}

  const account = await refreshLiveAccountRecord(ctx, provider, accountId, {
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
    getToolAccountIds,
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

  const { provider, accountId } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountArtifactsExist(ctx, provider, accountId)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const apiKey = String(payload && payload.apiKey || '').trim();
  const baseUrl = String(payload && payload.baseUrl || '').trim();

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

  const profileDir = getProfileDir(provider, accountId);
  const envPath = path.join(profileDir, '.aih_env.json');
  const envJson = parseJsonFileSafe(fs, envPath) || {};
  const effectiveBaseUrl = payload && 'baseUrl' in payload
    ? baseUrl
    : (
        provider === 'codex'
          ? String(envJson.OPENAI_BASE_URL || '').trim()
          : provider === 'claude'
          ? String(envJson.ANTHROPIC_BASE_URL || '').trim()
          : provider === 'agy'
          ? String(envJson.AGY_BASE_URL || '').trim()
          : ''
      );
  if (isSelfRelayBaseUrl(provider, effectiveBaseUrl, ctx)) {
    writeSelfRelayAccountRejected(ctx, provider);
    return true;
  }

  const accountArtifactHooks = ctx.deps && ctx.deps.accountArtifactHooks;
  const authSnapshotBefore = accountArtifactHooks
    && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
    ? accountArtifactHooks.snapshotAccountAuthArtifacts(provider, accountId)
    : null;

  if (provider === 'codex') {
    if (apiKey) envJson.OPENAI_API_KEY = apiKey;
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) envJson.OPENAI_BASE_URL = baseUrl;
      else delete envJson.OPENAI_BASE_URL;
    }

    if (apiKey) {
      const configDir = getToolConfigDir(provider, accountId);
      const authPath = path.join(configDir, 'auth.json');
      const authJson = parseJsonFileSafe(fs, authPath) || {};
      authJson.OPENAI_API_KEY = apiKey;
      ensureDirSync(fs, configDir);
      fs.writeFileSync(authPath, JSON.stringify(authJson, null, 2), 'utf8');
    }
  } else if (provider === 'gemini') {
    if (apiKey) {
      envJson.GEMINI_API_KEY = apiKey;
      envJson.GOOGLE_API_KEY = apiKey;
    }
  } else if (provider === 'agy') {
    if (apiKey) envJson.AGY_ACCESS_TOKEN = apiKey;
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) envJson.AGY_BASE_URL = baseUrl;
      else delete envJson.AGY_BASE_URL;
    }
  } else if (provider === 'claude') {
    if (apiKey) envJson.ANTHROPIC_API_KEY = apiKey;
    if (payload && 'baseUrl' in payload) {
      if (baseUrl) envJson.ANTHROPIC_BASE_URL = baseUrl;
      else delete envJson.ANTHROPIC_BASE_URL;
    }
  }

  ensureDirSync(fs, profileDir);
  fs.writeFileSync(envPath, JSON.stringify(envJson, null, 2), 'utf8');
  if (authSnapshotBefore && typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged === 'function') {
    accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
      provider,
      accountId,
      before: authSnapshotBefore,
      source: 'webui_account_updated',
      reason: 'credentials_updated'
    });
  }

  try {
    const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
      fs,
      accountStateIndex,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      checkStatus,
      serverPort: ctx.options && ctx.options.port
    }, ctx));
    applyReloadState(state, runtimeAccounts);
  } catch (_error) {}

  const account = await refreshLiveAccountRecord(ctx, provider, accountId, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });

  if (accountStateService && typeof accountStateService.syncAccountBaseState === 'function') {
    const stateRow = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
      ? accountStateIndex.getAccountState(provider, accountId)
      : null;
    const nextState = buildPersistedAccountState(ctx, provider, accountId, stateRow);
    accountStateService.syncAccountBaseState(provider, accountId, nextState);
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

  const { provider, accountId } = parsed;
  if (!SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
    writeJson(ctx.res, 400, { ok: false, error: 'unsupported_provider' });
    return true;
  }
  if (!accountArtifactsExist(ctx, provider, accountId)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const syncGlobalConfigToHost = deps && deps.syncGlobalConfigToHost;
  if (typeof syncGlobalConfigToHost !== 'function') {
    writeJson(ctx.res, 500, { ok: false, error: 'set_default_unavailable' });
    return true;
  }

  try {
    if (typeof ensureSessionStoreLinks === 'function') {
      ensureSessionStoreLinks(provider, accountId);
    }
    const syncResult = syncGlobalConfigToHost(provider, accountId);
    if (!syncResult || !syncResult.ok) {
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'set_default_sync_failed',
        reason: syncResult && syncResult.reason ? syncResult.reason : 'unknown_error'
      });
      return true;
    }
    const providerProfilesDir = resolveProviderProfilesDir(ctx, provider, accountId);
    if (!providerProfilesDir) {
      writeJson(ctx.res, 500, { ok: false, error: 'profiles_dir_unavailable' });
      return true;
    }
    ensureDirSync(fs, providerProfilesDir);
    fs.writeFileSync(path.join(providerProfilesDir, '.aih_default'), accountId);
    const account = await refreshLiveAccountRecord(ctx, provider, accountId, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, { ok: true, provider, accountId, account });
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

  const { provider, accountId } = parsed;
  if (provider !== 'codex') {
    writeJson(ctx.res, 400, { ok: false, error: 'mobile_account_unsupported' });
    return true;
  }
  if (!accountArtifactsExist(ctx, provider, accountId)) {
    writeJson(ctx.res, 404, { ok: false, error: 'account_not_found' });
    return true;
  }

  const validation = validateCodexDesktopAccount(ctx.fs, {
    accountId,
    aiHomeDir: resolveAiHomeDir(ctx, provider, accountId),
    processObj: deps && deps.processObj
  });
  if (!validation.ok) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'mobile_account_invalid',
      code: validation.code,
      message: 'Codex App 账号需要可用的 API Key 或 ChatGPT OAuth 授权。'
    });
    return true;
  }

  try {
    const aiHomeDir = resolveAiHomeDir(ctx, provider, accountId);
    const service = createCodexDesktopHookService({
      fs,
      path,
      aiHomeDir,
      hostHomeDir: String((deps && deps.hostHomeDir) || '').trim()
    });
    const result = service.setDesktopAccountId(accountId);
    if (!result || !result.ok) {
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'set_mobile_failed',
        reason: result && result.reason ? result.reason : 'unknown_error'
      });
      return true;
    }
    const account = await refreshLiveAccountRecord(ctx, provider, accountId, {
      skipUsageRefresh: true,
      skipRuntimeReload: true
    });
    writeJson(ctx.res, 200, { ok: true, provider, accountId, account });
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

async function handleDeleteAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    accountStateIndex,
    accountStateService,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus,
    state,
    writeJson
  } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)$/);
  const provider = matches[1];
  const accountId = matches[2];
  try {
    const profileDir = getProfileDir(provider, accountId);
    if (fs.existsSync(profileDir)) fs.rmSync(profileDir, { recursive: true, force: true });
    const configDir = getToolConfigDir(provider, accountId);
    if (configDir && fs.existsSync(configDir)) fs.rmSync(configDir, { recursive: true, force: true });
    if (accountStateService && typeof accountStateService.deleteAccount === 'function') {
      accountStateService.deleteAccount(provider, accountId);
    }
    try {
      const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
        fs,
        accountStateIndex,
        getToolAccountIds,
        getToolConfigDir,
        getProfileDir,
        checkStatus,
        aiHomeDir: deps.aiHomeDir || '',
        serverPort: ctx.options && ctx.options.port
      }, ctx));
      applyReloadState(state, runtimeAccounts);
    } catch (_error) {}
    writeJson(ctx.res, 200, { ok: true });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'delete_account_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

async function handleExportAccountsRequest(ctx) {
  const { fs, getToolAccountIds, getToolConfigDir, getProfileDir } = ctx;
  try {
    const exportData = { version: 2, accounts: [], exportedAt: new Date().toISOString() };
    for (const provider of SUPPORTED_SERVER_PROVIDERS) {
      const accountIds = getToolAccountIds(provider);
      for (const accountId of accountIds) {
        exportData.accounts.push(readAccountExportRecord({
          provider,
          accountId,
          profileDir: getProfileDir(provider, accountId),
          configDir: getToolConfigDir(provider, accountId),
          fs
        }));
      }
    }
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="ai-home-accounts.json"'
    });
    ctx.res.end(JSON.stringify(exportData, null, 2));
    return true;
  } catch (_error) {
    ctx.writeJson(ctx.res, 500, { ok: false, error: 'export_failed' });
    return true;
  }
}

function isNumericAccountId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function readJsonFileSafe(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
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

function findExistingCodexAccountIdByIdentity({ fs, getToolAccountIds, getToolConfigDir, authJson }) {
  const incomingKey = buildCodexAuthIdentityKey(authJson);
  if (!incomingKey) return '';
  for (const existingId of getToolAccountIds('codex')) {
    const authPath = path.join(getToolConfigDir('codex', existingId), 'auth.json');
    const existingAuth = readJsonFileSafe(fs, authPath);
    if (!existingAuth) continue;
    if (buildCodexAuthIdentityKey(existingAuth) === incomingKey) {
      return String(existingId);
    }
  }
  return '';
}

function resolveImportAccountId({
  fs,
  provider,
  account,
  authJson,
  getToolAccountIds,
  getToolConfigDir,
  getProfileDir,
  nextAccountId
}) {
  const explicitAccountId = String(account.accountId || account.aiHomeAccountId || '').trim();
  if (isNumericAccountId(explicitAccountId)) {
    if (provider !== 'codex') return explicitAccountId;

    const profileDir = getProfileDir(provider, explicitAccountId);
    const existingAuth = readJsonFileSafe(fs, path.join(getToolConfigDir(provider, explicitAccountId), 'auth.json'));
    if (!fs.existsSync(profileDir) || !existingAuth) return explicitAccountId;

    const incomingKey = buildCodexAuthIdentityKey(authJson);
    const existingKey = buildCodexAuthIdentityKey(existingAuth);
    if (!incomingKey || !existingKey || incomingKey === existingKey) return explicitAccountId;

    return findExistingCodexAccountIdByIdentity({
      fs,
      getToolAccountIds,
      getToolConfigDir,
      authJson
    }) || nextAccountId(provider);
  }

  if (provider === 'codex') {
    const existingId = findExistingCodexAccountIdByIdentity({
      fs,
      getToolAccountIds,
      getToolConfigDir,
      authJson
    });
    if (existingId) return existingId;
  }

  return nextAccountId(provider);
}

function appendImportAccountResult(summary, provider, accountId, existedBefore) {
  summary.imported += 1;
  if (existedBefore) summary.updated += 1;
  else summary.created += 1;
  addImportedProvider(summary, provider);
  summary.accounts.push({
    provider,
    accountId,
    status: existedBefore ? 'updated' : 'created'
  });
}

function normalizeImportApiKey(account) {
  const direct = account && typeof account === 'object' ? account : {};
  const config = account && account.config && typeof account.config === 'object' ? account.config : {};
  const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : {};
  const rawTokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
  const hasOauthTokens = Boolean(rawTokens && (rawTokens.refresh_token || rawTokens.access_token || rawTokens.id_token));
  if (hasOauthTokens) return '';
  return String(
    direct.apiKey
    || direct.api_key
    || direct.OPENAI_API_KEY
    || direct.GEMINI_API_KEY
    || direct.GOOGLE_API_KEY
    || direct.ANTHROPIC_API_KEY
    || config.apiKey
    || config.api_key
    || config.OPENAI_API_KEY
    || config.GEMINI_API_KEY
    || config.GOOGLE_API_KEY
    || config.ANTHROPIC_API_KEY
    || auth.OPENAI_API_KEY
    || auth.GEMINI_API_KEY
    || auth.GOOGLE_API_KEY
    || auth.ANTHROPIC_API_KEY
    || ''
  ).trim();
}

async function handleImportAccountsRequest(ctx) {
  const {
    fs,
    deps,
    state,
    readRequestBody,
    accountStateIndex,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    loadServerRuntimeAccounts,
    applyReloadState,
    checkStatus,
    writeJson
  } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 10 * 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  if (!payload) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_import_data' });
    return true;
  }
  try {
    const runtimeImportTools = buildRuntimeImportTools({
      fs,
      aiHomeDir: deps.aiHomeDir || '',
      getToolAccountIds,
      getProfileDir,
      getToolConfigDir
    });
    let summary = createImportSummary();
    let viaCliSources = null;

    if (payload.mode === 'path') {
      const importPath = String(payload.path || '').trim();
      if (!importPath) {
        writeJson(ctx.res, 400, { ok: false, error: 'missing_import_path' });
        return true;
      }
      const result = await runtimeImportTools.runUnifiedImport([importPath], {
        provider: String(payload.provider || '').trim().toLowerCase() || '',
        log: () => {},
        error: () => {}
      });
      summary = summarizeUnifiedImportResult(result);
      viaCliSources = result;
    } else {
      const records = extractImportRecords(payload);
      if (!records) {
        writeJson(ctx.res, 400, { ok: false, error: 'unsupported_import_payload' });
        return true;
      }
      summary.total = records.length;

      const nextAccountId = (provider) => {
        const ids = getToolAccountIds(provider).map((item) => Number(item)).filter((item) => Number.isFinite(item));
        return String((ids.length ? Math.max(...ids) : 0) + 1);
      };

      for (const account of records) {
        const provider = inferImportProvider(account);
        if (!provider || !SUPPORTED_SERVER_PROVIDERS.includes(provider)) {
          summary.invalid += 1;
          continue;
        }
        const normalizedProvider = String(provider).trim().toLowerCase();
        const accountArtifactHooks = ctx.deps && ctx.deps.accountArtifactHooks;
        const notifyImportedAuthUpdated = (accountId, authSnapshotBefore) => {
          if (!authSnapshotBefore || !accountArtifactHooks || typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged !== 'function') return;
          accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
            provider: normalizedProvider,
            accountId,
            before: authSnapshotBefore,
            source: 'webui_account_import',
            reason: 'imported_credentials_updated'
          });
        };

        const apiKey = normalizeImportApiKey(account);
        if (apiKey) {
          const config = account.config && typeof account.config === 'object' ? account.config : {};
          const accountId = resolveImportAccountId({
            fs,
            provider: normalizedProvider,
            account,
            authJson: null,
            getToolAccountIds,
            getToolConfigDir,
            getProfileDir,
            nextAccountId
          });
          const profileDir = getProfileDir(normalizedProvider, accountId);
          const configDir = getToolConfigDir(normalizedProvider, accountId);
          const existedBefore = fs.existsSync(path.join(profileDir, '.aih_env.json'))
            || fs.existsSync(path.join(configDir, 'auth.json'))
            || fs.existsSync(path.join(configDir, '.credentials.json'));
          configureApiKeyAccount({
            fs,
            provider: normalizedProvider,
            accountId,
            config: {
              apiKey,
              baseUrl: String(config.baseUrl || config.OPENAI_BASE_URL || config.ANTHROPIC_BASE_URL || '').trim()
            },
            getProfileDir,
            getToolConfigDir,
            accountArtifactHooks
          });
          appendImportAccountResult(summary, normalizedProvider, accountId, existedBefore);
          continue;
        }

        if (normalizedProvider === 'codex') {
          const authJson = normalizeCodexAuthPayload(account.auth || account);
          if (!authJson) {
            summary.invalid += 1;
            continue;
          }
          const accountId = resolveImportAccountId({
            fs,
            provider: normalizedProvider,
            account,
            authJson,
            getToolAccountIds,
            getToolConfigDir,
            getProfileDir,
            nextAccountId
          });
          const profileDir = getProfileDir(normalizedProvider, accountId);
          const configDir = getToolConfigDir(normalizedProvider, accountId);
          const existedBefore = fs.existsSync(path.join(configDir, 'auth.json'));
          ensureDirSync(fs, profileDir);
          ensureDirSync(fs, configDir);
          const authSnapshotBefore = accountArtifactHooks
            && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
            ? accountArtifactHooks.snapshotAccountAuthArtifacts(normalizedProvider, accountId)
            : null;
          fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify(authJson, null, 2));
          const config = account.config && typeof account.config === 'object' ? account.config : {};
          if (Object.keys(config).length > 0) {
            fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify(config, null, 2));
          }
          notifyImportedAuthUpdated(accountId, authSnapshotBefore);
          appendImportAccountResult(summary, normalizedProvider, accountId, existedBefore);
          continue;
        }

        if (normalizedProvider === 'gemini') {
          const auth = account.auth && typeof account.auth === 'object' ? account.auth : account;
          if (!auth || !String(auth.access_token || '').trim()) {
            summary.invalid += 1;
            continue;
          }
          const accountId = resolveImportAccountId({
            fs,
            provider: normalizedProvider,
            account,
            authJson: null,
            getToolAccountIds,
            getToolConfigDir,
            getProfileDir,
            nextAccountId
          });
          const profileDir = getProfileDir(normalizedProvider, accountId);
          const configDir = getToolConfigDir(normalizedProvider, accountId);
          const existedBefore = fs.existsSync(path.join(profileDir, '.gemini', 'oauth_creds.json'));
          ensureDirSync(fs, profileDir);
          ensureDirSync(fs, configDir);
          const authSnapshotBefore = accountArtifactHooks
            && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
            ? accountArtifactHooks.snapshotAccountAuthArtifacts(normalizedProvider, accountId)
            : null;
          const geminiDir = path.join(profileDir, '.gemini');
          ensureDirSync(fs, geminiDir);
          fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(auth, null, 2));
          const config = account.config && typeof account.config === 'object' ? account.config : {};
          if (Object.keys(config).length > 0) {
            fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify(config, null, 2));
          }
          notifyImportedAuthUpdated(accountId, authSnapshotBefore);
          appendImportAccountResult(summary, normalizedProvider, accountId, existedBefore);
          continue;
        }

        if (normalizedProvider === 'claude') {
          const auth = account.auth && typeof account.auth === 'object' ? account.auth : account;
          if (!auth || Object.keys(auth).length === 0) {
            summary.invalid += 1;
            continue;
          }
          const accountId = resolveImportAccountId({
            fs,
            provider: normalizedProvider,
            account,
            authJson: null,
            getToolAccountIds,
            getToolConfigDir,
            getProfileDir,
            nextAccountId
          });
          const profileDir = getProfileDir(normalizedProvider, accountId);
          const configDir = getToolConfigDir(normalizedProvider, accountId);
          const existedBefore = fs.existsSync(path.join(configDir, '.credentials.json'));
          ensureDirSync(fs, profileDir);
          ensureDirSync(fs, configDir);
          const authSnapshotBefore = accountArtifactHooks
            && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
            ? accountArtifactHooks.snapshotAccountAuthArtifacts(normalizedProvider, accountId)
            : null;
          fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify(auth, null, 2));
          const config = account.config && typeof account.config === 'object' ? account.config : {};
          if (Object.keys(config).length > 0) {
            fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify(config, null, 2));
          }
          notifyImportedAuthUpdated(accountId, authSnapshotBefore);
          appendImportAccountResult(summary, normalizedProvider, accountId, existedBefore);
        }
      }
    }

    try {
      const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
        fs,
        accountStateIndex,
        getToolAccountIds,
        getToolConfigDir,
        getProfileDir,
        checkStatus,
        aiHomeDir: deps.aiHomeDir || '',
        serverPort: ctx.options && ctx.options.port
      }, ctx));
      applyReloadState(state, runtimeAccounts);
    } catch (_error) {}

    writeJson(ctx.res, 200, {
      ok: true,
      imported: summary.imported,
      summary,
      result: viaCliSources
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'import_failed',
      message: String((error && error.message) || error || 'import_failed')
    });
    return true;
  }
}

module.exports = {
  handleListAccountsRequest,
  handleGetAddJobRequest,
  handleCancelAddJobRequest,
  handleCompleteAddJobCallbackRequest,
  handleAddAccountRequest,
  handleRefreshAccountUsageRequest,
  handleUpdateAccountStatusRequest,
  handleUpdateAccountRequest,
  handleSetDefaultAccountRequest,
  handleSetMobileAccountRequest,
  handleReauthAccountRequest,
  handleDeleteAccountRequest,
  handleExportAccountsRequest,
  handleImportAccountsRequest,
  inferReauthAuthMode
};
