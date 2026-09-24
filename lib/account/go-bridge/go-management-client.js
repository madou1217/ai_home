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
        errorCode: error ? String(error.code || '') : (response.ok ? '' : `http_${response.status}`)
      };
    } catch (error) {
      return { ok: false, status: 0, data: null, page: null, errorCode: error && error.name === 'AbortError' ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
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
    send: (request) => call(request.method, request.path, request.body),
    getAccount: (accountRef) => call('GET', `/v1/management/accounts/${encodeURIComponent(accountRef)}`),
    setEnabled: (accountRef, enabled) => call('PATCH', `/v1/management/accounts/${encodeURIComponent(accountRef)}`, { enabled }),
    deleteAccount: (accountRef) => call('DELETE', `/v1/management/accounts/${encodeURIComponent(accountRef)}`),
    setProviderDefault: (providerId, accountRef) => call('PUT', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`, { account_ref: accountRef }),
    clearProviderDefault: (providerId) => call('DELETE', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`),
    getProviderDefault: (providerId) => call('GET', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`),
    exportSub2api: (accountRef) => call('GET', `/v1/management/accounts/${encodeURIComponent(accountRef)}/export`),
    listAccounts
  };
}

module.exports = {
  createGoManagementClient
};
