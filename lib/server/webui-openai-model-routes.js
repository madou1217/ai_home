'use strict';

const { buildGatewayModelEntries, mergeGatewayModelEntries } = require('./gateway-model-list');
const { loadAliases } = require('./model-alias-store');
const { buildModelCapabilityIndex } = require('./model-capability-index');
const { buildOpenAIModelsList } = require('./models');
const { getWebUiModelsCache } = require('./webui-model-cache');
const {
  accountMatchesScope,
  listAccountModelCacheRefs,
  normalizeAccountScope
} = require('./provider-model-discovery');
const { withAccountQueryListFns } = require('./account-load-args');
const {
  buildModelAccountRefProjection
} = require('./webui-model-account-ref-projection');
const { triggerWebUiModelRefreshSoon } = require('./webui-model-refresh-scheduler');
const {
  attachModelMetadata,
  buildModelMetadataMap
} = require('./models-dev-metadata');
const {
  applyModelCatalogSettingsToEntries,
  findAccountModelSetting,
  isAccountModelEnabled,
  listManualModelSettings,
  loadModelCatalogSettings,
  normalizeAccountModelSettingRecord,
  normalizeModelCatalogSettings,
  removeAccountModelSetting,
  saveModelCatalogSettings,
  upsertAccountModelSetting
} = require('./model-catalog-settings-store');
const {
  attachSseWatcher,
  broadcastSseJson,
  openSseStream,
  writeSseJson
} = require('./webui-sse-broadcaster');
const {
  isApiCredentialAccount,
  resolveRuntimeAuthMode
} = require('../account/runtime-auth-mode');
const { listProvidersByCapability } = require('../provider-catalog');

const MODEL_CATALOG_PROVIDERS = Object.freeze(listProvidersByCapability('modelCatalog'));
const MAX_MODEL_CATALOG_JOBS = 12;

function getAccountDisplayName(account) {
  const pick = (value) => String(value || '').trim();
  // oauth 账号 → 邮箱(有真实展示名/名称则优先)。
  const named = pick(account && account.displayName)
    || pick(account && account.email)
    || pick(account && account.name);
  if (named) return named;
  // api-key / auth-token 账号 → url 的域名（它是生成稳定 accountRef 的身份因子），
  // 而不是可变的 CLI account id。用户不该在这里看到裸 CLI 索引。
  const baseUrl = pick(account && (account.baseUrl || account.openaiBaseUrl || account.url));
  if (baseUrl) {
    try {
      return new URL(baseUrl).host || baseUrl;
    } catch (_error) {
      return baseUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || baseUrl;
    }
  }
  return '';
}

function listProviderAccounts(state, provider) {
  const accounts = state && state.accounts && state.accounts[provider];
  return Array.isArray(accounts) ? accounts : [];
}

function getAccountRef(provider, account) {
  return listAccountModelCacheRefs(provider, account)[0] || '';
}

function getAccountScopeKey(scope) {
  const target = normalizeAccountScope(scope);
  if (!target) return 'global';
  return target.accountRef;
}

function serializeAccountScope(scope) {
  const target = normalizeAccountScope(scope);
  if (!target) return null;
  return {
    accountRef: target.accountRef || ''
  };
}

function hasSingleAccountScope(scope) {
  const target = normalizeAccountScope(scope);
  return Boolean(target && target.accountRef);
}

function findScopedAccount(state, scope) {
  const target = normalizeAccountScope(scope);
  if (!hasSingleAccountScope(target)) return null;
  for (const provider of MODEL_CATALOG_PROVIDERS) {
    const account = listProviderAccounts(state, provider)
      .find((item) => accountMatchesScope(provider, item, target));
    if (account) return { provider, account };
  }
  return null;
}

function findModelTargetAccount(state, target) {
  const provider = String(target && target.provider || '').trim();
  const accountRef = String(target && target.accountRef || '').trim();
  if (!provider || !accountRef) return null;
  return listProviderAccounts(state, provider)
    .find((account) => getAccountRef(provider, account) === accountRef) || null;
}

