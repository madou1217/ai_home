'use strict';

const { deriveAccountRuntimeStatus } = require('../../../server/account-runtime-state');
const { buildAuthInvalidRuntimeState } = require('../../../account/runtime-state-builders');
const { createAccountRuntimeGate } = require('../../../server/account-runtime-gate');
const { isSelfRelayApiKeyInfo } = require('../../../account/self-relay-account');
const { readAccountCredentialRecord } = require('../../../server/account-credential-store');
const { readProviderApiCredential, readProviderBaseUrl } = require('../../../account/provider-credential-env');
const {
  listCliAccountRefRecords,
  resolveAccountRefByCliId
} = require('../../../server/account-ref-store');
const {
  rankHealthyAccounts,
  summarizeRejections
} = require('../../../account/healthy-account-selector');
const { listSwitchableProviders } = require('../../../account/provider-family-pool');

// 模型目录快照（WebUI 已持久化的 byAccount）用于「指定模型时优先能服务该模型的账号」。
// 目录是弱证据：缺失 / 残缺只代表未知，不代表不支持。读取本身有 5s 缓存，
// 选号是热路径（自动换号、启动回退都会调用），不能每次都解析一份大 JSON。
const MODEL_CATALOG_TTL_MS = 5000;

function createAccountSelectionService(options = {}) {
  const {
    fs,
    aiHomeDir,
    getAccountStateIndex,
    checkStatus,
    accountStateService,
    accountQueryService,
    refreshIndexedStateForAccount,
    readServerConfig,
    readModelCatalog,
    // 测试接缝：生产默认读真实凭据库 / account_refs；单测可以注入内存表。
    readCredentialRecord,
    listCliAccountRecords,
    resolveAccountByCliId
  } = options;

  const readCredential = typeof readCredentialRecord === 'function'
    ? readCredentialRecord
    : (accountRef) => readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  const listAccountRecords = typeof listCliAccountRecords === 'function'
    ? listCliAccountRecords
    : (provider) => listCliAccountRefRecords(fs, aiHomeDir, provider, { bestEffort: true });
  const resolveAccountRecord = typeof resolveAccountByCliId === 'function'
    ? resolveAccountByCliId
    : (provider, cliAccountId) => resolveAccountRefByCliId(
      fs,
      aiHomeDir,
      provider,
      cliAccountId,
      { bestEffort: true }
    );

  let modelCatalogCache = null;
  let modelCatalogLoadedAt = -Infinity;
  let modelCatalogLoaded = false;

  function getIndexedState(accountRef) {
    const index = typeof getAccountStateIndex === 'function' ? getAccountStateIndex() : null;
    return index && typeof index.getAccountState === 'function'
      ? index.getAccountState(accountRef)
      : null;
  }

  // 登录回退（没有可调度 OAuth 号时）不能挑正在限流/失效的号去跑登录流程；
  // 日常选号不用这个谓词——那里由 healthy-account-selector 现算完整健康度。
  function isRuntimeSelectableForLogin(accountRef) {
    const row = getIndexedState(accountRef);
    const runtimeState = row && row.runtimeState;
    return !runtimeState || deriveAccountRuntimeStatus(runtimeState).status === 'healthy';
  }

  function readModelCatalogSnapshot() {
    const at = Date.now();
    if (modelCatalogLoaded && at - modelCatalogLoadedAt < MODEL_CATALOG_TTL_MS) {
      return modelCatalogCache;
    }
    try {
      if (typeof readModelCatalog === 'function') {
        modelCatalogCache = readModelCatalog() || null;
      } else {
        // 延迟 require：TAB 补全等轻量入口不应该因为选号模块而加载模型缓存整条依赖链。
        const { readPersistedWebUiModelsCache } = require('../../../server/webui-model-cache');
        modelCatalogCache = readPersistedWebUiModelsCache({ fs, aiHomeDir }) || null;
      }
    } catch (_error) {
      modelCatalogCache = null;
    }
    modelCatalogLoadedAt = at;
    modelCatalogLoaded = true;
    return modelCatalogCache;
  }

  function buildModelSelectionOptions(model) {
    if (!String(model || '').trim()) return {};
    const cache = readModelCatalogSnapshot();
    const byAccount = cache && cache.byAccount && typeof cache.byAccount === 'object'
      ? cache.byAccount
      : null;
    const incompleteByAccount = cache && cache.incompleteByAccount
      && typeof cache.incompleteByAccount === 'object'
      ? cache.incompleteByAccount
      : null;
    return {
      model: String(model).trim(),
      modelCatalog: byAccount,
      incompleteAccountRefs: incompleteByAccount ? new Set(Object.keys(incompleteByAccount)) : null
    };
  }

  function listKnownAccounts(provider) {
    return listAccountRecords(provider)
      .filter((record) => /^\d+$/.test(record.cliAccountId))
      .sort((left, right) => Number(left.cliAccountId) - Number(right.cliAccountId));
  }

  function readApiKeyInfo(provider, credentialRecord) {
    const credentials = credentialRecord && credentialRecord.env || {};
    const apiKey = readProviderApiCredential(provider, credentials);
    return {
      apiKeyMode: Boolean(apiKey),
      apiKey,
      baseUrl: readProviderBaseUrl(provider, credentials)
    };
  }

  function parseJwtPayload(token) {
    const text = String(token || '').trim();
    if (!text) return null;
    const parts = text.split('.');
    if (parts.length < 2) return null;
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      const decoded = Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  function isExpiredJwt(token, nowSeconds) {
    const payload = parseJwtPayload(token);
    const exp = Number(payload && payload.exp);
    return Number.isFinite(exp) && exp > 0 && exp <= nowSeconds;
  }

  function hasRefreshToken(tokens) {
    return !!(tokens && String(tokens.refresh_token || '').trim());
  }

  function isLocallyAuthExpired(provider, credentialRecord) {
    if (provider !== 'codex') return false;
    const auth = credentialRecord && credentialRecord.nativeAuth && credentialRecord.nativeAuth.auth;
    const tokens = auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
    if (!tokens || hasRefreshToken(tokens)) return false;
    const accessToken = String(tokens.access_token || '').trim();
    return accessToken
      ? isExpiredJwt(accessToken, Math.floor(Date.now() / 1000))
      : false;
  }

  function isSelfRelayApiKey(cliName, apiKeyInfo) {
    const serverConfig = typeof readServerConfig === 'function' ? (readServerConfig() || {}) : {};
    return isSelfRelayApiKeyInfo(apiKeyInfo, serverConfig.port);
  }

  function upsertIndexedBaseState(accountRef, provider, state) {
    if (!accountStateService || typeof accountStateService.syncAccountBaseState !== 'function') return false;
    return accountStateService.syncAccountBaseState(accountRef, provider, state);
  }

  function persistLocalAuthExpiredRuntimeState(accountRef, provider, displayName = '') {
    const row = getIndexedState(accountRef) || {};
    const baseState = {
      status: row.status || 'up',
      configured: true,
      apiKeyMode: false,
      authMode: row.authMode || '',
      displayName: displayName || row.displayName || ''
    };
    // 运行态变更统一走门禁（见 account-runtime-gate 的 observeRuntimeState）。
    return createAccountRuntimeGate({ accountStateService }).observeRuntimeState({
      provider,
      accountRef,
      runtimeState: buildAuthInvalidRuntimeState('local_unrefreshable_token_expired'),
      baseState,
      source: 'cli.account.selection'
    });
  }

  function getCurrentAccountRef(provider, currentCliAccountId) {
    const account = resolveAccountRecord(provider, currentCliAccountId);
    return String(account && account.accountRef || '');
  }

  /**
   * 把一个 CLI 账号记录变成「候选账号对象」。这里只做**硬条件**过滤（记录缺失、
   * 凭据类型不匹配、未配置、本地不可刷新令牌过期）；运行态/额度/模型这些会随
   * 时间变化的结论全部交给 healthy-account-selector 在选号那一刻现算。
   */
  function evaluateAccount(provider, record, options = {}) {
    const accountRef = record.accountRef;
    const row = getIndexedState(accountRef);
    if (row && String(row.status || 'up') !== 'up') return null;

    const credentialRecord = readCredential(accountRef);
    if (!credentialRecord || credentialRecord.provider !== provider) return null;
    const status = checkStatus(provider, accountRef) || {};
    const configured = Boolean(status.configured);
    const accountName = String(status.accountName || '').trim();
    const apiKeyInfo = readApiKeyInfo(provider, credentialRecord);
    const apiKeyMode = apiKeyInfo.apiKeyMode;
    if (!configured || isSelfRelayApiKey(provider, apiKeyInfo)) {
      upsertIndexedBaseState(accountRef, provider, { configured, apiKeyMode, remainingPct: null });
      return null;
    }
    if (!apiKeyMode && isLocallyAuthExpired(provider, credentialRecord)) {
      persistLocalAuthExpiredRuntimeState(accountRef, provider, accountName);
      upsertIndexedBaseState(accountRef, provider, {
        configured: true,
        apiKeyMode: false,
        remainingPct: null,
        displayName: accountName
      });
      return null;
    }

    if (apiKeyMode) {
      upsertIndexedBaseState(accountRef, provider, {
        configured: true,
        apiKeyMode: true,
        remainingPct: null,
        displayName: accountName
      });
      if (options.allowApiKey === false) return null;
      return {
        provider,
        accountRef,
        cliAccountId: record.cliAccountId,
        status: row && row.status || 'up',
        configured: true,
        apiKeyMode: true,
        authMode: row && row.authMode || '',
        remainingPct: null,
        quotaStatus: 'not_applicable',
        schedulableStatus: 'schedulable',
        schedulableReason: '',
        runtimeState: row && row.runtimeState || null
      };
    }

    const derivedState = refreshIndexedStateForAccount(provider, accountRef, {
      refreshSnapshot: options.refreshSnapshot !== false
    });
    const remainingPct = derivedState && Number.isFinite(Number(derivedState.remainingPct))
      ? Number(derivedState.remainingPct)
      : null;
    upsertIndexedBaseState(accountRef, provider, {
      configured: true,
      apiKeyMode: false,
      remainingPct: remainingPct != null && remainingPct >= 0 ? remainingPct : null,
      displayName: derivedState && derivedState.displayName || accountName
    });
    if (!derivedState) return null;
    return {
      provider,
      accountRef,
      cliAccountId: record.cliAccountId,
      status: row && row.status || 'up',
      configured: true,
      apiKeyMode: false,
      authMode: derivedState.authMode || row && row.authMode || '',
      remainingPct,
      quotaStatus: derivedState.quotaStatus || '',
      quotaReason: derivedState.quotaReason || '',
      schedulableStatus: derivedState.schedulableStatus || '',
      schedulableReason: derivedState.schedulableReason || '',
      runtimeState: row && row.runtimeState || null
    };
  }

  function normalizeExcludedRefs(options = {}) {
    const input = options.excludeAccountRefs;
    if (input instanceof Set) return input;
    if (Array.isArray(input)) {
      return new Set(input.map((ref) => String(ref || '').trim()).filter(Boolean));
    }
    return new Set();
  }

  /**
   * 取一个健康账号。
   *
   * family=true（默认）时，CodeBuddy 的 codebuddy / codebuddycn 会放在同一个候选池里
   * ——它们的会话存储本来就是同一份，换号不应该区分站点。
   *
   * 返回 `{ provider, accountRef, cliAccountId, remainingPct, healthStatus }` 或 null。
   * 账号健康度在**本次调用内**按当前时刻重算，不缓存。
   */
  function getNextHealthyAccount(provider, currentId, options = {}) {
    const baseProvider = String(provider || '').trim().toLowerCase();
    if (!baseProvider) return null;
    const providers = options.family === false
      ? [baseProvider]
      : listSwitchableProviders(baseProvider);
    let currentRef = '';
    try {
      currentRef = getCurrentAccountRef(baseProvider, currentId);
    } catch (_error) {
      currentRef = '';
    }
    const excludedRefs = normalizeExcludedRefs(options);
    const modelOptions = buildModelSelectionOptions(options.model);
    const candidates = [];

    providers.forEach((candidateProvider) => {
      let records = [];
      try {
        records = listKnownAccounts(candidateProvider);
      } catch (_error) {
        records = [];
      }
      records.forEach((record) => {
        const accountRef = String(record && record.accountRef || '').trim();
        if (!accountRef) return;
        if (accountRef === currentRef) return;
        if (excludedRefs.has(accountRef)) return;
        let candidate = null;
        try {
          candidate = evaluateAccount(candidateProvider, record, options);
        } catch (_error) {
          // 单个账号读失败（凭据文件损坏 / DB 忙）不能拖垮整次选号：
          // 自动换号是在看门狗里跑的，抛出去会直接把会话进程带崩。
          candidate = null;
        }
        if (candidate) candidates.push(candidate);
      });
    });

    let evaluated = [];
    try {
      evaluated = rankHealthyAccounts(candidates, {
        provider: baseProvider,
        model: options.model || '',
        now: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
        allowApiKey: options.allowApiKey !== false,
        requireModel: options.requireModel === true,
        providerPreference: [baseProvider],
        accountActivity: options.accountActivity,
        includeUnhealthy: true,
        ...modelOptions
      });
    } catch (_error) {
      // 排序层自身异常同样不能拖垮看门狗：按「这次没找到」处理。
      evaluated = [];
    }
    const picked = evaluated.find((item) => item && item.healthy) || null;
    if (!picked) {
      if (options.describeFailure === true) {
        return {
          target: null,
          reason: summarizeRejections(evaluated) || `no_${baseProvider}_accounts`
        };
      }
      return null;
    }
    return {
      provider: picked.provider,
      accountRef: picked.accountRef,
      cliAccountId: String(picked.cliAccountId || '').trim(),
      remainingPct: picked.remainingPct,
      healthStatus: picked.status
    };
  }

  function getNextAvailableId(provider, currentId, options = {}) {
    const target = getNextHealthyAccount(provider, currentId, {
      ...options,
      family: false
    });
    return target ? target.cliAccountId : null;
  }

  function getFirstLoginableOAuthId(provider, currentId) {
    const currentRef = getCurrentAccountRef(provider, currentId);
    for (const record of listKnownAccounts(provider)) {
      if (record.accountRef === currentRef || !isRuntimeSelectableForLogin(record.accountRef)) continue;
      const row = getIndexedState(record.accountRef);
      if (row && String(row.status || 'up') !== 'up') continue;
      const credentialRecord = readCredential(record.accountRef);
      const status = checkStatus(provider, record.accountRef) || {};
      const accountName = String(status.accountName || '').trim();
      const apiKeyInfo = readApiKeyInfo(provider, credentialRecord);
      if (!status.configured || apiKeyInfo.apiKeyMode || isSelfRelayApiKey(provider, apiKeyInfo)) continue;
      if (isLocallyAuthExpired(provider, credentialRecord)) {
        persistLocalAuthExpiredRuntimeState(record.accountRef, provider, accountName);
        continue;
      }
      upsertIndexedBaseState(record.accountRef, provider, {
        configured: true,
        apiKeyMode: false,
        remainingPct: null,
        displayName: accountName && accountName !== 'Unknown' ? accountName : null
      });
      return record.cliAccountId;
    }

    return null;
  }

  function getNextLoginableId(provider, currentId, options = {}) {
    const schedulableOAuthId = getNextAvailableId(provider, currentId, {
      ...options,
      allowApiKey: false
    });
    if (schedulableOAuthId) return schedulableOAuthId;
    return getFirstLoginableOAuthId(provider, currentId);
  }

  return {
    getNextAvailableId,
    getNextHealthyAccount,
    getNextLoginableId
  };
}

module.exports = {
  createAccountSelectionService
};
