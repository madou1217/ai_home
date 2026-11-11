'use strict';

const crypto = require('node:crypto');
const { readGoAccountRecord } = require('../account/go-bridge/go-native-auth');

const { buildGatewayModelEntries, mergeGatewayModelEntries } = require('./gateway-model-list');
const { loadAliases } = require('./model-alias-store');
const { buildModelCapabilityIndex } = require('./model-capability-index');
const { buildOpenAIModelsList } = require('./models');
const { getWebUiModelsCache, WEBUI_MODELS_REFRESH_TIMEOUT_MS } = require('./webui-model-cache');
const { getWebUiCatalogResult } = require('./webui-model-catalog-source');
const { isGoOwnedModels } = require('../providers/model-ownership');
const {
  accountMatchesScope,
  listAccountModelCacheRefs,
  normalizeAccountScope
} = require('./provider-model-discovery');
const { withAccountQueryListFns } = require('./account-load-args');
const { notifyGoCoreProjection } = require('./go-core-projection-sync');
const {
  buildModelAccountRefProjection
} = require('./webui-model-account-ref-projection');
const { triggerWebUiModelRefreshSoon } = require('./webui-model-refresh-scheduler');
const { triggerWebUiModelCacheGoSync } = require('./webui-model-cache-go-sync');
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

const { listModelDiscoveryAccounts } = require('./model-discovery-accounts');
const MODEL_CATALOG_PROVIDERS = Object.freeze(listProvidersByCapability('modelCatalog'));
const MAX_MODEL_CATALOG_JOBS = 12;
const MODEL_RESPONSE_CACHE_TTL_MS = 3000;

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

// 运行时账号池 + 只参与模型发现的账号（WorkBuddy 家族），与模型发现同一口径，见 model-discovery-accounts.js。
function listProviderAccounts(state, provider, deps = null) {
  return listModelDiscoveryAccounts(state, provider, deps);
}