function getContextFs(ctx) {
  return ctx && (ctx.fs || ctx.deps && ctx.deps.fs);
}

function getContextAiHomeDir(ctx) {
  return String(ctx && (ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir) || '').trim();
}

function getModelMetadataDeps(ctx) {
  return {
    fs: getContextFs(ctx),
    modelsDevDir: ctx && ctx.deps && ctx.deps.modelsDevDir
  };
}

function reloadRuntimeAccountsForModelRefresh(ctx) {
  const deps = ctx && ctx.deps || {};
  const state = ctx && ctx.state;
  const loadServerRuntimeAccounts = ctx && ctx.loadServerRuntimeAccounts || deps.loadServerRuntimeAccounts;
  const applyReloadState = ctx && ctx.applyReloadState || deps.applyReloadState;
  if (!state || typeof loadServerRuntimeAccounts !== 'function' || typeof applyReloadState !== 'function') {
    return false;
  }
  const reloadDeps = {
    ...deps,
    accountQueryService: ctx.accountQueryService || deps.accountQueryService,
    accountStateService: ctx.accountStateService || deps.accountStateService
  };
  const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
    fs: getContextFs(ctx),
    aiHomeDir: getContextAiHomeDir(ctx),
    accountStateIndex: ctx.accountStateIndex || deps.accountStateIndex,
    getProfileDir: ctx.getProfileDir || deps.getProfileDir,
    checkStatus: ctx.checkStatus || deps.checkStatus,
    serverPort: ctx.options && ctx.options.port
  }, reloadDeps));
  applyReloadState(state, runtimeAccounts);
  return true;
}

function resolveScopedAccountForRefresh(ctx, accountScope) {
  const existing = findScopedAccount(ctx.state || {}, accountScope);
  if (existing) return existing;
  reloadRuntimeAccountsForModelRefresh(ctx);
  return findScopedAccount(ctx.state || {}, accountScope);
}

function shouldProbeCodexForScope(scope) {
  const target = normalizeAccountScope(scope);
  return Boolean(target && target.provider === 'codex');
}

function collectDescriptorModels(account) {
  return []
    .concat(Array.isArray(account && account.codeAssistModelDescriptors) ? account.codeAssistModelDescriptors : [])
    .concat(Array.isArray(account && account.availableModelDescriptors) ? account.availableModelDescriptors : [])
    .concat(Array.isArray(account && account.modelDescriptors) ? account.modelDescriptors : [])
    .map((descriptor) => String(descriptor && (descriptor.id || descriptor.modelId) || '').trim())
    .filter(Boolean);
}

function addAccountModelEntry(entriesByKey, entry) {
  const normalized = normalizeAccountModelSettingRecord(entry);
  if (!normalized) return;
  const key = `${normalized.accountRef}\u0000${normalized.id.toLowerCase()}`;
  const previous = entriesByKey.get(key);
  const source = String(entry && entry.source || '').trim() || 'discovered';
  const priority = { manual: 4, 'webui-probe': 3, account: 2, descriptor: 1, configured: 0 };
  if (previous && Number(priority[previous.source] || 0) > Number(priority[source] || 0)) return;
  entriesByKey.set(key, {
    id: normalized.id,
    provider: normalized.provider,
    accountRef: normalized.accountRef,
    source,
    manual: entry && entry.manual === true,
    description: String(entry && entry.description || '').trim()
  });
}

function addAccountModelList(entriesByKey, account, models, source) {
  const provider = String(account && account.provider || '').trim();
  const accountRef = getAccountRef(provider, account);
  if (!accountRef) return;
  (Array.isArray(models) ? models : []).forEach((id) => {
    addAccountModelEntry(entriesByKey, {
      id,
      provider,
      accountRef,
      source
    });
  });
}

