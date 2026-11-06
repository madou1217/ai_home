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

  // 账号级配置：只推账号自身规则与挂载组 id，有效规则由 Go 拼装。
  function putAccountUpstreamErrorRules(accountRef, payload) {
    return call(
      'PUT',
      '/v1/management/accounts/' + encodeURIComponent(String(accountRef || '')) + '/upstream-error-rules',
      payload
    );
  }

  // 清空账号级配置（Go 侧幂等；账号已删除时返回 deleted:false）。
  function deleteAccountUpstreamErrorRules(accountRef) {
    return call(
      'DELETE',
      '/v1/management/accounts/' + encodeURIComponent(String(accountRef || '')) + '/upstream-error-rules'
    );
  }

  // 全部账号级配置：用于对账与删除 Go 侧已不存在的旧引用。
  function listAccountUpstreamErrorRules() {
    return call('GET', '/v1/management/account-upstream-error-rules');
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
    putAccountUpstreamErrorRules,
    deleteAccountUpstreamErrorRules,
    listAccountUpstreamErrorRules,
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
    // 完整 Provider 额度快照文档：Go 是存储真相，Node 只做采集与读缓存。
    putUsageDocument: (accountRef, document) => call('PUT', `/v1/management/accounts/${encodeURIComponent(accountRef)}/usage-document`, document),
    getUsageDocument: (accountRef) => call('GET', `/v1/management/accounts/${encodeURIComponent(accountRef)}/usage-document`),
    listUsageDocuments: () => call('GET', '/v1/management/account-usage-documents'),
    // Go 里的归一化额度事实（窗口/剩余/可用性）：Node 用它判断哪些快照还没归一化。
    listAccountUsage: () => call('GET', '/v1/management/account-usage'),
    // Go 派生的账号级额度状态（含 codex Team/Free 的 pending 语义），账号页只做展示叠加。
    listAccountQuotaStates: () => call('GET', '/v1/management/account-quota-states'),
    // 账号页展示状态：Node 是写方，Go 持久化。
    putUIState: (accountRef, state) => call('PUT', `/v1/management/accounts/${encodeURIComponent(accountRef)}/ui-state`, state),
    listUIStates: () => call('GET', '/v1/management/account-ui-states'),
    // 账号级运行态文档：Node 事件转移后写入完整 runtime_state，Go 存储并派生状态与阻塞。
    putRuntimeState: (accountRef, state, updatedAt) => call(
      'PUT',
      `/v1/management/accounts/${encodeURIComponent(accountRef)}/runtime-state`,
      { state, updated_at: String(Math.max(0, Math.floor(Number(updatedAt) || 0))) }
    ),
    deleteRuntimeState: (accountRef, updatedAt) => call(
      'PUT',
      `/v1/management/accounts/${encodeURIComponent(accountRef)}/runtime-state`,
      { state: null, updated_at: String(Math.max(0, Math.floor(Number(updatedAt) || 0))) }
    ),
    listRuntimeStates: () => call('GET', '/v1/management/account-runtime-states'),
    // 成功尝试的 token 用量事件（按序号增量），计入账号 Token 用量。
    listAccountUsageEvents: (afterSeq) => call('GET', `/v1/management/account-usage-events?after_seq=${Math.max(0, Math.floor(Number(afterSeq) || 0))}`),
    // OAuth Job 公开快照：Node 是登录执行者，Go 只负责跨重启持久化与查询。
    putOAuthJob: (record) => call('PUT', `/v1/management/oauth-jobs/${encodeURIComponent(record.job_id)}`, record),
    getOAuthJob: (jobId) => call('GET', `/v1/management/oauth-jobs/${encodeURIComponent(jobId)}`),
    listOAuthJobs: (activeOnly) => call('GET', `/v1/management/oauth-jobs${activeOnly ? '?active=1' : ''}`),
    listAccounts
  };
}

module.exports = {
  createGoManagementClient
};
