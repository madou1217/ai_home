'use strict';
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

function isDigitsOnly(value) {
  return /^\d+$/.test(String(value || '').trim());
}

async function readManagementJson(req, readRequestBody) {
  if (typeof readRequestBody !== 'function') return null;
  const body = await readRequestBody(req, { maxBytes: 1024 * 1024 }).catch(() => null);
  if (!body) return null;
  try {
    return body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

async function handleManagementRequest(ctx) {
  const {
    method,
    pathname,
    url,
    req,
    res,
    options,
    state,
    requiredManagementKey,
    deps
  } = ctx;

  const {
    parseAuthorizationBearer,
    writeJson,
    renderProxyStatusPage,
    buildManagementStatusPayload,
    buildManagementMetricsPayload,
    buildManagementModelsResponse,
    buildManagementAccountsPayload,
    loadServerRuntimeAccounts,
    applyReloadState,
    fetchModelsForAccount,
    getRegistryModelList,
    accountStateIndex,
    fs,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    readRequestBody
  } = deps;

  if (!pathname.startsWith('/v0/management')) return false;

  if (requiredManagementKey) {
    const incoming = parseAuthorizationBearer(req.headers.authorization);
    if (incoming !== requiredManagementKey) {
      writeJson(res, 401, { ok: false, error: 'unauthorized_management' });
      return true;
    }
  }

  if (method === 'GET' && pathname === '/v0/management/ui') {
    const html = renderProxyStatusPage();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
    return true;
  }
  if (method === 'GET' && pathname === '/v0/management/status') {
    writeJson(res, 200, buildManagementStatusPayload(state, options));
    return true;
  }
  if (method === 'GET' && pathname === '/v0/management/metrics') {
    writeJson(res, 200, buildManagementMetricsPayload(state));
    return true;
  }
  if (method === 'GET' && pathname === '/v0/management/models') {
    const out = await buildManagementModelsResponse({
      options,
      state,
      url,
      fetchModelsForAccount,
      getRegistryModelList
    });
    writeJson(res, out.status, out.payload);
    return true;
  }
  if (method === 'GET' && pathname === '/v0/management/accounts') {
    writeJson(res, 200, buildManagementAccountsPayload(state));
    return true;
  }
  if (method === 'POST' && pathname === '/v0/management/reload') {
    const runtimeAccounts = loadServerRuntimeAccounts({ fs, getToolAccountIds, getToolConfigDir, getProfileDir, checkStatus });
    applyReloadState(state, runtimeAccounts);
    const counts = {};
    let total = 0;
    SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
      const count = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider].length : 0;
      counts[provider] = count;
      total += count;
    });
    writeJson(res, 200, {
      ok: true,
      reloaded: total,
      providers: counts
    });
    return true;
  }
  if (method === 'POST' && pathname === '/v0/management/cooldown/clear') {
    SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
      const accounts = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
      accounts.forEach((a) => {
        a.cooldownUntil = 0;
        a.consecutiveFailures = 0;
      });
    });
    writeJson(res, 200, { ok: true });
    return true;
  }
  if (method === 'POST' && pathname === '/v0/management/restart') {
    if (typeof deps.restartProxy !== 'function') {
      writeJson(res, 503, {
        ok: false,
        error: 'management_restart_unavailable'
      });
      return true;
    }
    try {
      const restartResult = await deps.restartProxy([]);
      const started = restartResult && restartResult.started ? restartResult.started : {};
      const stopped = restartResult && restartResult.stopped ? restartResult.stopped : {};
      writeJson(res, 200, {
        ok: true,
        action: 'restart',
        running: Boolean(restartResult && restartResult.running),
        pid: Number(started.pid || restartResult.pid || 0),
        started: Boolean(started.started),
        stopped: {
          stopped: Boolean(stopped.stopped),
          reason: stopped.reason || '',
          forced: Boolean(stopped.forced)
        },
        appliedConfig: started.appliedConfig || restartResult.appliedConfig || {}
      });
      return true;
    } catch (e) {
      writeJson(res, 500, {
        ok: false,
        error: 'management_restart_failed',
        message: e && e.message ? String(e.message) : 'unknown_error'
      });
      return true;
    }
  }

  if (method === 'POST' && pathname === '/v0/management/state-index/upsert') {
    if (!accountStateIndex || typeof accountStateIndex.upsertAccountState !== 'function') {
      writeJson(res, 503, { ok: false, error: 'state_index_unavailable' });
      return true;
    }
    const payload = await readManagementJson(req, readRequestBody);
    const provider = String(payload && payload.provider || '').trim();
    const accountId = String(payload && payload.accountId || '').trim();
    const state = payload && typeof payload.state === 'object' ? payload.state : {};
    if (!provider || !isDigitsOnly(accountId)) {
      writeJson(res, 400, { ok: false, error: 'invalid_state_index_payload' });
      return true;
    }
    const updated = accountStateIndex.upsertAccountState(provider, accountId, state);
    writeJson(res, 200, { ok: true, updated: !!updated });
    return true;
  }

  if (method === 'POST' && pathname === '/v0/management/state-index/set-exhausted') {
    if (!accountStateIndex || typeof accountStateIndex.setExhausted !== 'function') {
      writeJson(res, 503, { ok: false, error: 'state_index_unavailable' });
      return true;
    }
    const payload = await readManagementJson(req, readRequestBody);
    const provider = String(payload && payload.provider || '').trim();
    const accountId = String(payload && payload.accountId || '').trim();
    const exhausted = !!(payload && payload.exhausted);
    if (!provider || !isDigitsOnly(accountId)) {
      writeJson(res, 400, { ok: false, error: 'invalid_state_index_payload' });
      return true;
    }
    const updated = accountStateIndex.setExhausted(provider, accountId, exhausted);
    writeJson(res, 200, { ok: true, updated: !!updated });
    return true;
  }

  if (method === 'POST' && pathname === '/v0/management/state-index/prune-missing') {
    if (!accountStateIndex || typeof accountStateIndex.pruneMissingIds !== 'function') {
      writeJson(res, 503, { ok: false, error: 'state_index_unavailable' });
      return true;
    }
    const payload = await readManagementJson(req, readRequestBody);
    const provider = String(payload && payload.provider || '').trim();
    const existingIds = Array.isArray(payload && payload.existingIds) ? payload.existingIds : [];
    if (!provider) {
      writeJson(res, 400, { ok: false, error: 'invalid_state_index_payload' });
      return true;
    }
    const normalizedIds = existingIds
      .map((id) => String(id || '').trim())
      .filter((id) => isDigitsOnly(id));
    const removed = accountStateIndex.pruneMissingIds(provider, normalizedIds);
    writeJson(res, 200, { ok: true, removed: Number(removed) || 0 });
    return true;
  }

  writeJson(res, 404, { ok: false, error: 'management_not_found' });
  return true;
}

module.exports = {
  handleManagementRequest
};