function buildCatalogModelEntries(catalogResult, state = {}, settings = null, accountScope = null) {
  const entries = [];
  const entriesByKey = new Map();
  const byAccount = catalogResult && catalogResult.byAccount && typeof catalogResult.byAccount === 'object'
    ? catalogResult.byAccount
    : {};

  MODEL_CATALOG_PROVIDERS.forEach((provider) => {
    listProviderAccounts(state, provider).filter((account) => accountMatchesScope(provider, account, accountScope)).forEach((account) => {
      const accountRef = getAccountRef(provider, account);
      if (!accountRef) return;
      if (Object.prototype.hasOwnProperty.call(byAccount, accountRef)) {
        addAccountModelList(entriesByKey, account, byAccount[accountRef], 'webui-probe');
        return;
      }
      addAccountModelList(entriesByKey, account, account && account.availableModels, 'account');
      addAccountModelList(entriesByKey, account, collectDescriptorModels(account), 'descriptor');
    });
  });

  if (!accountScope && entriesByKey.size < 1) {
    Object.entries(catalogResult && catalogResult.models && typeof catalogResult.models === 'object' ? catalogResult.models : {})
      .forEach(([provider, modelIds]) => {
        (Array.isArray(modelIds) ? modelIds : []).forEach((id) => {
          const modelId = String(id || '').trim();
          if (!modelId) return;
          entries.push({ id: modelId, provider, source: 'webui-probe' });
        });
      });
  }

  listManualModelSettings(settings, { enabledOnly: false }).forEach((record) => {
    if (!accountMatchesScope(record.provider, record, accountScope)) return;
    addAccountModelEntry(entriesByKey, {
      ...record,
      source: 'manual',
      manual: true
    });
  });

  return [
    ...entries,
    ...Array.from(entriesByKey.values())
  ].sort((a, b) => (
    String(a.provider || '').localeCompare(String(b.provider || ''))
    || String(a.accountRef || '').localeCompare(String(b.accountRef || ''))
    || String(a.id || '').localeCompare(String(b.id || ''))
  ));
}

function buildModelAccountSummaries(ctx, state, settings = null) {
  const accountsByRef = new Map();
  MODEL_CATALOG_PROVIDERS.forEach((provider) => {
    listProviderAccounts(state, provider).forEach((account) => {
      const accountRef = getAccountRef(provider, account);
      if (!accountRef) return;
      accountsByRef.set(accountRef, {
        provider,
        accountRef,
        displayName: getAccountDisplayName(account) || accountRef,
        email: String(account && account.email || '').trim(),
        apiKeyMode: isApiCredentialAccount(account),
        authType: resolveRuntimeAuthMode(account) || String(account && account.authType || '').trim()
      });
    });
  });
  listManualModelSettings(settings, { enabledOnly: false }).forEach((record) => {
    if (!record.accountRef || accountsByRef.has(record.accountRef)) return;
    accountsByRef.set(record.accountRef, {
      provider: record.provider,
      accountRef: record.accountRef,
      displayName: record.accountRef,
      email: '',
      apiKeyMode: false,
      authType: ''
    });
  });
  return Array.from(accountsByRef.values()).sort((a, b) => (
    a.provider.localeCompare(b.provider)
    || a.accountRef.localeCompare(b.accountRef)
  ));
}

async function loadAliasData(ctx) {
  const deps = ctx.deps || {};
  if (!ctx.fs || !ctx.aiHomeDir) return { aliases: [] };
  if (typeof deps.loadAliases === 'function') {
    return deps.loadAliases(ctx.fs, ctx.aiHomeDir);
  }
  return loadAliases(ctx.fs, ctx.aiHomeDir, deps);
}

async function loadModelSettingsData(ctx) {
  const deps = ctx.deps || {};
  if (!ctx.fs || !ctx.aiHomeDir) return normalizeModelCatalogSettings(null);
  if (typeof deps.loadModelCatalogSettings === 'function') {
    const data = await deps.loadModelCatalogSettings(ctx.fs, ctx.aiHomeDir);
    ctx.state.modelCatalogSettings = data;
    return data;
  }
  const data = await loadModelCatalogSettings(ctx.fs, ctx.aiHomeDir);
  ctx.state.modelCatalogSettings = data;
  return data;
}

