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
  parseManualImportText,
  inferImportProvider,
  buildRuntimeImportTools
} = require('./web-account-transfer');
const {
  handleListAccountsFastRequest,
  refreshLiveAccountRecord
} = require('./webui-account-live');
const {
  cleanOauthDisplayName,
  getApiKeyDisplayName
} = require('./account-display-identity');

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
    writeJson(ctx.res, 404, { ok: false, error: result.code || 'job_not_found' });
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
    redirectUri: started.redirectUri || ''
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
      const accountId = getNextAccountIdFromIds(getToolAccountIds(provider));
      configureApiKeyAccount({ fs, provider, accountId, config, getProfileDir, getToolConfigDir });
      accountStateIndex.upsertAccountState(provider, accountId, {
        status: 'up',
        configured: true,
        apiKeyMode: true,
        displayName: getApiKeyDisplayName(provider, config)
      });
      writeAccountStatusFile(fs, getProfileDir(provider, accountId), 'up');
      const runtimeAccounts = loadServerRuntimeAccounts({
        fs,
        accountStateIndex,
        getToolAccountIds,
        getToolConfigDir,
        getProfileDir,
        checkStatus,
        serverPort: ctx.options && ctx.options.port
      });
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
    accountStateIndex.upsertAccountState(
      provider,
      started.accountId,
      {
        ...buildPendingOauthState(provider, started.accountId, authMode),
        status: pendingStatus
      }
    );
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
    accountStateIndex.upsertAccountState(
      provider,
      accountId,
      {
        ...buildPendingOauthState(
          provider,
          accountId,
          authMode,
          stateRow && (stateRow.displayName || stateRow.display_name)
        ),
        status: currentStatus
      }
    );
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
  if (stateRow && typeof accountStateIndex.setStatus === 'function') {
    updated = accountStateIndex.setStatus(provider, accountId, nextStatus);
  }
  if (!updated) {
    const nextState = buildPersistedAccountState(ctx, provider, accountId, stateRow, { status: nextStatus });
    updated = accountStateIndex.upsertAccountState(provider, accountId, nextState);
  }
  if (!updated) {
    writeJson(ctx.res, 500, { ok: false, error: 'update_status_failed' });
    return true;
  }
  writeAccountStatusFile(fs, getProfileDir(provider, accountId), nextStatus);

  try {
    const runtimeAccounts = loadServerRuntimeAccounts({
      fs,
      accountStateIndex,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      checkStatus,
      serverPort: ctx.options && ctx.options.port
    });
    applyReloadState(state, runtimeAccounts);
  } catch (_error) {}

  const account = await refreshLiveAccountRecord(ctx, provider, accountId, {
    skipUsageRefresh: true,
    skipRuntimeReload: true
  });
  writeJson(ctx.res, 200, { ok: true, account });
  return true;
}

async function handleDeleteAccountRequest(ctx) {
  const {
    pathname,
    fs,
    deps,
    accountStateIndex,
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
    accountStateIndex.removeAccount(provider, accountId);
    try {
      const runtimeAccounts = loadServerRuntimeAccounts({
        fs,
        accountStateIndex,
        getToolAccountIds,
        listUsageCandidateIds: () => [],
        listConfiguredIds: () => [],
        getToolConfigDir,
        getProfileDir,
        checkStatus,
        aiHomeDir: deps.aiHomeDir || '',
        serverPort: ctx.options && ctx.options.port
      });
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

async function handleImportAccountsRequest(ctx) {
  const {
    fs,
    deps,
    state,
    readRequestBody,
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
    let imported = 0;
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
      imported = Number(
        (Array.isArray(result && result.sourceResults) ? result.sourceResults : [])
          .reduce((sum, item) => sum + Number(item && item.imported || 0), 0)
      ) || 0;
      viaCliSources = result;
    } else {
      let records = [];
      if (Array.isArray(payload.accounts)) records = payload.accounts.slice();
      else if (typeof payload.content === 'string' && payload.content.trim()) records = parseManualImportText(payload.content);
      else if (payload.account && typeof payload.account === 'object') records = [payload.account];
      else {
        writeJson(ctx.res, 400, { ok: false, error: 'unsupported_import_payload' });
        return true;
      }

      const nextAccountId = (provider) => {
        const ids = getToolAccountIds(provider).map((item) => Number(item)).filter((item) => Number.isFinite(item));
        return String((ids.length ? Math.max(...ids) : 0) + 1);
      };

      for (const account of records) {
        const provider = inferImportProvider(account);
        if (!provider) continue;
        const normalizedProvider = String(provider).trim().toLowerCase();
        const accountId = String(account.accountId || account.account_id || nextAccountId(normalizedProvider)).trim();
        const profileDir = getProfileDir(normalizedProvider, accountId);
        const configDir = getToolConfigDir(normalizedProvider, accountId);
        ensureDirSync(fs, profileDir);
        ensureDirSync(fs, configDir);

        if (normalizedProvider === 'codex') {
          const authJson = normalizeCodexAuthPayload(account.auth || account);
          if (!authJson) continue;
          fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify(authJson, null, 2));
          const config = account.config && typeof account.config === 'object' ? account.config : {};
          if (Object.keys(config).length > 0) {
            fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify(config, null, 2));
          }
          imported += 1;
          continue;
        }

        if (normalizedProvider === 'gemini') {
          const auth = account.auth && typeof account.auth === 'object' ? account.auth : account;
          if (!auth || !String(auth.access_token || '').trim()) continue;
          const geminiDir = path.join(profileDir, '.gemini');
          ensureDirSync(fs, geminiDir);
          fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify(auth, null, 2));
          const config = account.config && typeof account.config === 'object' ? account.config : {};
          if (Object.keys(config).length > 0) {
            fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify(config, null, 2));
          }
          imported += 1;
          continue;
        }

        if (normalizedProvider === 'claude') {
          const auth = account.auth && typeof account.auth === 'object' ? account.auth : account;
          ensureDirSync(fs, configDir);
          fs.writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify(auth, null, 2));
          const config = account.config && typeof account.config === 'object' ? account.config : {};
          if (Object.keys(config).length > 0) {
            fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify(config, null, 2));
          }
          imported += 1;
        }
      }
    }

    try {
      const runtimeAccounts = loadServerRuntimeAccounts({
        fs,
        accountStateIndex,
        getToolAccountIds,
        listUsageCandidateIds: () => [],
        listConfiguredIds: () => [],
        getToolConfigDir,
        getProfileDir,
        checkStatus,
        aiHomeDir: deps.aiHomeDir || '',
        serverPort: ctx.options && ctx.options.port
      });
      applyReloadState(state, runtimeAccounts);
    } catch (_error) {}

    writeJson(ctx.res, 200, { ok: true, imported, result: viaCliSources });
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
  handleReauthAccountRequest,
  handleDeleteAccountRequest,
  handleExportAccountsRequest,
  handleImportAccountsRequest,
  inferReauthAuthMode
};
