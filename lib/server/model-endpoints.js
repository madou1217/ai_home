'use strict';
const { listEnabledProviders } = require('./providers');

async function buildManagementModelsResponse(params) {
  const {
    options,
    state,
    url,
    fetchModelsForAccount
  } = params;

  const forceRefresh = ['1', 'true', 'yes'].includes(String(url.searchParams.get('refresh') || '').toLowerCase());
  const accountLimitRaw = String(url.searchParams.get('accounts') || '').trim();
  const accountLimit = /^\d+$/.test(accountLimitRaw) ? Math.max(1, Number(accountLimitRaw)) : 3;
  const cacheTtlRaw = String(url.searchParams.get('ttl_ms') || '').trim();
  const cacheTtl = /^\d+$/.test(cacheTtlRaw) ? Math.max(1000, Number(cacheTtlRaw)) : 5 * 60 * 1000;
  const now = Date.now();

  if (!forceRefresh && state.modelsCache.updatedAt > 0 && now - state.modelsCache.updatedAt < cacheTtl) {
    return {
      status: 200,
      payload: {
        ok: true,
        cached: true,
        updatedAt: state.modelsCache.updatedAt,
        sources: state.modelsCache.sourceCount,
        models: state.modelsCache.ids
      }
    };
  }

  const candidates = [];
  listEnabledProviders(options && options.provider).forEach((provider) => {
    if (provider === 'codex') return;
    const accounts = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
    accounts
      .filter((a) => !!a.accessToken)
      .forEach((account) => {
        if (candidates.length < accountLimit) candidates.push(account);
      });
  });
  const modelSet = new Set();
  const byAccount = {};
  let sourceCount = 0;
  let firstError = '';
  for (const acc of candidates) {
    const availableModels = Array.isArray(acc && acc.availableModels) ? acc.availableModels : [];
    availableModels.forEach((id) => {
      const safe = String(id || '').trim();
      if (safe) modelSet.add(safe);
    });
    if (!acc || !acc.accessToken) {
      byAccount[acc && acc.id ? acc.id : 'unknown'] = availableModels;
      continue;
    }
    try {
      const models = await fetchModelsForAccount(options, acc, 8000);
      byAccount[acc.id] = models;
      models.forEach((m) => modelSet.add(m));
      sourceCount += 1;
    } catch (e) {
      byAccount[acc.id] = [];
      if (!firstError) firstError = String((e && e.message) || e);
    }
  }

  const ids = Array.from(modelSet).sort();
  state.modelsCache = {
    updatedAt: now,
    ids,
    byAccount,
    sourceCount
  };

  return {
    status: 200,
    payload: {
      ok: true,
      cached: false,
      updatedAt: state.modelsCache.updatedAt,
      scannedAccounts: candidates.length,
      sources: sourceCount,
      models: ids,
      firstError
    }
  };
}

module.exports = {
  buildManagementModelsResponse
};