async function saveModelSettingsData(ctx, data) {
  const deps = ctx.deps || {};
  if (typeof deps.saveModelCatalogSettings === 'function') {
    const saved = await deps.saveModelCatalogSettings(ctx.fs, ctx.aiHomeDir, data);
    ctx.state.modelCatalogSettings = saved;
    return saved;
  }
  const saved = await saveModelCatalogSettings(ctx.fs, ctx.aiHomeDir, data);
  ctx.state.modelCatalogSettings = saved;
  return saved;
}

function getSettingsFreeState(state) {
  return {
    ...(state || {}),
    modelCatalogSettings: normalizeModelCatalogSettings(null)
  };
}

async function buildModelEntrySets(ctx, catalogResult, settings, accountScope = null) {
  let aliasData = { aliases: [] };
  try {
    // 真实 /v1/models 会合并 alias/gateway 能力；模型页也必须沿用这条输出口径。
    aliasData = await loadAliasData(ctx);
  } catch (_error) {
    aliasData = { aliases: [] };
  }

  const rawState = getSettingsFreeState(ctx.state || {});
  const options = ctx.options || {};
  const accountEntries = buildCatalogModelEntries(catalogResult, rawState, settings, accountScope);
  const baseEntries = accountEntries.length > 0
    ? accountEntries
    : (accountScope ? [] : buildGatewayModelEntries(rawState, options));
  const finalEntries = mergeGatewayModelEntries(baseEntries, aliasData.aliases, {
    state: ctx.state || {},
    options,
    modelCapabilityIndex: buildModelCapabilityIndex(ctx.state || {}, options),
    modelCatalogSettings: settings
  });
  const managedEntries = applyModelCatalogSettingsToEntries(accountEntries, normalizeModelCatalogSettings(null), {
    providerMode: options.provider
  });
  return {
    finalEntries,
    managedEntries: accountEntries.length > 0 || accountScope ? accountEntries : managedEntries
  };
}

async function buildDisplayModelItems(ctx, catalogResult, settings) {
  const entrySets = await buildModelEntrySets(ctx, catalogResult, settings);
  return buildOpenAIModelsList(entrySets.finalEntries).data;
}