function resolveDiscoveryDeps(ctx) {
  const deps = ctx && ctx.deps || {};
  return { fs: ctx && ctx.fs || deps.fs, aiHomeDir: ctx && ctx.aiHomeDir || deps.aiHomeDir };
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

function findScopedAccount(state, scope, deps = null) {
  const target = normalizeAccountScope(scope);
  if (!hasSingleAccountScope(target)) return null;
  for (const provider of MODEL_CATALOG_PROVIDERS) {
    const account = listProviderAccounts(state, provider, deps)
      .find((item) => accountMatchesScope(provider, item, target));
    if (account) return { provider, account };
  }
  return null;
}

function findModelTargetAccount(state, target, deps = null) {
  const provider = String(target && target.provider || '').trim();
  const accountRef = String(target && target.accountRef || '').trim();
  if (!provider || !accountRef) return null;
  return listProviderAccounts(state, provider, deps)
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
    modelsDevCatalogPath: ctx && ctx.deps && ctx.deps.modelsDevCatalogPath
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
    accountStateService: ctx.accountStateService || deps.accountStateService,
    accountRuntimeGate: (ctx.deps && ctx.deps.accountRuntimeGate) || deps.accountRuntimeGate
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
  // 池变即推送（见 go-core-projection-sync）：模型刷新触发的重载同样可能改变规则投影。
  notifyGoCoreProjection(ctx, 'upstreamErrorRules');
  return true;
}

function resolveScopedAccountForRefresh(ctx, accountScope) {
  const existing = findScopedAccount(ctx.state || {}, accountScope, resolveDiscoveryDeps(ctx));
  if (existing) return existing;
  reloadRuntimeAccountsForModelRefresh(ctx);
  const reloaded = findScopedAccount(ctx.state || {}, accountScope, resolveDiscoveryDeps(ctx));
  if (reloaded) return reloaded;
  // Go 独有账号（Node 账号库没有、Go 有）：探测本来就由 Go 执行
  // （runModelCatalogJob 优先调 refreshAccountModels），这里只需要给出 provider，
  // 不能因为 Node 列表里没有就报「未找到要探测的账号」。
  const accountRef = String(accountScope && accountScope.accountRef || '').trim();
  const aiHomeDir = String((ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir)) || '').trim();
  const fsImpl = ctx.fs || (ctx.deps && ctx.deps.fs);
  if (!accountRef || !aiHomeDir) return null;
  const goAccount = readGoAccountRecord(aiHomeDir, accountRef, { fs: fsImpl });
  if (!goAccount) return null;
  return { provider: goAccount.provider, accountRef: goAccount.accountRef, goOnly: true };
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

function buildCatalogModelEntries(catalogResult, state = {}, settings = null, accountScope = null, deps = null) {
  const entries = [];
  const entriesByKey = new Map();
  const byAccount = catalogResult && catalogResult.byAccount && typeof catalogResult.byAccount === 'object'
    ? catalogResult.byAccount
    : {};

  const poolRefs = new Set();
  MODEL_CATALOG_PROVIDERS.forEach((provider) => {
    listProviderAccounts(state, provider, deps).filter((account) => accountMatchesScope(provider, account, accountScope)).forEach((account) => {
      const accountRef = getAccountRef(provider, account);
      if (!accountRef) return;
      poolRefs.add(accountRef);
      if (Object.prototype.hasOwnProperty.call(byAccount, accountRef)) {
        addAccountModelList(entriesByKey, account, byAccount[accountRef], 'webui-probe');
      } else if (!isGoOwnedModels(provider)) {
        // Go 接管的 Provider 没有本地目录兜底：account.availableModels 是历史探测快照，
        // 在 Go 尚未刷新该账号（未同步/停用）时会显示成「这个账号只有两条模型」，
        // 与 account_models 的真值不一致。目录只认 Go，读不到就是空。
        addAccountModelList(entriesByKey, account, account && account.availableModels, 'account');
        addAccountModelList(entriesByKey, account, collectDescriptorModels(account), 'descriptor');
      }
      // 原生图像模型不进这里：本端点是 /v1/models 口径的聊天模型目录，图像模型由
      // image-studio-model-catalog 独立提供；合成进列表会让模型页把纯图像模型当成
      // 聊天模型展示（且让「scoped 账号无目录」无法给出空结果）。
    });
  });

  // Go 独有账号（Node 运行池里没有、Go 有）：provider 归属与模型目录都以 Go 为准。
  // 运行池遍历永远碰不到它们，模型管理页因此整块看不到（agy 的 16 个模型就是这样消失的）。
  // 这里只补「Go 里有目录、Node 池里没有」的账号，不去复制 Go 的任何判定逻辑。
  {
    const aiHomeDir = String((deps && deps.aiHomeDir) || '').trim();
    const fsImpl = deps && deps.fs;
    if (aiHomeDir) {
      Object.entries(byAccount).forEach(([accountRef, models]) => {
        if (poolRefs.has(accountRef)) return;
        const list = Array.isArray(models) ? models : [];
        if (list.length === 0) return;
        if (accountScope && String(accountScope.accountRef || '') !== accountRef) return;
        const goAccount = readGoAccountRecord(aiHomeDir, accountRef, { fs: fsImpl });
        if (!goAccount) return;
        const provider = String(goAccount.provider || '').trim().toLowerCase();
        if (!MODEL_CATALOG_PROVIDERS.includes(provider)) return;
        poolRefs.add(accountRef);
        addAccountModelList(entriesByKey, { provider, accountRef }, list, 'webui-probe');
        // 供账号汇总复用：避免再去读一次 Go 账号库（同一请求内只解析一次归属）。
        if (catalogResult && typeof catalogResult === 'object') {
          if (!catalogResult.goOnlyProviders || typeof catalogResult.goOnlyProviders !== 'object') {
            catalogResult.goOnlyProviders = {};
          }
          catalogResult.goOnlyProviders[accountRef] = provider;
        }
      });
    }
  }

  // 已离开运行池的账号（停用/删除）保留下来的目录：仍然是「全量」的一部分。
  // 归到该模型所属 provider 的 provider 级条目（不带 accountRef），只用于展示与
  // provider 级启停，不会被当成某个现存账号的目录。
  if (!accountScope) {
    const retainedByAccount = catalogResult && catalogResult.retainedByAccount
      && typeof catalogResult.retainedByAccount === 'object'
      ? catalogResult.retainedByAccount
      : (state.webUiModelsCache && state.webUiModelsCache.retainedByAccount);
    if (retainedByAccount && typeof retainedByAccount === 'object') {
      const providerByModel = new Map();
      const byProvider = catalogResult && catalogResult.byProvider && typeof catalogResult.byProvider === 'object'
        ? catalogResult.byProvider
        : {};
      Object.entries(byProvider).forEach(([provider, ids]) => {
        (Array.isArray(ids) ? ids : []).forEach((id) => {
          const key = String(id || '').trim().toLowerCase();
          if (key && !providerByModel.has(key)) providerByModel.set(key, provider);
        });
      });
      // 同一个 provider 可能有两个留档键（真实 accountRef 与合成 provider:<name>），
      // 它们的模型集合相同，按精确 id 去重，避免「全量」视图出现重复行。
      const retainedIds = new Set();
      Object.entries(retainedByAccount).forEach(([accountRef, value]) => {
        if (poolRefs.has(accountRef)) return;
        // 两种形状：数组（旧快照）与 { provider, models }（新）。
        const models = Array.isArray(value) ? value : value && Array.isArray(value.models) ? value.models : null;
        if (!models) return;
        const retainedProvider = String(!Array.isArray(value) && value && value.provider || '').trim().toLowerCase();
        models.forEach((modelId) => {
          const id = String(modelId || '').trim();
          if (!id) return;
          // 留档条目自带 provider 时以它为准：providerByModel 只能按小写 id 反查，
          // qoder 的 `GLM-5.3` / `Auto` 会被别的 provider 的同名小写条目抢走归属，
          // 于是这 8 个模型在停用后从「全量」视图里消失（实测 data 80 → 72）。
          const provider = (MODEL_CATALOG_PROVIDERS.includes(retainedProvider) ? retainedProvider : '')
            || providerByModel.get(id.toLowerCase())
            || '';
          if (!provider || retainedIds.has(id)) return;
          retainedIds.add(id);
          entries.push({ id, provider, source: 'retained' });
        });
      });
    }
  }

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

  // Go 独有账号：Node 运行池里没有它，但它确实是可管理的账号行。
  // provider 归属由目录构建阶段从 Go 账号库解析（catalogResult.goOnlyProviders），
  // 这里只负责把行补出来——数据全部来自 Go，不在这里复制任何判定。
  try {
    const goOnlyProviders = catalogResult && catalogResult.goOnlyProviders
      && typeof catalogResult.goOnlyProviders === 'object'
      ? catalogResult.goOnlyProviders
      : {};
    for (const [accountRef, providerRaw] of Object.entries(goOnlyProviders)) {
      if (!accountRef || accountsByRef.has(accountRef)) continue;
      const provider = String(providerRaw || '').trim().toLowerCase();
      if (!provider) continue;
      accountsByRef.set(accountRef, {
        provider,
        accountRef,
        displayName: accountRef,
        email: '',
        apiKeyMode: false,
        authType: ''
      });
    }
  } catch (_error) {
    // 补行失败不影响页面：Node 池里的账号照常返回。
  }
  listManualModelSettings(settings, { enabledOnly: false }).forEach((record) => {
    if (!accountMatchesScope(record.provider, record, accountScope)) return;
    addAccountModelEntry(entriesByKey, {
      ...record,
      source: 'manual',
      manual: true
    });
  });

  // 账号级条目优先：同 id 的 provider 级条目（如 retained）不能再出现一次，
  // 否则合并时先出现的无 accountRef 条目会顶掉「可按账号管理」的那条。
  //
  // 这里必须**大小写精确**：qoder 的 `Auto`/`Sonus` 等大写 id 与其他 provider 的
  // `auto` 是两个不同的上游条目。按小写去重会把 qoder 账号停用后留档的大写条目
  // 当成重复直接吞掉（实测 WebUI 少 8 行）。
  const accountEntryIds = new Set(Array.from(entriesByKey.values()).map((entry) => String(entry.id || '').trim()));
  return [
    ...entries.filter((entry) => !accountEntryIds.has(String(entry.id || '').trim())),
    ...Array.from(entriesByKey.values())
  ].sort((a, b) => (
    String(a.provider || '').localeCompare(String(b.provider || ''))
    || String(a.accountRef || '').localeCompare(String(b.accountRef || ''))
    || String(a.id || '').localeCompare(String(b.id || ''))
  ));
}

function buildModelAccountSummaries(ctx, state, settings = null, catalogResult = null) {
  const accountsByRef = new Map();
  MODEL_CATALOG_PROVIDERS.forEach((provider) => {
    listProviderAccounts(state, provider, resolveDiscoveryDeps(ctx)).forEach((account) => {
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
  const accountEntries = buildCatalogModelEntries(catalogResult, rawState, settings, accountScope, resolveDiscoveryDeps(ctx));
  // WebUI 模型管理 = **全量口径**：对外 /v1/models 只发布「可见可用」，这里则要能看到
  // 全部被发现/声明过的模型（含暂时被关闭账号的目录），否则管理员没法配置、排查它们。
  //
  // 之前只在「运行池里一个账号目录都没有」时才回退到网关能力目录，账号一多，
  // provider 级目录（模型注册表、byProvider 并集）就被池内账号目录完全遮住了：
  // 例如 qoder 的模型在注册表里有、但它不在 WebUI 的逐账号目录里，模型页就整块看不到。
  // 现在两路合并，按模型 id 去重（账号级条目优先，带 accountRef 的才能按账号管理）。
  const capabilityEntries = accountScope ? [] : buildGatewayModelEntries(rawState, options);
  const catalogEntries = accountScope ? accountEntries : unionCatalogEntries(accountEntries, capabilityEntries);
  const baseEntries = catalogEntries.length > 0
    ? catalogEntries
    : (accountScope ? [] : capabilityEntries);
  // 单账号作用域：只返回该账号的目录本体。别名与全局手工模型（source: 'manual'）
  // 都是 provider/全局级配置，混进 scoped 响应会让「账号目录」与 Go account_models
  // 对不上（实测 opencode 109 → 120）。全量视图仍走完整合并。
  const finalEntries = accountScope
    ? catalogEntries
    : mergeGatewayModelEntries(baseEntries, aliasData.aliases, {
    state: ctx.state || {},
    options,
    modelCapabilityIndex: buildModelCapabilityIndex(ctx.state || {}, options),
    modelCatalogSettings: settings
  });
  const managedEntries = applyModelCatalogSettingsToEntries(catalogEntries, normalizeModelCatalogSettings(null), {
    providerMode: options.provider
  });
  return {
    finalEntries,
    managedEntries: catalogEntries.length > 0 || accountScope ? catalogEntries : managedEntries
  };
}

// 合并两路目录：账号级条目优先（带 accountRef，可按账号启停/删除），
// provider 级条目只在同一 id 缺席时补上。大小写敏感的 id 不合并 —— 它们是上游的
// 不同条目（如 qoder 的 `Auto` 与另一家的 `auto`），合并会误导管理员。
function unionCatalogEntries(primary, secondary) {
  const seen = new Set();
  const out = [];
  [primary, secondary].forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((entry) => {
      const id = String(entry && entry.id || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push(entry);
    });
  });
  return out;
}

async function buildDisplayModelItems(ctx, catalogResult, settings) {
  const entrySets = await buildModelEntrySets(ctx, catalogResult, settings);
  return buildOpenAIModelsList(entrySets.finalEntries).data;
}

function resolveProviderFromOpenAIModel(model) {
  const id = String(model && model.id || '').trim().toLowerCase();
  const owner = String(model && model.owned_by || '').trim().toLowerCase();
  if (owner === 'openai' || id.startsWith('gpt-') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'codex';
  if (owner === 'zhipu' || id.startsWith('glm-')) return 'zcode';
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
        customPricing: setting ? setting.customPricing : undefined,
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
    const liveState = getModelCatalogLiveState(state);
    const responseKey = modelResponseCacheKey(accountScope);
    const cachedResponse = liveState.responseCache.get(responseKey);
    if (cachedResponse && Date.now() - cachedResponse.createdAt < MODEL_RESPONSE_CACHE_TTL_MS) {
      sendModelResponse(ctx.res, ctx.req, cachedResponse.body, cachedResponse.etag);
      return true;
    }
    const result = await getWebUiCatalogResult(state, options, {
      accountScope,
      fs: ctx.fs || deps.fs,
      aiHomeDir: ctx.aiHomeDir || deps.aiHomeDir,
      fetchModelsForAccount: deps.fetchModelsForAccount,
      accountStateService: deps.accountStateService
    }, ctx);

    const settings = await loadModelSettingsData(ctx);
    const { finalEntries, managedEntries } = await buildModelEntrySets(ctx, result, settings, accountScope);
    const data = buildOpenAIModelsList(finalEntries).data;
    const metadataDeps = getModelMetadataDeps(ctx);
    const managedData = attachModelMetadata(
      buildManagedModelItems(ctx, managedEntries, settings, accountScope),
      metadataDeps
    );
    const byProvider = buildOpenAIModelsByProvider(data, finalEntries);
    // 账号页渲染的行以这份汇总为准（含只在手动模型设置里出现、已不在运行池的账号），
    // 投影要按同一份 ref 兜底，否则那些行会把「有上次探测结果」显示成「待探测」。
    const accountSummaries = buildModelAccountSummaries(ctx, state, settings, result);
    const accountRefProjection = buildModelAccountRefProjection(
      ctx,
      state,
      result,
      accountScope,
      accountSummaries.map((item) => item.accountRef)
    );

    const payload = {
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
      labels: result.labels || {},
      accounts: accountSummaries,
      byProvider,
      byAccountRef: accountRefProjection.byAccountRef,
      errorsByAccountRef: accountRefProjection.errorsByAccountRef,
      // accountRef → 上次探测时刻；与 byAccountRef 合并使用，区分「探测过但为空」
      // 与「从未探测」（后者才是页面上的「待探测」）。
      accountProbedAt: accountRefProjection.accountProbedAt || {},
      settingsUpdatedAt: Number(settings.updatedAt || 0),
      // Go 目录指纹：同一代次的重复读取可以直接复用响应；它进入 body 后也会自然
      // 参与 ETag 计算，Go 侧目录一变，304 就不再命中。
      catalogGeneration: Number(result.generation) || 0
    };
    const body = JSON.stringify(payload);
    const etag = modelResponseEtag(body);
    // 空目录不进 3 秒响应缓存：启动早期 Go 子进程可能还没 ready，这一次读不到目录会
    // 得到空结果；缓存住它会让「刷新一下就能出现」的账号在整个 TTL 内持续显示空，
    // 轮询时还会被反复续期（实测 opencode 的 API Key 账号）。空结果重算成本可以忽略。
    if (data.length > 0 || !accountScope) {
      liveState.responseCache.set(responseKey, { createdAt: Date.now(), body, etag });
    } else {
      liveState.responseCache.delete(responseKey);
    }
    sendModelResponse(ctx.res, ctx.req, body, etag);
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
    description: payload.description,
    ...(Object.prototype.hasOwnProperty.call(payload, 'customPricing')
      ? { customPricing: payload.customPricing }
      : {})
  });
  if (!target) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'missing_account_model' });
    return true;
  }
  const account = findModelTargetAccount(ctx.state || {}, target, resolveDiscoveryDeps(ctx));
  if (!account) {
    ctx.writeJson(ctx.res, 404, {
      ok: false,
      error: 'account_not_found',
      message: '未找到要添加模型的账号'
    });
    return true;
  }
  try {
    const settings = await loadModelSettingsData(ctx);
    const next = upsertAccountModelSetting(settings, target);
    const saved = await saveModelSettingsData(ctx, next);
    clearModelResponseCache(ctx.state);
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
        : existing && existing.description,
      // 未提交 customPricing 键 = 不碰原值（存储层按 hasOwnProperty 继承 existing）；
      // 显式提交（含 null）= 覆盖/清空。
      ...(Object.prototype.hasOwnProperty.call(payload, 'customPricing')
        ? { customPricing: payload.customPricing }
        : {})
    }, existing || target);
    const saved = await saveModelSettingsData(ctx, next);
    clearModelResponseCache(ctx.state);
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
    clearModelResponseCache(ctx.state);
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
      nextJobSeq: 0,
      responseCache: new Map()
    };
  }
  if (!(state.modelCatalogLive.responseCache instanceof Map)) state.modelCatalogLive.responseCache = new Map();
  return state.modelCatalogLive;
}

