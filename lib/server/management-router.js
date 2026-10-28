'use strict';

const { authorizeManagementKeyOrLoopback } = require('./management-key-auth');
const { handlePluginManagementRequest } = require('./plugin-management-routes');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  handleManagementWatchRequest,
  notifyManagementWatchers
} = require('./management-live');
const {
  handleUsageScanWatchRequest,
  startUsageScanJob
} = require('./management-usage-live');
const {
  cancelUsageDashboardQuery,
  handleUsageDashboardQueryWatchRequest,
  startUsageDashboardQuery
} = require('./management-usage-query-live');
const { withAccountQueryListFns } = require('./account-load-args');
const { notifyGoCoreProjection } = require('./go-core-projection-sync');
const { isAccountRef } = require('./account-ref-store');
const { sanitizeBaseState } = require('../account/state-sync-policy');
const { providerSupports } = require('../provider-catalog');

const { clearAccountRuntimeBlock } = require('./account-probe-recovery');
const { getAccountRuntimeGate } = require('./account-runtime-gate');

function formatLocalDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function parseLocalDateStart(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

function parseUsageTimeBound(value, options = {}) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const dateOnlyMs = parseLocalDateStart(text);
  if (dateOnlyMs) {
    return options.endOfDay ? dateOnlyMs + 24 * 60 * 60 * 1000 - 1 : dateOnlyMs;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseModelUsageQuery(url) {
  const today = formatLocalDate(new Date());
  const from = String(url.searchParams.get('from') || today).trim();
  const to = String(url.searchParams.get('to') || from).trim();
  const fromMs = parseUsageTimeBound(from);
  const toMs = parseUsageTimeBound(to, { endOfDay: true });
  if (!fromMs || !toMs) {
    const error = new Error('invalid_date: expected YYYY-MM-DD or ISO date-time');
    error.code = 'invalid_usage_query';
    throw error;
  }
  return {
    from,
    to,
    fromMs,
    toMs,
    provider: String(url.searchParams.get('provider') || url.searchParams.get('source') || '').trim().toLowerCase(),
    model: String(url.searchParams.get('model') || '').trim(),
    sessionId: String(url.searchParams.get('session_id') || url.searchParams.get('sessionId') || '').trim(),
    limit: Number(url.searchParams.get('limit') || '50') || 50,
    scan: ['1', 'true', 'yes'].includes(String(url.searchParams.get('scan') || '').trim().toLowerCase())
  };
}

async function syncModelUsagePricingBestEffort(modelUsageService) {
  if (!modelUsageService || typeof modelUsageService.syncPricingIfStale !== 'function') return null;
  try {
    return await modelUsageService.syncPricingIfStale();
  } catch (_error) {
    return null;
  }
}

function executeModelUsageRead(modelUsageService, method, query) {
  const asyncMethod = `${method}Async`;
  const read = typeof modelUsageService[asyncMethod] === 'function'
    ? modelUsageService[asyncMethod]
    : modelUsageService[method];
  if (typeof read !== 'function') {
    const error = new Error(`model_usage_read_unavailable:${method}`);
    error.code = 'model_usage_read_unavailable';
    throw error;
  }
  return Promise.resolve(read.call(modelUsageService, query));
}

async function handleModelUsageManagementRequest(ctx, modelUsageService, writeJson, onTokenUsageUpdated) {
  const { method, pathname, url, res } = ctx;
  if (!pathname.startsWith('/v0/management/usage')) return false;
  if (!modelUsageService) {
    writeJson(res, 503, { ok: false, error: 'model_usage_unavailable' });
    return true;
  }

  try {
    if (method === 'POST' && pathname === '/v0/management/usage/import') {
      const sourceId = String(ctx.req && ctx.req.headers && ctx.req.headers['x-aih-usage-source'] || '').trim();
      const localId = String(ctx.state && ctx.state.serverIdentity && ctx.state.serverIdentity.id || '').trim();
      if (sourceId && localId && sourceId === localId) {
        writeJson(res, 200, { ok: true, accepted: 0, inserted: 0, skipped: 'same_server' });
        return true;
      }
      const body = await readManagementJson(
        ctx.req,
        ctx.readRequestBody || (ctx.deps && ctx.deps.readRequestBody)
      );
      const records = body && Array.isArray(body.records) ? body.records : [];
      if (records.length > 500) {
        writeJson(res, 413, { ok: false, error: 'usage_import_batch_too_large' });
        return true;
      }
      if (records.length === 0) {
        writeJson(res, 200, { ok: true, accepted: 0, inserted: 0 });
        return true;
      }
      const inserted = typeof modelUsageService.recordUsageBatch === 'function'
        ? modelUsageService.recordUsageBatch(records)
        : 0;
      if (typeof onTokenUsageUpdated === 'function' && inserted > 0) {
        try {
          const usageByAccount = typeof modelUsageService.getAccountTokenUsage === 'function'
            ? modelUsageService.getAccountTokenUsage({ nowMs: Date.now() })
            : null;
          if (usageByAccount) await onTokenUsageUpdated(usageByAccount, { generatedAt: Date.now() });
        } catch (_error) {}
      }
      writeJson(res, 200, { ok: true, accepted: records.length, inserted });
      return true;
    }

    if (method === 'GET' && pathname === '/v0/management/usage/dashboard/query/watch') {
      return handleUsageDashboardQueryWatchRequest(ctx);
    }

    if (method === 'POST' && pathname === '/v0/management/usage/dashboard/query') {
      const query = parseModelUsageQuery(url);
      const job = startUsageDashboardQuery(ctx.state, modelUsageService, query);
      writeJson(res, 202, { ok: true, accepted: true, job });
      return true;
    }

    const dashboardQueryJobMatch = pathname.match(/^\/v0\/management\/usage\/dashboard\/query\/([^/]+)$/);
    if (method === 'DELETE' && dashboardQueryJobMatch) {
      const result = cancelUsageDashboardQuery(ctx.state, decodeURIComponent(dashboardQueryJobMatch[1]));
      if (!result) {
        writeJson(res, 404, { ok: false, error: 'model_usage_query_job_not_found' });
        return true;
      }
      writeJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (method === 'GET' && pathname === '/v0/management/usage/scan/watch') {
      return handleUsageScanWatchRequest(ctx);
    }

    if ((method === 'GET' || method === 'POST') && pathname === '/v0/management/usage/scan') {
      const query = parseModelUsageQuery(url);
      const started = startUsageScanJob(ctx.state, modelUsageService, {
        provider: query.provider,
        onTokenUsageUpdated
      });
      writeJson(res, 202, { ok: true, ...started });
      return true;
    }

    if (method !== 'GET') {
      writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    const query = parseModelUsageQuery(url);
    await syncModelUsagePricingBestEffort(modelUsageService);
    if (query.scan && (!query.provider || providerSupports(query.provider, 'usageScan'))) {
      modelUsageService.scan({ provider: query.provider });
    }

    if (pathname === '/v0/management/usage' || pathname === '/v0/management/usage/stats') {
      writeJson(res, 200, {
        ok: true,
        range: { from: query.from, to: query.to },
        stats: await executeModelUsageRead(modelUsageService, 'getStats', query)
      });
      return true;
    }

    if (pathname === '/v0/management/usage/dashboard') {
      const dashboard = await executeModelUsageRead(modelUsageService, 'getDashboard', query);
      writeJson(res, 200, {
        ok: true,
        range: { from: query.from, to: query.to },
        ...dashboard
      });
      return true;
    }

    if (pathname === '/v0/management/usage/models') {
      writeJson(res, 200, {
        ok: true,
        range: { from: query.from, to: query.to },
        models: await executeModelUsageRead(modelUsageService, 'getCostByModel', query)
      });
      return true;
    }

    if (pathname === '/v0/management/usage/sessions') {
      writeJson(res, 200, {
        ok: true,
        range: { from: query.from, to: query.to },
        sessions: await executeModelUsageRead(modelUsageService, 'getSessions', query)
      });
      return true;
    }

    if (pathname === '/v0/management/usage/requests') {
      const details = await executeModelUsageRead(modelUsageService, 'getRequestDetails', query);
      writeJson(res, 200, {
        ok: true,
        range: { from: query.from, to: query.to },
        ...details
      });
      return true;
    }

    if (pathname === '/v0/management/usage/breakdown') {
      if (!query.sessionId && !query.model) {
        writeJson(res, 400, { ok: false, error: 'usage_breakdown_scope_required' });
        return true;
      }
      const breakdown = await executeModelUsageRead(modelUsageService, 'getBreakdown', query);
      writeJson(res, 200, {
        ok: true,
        range: { from: query.from, to: query.to },
        ...breakdown
      });
      return true;
    }

    if (pathname === '/v0/management/usage/session-detail') {
      if (!query.sessionId) {
        writeJson(res, 400, { ok: false, error: 'session_id_required' });
        return true;
      }
      writeJson(res, 200, {
        ok: true,
        range: { from: query.from, to: query.to },
        session: await executeModelUsageRead(modelUsageService, 'getSessionDetail', query)
      });
      return true;
    }
  } catch (error) {
    const status = error && error.code === 'invalid_usage_query' ? 400 : 500;
    writeJson(res, status, {
      ok: false,
      error: status === 400 ? 'invalid_usage_query' : 'model_usage_failed',
      message: String((error && error.message) || error || 'unknown_error')
    });
    return true;
  }

  writeJson(res, 404, { ok: false, error: 'model_usage_not_found' });
  return true;
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
    accountStateService,
    accountRuntimeGate,
    accountQueryService,
    fs,
    aiHomeDir,
    getProfileDir,
    checkStatus,
    readRequestBody,
    modelUsageService,
    onTokenUsageUpdated
  } = deps;

  const managementWatchDeps = (
    typeof buildManagementStatusPayload === 'function'
    && typeof buildManagementMetricsPayload === 'function'
    && typeof buildManagementAccountsPayload === 'function'
  )
    ? {
        buildManagementStatusPayload,
        buildManagementMetricsPayload,
        buildManagementAccountsPayload,
        fs,
        aiHomeDir,
        accountStateIndex
      }
    : null;

  // 插件路由有自己更严格的鉴权（只认管理密钥），先于 /v0/management 的放行逻辑处理。
  if (await handlePluginManagementRequest(ctx)) return true;

  if (!pathname.startsWith('/v0/management')) return false;

  const authorization = authorizeManagementKeyOrLoopback({
    req,
    requiredManagementKey,
    deps: { parseAuthorizationBearer }
  });
  if (!authorization.ok) {
    writeJson(res, authorization.statusCode, { ok: false, error: authorization.error });
    return true;
  }

  if (method === 'GET' && pathname === '/v0/management/ui') {
    const html = renderProxyStatusPage();
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
    return true;
  }
  if (method === 'GET' && pathname === '/v0/management/watch') {
    if (!managementWatchDeps) {
      writeJson(res, 503, { ok: false, error: 'management_watch_unavailable' });
      return true;
    }
    return handleManagementWatchRequest({
      req,
      res,
      state,
      options,
      deps: managementWatchDeps
    });
  }
  if (method === 'POST' && pathname === '/v0/management/watch/snapshot') {
    if (!managementWatchDeps) {
      writeJson(res, 503, { ok: false, error: 'management_watch_unavailable' });
      return true;
    }
    const broadcasted = notifyManagementWatchers({
      state,
      options,
      deps: managementWatchDeps
    }, { force: true });
    writeJson(res, 202, {
      ok: true,
      accepted: true,
      broadcasted,
      requestedAt: Date.now()
    });
    return true;
  }
  if (method === 'GET' && pathname === '/v0/management/status') {
    writeJson(res, 200, buildManagementStatusPayload(state, options, { accountStateIndex }));
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
      getRegistryModelList,
      fs,
      aiHomeDir
    });
    writeJson(res, out.status, out.payload);
    return true;
  }
  if (method === 'GET' && pathname === '/v0/management/accounts') {
    writeJson(res, 200, buildManagementAccountsPayload(state, { fs, aiHomeDir, accountStateIndex }));
    return true;
  }

  if (pathname.startsWith('/v0/management/usage')) {
    return await handleModelUsageManagementRequest(ctx, modelUsageService, writeJson, onTokenUsageUpdated);
  }
  if (method === 'POST' && pathname === '/v0/management/reload') {
    // aiHomeDir 是凭据目录的根：漏传会让 listAccountCredentialRecords 一条都读不到，
    // reload 于是把整个账号池换成空池，网关立刻全线 no_available_account。
    const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
      fs,
      aiHomeDir,
      accountStateIndex,
      accountStateService,
      getProfileDir,
      checkStatus,
      serverPort: options.port
    }, { accountQueryService, accountRuntimeGate }));
    applyReloadState(state, runtimeAccounts);
    // 池变即推送（见 go-core-projection-sync）：运维 reload 后新账号的规则必须立刻生效。
    notifyGoCoreProjection(ctx, 'upstreamErrorRules');
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
    if (managementWatchDeps) {
      notifyManagementWatchers({
        state,
        options,
        deps: managementWatchDeps
      });
    }
    return true;
  }
  if (method === 'POST' && pathname === '/v0/management/cooldown/clear') {
    // 统一门禁：全局清空与账号级「恢复调度」是同一条人工覆盖路径（evidence=manual_admin_clear），
    // 这里不再自己拼内存清理 + 直接写 DB（见 account-runtime-gate 的 forceRecover）。
    const gate = getAccountRuntimeGate(state, { accountStateService });
    SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
      const accounts = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
      accounts.forEach((a) => {
        gate.forceRecover({ account: a, provider, source: 'management.cooldown.clear' });
      });
    });
    writeJson(res, 200, { ok: true });
    if (managementWatchDeps) {
      notifyManagementWatchers({
        state,
        options,
        deps: managementWatchDeps
      });
    }
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

  if (method === 'POST' && pathname === '/v0/management/state-index/operational-status') {
    if (!accountStateService || typeof accountStateService.setOperationalStatus !== 'function') {
      writeJson(res, 503, { ok: false, error: 'state_index_unavailable' });
      return true;
    }
    const payload = await readManagementJson(req, readRequestBody);
    const provider = String(payload && payload.provider || '').trim();
    const accountRef = String(payload && payload.accountRef || '').trim();
    const status = String(payload && payload.status || '').trim();
    const baseState = sanitizeBaseState(payload && payload.baseState);
    if (!provider || !isAccountRef(accountRef) || !status) {
      writeJson(res, 400, { ok: false, error: 'invalid_state_index_payload' });
      return true;
    }
    const updated = accountStateService.setOperationalStatus(
      accountRef,
      provider,
      status,
      baseState
    );
    writeJson(res, 200, { ok: true, updated: !!updated });
    return true;
  }

  if (method === 'POST' && pathname === '/v0/management/state-index/upsert') {
    if (!accountStateService || typeof accountStateService.syncAccountBaseState !== 'function') {
      writeJson(res, 503, { ok: false, error: 'state_index_unavailable' });
      return true;
    }
    const payload = await readManagementJson(req, readRequestBody);
    const provider = String(payload && payload.provider || '').trim();
    const accountRef = String(payload && payload.accountRef || '').trim();
    const state = sanitizeBaseState(payload && payload.state);
    if (!provider || !isAccountRef(accountRef)) {
      writeJson(res, 400, { ok: false, error: 'invalid_state_index_payload' });
      return true;
    }
    const updated = accountStateService.syncAccountBaseState(accountRef, provider, state);
    writeJson(res, 200, { ok: true, updated: !!updated });
    return true;
  }

  if (method === 'POST' && pathname === '/v0/management/state-index/prune-missing') {
    if (!accountStateService || typeof accountStateService.pruneMissing !== 'function') {
      writeJson(res, 503, { ok: false, error: 'state_index_unavailable' });
      return true;
    }
    const payload = await readManagementJson(req, readRequestBody);
    const provider = String(payload && payload.provider || '').trim();
    const existingRefs = Array.isArray(payload && payload.existingRefs) ? payload.existingRefs : [];
    if (!provider) {
      writeJson(res, 400, { ok: false, error: 'invalid_state_index_payload' });
      return true;
    }
    const normalizedRefs = existingRefs
      .map((accountRef) => String(accountRef || '').trim())
      .filter((accountRef) => isAccountRef(accountRef));
    const removed = accountStateService.pruneMissing(provider, normalizedRefs);
    writeJson(res, 200, { ok: true, removed: Number(removed) || 0 });
    return true;
  }

  writeJson(res, 404, { ok: false, error: 'management_not_found' });
  return true;
}

module.exports = {
  handleManagementRequest,
  __private: {
    clearAccountRuntimeBlock,
    handleModelUsageManagementRequest
  }
};