function resolveProviderFromOpenAIModel(model) {
  const id = String(model && model.id || '').trim().toLowerCase();
  const owner = String(model && model.owned_by || '').trim().toLowerCase();
  if (owner === 'openai' || id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'codex';
  if (owner === 'google' || id.startsWith('gemini-')) return 'gemini';
  if (owner === 'anthropic' || id.startsWith('claude-') || id.startsWith('anthropic.')) return 'claude';
  if (owner === 'opencode' || id.startsWith('opencode-go/') || id.startsWith('opencode/')) return 'opencode';
  return '';
}

function buildOpenAIModelsByProvider(displayItems, entries) {
  const grouped = {};
  MODEL_CATALOG_PROVIDERS.forEach((provider) => {
    grouped[provider] = new Set();
  });

  // 先按最终 /v1/models owner 归类，再合并真实探测 provider；聚合 provider 可能服务同一个模型。
  (Array.isArray(displayItems) ? displayItems : []).forEach((model) => {
    const provider = resolveProviderFromOpenAIModel(model);
    if (!provider || !grouped[provider]) return;
    const modelId = String(model && model.id || '').trim();
    if (!modelId) return;
    grouped[provider].add(modelId);
  });

  (Array.isArray(entries) ? entries : [])
    .forEach((entry) => {
      const provider = String(entry && entry.provider || '').trim();
      if (!provider || !grouped[provider]) return;
      const modelId = String(entry && entry.id || '').trim();
      if (modelId) grouped[provider].add(modelId);
    });

  const out = {};
  MODEL_CATALOG_PROVIDERS.forEach((provider) => {
    out[provider] = Array.from(grouped[provider]).sort();
  });
  return out;
}

function buildManagedModelItems(ctx, rawEntries, settings, accountScope = null) {
  const recordsByKey = new Map();
  const addEntry = (entry) => {
    const id = String(entry && entry.id || '').trim();
    if (!id) return;
    const normalized = normalizeAccountModelSettingRecord(entry);
    const key = normalized ? `${normalized.accountRef}\u0000${normalized.id.toLowerCase()}` : `legacy\u0000${id.toLowerCase()}`;
    if (!recordsByKey.has(key)) {
      recordsByKey.set(key, {
        id,
        provider: normalized ? normalized.provider : String(entry && entry.provider || '').trim(),
        accountRef: normalized ? normalized.accountRef : '',
        source: String(entry && entry.source || '').trim() || 'discovered',
        manual: entry && entry.manual === true,
        description: String(entry && entry.description || '').trim()
      });
    }
    const record = recordsByKey.get(key);
    const provider = String(entry && entry.provider || '').trim();
    if (MODEL_CATALOG_PROVIDERS.includes(provider)) record.provider = provider;
    if (String(entry && entry.source || '').trim() === 'manual') record.source = 'manual';
    if (entry && entry.manual === true) record.manual = true;
  };

  (Array.isArray(rawEntries) ? rawEntries : []).forEach(addEntry);
  listManualModelSettings(settings, { enabledOnly: false }).forEach((record) => {
    if (!accountMatchesScope(record.provider, record, accountScope)) return;
    addEntry({
      id: record.id,
      provider: record.provider,
      accountRef: record.accountRef,
      source: 'manual'
    });
  });

  return Array.from(recordsByKey.values())
    .sort((a, b) => (
      String(a.provider || '').localeCompare(String(b.provider || ''))
      || String(a.accountRef || '').localeCompare(String(b.accountRef || ''))
      || a.id.localeCompare(b.id)
    ))
    .map((record) => {
      const setting = findAccountModelSetting(settings, record);
      const model = buildOpenAIModelsList([{ id: record.id, provider: record.provider || '' }]).data[0];
      return {
        ...model,
        provider: record.provider,
        accountRef: record.accountRef,
        enabled: isAccountModelEnabled(settings, record),
        manual: Boolean(record.manual || setting && setting.manual === true),
        defaultModel: Boolean(setting && setting.defaultModel === true),
        source: setting && setting.manual === true ? 'manual' : record.source,
        providers: record.provider ? [record.provider] : [],
        description: String(setting && setting.description || ''),
        updatedAt: Number(setting && setting.updatedAt || 0)
      };
    });
}

async function readJsonRequestBody(ctx) {
  const { req, res, deps, writeJson } = ctx;
  const readRequestBody = deps && deps.readRequestBody;
  if (typeof readRequestBody !== 'function') {
    writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
    return null;
  }
  const bodyBufferResult = await readRequestBody(req, { maxBytes: 1024 * 1024 }).catch((error) => ({ __error: error }));
  if (!bodyBufferResult || bodyBufferResult.__error) {
    writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
    return null;
  }
  try {
    return JSON.parse(bodyBufferResult.toString('utf8'));
  } catch (_error) {
    writeJson(res, 400, { ok: false, error: 'invalid_json' });
    return null;
  }
}

async function handleGetOpenAIModelsRequest(ctx) {
  const {
    state,
    options,
    url,
    deps,
    writeJson
  } = ctx;

  try {
    const parsedScope = parseAccountScope(ctx);
    if (parsedScope.requested && !parsedScope.accountScope) {
      writeJson(ctx.res, 404, {
        ok: false,
        error: 'account_not_found',
        message: '未找到要读取的账号'
      });
      return true;
    }
    const accountScope = parsedScope.accountScope;
    const result = await getWebUiModelsCache(state, options, {
      accountScope,
      fs: ctx.fs || deps.fs,
      aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
      fetchModelsForAccount: deps.fetchModelsForAccount,
      accountStateService: deps.accountStateService
    });

    const settings = await loadModelSettingsData(ctx);
    const { finalEntries, managedEntries } = await buildModelEntrySets(ctx, result, settings, accountScope);
    const data = buildOpenAIModelsList(finalEntries).data;
    const metadataDeps = getModelMetadataDeps(ctx);
    const managedData = attachModelMetadata(
      buildManagedModelItems(ctx, managedEntries, settings, accountScope),
      metadataDeps
    );
    const byProvider = buildOpenAIModelsByProvider(data, finalEntries);
    const accountRefProjection = buildModelAccountRefProjection(ctx, state, result, accountScope);

    writeJson(ctx.res, 200, {
      ok: true,
      endpoint: '/v1/models',
      cached: result.cached,
      updatedAt: result.updatedAt,
      source: result.source,
      sources: result.sourceCount,
      scannedAccounts: result.scannedAccounts,
      firstError: result.firstError,
      accountScope: serializeAccountScope(accountScope),
      data,
      managedData,
      metadata: buildModelMetadataMap(finalEntries, metadataDeps),
      accounts: buildModelAccountSummaries(ctx, state, settings),
      byProvider,
      byAccountRef: accountRefProjection.byAccountRef,
      errorsByAccountRef: accountRefProjection.errorsByAccountRef,
      settingsUpdatedAt: Number(settings.updatedAt || 0)
    });
    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'get_openai_models_failed',
      message: String((error && error.message) || error || 'get_openai_models_failed')
    });
    return true;
  }
}

