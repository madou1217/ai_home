'use strict';

// Go 管理 API（/v1/management/*）的最小客户端。只做传输与错误结构化，不做业务决策；
// Management Key 只进 Authorization 头，不进 URL、日志或错误文本。

function createGoManagementClient(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const managementKey = String(options.managementKey || '');
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
  if (!baseUrl || !managementKey) throw new Error('go management client requires baseUrl and managementKey');

  async function call(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${managementKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const raw = await response.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch (_error) {}
      const error = json && json.error && typeof json.error === 'object' ? json.error : null;
      return {
        ok: response.ok,
        status: response.status,
        data: json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json,
        page: json && json.page ? json.page : null,
        // 完整响应体：少数接口在 data 之外还有游标字段（如用量事件的 boot_id / latest_seq）。
        body: json,
        errorCode: error ? String(error.code || '') : (response.ok ? '' : `http_${response.status}`)
      };
    } catch (error) {
      return { ok: false, status: 0, data: null, page: null, errorCode: error && error.name === 'AbortError' ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  // 插件发布投影：整体替换 Go 的存活代次集合，返回 Go 已接受的代次（data.generations）。
  function pushPluginProjection(payload) {
    return call('PUT', '/v1/management/plugins/projection', payload);
  }

  // 模型别名投影：整体替换 Go 的别名表，返回已接受 id 与已应用代次
  // （data.accepted_ids / data.applied_generation）。Go 只接受它能忠实执行的别名。
  function pushModelAliases(aliases) {
    return call('PUT', '/v1/management/model-aliases', { aliases });
  }

  // 只读诊断：查看 Go 当前存储与已应用的别名代次。
  function getModelAliases() {
    return call('GET', '/v1/management/model-aliases');
  }

  // 账号自定义上游错误规则投影：整体替换 Go 的规则表，返回 Go 已承接的账号引用
  // （data.accepted_account_refs）、丢弃原因（data.dropped）与已接入的 Provider
  // （data.supported_providers）。规则编译是同步的，因此返回的代次即已应用代次。
  function pushUpstreamErrorRules(accounts) {
    return call('PUT', '/v1/management/upstream-error-rules', { accounts });
  }

  // 只读诊断：查看 Go 当前持有的规则投影与它已接入的 Provider。
  function getUpstreamErrorRules() {
    return call('GET', '/v1/management/upstream-error-rules');
  }

  // 全局公共模型目录投影：Node 仍拥有远端探测与合并，Go 只接收最近完整快照。
  function pushModelCatalogProjection(payload) {
    return call('PUT', '/v1/management/model-catalog', payload);
  }

  function getModelCatalog() {
    return call('GET', '/v1/management/model-catalog');
  }

  // Go Host authoritative management projections. These are read-only shadow
  // contracts; Node remains the production owner of /v0/management/*.
  function getManagementStatus() {
    return call('GET', '/v1/management/status');
  }

  function getManagementMetrics() {
    return call('GET', '/v1/management/metrics');
  }

  function buildUsageQuery(query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const suffix = params.toString();
    return suffix ? `?${suffix}` : '';
  }

  function getUsageStats(query = {}) {
    return call('GET', `/v1/management/usage/stats${buildUsageQuery(query)}`);
  }

  function getUsageModels(query = {}) {
    return call('GET', `/v1/management/usage/models${buildUsageQuery(query)}`);
  }

  function getUsageSessions(query = {}) {
    return call('GET', `/v1/management/usage/sessions${buildUsageQuery(query)}`);
  }

  // Go 账号列表使用 after_ref keyset 分页（page.has_more / page.next_after_ref）。
  async function listAccounts() {
    const accounts = [];
    let afterRef = '';
    for (let guard = 0; guard < 10000; guard += 1) {
      const query = afterRef ? `?limit=100&after_ref=${encodeURIComponent(afterRef)}` : '?limit=100';
      const result = await call('GET', `/v1/management/accounts${query}`);
      if (!result.ok) return { ...result, data: accounts };
      for (const item of Array.isArray(result.data) ? result.data : []) accounts.push(item);
      const page = result.page || {};
      if (!page.has_more || !page.next_after_ref) {
        return { ok: true, status: 200, data: accounts, page: null, errorCode: '' };
      }
      afterRef = String(page.next_after_ref);
    }
    return { ok: false, status: 0, data: accounts, page: null, errorCode: 'pagination_runaway' };
  }

  return {
    pushPluginProjection,
    pushModelAliases,
    getModelAliases,
    pushUpstreamErrorRules,
    getUpstreamErrorRules,
    pushModelCatalogProjection,
    getModelCatalog,
    getManagementStatus,
    getManagementMetrics,
    getUsageStats,
    getUsageModels,
    getUsageSessions,
    send: (request) => call(request.method, request.path, request.body),
    getAccount: (accountRef) => call('GET', `/v1/management/accounts/${encodeURIComponent(accountRef)}`),
    setEnabled: (accountRef, enabled) => call('PATCH', `/v1/management/accounts/${encodeURIComponent(accountRef)}`, { enabled }),
    deleteAccount: (accountRef) => call('DELETE', `/v1/management/accounts/${encodeURIComponent(accountRef)}`),
    setProviderDefault: (providerId, accountRef) => call('PUT', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`, { account_ref: accountRef }),
    clearProviderDefault: (providerId) => call('DELETE', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`),
    getProviderDefault: (providerId) => call('GET', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`),
    setModelPolicy: (accountRef, modelId, manualPolicy) => call('PATCH', `/v1/management/accounts/${encodeURIComponent(accountRef)}/models`, { model_id: modelId, manual_policy: manualPolicy }),
    // 账号结果时间桶（账号页状态条）：granularity = day | hour。
    listAccountOutcomes: (granularity, fromMs) => call('GET', `/v1/management/account-outcomes?granularity=${encodeURIComponent(granularity)}&from_ms=${Math.max(0, Math.floor(Number(fromMs) || 0))}`),
    // 账号当前运行态（硬阻塞 / 模型 cooldown / 最近结果），账号页调度状态叠加层用。
    listAccountRuntime: () => call('GET', '/v1/management/account-runtime'),
    // 成功尝试的 token 用量事件（按序号增量），计入账号 Token 用量。
    listAccountUsageEvents: (afterSeq) => call('GET', `/v1/management/account-usage-events?after_seq=${Math.max(0, Math.floor(Number(afterSeq) || 0))}`),
    listAccounts
  };
}

module.exports = {
  createGoManagementClient
};