function modelResponseCacheKey(accountScope) {
  return String(accountScope && accountScope.accountRef || 'global').trim() || 'global';
}

function modelResponseEtag(body) {
  return `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
}

function sendModelResponse(res, req, body, etag) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'private, max-age=3, stale-while-revalidate=30');
  res.setHeader('etag', etag);
  if (String(req && req.headers && req.headers['if-none-match'] || '').trim() === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.end(body);
}

function clearModelResponseCache(state) {
  const liveState = getModelCatalogLiveState(state || {});
  liveState.responseCache.clear();
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

// 这些状态说明「当前 Go 版本没有这条刷新入口」：404/405 是路由缺失，501 是
// Refresher 未接线。只有这三种才回落到 Node 的旧探测路径；其余失败都如实报错。
const GO_MODEL_REFRESH_FALLBACK_STATUS = new Set([404, 405, 501]);

/**
 * 触发一次 Go 侧的模型目录刷新（策略：Go 优先，旧版本回退）。
 *
 * 返回 `{ used: true }` 表示 Go 已经完成探测并落库，调用方应直接读 Go 的结果；
 * 返回 `{ used: false }` 表示当前 Go 不支持该入口，调用方走 Node 旧探测。
 *
 * 超时与 5xx 必须抛出而不是回退：
 *   - timeout 时 Go 可能仍在探测上游，回退会重复打上游、放大限流；
 *   - 5xx 是 Go 明确失败，Node 对 Go 接管的 Provider 已没有探测策略，回退只会更糟。
 */
async function tryGoModelCatalogRefresh(ctx) {
  return runGoRefreshRequest(ctx, () => {
    const refresh = ctx && ctx.deps && ctx.deps.refreshWebUiModelCatalog;
    return typeof refresh === 'function' ? refresh() : null;
  });
}

// 单账号刷新走 Go 的账号级入口；语义与全局刷新一致，只是范围收窄到一个账号。
async function tryGoAccountModelRefresh(ctx, accountRef) {
  return runGoRefreshRequest(ctx, () => {
    const refresh = ctx && ctx.deps && ctx.deps.refreshAccountModels;
    const ref = String(accountRef || '').trim();
    if (typeof refresh !== 'function' || !ref) return null;
    return refresh(ref);
  });
}

// 两个入口共用同一套回退边界：只有「当前 Go 版本没有这条入口」才回退。
async function runGoRefreshRequest(ctx, invoke) {
  let response = null;
  try {
    response = await invoke();
  } catch (_error) {
    return { used: false, reason: 'network_error' };
  }
  if (!response) return { used: false, reason: 'go_core_unavailable' };
  const status = Number(response.status) || 0;
  if (status === 0) {
    if (String(response.errorCode || '') === 'timeout') {
      throw Object.assign(new Error('model_catalog_refresh_timeout'), {
        code: 'model_catalog_refresh_timeout'
      });
    }
    return { used: false, reason: String(response.errorCode || 'network_error') };
  }
  if (GO_MODEL_REFRESH_FALLBACK_STATUS.has(status)) {
    return { used: false, reason: String(response.errorCode || `http_${status}`) };
  }
  if (response.ok !== true || status >= 400) {
    throw Object.assign(new Error(`model_catalog_refresh_failed: ${status}`), {
      code: 'model_catalog_refresh_failed'
    });
  }
  return { used: true, data: response.data || null };
}

async function runModelCatalogJob(ctx, liveState, job) {
  job.status = 'running';
  job.startedAt = Date.now();
  broadcastModelCatalogJob(liveState, job);

  try {
    // 单账号刷新优先由 Go 执行：它拥有 account_models 与各 Provider 的探测适配器。
    // Go 不支持时才走 Node 旧探测（forceRefresh），避免两条路径同时打上游。
    const goRefresh = await tryGoAccountModelRefresh(
      ctx,
      job.accountScope && job.accountScope.accountRef
    );
    if (goRefresh.used) {
      // Go 刚写完目录：先把新代次投影回 Node 缓存，让模型选择器等读路径看到同一份数据。
      await triggerWebUiModelCacheGoSync(ctx).catch(() => null);
    }
    const result = await getWebUiCatalogResult(ctx.state, ctx.options, {
      forceRefresh: !goRefresh.used,
      accountScope: job.accountScope,
      probeCodex: job.probeCodex === true,
      // 显式刷新是用户在等结果的操作：给足冷启动预算，不要沿用后台调度的 2.5s。
      timeoutMs: WEBUI_MODELS_REFRESH_TIMEOUT_MS,
      fs: ctx.fs || ctx.deps && ctx.deps.fs,
      aiHomeDir: ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir,
      fetchModelsForAccount: ctx.deps && ctx.deps.fetchModelsForAccount,
      accountStateService: ctx.deps && ctx.deps.accountStateService
    }, ctx);
    const settings = await loadModelSettingsData(ctx);
    const { finalEntries, managedEntries } = await buildModelEntrySets(ctx, result, settings, job.accountScope);
    clearModelResponseCache(ctx.state);
    const data = buildOpenAIModelsList(finalEntries).data;
    const accountSummaries = buildModelAccountSummaries(ctx, ctx.state, settings, result);
    // 与同步取目录的那条路径保持一致：刷新完成后也要按页面实际渲染的 ref 兜底，
    // 否则刷新一次就把「上次结果」重新打回「待探测」。
    const accountRefProjection = buildModelAccountRefProjection(
      ctx,
      ctx.state,
      result,
      job.accountScope,
      accountSummaries.map((item) => item.accountRef)
    );
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
      labels: result.labels || {},
      accounts: accountSummaries,
      byProvider: buildOpenAIModelsByProvider(data, finalEntries),
      byAccountRef: accountRefProjection.byAccountRef,
      errorsByAccountRef: accountRefProjection.errorsByAccountRef,
      // 与主接口同口径：探测过但为空 ≠ 从未探测。
      accountProbedAt: accountRefProjection.accountProbedAt || {},
      settingsUpdatedAt: Number(settings.updatedAt || 0),
      catalogGeneration: Number(result.generation) || 0
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

function startModelCatalogRefreshJob(ctx, accountScope) {
  const liveState = getModelCatalogLiveState(ctx.state || {});
  const scopedAccount = resolveScopedAccountForRefresh(ctx, accountScope);
  if (!scopedAccount) {
    const error = new Error('未找到要探测的账号');
    error.code = 'account_not_found';
    throw error;
  }
  const scopeKey = getAccountScopeKey(accountScope);
  const running = [...liveState.jobs.values()].find((job) => (
    (job.status === 'queued' || job.status === 'running')
    && getAccountScopeKey(job.accountScope) === scopeKey
  ));
  if (running) return { job: running, alreadyRunning: true };

  liveState.nextJobSeq += 1;
  const job = {
    id: `model-catalog-${Date.now()}-${liveState.nextJobSeq}`,
    status: 'queued',
    accountScope,
    probeCodex: scopedAccount.provider === 'codex',
    startedAt: 0,
    finishedAt: 0,
    catalog: null,
    error: ''
  };
  liveState.jobs.set(job.id, job);
  broadcastModelCatalogJob(liveState, job);
  job.completion = Promise.resolve()
    .then(() => runModelCatalogJob(ctx, liveState, job));
  // HTTP 调用方不等待作业；账号统一刷新通过 completion 汇总分支结果。
  job.completion.catch(() => {});
  return { job, alreadyRunning: false };
}

function handleRefreshOpenAIModelsRequest(ctx) {
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
    // 全局刷新：先让 Go 重新探测上游（它拥有各 Provider 的适配器），完成后再把新
    // 代次投影回 Node 缓存。HTTP 立刻返回 202，前端按既有轮询/SSE 语义等结果。
    void (async () => {
      let goRefresh = { used: false };
      try {
        goRefresh = await tryGoModelCatalogRefresh(ctx);
      } catch (error) {
        // 没有作业承载全局刷新的错误：记录后不再回退（timeout/5xx 回退会重复打上游）。
        const logger = ctx && ctx.deps && ctx.deps.logger;
        if (logger && typeof logger.warn === 'function') {
          logger.warn('model catalog refresh failed: ' + String((error && error.message) || error));
        }
        return;
      }
      if (goRefresh.used) {
        await triggerWebUiModelCacheGoSync(ctx).catch(() => null);
        clearModelResponseCache(ctx.state);
        return;
      }
      // 旧版本 Go 没有全局入口：保持旧行为（重读缓存 / 标记 stale）。
      await triggerWebUiModelRefreshSoon(ctx).catch(() => null);
    })();
    ctx.writeJson(ctx.res, 202, {
      ok: true,
      accepted: true,
      alreadyRunning: false,
      scheduled: true,
      job: null
    });
    return true;
  }
  let started;
  try {
    started = startModelCatalogRefreshJob(ctx, accountScope);
  } catch (error) {
    if (error.code === 'account_not_found') {
      ctx.writeJson(ctx.res, 404, {
        ok: false,
        error: 'account_not_found',
        message: error.message
      });
      return true;
    }
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'reload_model_accounts_failed',
      message: String((error && error.message) || error || 'reload_model_accounts_failed')
    });
    return true;
  }
  ctx.writeJson(ctx.res, 202, {
    ok: true,
    accepted: !started.alreadyRunning,
    alreadyRunning: started.alreadyRunning,
    job: serializeModelCatalogJob(started.job)
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
  startModelCatalogRefreshJob,
  __private: {
    buildCatalogModelEntries,
    buildDisplayModelItems,
    buildManagedModelItems,
    buildModelEntrySets,
    buildOpenAIModelsByProvider,
    resolveProviderFromOpenAIModel,
    serializeModelCatalogJob,
    tryGoAccountModelRefresh,
    tryGoModelCatalogRefresh
  }
};