async function handleCreateManualOpenAIModelRequest(ctx) {
  const payload = await readJsonRequestBody(ctx);
  if (!payload) return true;
  const target = normalizeAccountModelSettingRecord({
    id: payload.id || payload.model || payload.modelId,
    provider: payload.provider,
    accountRef: payload.accountRef,
    enabled: payload.defaultModel === true ? true : payload.enabled !== false,
    manual: true,
    defaultModel: payload.defaultModel === true,
    description: payload.description
  });
  if (!target) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'missing_account_model' });
    return true;
  }
  const account = findModelTargetAccount(ctx.state || {}, target);
  if (!isApiCredentialAccount(account)) {
    ctx.writeJson(ctx.res, 403, {
      ok: false,
      error: 'manual_model_requires_api_key_account',
      message: 'OAuth 账号不能新增自定义模型，请选择密钥/令牌账号。'
    });
    return true;
  }
  try {
    const settings = await loadModelSettingsData(ctx);
    const next = upsertAccountModelSetting(settings, target);
    const saved = await saveModelSettingsData(ctx, next);
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      model: findAccountModelSetting(saved, target),
      settingsUpdatedAt: Number(saved.updatedAt || 0)
    });
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'save_model_catalog_settings_failed',
      message: String((error && error.message) || error || 'save_model_catalog_settings_failed')
    });
  }
  return true;
}

async function handleUpdateOpenAIModelRequest(ctx) {
  const payload = await readJsonRequestBody(ctx);
  if (!payload) return true;
  const target = normalizeAccountModelSettingRecord({
    id: payload.id || payload.model || payload.modelId,
    provider: payload.provider,
    accountRef: payload.accountRef
  });
  if (!target) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'missing_account_model' });
    return true;
  }
  try {
    const settings = await loadModelSettingsData(ctx);
    const existing = findAccountModelSetting(settings, target);
    const hasEnabledPayload = Object.prototype.hasOwnProperty.call(payload, 'enabled');
    const nextEnabled = payload.defaultModel === true
      ? true
      : hasEnabledPayload ? payload.enabled !== false : existing ? existing.enabled !== false : true;
    const nextDefaultModel = payload.defaultModel === true
      ? true
      : nextEnabled && existing && existing.defaultModel === true;
    const next = upsertAccountModelSetting(settings, {
      ...target,
      enabled: nextEnabled,
      manual: existing ? existing.manual === true : false,
      defaultModel: nextDefaultModel,
      description: payload.description !== undefined
        ? payload.description
        : existing && existing.description
    }, existing || target);
    const saved = await saveModelSettingsData(ctx, next);
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      model: findAccountModelSetting(saved, target),
      settingsUpdatedAt: Number(saved.updatedAt || 0)
    });
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'save_model_catalog_settings_failed',
      message: String((error && error.message) || error || 'save_model_catalog_settings_failed')
    });
  }
  return true;
}

