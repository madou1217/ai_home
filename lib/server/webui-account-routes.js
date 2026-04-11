'use strict';

const path = require('node:path');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { ensureDirSync } = require('./fs-compat');
const {
  configureApiKeyAccount,
  getNextAccountIdFromIds,
  isSupportedAuthMode,
  normalizeAuthMode
} = require('./web-account-auth');
const {
  normalizeCodexAuthPayload,
  extractCodexMetadata,
  readAccountExportRecord,
  parseManualImportText,
  inferImportProvider,
  buildRuntimeImportTools
} = require('./web-account-transfer');

async function handleListAccountsRequest(ctx) {
  const {
    fs,
    state,
    accountStateIndex,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    writeJson
  } = ctx;
  const accounts = [];
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const accountIds = getToolAccountIds(provider);
    for (const accountId of accountIds) {
      const configDir = getToolConfigDir(provider, accountId);
      const profileDir = getProfileDir(provider, accountId);
      const stateInfo = accountStateIndex.getAccountState(provider, accountId) || {};
      const liveStatus = checkStatus(provider, profileDir) || {};
      const accountName = String(liveStatus.accountName || '').trim();
      const configured = Boolean(liveStatus.configured);
      const apiKeyMode = configured
        ? (accountName.startsWith('API Key') || Boolean(stateInfo.api_key_mode))
        : false;
      const exhausted = configured && !apiKeyMode ? Boolean(stateInfo.exhausted) : false;
      const remainingPct = configured && !apiKeyMode
        ? (Number.isFinite(Number(stateInfo.remaining_pct)) ? Number(stateInfo.remaining_pct) : 0)
        : 0;
      const displayName = configured && accountName && accountName !== 'Unknown'
        ? accountName
        : (String(stateInfo.display_name || '').trim() || `${provider}-${accountId}`);

      let planType = configured ? (apiKeyMode ? 'api-key' : 'oauth') : 'pending';
      let email = '';
      try {
        if (provider === 'codex' && configured && !apiKeyMode) {
          const authPath = path.join(configDir, 'auth.json');
          if (fs.existsSync(authPath)) {
            const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            const meta = extractCodexMetadata(authData);
            planType = meta.planType || 'free';
            email = meta.email || '';
          }
        } else if (provider === 'gemini' && configured) {
          const settingsPath = path.join(profileDir, '.gemini', 'settings.json');
          if (fs.existsSync(settingsPath)) {
            const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            planType = settings?.security?.auth?.selectedType || 'oauth';
          }
          if (accountName && accountName !== 'Unknown' && !accountName.startsWith('API Key')) {
            email = accountName;
          }
        } else if (provider === 'claude' && configured) {
          planType = apiKeyMode ? 'api-key' : 'oauth';
          if (accountName && accountName !== 'Unknown' && !accountName.startsWith('API Key')) {
            email = accountName;
          }
        }
      } catch (_error) {}

      const runtimeAccount = Array.isArray(state.accounts && state.accounts[provider])
        ? state.accounts[provider].find((item) => String(item && item.id || '') === String(accountId))
        : null;
      const runtimeStatus = deriveAccountRuntimeStatus(runtimeAccount);

      const accountRecord = {
        provider,
        accountId,
        displayName,
        configured,
        apiKeyMode,
        exhausted,
        remainingPct,
        updatedAt: Number(stateInfo.updated_at) || 0,
        planType,
        email,
        configDir,
        profileDir
      };

      if (runtimeAccount) {
        accountRecord.runtimeStatus = runtimeStatus.status;
        accountRecord.runtimeUntil = runtimeStatus.until;
        accountRecord.runtimeReason = runtimeStatus.reason;
      }

      accounts.push(accountRecord);
    }
  }
  writeJson(ctx.res, 200, { ok: true, accounts });
  return true;
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
  const authMode = normalizeAuthMode(payload.authMode || (payload.config && payload.config.apiKey ? 'api-key' : 'oauth-browser'));
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
        configured: true,
        apiKeyMode: true,
        displayName: `${provider}-${accountId}`
      });
      const runtimeAccounts = loadServerRuntimeAccounts({ fs, getToolAccountIds, getToolConfigDir, getProfileDir, checkStatus });
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
    accountStateIndex.upsertAccountState(provider, started.accountId, {
      configured: false,
      apiKeyMode: false,
      displayName: `${provider}-${started.accountId}`
    });
    writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountId: started.accountId,
      authMode,
      status: 'pending',
      jobId: started.jobId,
      expiresAt: Number.isFinite(started.expiresAt) ? started.expiresAt : null,
      pollIntervalMs: Number.isFinite(started.pollIntervalMs) ? started.pollIntervalMs : null
    });
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
        getToolAccountIds,
        listUsageCandidateIds: () => [],
        listConfiguredIds: () => [],
        getToolConfigDir,
        getProfileDir,
        checkStatus,
        aiHomeDir: deps.aiHomeDir || ''
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
        getToolAccountIds,
        listUsageCandidateIds: () => [],
        listConfiguredIds: () => [],
        getToolConfigDir,
        getProfileDir,
        checkStatus,
        aiHomeDir: deps.aiHomeDir || ''
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
  handleAddAccountRequest,
  handleDeleteAccountRequest,
  handleExportAccountsRequest,
  handleImportAccountsRequest
};
