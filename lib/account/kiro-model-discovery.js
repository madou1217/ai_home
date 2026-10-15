'use strict';

// kiro 的模型发现策略（描述符 `models.strategies` 的实现）。
//
// **纯 HTTP 优先**：codewhisperer ListAvailableModels（实测 200，返回 defaultModel + models[]），
// token 过期时先用内嵌 device-registration 自刷新（见 lib/account/kiro-grant-store.js）。
// 这样「没装本地 kiro CLI」也能列出模型，不再报 `native_cli_model_discovery_cli_not_found`。

const { readAccountCredentialRecord } = require('../server/account-credential-store');
const { ensureFreshKiroGrant } = require('./kiro-grant-store');
const { fetchKiroAvailableModels } = require('./kiro-model-catalog');

function createKiroHttpModelDiscovery(options = {}) {
  const readRecord = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const ensureFresh = options.ensureFreshKiroGrant || ensureFreshKiroGrant;
  const fetchModels = options.fetchKiroAvailableModels || fetchKiroAvailableModels;

  async function discover(account, timeoutMs) {
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef) return { error: 'kiro_models_missing_account_ref' };
    const record = readRecord(options.fs, options.aiHomeDir, accountRef);
    if (!record || record.provider !== 'kiro') return { error: 'credential_record_missing' };
    const request = (url, init) => (options.fetchWithTimeout
      ? options.fetchWithTimeout(url, init, Math.max(1000, Number(timeoutMs) || 10000))
      : fetch(url, init));
    try {
      const fresh = await ensureFresh(record, {
        fs: options.fs,
        aiHomeDir: options.aiHomeDir,
        accountRef,
        request,
        timeoutMs
      });
      if (fresh.error) return { error: fresh.error };
      const catalog = await fetchModels(fresh.record.nativeAuth.auth, { request, timeoutMs });
      return { models: catalog.models, defaultModel: catalog.defaultModel };
    } catch (error) {
      return { error: error && error.code || 'kiro_models_discovery_failed' };
    }
  }

  return { discover };
}

module.exports = { createKiroHttpModelDiscovery };