async function handleDeleteOpenAIModelRequest(ctx) {
  const payload = await readJsonRequestBody(ctx);
  if (!payload) return true;
  const target = normalizeAccountModelSettingRecord({
    id: payload.id || payload.model || payload.modelId,
    provider: payload.provider,
    accountRef: payload.accountRef
  });
  if (!target) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'missing_account_model' });
    return true;
  }
  try {
    const settings = await loadModelSettingsData(ctx);
    const saved = await saveModelSettingsData(ctx, removeAccountModelSetting(settings, target));
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      settingsUpdatedAt: Number(saved.updatedAt || 0)
    });
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'save_model_catalog_settings_failed',
      message: String((error && error.message) || error || 'save_model_catalog_settings_failed')
    });
  }
  return true;
}

function getModelCatalogLiveState(state) {
  if (!state.modelCatalogLive || typeof state.modelCatalogLive !== 'object') {
    state.modelCatalogLive = {
      watchers: new Set(),
      jobs: new Map(),
      nextJobSeq: 0
    };
  }
  return state.modelCatalogLive;
}

function serializeModelCatalogJob(job) {
  return {
    id: String(job && job.id || ''),
    status: String(job && job.status || 'queued'),
    accountScope: serializeAccountScope(job && job.accountScope),
    startedAt: Number(job && job.startedAt) || 0,
    finishedAt: Number(job && job.finishedAt) || 0,
    catalog: job && job.catalog || null,
    error: String(job && job.error || '')
  };
}

function broadcastModelCatalogJob(liveState, job) {
  broadcastSseJson(liveState.watchers, {
    type: 'model-catalog-job',
    job: serializeModelCatalogJob(job)
  });
}

function trimFinishedCatalogJobs(liveState) {
  const jobs = [...liveState.jobs.values()];
  if (jobs.length <= MAX_MODEL_CATALOG_JOBS) return;
  jobs
    .filter((job) => job.status !== 'queued' && job.status !== 'running')
    .sort((left, right) => (
      (Number(left.finishedAt) || Number(left.startedAt) || 0)
      - (Number(right.finishedAt) || Number(right.startedAt) || 0)
    ))
    .slice(0, Math.max(0, jobs.length - MAX_MODEL_CATALOG_JOBS))
    .forEach((job) => liveState.jobs.delete(job.id));
}

async function runModelCatalogJob(ctx, liveState, job) {
  job.status = 'running';
  job.startedAt = Date.now();
  broadcastModelCatalogJob(liveState, job);

  try {
    const result = await getWebUiModelsCache(ctx.state, ctx.options, {
      forceRefresh: true,
      accountScope: job.accountScope,
      probeCodex: shouldProbeCodexForScope(job.accountScope),
      fs: ctx.fs || ctx.deps && ctx.deps.fs,
      aiHomeDir: ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir,
      fetchModelsForAccount: ctx.deps && ctx.deps.fetchModelsForAccount,
      accountStateService: ctx.deps && ctx.deps.accountStateService
    });
    const settings = await loadModelSettingsData(ctx);
    const { finalEntries, managedEntries } = await buildModelEntrySets(ctx, result, settings, job.accountScope);
    const data = buildOpenAIModelsList(finalEntries).data;
    const accountRefProjection = buildModelAccountRefProjection(ctx, ctx.state, result, job.accountScope);
    const metadataDeps = getModelMetadataDeps(ctx);
    job.catalog = {
      ok: true,
      endpoint: '/v1/models',
      cached: result.cached,
      updatedAt: result.updatedAt,
      source: result.source,
      sources: result.sourceCount,
      scannedAccounts: result.scannedAccounts,
      firstError: result.firstError,
      accountScope: serializeAccountScope(job.accountScope),
      data,
      managedData: attachModelMetadata(
        buildManagedModelItems(ctx, managedEntries, settings, job.accountScope),
        metadataDeps
      ),
      metadata: buildModelMetadataMap(finalEntries, metadataDeps),
      accounts: buildModelAccountSummaries(ctx, ctx.state, settings),
      byProvider: buildOpenAIModelsByProvider(data, finalEntries),
      byAccountRef: accountRefProjection.byAccountRef,
      errorsByAccountRef: accountRefProjection.errorsByAccountRef,
      settingsUpdatedAt: Number(settings.updatedAt || 0)
    };
    job.status = 'succeeded';
  } catch (error) {
    job.status = 'failed';
    job.error = String((error && error.message) || error || 'model_catalog_refresh_failed');
  } finally {
    job.finishedAt = Date.now();
    broadcastModelCatalogJob(liveState, job);
    trimFinishedCatalogJobs(liveState);
  }
}

function parseAccountScope(ctx) {
  const params = ctx && ctx.url && ctx.url.searchParams;
  if (!params) return { requested: false, accountScope: null };
  const accountRef = String(params.get('accountRef') || '').trim();
  if (!accountRef) return { requested: false, accountScope: null };
  const scope = normalizeAccountScope({ accountRef });
  return {
    requested: true,
    accountScope: hasSingleAccountScope(scope) ? scope : null
  };
}

function handleWatchOpenAIModelsRequest(ctx) {
  const liveState = getModelCatalogLiveState(ctx.state || {});
  openSseStream(ctx.res);
  writeSseJson(ctx.res, { type: 'connected' });
  attachSseWatcher(liveState.watchers, ctx.req, ctx.res);
  writeSseJson(ctx.res, {
    type: 'model-catalog-snapshot',
    jobs: [...liveState.jobs.values()].map(serializeModelCatalogJob)
  });
  return true;
}

function handleRefreshOpenAIModelsRequest(ctx) {
  const liveState = getModelCatalogLiveState(ctx.state || {});
  const parsedScope = parseAccountScope(ctx);
  const accountScope = parsedScope.accountScope;
  if (!accountScope) {
    if (parsedScope.requested) {
      ctx.writeJson(ctx.res, 404, {
        ok: false,
        error: 'account_not_found',
        message: '未找到要探测的账号'
      });
      return true;
    }
    triggerWebUiModelRefreshSoon(ctx);
    ctx.writeJson(ctx.res, 202, {
      ok: true,
      accepted: true,
      alreadyRunning: false,
      scheduled: true,
      job: null
    });
    return true;
  }
  let scopedAccount = null;
  try {
    scopedAccount = resolveScopedAccountForRefresh(ctx, accountScope);
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'reload_model_accounts_failed',
      message: String((error && error.message) || error || 'reload_model_accounts_failed')
    });
    return true;
  }
  if (!scopedAccount) {
    ctx.writeJson(ctx.res, 404, {
      ok: false,
      error: 'account_not_found',
      message: '未找到要探测的账号'
    });
    return true;
  }
  const scopeKey = getAccountScopeKey(accountScope);
  const running = [...liveState.jobs.values()].find((job) => (
    (job.status === 'queued' || job.status === 'running')
    && getAccountScopeKey(job.accountScope) === scopeKey
  ));
  if (running) {
    ctx.writeJson(ctx.res, 202, {
      ok: true,
      accepted: false,
      alreadyRunning: true,
      job: serializeModelCatalogJob(running)
    });
    return true;
  }

  liveState.nextJobSeq += 1;
  const job = {
    id: `model-catalog-${Date.now()}-${liveState.nextJobSeq}`,
    status: 'queued',
    accountScope,
    startedAt: 0,
    finishedAt: 0,
    catalog: null,
    error: ''
  };
  liveState.jobs.set(job.id, job);
  broadcastModelCatalogJob(liveState, job);
  Promise.resolve()
    .then(() => runModelCatalogJob(ctx, liveState, job))
    .catch(() => {});

  ctx.writeJson(ctx.res, 202, {
    ok: true,
    accepted: true,
    alreadyRunning: false,
    job: serializeModelCatalogJob(job)
  });
  return true;
}

module.exports = {
  handleCreateManualOpenAIModelRequest,
  handleDeleteOpenAIModelRequest,
  handleRefreshOpenAIModelsRequest,
  handleGetOpenAIModelsRequest,
  handleUpdateOpenAIModelRequest,
  handleWatchOpenAIModelsRequest,
  __private: {
    buildCatalogModelEntries,
    buildDisplayModelItems,
    buildManagedModelItems,
    buildModelEntrySets,
    buildOpenAIModelsByProvider,
    resolveProviderFromOpenAIModel,
    serializeModelCatalogJob
  }
};
