'use strict';

const { readAccountUsageSnapshot } = require('../account/usage-snapshot-store');
const { readUpstreamErrorRules, readUpstreamErrorGroupIds } = require('../account/upstream-error-rules');
const { isCodebuddyFamilyProvider } = require('../account/codebuddy-account-status');
const { readFastAccountPresence, isCredentialOnlyProvider } = require('./account-presence-probes');
const {
  buildDisplayNameCandidates,
  buildViewUsageView,
  decorateAccountRecord,
  readViewAuthMetadata,
  resolveAuthMetadataEmail,
  resolveRoleFlagsExtras,
  resolveSchedulableOverride,
  shouldDeferAuthJsonIdentity
} = require('./account-view-hints');
const { listProvidersByCapability } = require('../provider-catalog');
const { getProbeSpec } = require('./window-activation/probe-specs');
const { getProviderCapability } = require('../providers');
const { listActivityActions } = require('../account/activity-claim');
const { buildStepRegistry, runRefreshSteps } = require('./account-refresh-steps');

// 「该 provider 能否由网关服务（HTTP relay，**不依赖本机客户端**）」的唯一判定：
// provider 描述符的 relay 能力（transport=http 且 clientDependent=false）。
// qoder 这类 transport=client-cli 的 provider 不满足（推理必须经本机 CLI）。
// 前端据此给出 aih-server 目标（chat 走网关 = 无 CLI 冷启动、无 CLI 侧模型名问题）。
function providerSupportsGatewayRelay(provider) {
  try {
    const relay = getProviderCapability(provider, 'relay');
    return Boolean(relay) && relay.transport === 'http' && relay.clientDependent === false;
  } catch (_error) {
    return false;
  }
}
const { listQuotaProviders } = require('../usage/quota');

// 有额度快照的 provider 以额度源注册表为准（native 合同能力 ∪ 额度插件），
// 不在这里另写名单（此前读合同能力会漏掉插件型 provider，账号页永远读不到它们的额度）。
const QUOTA_USAGE_PROVIDERS = new Set(listQuotaProviders());
const { applyGoRuntimeOverlay } = require('./go-runtime-overlay');
// 运行池一被重载，规则投影就可能变了（宿主侧新增/消失的账号、外部改动）。
// 池变即推送：见 go-core-projection-sync（未装配时安静跳过）。
const { notifyGoCoreProjection } = require('./go-core-projection-sync');

const path = require('node:path');
const WebSocket = require('ws');
const {
  listAccountCredentialRecords,
  readAccountCredentialRecord
} = require('./account-credential-store');
const { resolveEffectiveAccountStatus } = require('../account/status-file');
const { readDefaultAccountRef } = require('../account/default-account-store');
const {
  readOptionalNumber,
  deriveQuotaState,
  deriveSchedulableState,
  getMinRemainingPctFromUsageSnapshot,
  resolvePreferredRemainingPct
} = require('../account/derived-state');
const {
  SUPPORTED_SERVER_PROVIDERS
} = require('./providers');
const {
  readTrustedUsageSnapshot,
  readUsageThresholdPct
} = require('./accounts');
const { withAccountQueryListFns } = require('./account-load-args');
const { normalizeAccountUsageSnapshot } = require('./account-usage-view');
const {
  ensureAccountsSnapshotLoaded,
  persistAccountsSnapshot
} = require('./webui-accounts-cache');
const {
  readAccountTokenUsageCache,
  writeAccountTokenUsageCache
} = require('./webui-account-token-usage-cache');
const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');
const {
  cleanOauthDisplayName,
  getApiKeyDisplayName,
  pickOauthDisplayName
} = require('./account-display-identity');
const { readProviderBaseUrl } = require('../account/provider-credential-env');
const { isCustomUpstreamAccount } = require('../account/official-upstream-endpoint');
const { getProviderUsageStrategy } = require('../usage/provider-usage');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { readKimiDesktopRegion } = require('./kimi-desktop-injector');
const { normalizeApiUsageByFormat } = require('../usage/model-usage-api-record');
const {
  resolveAgyRuntimeStatus
} = require('../account/agy-auth-recovery');
const {
  deriveEffectiveRuntimeStatus,
  isBlockingRuntimeStatus
} = require('../account/runtime-view');
const {
  buildProviderNativeCapabilityMap
} = require('../provider-native-capability-registry');
const {
  resolveOauthPendingState
} = require('./oauth-pending-state');
const { serializeAuthJob } = require('./web-account-auth');
const {
  ACCOUNT_TOKEN_USAGE_DIMENSIONS,
  applyAccountTokenUsageDelta,
  normalizeAccountTokenUsageValue
} = require('../usage/account-token-usage');

const ACCOUNTS_HYDRATE_TTL_MS = 15_000;
const ACCOUNTS_HYDRATE_BATCH_SIZE = 6;
const ACCOUNTS_WATCH_HEARTBEAT_MS = 30_000;
const ACCOUNTS_USAGE_CACHE_TTL_MS = 15_000;
const ACCOUNTS_FAST_SNAPSHOT_TTL_MS = 3_000;
// The signature scan opens the canonical account DB and reads credential
// metadata synchronously. A ten-second cadence keeps account changes fresh
// without monopolizing the server event loop between watcher events.
const ACCOUNTS_CANONICAL_POLL_MS = 10_000;
const ACCOUNTS_TOKEN_USAGE_CACHE_TTL_MS = 3_000;

function readConfiguredAccountErrorRules(ctx, credentialRecord) {
  return readUpstreamErrorRules(credentialRecord && credentialRecord.env);
}

function readConfiguredAccountErrorGroupIds(credentialRecord) {
  return readUpstreamErrorGroupIds(credentialRecord && credentialRecord.env);
}

const {
  isApiCredentialAuthMode,
  resolveRuntimeAuthMode
} = require('../account/runtime-auth-mode');

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(value) ? value : '';
}

function resolveUsageSnapshotRemaining(snapshot) {
  return getMinRemainingPctFromUsageSnapshot(snapshot);
}

function resolveAccountRemainingPct(values) {
  const snapshot = values && values.usageSnapshot;
  if (String(values && values.provider || '').trim().toLowerCase() === 'agy' && !snapshot) {
    return null;
  }
  if (snapshot && resolveUsageSnapshotRemaining(snapshot) == null) {
    return null;
  }
  return resolvePreferredRemainingPct(
    snapshot,
    values && values.stateRemainingPct,
    values && values.runtimeRemainingPct,
    values && values.cachedRemainingPct
  );
}

function resolveAccountUpdatedAt(values) {
  const configured = Boolean(values && values.configured);
  const apiKeyMode = Boolean(values && values.apiKeyMode);
  const usageSnapshot = values && values.usageSnapshot;
  const snapshotCapturedAt = Number(usageSnapshot && usageSnapshot.capturedAt);
  if (configured && !apiKeyMode && Number.isFinite(snapshotCapturedAt) && snapshotCapturedAt > 0) {
    return snapshotCapturedAt;
  }
  const probeCheckedAt = Number(values && values.probeCheckedAt);
  if (configured && !apiKeyMode && Number.isFinite(probeCheckedAt) && probeCheckedAt > 0) {
    return probeCheckedAt;
  }
  const fallbackCandidates = [
    Number(values && values.stateUpdatedAt),
    Number(values && values.cachedUpdatedAt)
  ].filter((value) => Number.isFinite(value) && value > 0);
  return fallbackCandidates.length > 0 ? Math.max(...fallbackCandidates) : 0;
}

// "Last used" should reflect ANY activity, not just gateway-proxied successes
// (lastSuccessAt). Native CLI usage refreshes the usage snapshot, so fold in
// usageSnapshot.capturedAt — otherwise an account in active use shows
// "尚无使用记录". Take the most recent of the available signals.
function resolveAccountLastUsedAt(runtimeAccount, usageSnapshot) {
  const candidates = [
    Number(runtimeAccount && runtimeAccount.lastSuccessAt),
    Number(usageSnapshot && usageSnapshot.capturedAt)
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

const CODEBUDDY_AUTH_INVALID_REASONS = new Set([
  'refresh_token_expired',
  'incomplete_oauth_credential',
  'credential_time_invalid'
]);

function resolveCodebuddyCredentialRuntimeStatus(provider, authReason, fallback) {
  const reason = String(authReason || '').trim();
  if (isCodebuddyFamilyProvider(provider) && CODEBUDDY_AUTH_INVALID_REASONS.has(reason)) {
    return { status: 'auth_invalid', until: 0, reason };
  }
  return fallback;
}

// Go 承接流量产生的冷却 / 熔断 / 最近成功只在 Go 内存里，由 go-runtime-overlay 定期拉取；
// 这里只叠加到展示记录上，不回写 Node 运行池（见 go-runtime-overlay.js 头注释）。
function readGoRuntimeOverlay(ctx) {
  const overlay = ctx && ctx.state && ctx.state.goRuntimeOverlay;
  return overlay && typeof overlay.get === 'function' ? overlay : null;
}

function withGoRuntimeOverlay(ctx, record) {
  const overlay = readGoRuntimeOverlay(ctx);
  if (!overlay || !record) return record;
  return applyGoRuntimeOverlay(record, overlay.get(record.accountRef));
}

function readEffectiveRuntimeState(runtimeAccount, stateInfo) {
  if (stateInfo && Object.prototype.hasOwnProperty.call(stateInfo, 'runtimeState')) return stateInfo.runtimeState;
  return runtimeAccount;
}

function parseJsonFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function resolveAiHomeDir(ctx) {
  const explicit = String((ctx && ctx.aiHomeDir) || (ctx && ctx.deps && ctx.deps.aiHomeDir) || '').trim();
  return explicit;
}

function resolveAccountProfileDir(ctx, provider, accountRef) {
  const resolver = typeof (ctx && ctx.getProfileDir) === 'function'
    ? ctx.getProfileDir
    : (ctx && ctx.deps && typeof ctx.deps.getProfileDir === 'function' ? ctx.deps.getProfileDir : null);
  if (resolver) {
    try {
      const profileDir = String(resolver(provider, accountRef) || '').trim();
      if (profileDir) return profileDir;
    } catch (_error) {}
  }
  return resolveAccountRuntimeDir(resolveAiHomeDir(ctx), provider, accountRef);
}

function readAccountRegion(ctx, provider, accountRef) {
  if (String(provider || '').trim().toLowerCase() !== 'kimi') return '';
  const profileDir = resolveAccountProfileDir(ctx, 'kimi', accountRef);
  if (!profileDir) return '';
  return readKimiDesktopRegion(path.join(profileDir, 'electron-user-data'), {
    fs: ctx.fs,
    path
  });
}

function readCodexDesktopAccountRef(ctx, aiHomeDir) {
  const state = parseJsonFileSafe(
    ctx.fs,
    path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json')
  ) || {};
  const accountRef = String(state.desktopAccountRef || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(accountRef) ? accountRef : '';
}

function resolveAccountRoleFlags(ctx, provider, accountRef) {
  const aiHomeDir = resolveAiHomeDir(ctx);
  const defaultAccountRef = readDefaultAccountRef(ctx.fs, aiHomeDir, provider);
  // 桌面端（ChatGPT App）账号标记由 provider 的视图提示回答，这里不判 provider。
  const extras = resolveRoleFlagsExtras(provider, ctx, {
    aiHomeDir,
    accountRef,
    readDesktopAccountRef: (dir) => readCodexDesktopAccountRef(ctx, dir)
  });
  return {
    isDefault: defaultAccountRef === String(accountRef),
    isMobile: extras.isMobile
  };
}

function resolveAccountRoleSignature(ctx) {
  const parts = [];
  const aiHomeDir = String((ctx && ctx.aiHomeDir) || (ctx && ctx.deps && ctx.deps.aiHomeDir) || '').trim();
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const defaultRef = readDefaultAccountRef(ctx.fs, aiHomeDir, provider);
    parts.push(`${provider}:${defaultRef}`);
  }
  const mobileRef = aiHomeDir ? readCodexDesktopAccountRef(ctx, aiHomeDir) : '';
  parts.push(`codex-mobile:${mobileRef}`);
  return parts.join('|');
}

function resolveApiKeyBaseUrl(provider, credentialRecord, runtimeAccount) {
  const runtimeBaseUrl = String(
    (runtimeAccount && (runtimeAccount.baseUrl || runtimeAccount.openaiBaseUrl))
    || ''
  ).trim();
  if (runtimeBaseUrl) return runtimeBaseUrl;

  const env = credentialRecord && credentialRecord.env && typeof credentialRecord.env === 'object'
    ? credentialRecord.env
    : {};
  return readProviderBaseUrl(provider, env);
}

function normalizeUsageProbeReason(value) {
  return String(value || '').trim().slice(0, 500);
}

function deriveAccountPoolState(values) {
  const quotaState = deriveQuotaState({
    provider: values && values.provider,
    configured: values && values.configured,
    apiKeyMode: values && values.apiKeyMode,
    planType: values && values.planType,
    remainingPct: values && values.remainingPct,
    usageSnapshot: values && values.usageSnapshot,
    probeError: values && values.probeError
  });
  const schedulableState = deriveSchedulableState({
    provider: values && values.provider,
    configured: values && values.configured,
    apiKeyMode: values && values.apiKeyMode,
    accountStatus: values && values.accountStatus,
    runtimeStatus: values && values.runtimeStatus,
    // relay 禁用是运行池的显式策略；额度/阈值仍按最新快照重算，不能继承旧阻塞。
    relayDisabled: Boolean(values && values.runtimeAccount
      && values.runtimeAccount.schedulableStatus === 'relay_disabled'),
    relayDisabledReason: values && values.runtimeAccount && values.runtimeAccount.schedulableReason,
    planType: values && values.planType,
    remainingPct: values && values.remainingPct,
    usageSnapshot: values && values.usageSnapshot,
    quotaState,
    usageThresholdPct: values && values.usageThresholdPct
  });
  return {
    disabled: schedulableState.status === 'blocked_by_policy',
    reason: schedulableState.status === 'blocked_by_policy'
      ? String(schedulableState.reason || '')
      : '',
    quotaState,
    schedulableState
  };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function reloadRuntimeAccountsForLiveSnapshot(ctx) {
  if (!ctx || !ctx.state) return false;
  const {
    state,
    fs,
    accountStateIndex,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    loadServerRuntimeAccounts,
    applyReloadState
  } = ctx;
  if (typeof loadServerRuntimeAccounts !== 'function' || typeof applyReloadState !== 'function') {
    return false;
  }
  const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
    fs,
    accountStateIndex,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    aiHomeDir: ctx.aiHomeDir || '',
    serverPort: ctx.options && ctx.options.port,
    accountRuntimeGate: ctx.deps && ctx.deps.accountRuntimeGate
  }, ctx));
  applyReloadState(state, runtimeAccounts);
  // 池变即推送：宿主/外部新增或消失的账号会改变「哪些账号带生效规则」，
  // 不推送则 go-core-route-deferral 继续按旧规则表决定请求交给谁。
  notifyGoCoreProjection(ctx, 'upstreamErrorRules');
  return true;
}

function getAccountsLiveState(state) {
  if (!state.__webUiAccountsLive) {
    state.__webUiAccountsLive = {
      records: new Map(),
      metadata: new Map(),
      usageSnapshots: new Map(),
      tokenUsage: null,
      pendingTokenUsage: new Map(),
      watchers: new Set(),
      webSocketWatchers: new Set(),
      webSocketServer: null,
      loadedFromDisk: false,
      hydrating: false,
      queued: false,
      snapshotRefreshScheduled: false,
      canonicalPoller: null,
      canonicalPollInFlight: false,
      canonicalSignature: '',
      hydrationPromise: null,
      lastHydratedAt: 0,
      revision: 0,
      roleSignature: '',
      fastSnapshot: null,
      fastSnapshotAt: 0
    };
  }
  if (!state.__webUiAccountsLive.pendingTokenUsage) {
    state.__webUiAccountsLive.pendingTokenUsage = new Map();
  }
  return state.__webUiAccountsLive;
}

// 额度快照的采集时间也是账号列表的真相来源之一：后台定时/手动刷新只写额度快照
// (app_kv account:usage:*)，不一定改变 account_state。签名不含它时，页面开着几小时
// 额度都不动（5h/7d 窗口变化、额度更新时间、订阅到期都依赖快照），必须纳入签名，
// 让 10 秒轮询发现变化并经 SSE/WebSocket 推送。
function buildUsageSnapshotSignature(ctx, accountRef) {
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!ctx || !ctx.fs || !aiHomeDir) return '';
  try {
    const snapshot = readAccountUsageSnapshot(ctx.fs, aiHomeDir, accountRef);
    return snapshot ? String(snapshot.capturedAt || '') : '';
  } catch (_error) {
    return '';
  }
}

function buildStateRowSignature(row) {
  if (!row || typeof row !== 'object') return '';
  return [
    row.status,
    row.configured,
    row.apiKeyMode,
    row.authMode,
    row.remainingPct,
    row.displayName,
    row.updatedAt,
    JSON.stringify(row.runtimeState || null)
  ].map((value) => String(value == null ? '' : value)).join(',');
}

function listProviderAccountRecords(ctx, provider) {
  const aiHomeDir = resolveAiHomeDir(ctx);
  if (!ctx || !ctx.fs || !aiHomeDir) return [];
  const reader = typeof ctx.listAccountCredentialRecords === 'function'
    ? ctx.listAccountCredentialRecords
    : (ctx.deps && typeof ctx.deps.listAccountCredentialRecords === 'function'
        ? ctx.deps.listAccountCredentialRecords
        : listAccountCredentialRecords);
  return reader(ctx.fs, aiHomeDir, provider) || [];
}

function buildAccountArtifactSignature(ctx, provider, accountRef, credentials) {
  return [
    Number(credentials && credentials.envUpdatedAt) || 0,
    Number(credentials && credentials.nativeAuthUpdatedAt) || 0,
    credentials && credentials.env && credentials.env.AIH_UPSTREAM_ERROR_RULES || '',
    credentials && credentials.env && credentials.env.AIH_UPSTREAM_ERROR_GROUP_IDS || '',
    readAccountRegion(ctx, provider, accountRef)
  ].join(',');
}

function buildCanonicalAccountsSignature(ctx) {
  if (!ctx) return '';
  const { accountStateIndex } = ctx;
  const parts = [`roles:${resolveAccountRoleSignature(ctx)}`];
  const goOverlay = readGoRuntimeOverlay(ctx);
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const accountRecords = listProviderAccountRecords(ctx, provider);
    const stateRows = listProviderStateRows(accountStateIndex, provider);
    const stateByRef = new Map(
      stateRows.map((row) => [
        String(row.accountRef || '').trim(),
        row
      ])
    );
    parts.push(provider);
    for (const accountRecord of accountRecords) {
      const accountRef = String(accountRecord && accountRecord.accountRef || '').trim();
      if (!accountRef) continue;
      const usageSignature = buildUsageSnapshotSignature(ctx, accountRef);
      const goRuntimeSignature = goOverlay ? goOverlay.signature(accountRef) : '';
      parts.push([
        accountRef,
        buildStateRowSignature(stateByRef.get(accountRef)),
        buildAccountArtifactSignature(ctx, provider, accountRef, accountRecord),
        ...(usageSignature ? [`usage@${usageSignature}`] : []),
        ...(goRuntimeSignature ? [`go@${goRuntimeSignature}`] : [])
      ].join(':'));
    }
  }
  return parts.join('|');
}

function invalidateCanonicalDerivedCaches(liveState) {
  if (!liveState) return;
  liveState.metadata.clear();
  liveState.usageSnapshots.clear();
  liveState.tokenUsage = null;
  invalidateFastAccountsSnapshot(liveState);
}

async function refreshAccountsFromCanonicalSource(ctx, options = {}) {
  if (!ctx || !ctx.state) return false;
  const liveState = getAccountsLiveState(ctx.state);
  const goOverlay = readGoRuntimeOverlay(ctx);
  if (goOverlay && typeof goOverlay.refresh === 'function') await goOverlay.refresh().catch(() => false);
  const nextSignature = buildCanonicalAccountsSignature(ctx);
  if (!options.force && nextSignature === liveState.canonicalSignature) return false;
  liveState.canonicalSignature = nextSignature;
  invalidateCanonicalDerivedCaches(liveState);
  try {
    reloadRuntimeAccountsForLiveSnapshot(ctx);
  } catch (_error) {}
  await hydrateAccountsInBackground(ctx, true).catch(() => false);
  return true;
}

function pollCanonicalAccountsOnce(ctx) {
  return refreshAccountsFromCanonicalSource(ctx, { force: false });
}

function stopCanonicalAccountsPoller(liveState) {
  if (!liveState || !liveState.canonicalPoller) return;
  clearInterval(liveState.canonicalPoller);
  liveState.canonicalPoller = null;
}

function ensureCanonicalAccountsPoller(ctx) {
  if (!ctx || !ctx.state) return;
  const liveState = getAccountsLiveState(ctx.state);
  if (liveState.canonicalPoller) return;
  liveState.canonicalSignature = buildCanonicalAccountsSignature(ctx);
  const pollOnce = () => {
    if (liveState.canonicalPollInFlight) return;
    liveState.canonicalPollInFlight = true;
    pollCanonicalAccountsOnce(ctx)
      .catch(() => {})
      .finally(() => {
        liveState.canonicalPollInFlight = false;
      });
  };
  liveState.canonicalPoller = setInterval(() => {
    if (liveState.watchers.size === 0 && liveState.webSocketWatchers.size === 0) {
      stopCanonicalAccountsPoller(liveState);
      return;
    }
    pollOnce();
  }, ACCOUNTS_CANONICAL_POLL_MS);
  // Go 运行态叠加层只在轮询里刷新；页面刚连上就拉一次，不必等第一个 10 秒。
  if (readGoRuntimeOverlay(ctx)) pollOnce();
  if (typeof liveState.canonicalPoller.unref === 'function') {
    liveState.canonicalPoller.unref();
  }
}

function cloneFastSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      accounts: [],
      hydrating: false,
      providerNativeCapabilities: buildProviderNativeCapabilityMap(SUPPORTED_SERVER_PROVIDERS)
    };
  }
  return {
    accounts: serializePublicAccountRecords(Array.isArray(snapshot.accounts) ? snapshot.accounts : []),
    hydrating: Boolean(snapshot.hydrating),
    providerNativeCapabilities: buildProviderNativeCapabilityMap(SUPPORTED_SERVER_PROVIDERS)
  };
}

function serializePublicAccountRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const publicRecord = { ...record };
  delete publicRecord.uniqueKey;
  delete publicRecord.accountId;
  delete publicRecord.cliAccountId;
  delete publicRecord.configDir;
  delete publicRecord.profileDir;
  return publicRecord;
}

function serializePublicAccountRecords(records) {
  return (Array.isArray(records) ? records : []).map(serializePublicAccountRecord);
}

function readCachedUsageSnapshot(ctx, provider, accountRef) {
  const { state, fs } = ctx;
  const liveState = getAccountsLiveState(state);
  const key = normalizeAccountRef(accountRef);
  const cached = liveState.usageSnapshots.get(key);
  if (cached && Number(cached.expiresAt) > Date.now()) {
    return cached.value;
  }
  const snapshot = normalizeAccountUsageSnapshot(
    readTrustedUsageSnapshot({ fs, aiHomeDir: resolveAiHomeDir(ctx) }, provider, accountRef)
  );
  liveState.usageSnapshots.set(key, {
    expiresAt: Date.now() + ACCOUNTS_USAGE_CACHE_TTL_MS,
    value: snapshot
  });
  return snapshot;
}

function readCachedAccountMetadata(ctx, provider, accountRef, usageSnapshot) {
  const { state } = ctx;
  const liveState = getAccountsLiveState(state);
  const key = normalizeAccountRef(accountRef);
  const cached = liveState.metadata.get(key);
  if (cached && Number(cached.expiresAt) > Date.now()) {
    return cached.value;
  }

  let value = {
    email: '',
    planType: '',
    planName: ''
  };

  // 缓存元数据（邮箱/套餐等）从用量快照的 account 里取哪些字段，由用量端口模块决定。
  const usageStrategy = getProviderUsageStrategy(provider);
  if (typeof usageStrategy.cachedAccountMetadata === 'function' && usageSnapshot && usageSnapshot.account) {
    value = usageStrategy.cachedAccountMetadata(usageSnapshot.account);
  }

  liveState.metadata.set(key, {
    expiresAt: Date.now() + ACCOUNTS_USAGE_CACHE_TTL_MS,
    value
  });
  return value;
}

function readCachedAccountTokenUsage(ctx) {
  const liveState = getAccountsLiveState(ctx.state);
  const now = Date.now();
  if (liveState.tokenUsage && Number(liveState.tokenUsage.expiresAt) > now) {
    return liveState.tokenUsage.value;
  }

  const cache = readAccountTokenUsageCache(ctx);
  liveState.tokenUsage = {
    expiresAt: now + ACCOUNTS_TOKEN_USAGE_CACHE_TTL_MS,
    generatedAt: Number(cache && cache.generatedAt) || 0,
    accountGeneratedAt: liveState.tokenUsage && liveState.tokenUsage.accountGeneratedAt || new Map(),
    value: cache ? cache.accounts : null
  };
  return liveState.tokenUsage.value;
}

function readAccountTokenUsage(ctx, accountRef) {
  const allUsage = readCachedAccountTokenUsage(ctx);
  const key = String(accountRef || '').trim();
  const pending = getAccountsLiveState(ctx.state).pendingTokenUsage.get(key) || [];
  if (!allUsage && pending.length === 0) return null;
  const value = allUsage instanceof Map ? allUsage.get(key) : allUsage && allUsage[key];
  const usage = value
    ? normalizeAccountTokenUsageValue(value, ACCOUNT_TOKEN_USAGE_DIMENSIONS)
    // 没有任何记录的账号也要给全维度零值，避免前端少一根柱子。
    : { ...Object.fromEntries(ACCOUNT_TOKEN_USAGE_DIMENSIONS.map((dimension) => [dimension, 0])), models: [] };
  return pending.reduce((current, event) => applyAccountTokenUsageDelta(current, event), usage);
}

function updateCachedAccountTokenUsage(ctx, usageByAccount, options = {}) {
  if (!ctx || !ctx.state) return null;
  const liveState = getAccountsLiveState(ctx.state);
  const previousUsage = readCachedAccountTokenUsage(ctx);
  const generatedAt = Number(options.generatedAt) || Date.now();
  const previousAt = Number(liveState.tokenUsage && liveState.tokenUsage.generatedAt) || 0;
  const provider = String(options.provider || '').trim().toLowerCase();
  if (!provider && previousAt > generatedAt) {
    return readAccountTokenUsageCache(ctx);
  }
  const accountGeneratedAt = new Map(liveState.tokenUsage && liveState.tokenUsage.accountGeneratedAt);
  const previous = previousUsage instanceof Map ? Object.fromEntries(previousUsage) : { ...previousUsage };
  const nextUsage = provider ? { ...previous } : { ...usageByAccount };
  const updatedRefs = new Set(Object.keys(usageByAccount || {}));
  for (const [accountRef, record] of liveState.records) {
    if (!provider || record.provider === provider) updatedRefs.add(accountRef);
  }
  if (!provider) {
    for (const accountRef of [...Object.keys(previous), ...liveState.pendingTokenUsage.keys()]) updatedRefs.add(accountRef);
  }
  for (const accountRef of updatedRefs) {
    // 全量查询与 provider 增量查询可以并行返回，按账号的查询截止时间合并，
    // 既保留较新的 Grok 账单，也接收同一全量结果中其他账号的新用量。
    if (Math.max(accountGeneratedAt.get(accountRef) || 0, previousAt) > generatedAt) {
      if (previous[accountRef]) nextUsage[accountRef] = previous[accountRef];
      else delete nextUsage[accountRef];
      updatedRefs.delete(accountRef);
      continue;
    }
    if (usageByAccount && usageByAccount[accountRef]) nextUsage[accountRef] = usageByAccount[accountRef];
    else delete nextUsage[accountRef];
    accountGeneratedAt.set(accountRef, generatedAt);
  }
  const cache = writeAccountTokenUsageCache(ctx, nextUsage, {
    ...options, generatedAt: provider ? previousAt : generatedAt
  });
  const now = Date.now();
  liveState.tokenUsage = {
    expiresAt: now + ACCOUNTS_TOKEN_USAGE_CACHE_TTL_MS,
    generatedAt: cache.generatedAt,
    accountGeneratedAt,
    value: cache.accounts
  };
  for (const [accountRef, events] of liveState.pendingTokenUsage) {
    if (!updatedRefs.has(accountRef)) continue;
    const pending = events.filter((event) => event.occurredAt > generatedAt);
    if (pending.length) liveState.pendingTokenUsage.set(accountRef, pending);
    else liveState.pendingTokenUsage.delete(accountRef);
  }

  let changed = false;
  for (const [accountRef, record] of liveState.records) {
    const nextTokenUsage = readAccountTokenUsage(ctx, accountRef);
    const previousTokenUsage = record && record.tokenUsage;
    if (JSON.stringify(previousTokenUsage || null) === JSON.stringify(nextTokenUsage || null)) continue;
    const nextRecord = { ...record, tokenUsage: nextTokenUsage };
    liveState.records.set(accountRef, nextRecord);
    liveState.revision += 1;
    changed = true;
    emitAccountsEvent(liveState, {
      type: 'account',
      revision: liveState.revision,
      account: serializePublicAccountRecord(nextRecord)
    });
  }

  if (changed) invalidateFastAccountsSnapshot(liveState);
  if (liveState.loadedFromDisk) {
    persistAccountsSnapshot(ctx, liveState, {
      revision: liveState.revision,
      hydrating: Boolean(liveState.hydrating),
      accounts: Array.from(liveState.records.values())
    });
  }
  return cache;
}

function emitAccountsEvent(liveState, payload) {
  broadcastSseJson(liveState.watchers, payload);
  broadcastAccountsWebSocketJson(liveState, liveState.webSocketWatchers, payload);
}

function emitAccountsLiveEvent(ctx, payload) {
  if (!ctx || !ctx.state) return;
  const liveState = getAccountsLiveState(ctx && ctx.state);
  emitAccountsEvent(liveState, payload);
}

// 单次请求完成的实时 token 消耗事件：由 server.js 的 recordModelUsage 钩子调用，
// 绕过 10 分钟级 model-usage 扫描，让 WebUI 账号用量随请求实时更新。
function emitAccountTokenConsumedEvent(state, payload = {}) {
  if (!state) return;
  const provider = String(payload.provider || '').trim().toLowerCase();
  const accountRef = normalizeAccountRef(payload.accountRef);
  if (!provider || !accountRef) return;
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
  const normalized = usage
    ? normalizeApiUsageByFormat(payload.usageFormat, provider, usage)
    : null;
  if (!normalized) return;
  const inputTokens = Math.max(0, Number(normalized.inputTokens) || 0)
    + Math.max(0, Number(normalized.cacheReadInputTokens) || 0)
    + Math.max(0, Number(normalized.cacheCreationInputTokens) || 0);
  const outputTokens = Math.max(0, Number(normalized.outputTokens) || 0)
    + Math.max(0, Number(normalized.reasoningOutputTokens) || 0);
  const totalTokens = Math.max(0, Number(normalized.totalTokens) || 0)
    || (inputTokens + outputTokens);
  if (totalTokens <= 0) return;
  const liveState = getAccountsLiveState(state);
  const record = liveState.records.get(accountRef);
  if (record && String(record.provider || '').toLowerCase() !== provider) return;
  const occurredAt = Number(payload.timestampMs) || Date.now();
  const event = { model: String(payload.model || '').trim(), total: totalTokens, occurredAt };
  const pending = liveState.pendingTokenUsage.get(accountRef) || [];
  liveState.pendingTokenUsage.set(accountRef, [...pending, event]);
  emitAccountsEvent(liveState, {
    type: 'token-consumed',
    provider,
    accountRef,
    model: event.model,
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens
    },
    occurredAt
  });
  if (!record) return;
  const nextRecord = { ...record, tokenUsage: applyAccountTokenUsageDelta(record.tokenUsage, event) };
  liveState.records.set(accountRef, nextRecord);
  liveState.revision += 1;
  invalidateFastAccountsSnapshot(liveState);
  emitAccountsEvent(liveState, {
    type: 'account',
    revision: liveState.revision,
    account: serializePublicAccountRecord(nextRecord)
  });
}

// 当前 accounts watch 的 SSE + WebSocket 监听者总数。验证码桥用它 fail-fast：
// 没有任何 WebUI 在线时不值得把客户端请求挂到验证超时。
function countAccountsWatchListeners(ctx) {
  if (!ctx || !ctx.state) return 0;
  const liveState = getAccountsLiveState(ctx.state);
  return liveState.watchers.size + liveState.webSocketWatchers.size;
}

function emitAccountsAuthJobEvent(ctx, job) {
  if (!ctx || !job) return;
  emitAccountsLiveEvent(ctx, {
    type: 'auth-job',
    job: serializeAuthJob(job)
  });
}

function sendAccountsWebSocketJson(client, payload) {
  if (!client || client.readyState !== WebSocket.OPEN) return false;
  client.send(JSON.stringify(payload));
  return true;
}

function removeAccountsWebSocketWatcher(liveState, watcher) {
  if (!liveState || !watcher) return;
  liveState.webSocketWatchers.delete(watcher);
  if (watcher.heartbeat) clearInterval(watcher.heartbeat);
  if (liveState.watchers.size === 0 && liveState.webSocketWatchers.size === 0) {
    stopCanonicalAccountsPoller(liveState);
  }
}

function broadcastAccountsWebSocketJson(liveState, watchers, payload) {
  for (const watcher of [...watchers]) {
    try {
      if (!sendAccountsWebSocketJson(watcher.client, payload)) {
        watchers.delete(watcher);
        if (watcher.heartbeat) clearInterval(watcher.heartbeat);
        if (watchers.size === 0 && liveState.watchers.size === 0) {
          stopCanonicalAccountsPoller(liveState);
        }
      }
    } catch (_error) {
      watchers.delete(watcher);
      if (watcher.heartbeat) clearInterval(watcher.heartbeat);
      if (watchers.size === 0 && liveState.watchers.size === 0) {
        stopCanonicalAccountsPoller(liveState);
      }
    }
  }
}

function attachAccountsWebSocketWatcher(liveState, client) {
  const watcher = {
    client,
    heartbeat: setInterval(() => {
      try {
        sendAccountsWebSocketJson(client, { type: 'heartbeat', at: Date.now() });
      } catch (_error) {
        removeAccountsWebSocketWatcher(liveState, watcher);
      }
    }, ACCOUNTS_WATCH_HEARTBEAT_MS)
  };
  if (typeof watcher.heartbeat.unref === 'function') watcher.heartbeat.unref();
  liveState.webSocketWatchers.add(watcher);

  client.on('close', () => removeAccountsWebSocketWatcher(liveState, watcher));
  client.on('error', () => removeAccountsWebSocketWatcher(liveState, watcher));

  return watcher;
}

function getAccountsWatchWebSocketServer(liveState) {
  if (!liveState.webSocketServer) {
    liveState.webSocketServer = new WebSocket.Server({ noServer: true });
  }
  return liveState.webSocketServer;
}

function invalidateFastAccountsSnapshot(liveState) {
  if (!liveState) return;
  liveState.fastSnapshot = null;
  liveState.fastSnapshotAt = 0;
}

function removeLiveAccountRecord(ctx, provider, accountRef, reason = '') {
  if (!ctx || !ctx.state) return false;
  const liveState = getAccountsLiveState(ctx.state);
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedAccountRef = String(accountRef || '').trim();
  if (!normalizedProvider || !/^acct_[a-f0-9]{20}$/.test(normalizedAccountRef)) return false;
  const key = normalizedAccountRef;
  const existed = liveState.records.delete(key);
  liveState.metadata.delete(key);
  liveState.usageSnapshots.delete(key);
  liveState.pendingTokenUsage.delete(key);
  invalidateFastAccountsSnapshot(liveState);
  liveState.revision += 1;
  emitAccountsEvent(liveState, {
    type: 'account-removed',
    revision: liveState.revision,
    provider: normalizedProvider,
    accountRef: normalizedAccountRef,
    reason: String(reason || '').trim().slice(0, 160),
    removedAt: Date.now()
  });
  persistAccountsSnapshot(ctx, liveState, {
    revision: liveState.revision,
    hydrating: Boolean(liveState.hydrating),
    accounts: Array.from(liveState.records.values())
  });
  return existed;
}

function removeMissingLiveAccountRecords(ctx, canonicalAccountRefs, reason) {
  const liveState = getAccountsLiveState(ctx.state);
  for (const [accountRef, record] of liveState.records) {
    if (canonicalAccountRefs.has(accountRef)) continue;
    removeLiveAccountRecord(ctx, record && record.provider, accountRef, reason);
  }
}

function listProviderStateRows(accountStateIndex, provider) {
  if (accountStateIndex && typeof accountStateIndex.listStates === 'function') {
    return accountStateIndex.listStates(provider);
  }
  return [];
}

function readLatestAccountState(accountStateIndex, accountRef, fallback = {}) {
  if (!accountStateIndex || typeof accountStateIndex.getAccountState !== 'function') {
    return fallback;
  }
  return accountStateIndex.getAccountState(accountRef) || {};
}

function buildRuntimeAccountMap(state) {
  const map = new Map();
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const items = Array.isArray(state.accounts && state.accounts[provider])
      ? state.accounts[provider]
      : [];
    for (const account of items) {
      const accountRef = String(account && account.accountRef || '').trim();
      if (!/^acct_[a-f0-9]{20}$/.test(accountRef)) continue;
      map.set(normalizeAccountRef(accountRef), account);
    }
  }
  return map;
}

// 在场判定（已配置 / API Key 模式）由 provider 探针注册表回答：见 ./account-presence-probes.js。

// 「在场判定只来自 DB 已登记凭据」的 provider：CodeBuddy / WorkBuddy 家族与 Cline。
// 它们都不在运行时账号池里（没有 runtimeAccount 可发布），但页面仍须收到显式运行时状态
// ——包括 healthy，用来清掉浏览器里保留的上一次认证失败状态。
// `pending` 是「未配置」时的**派生占位值**（唯一生产者是本文件 `configured ? … : 'pending'`），
// 不是真实套餐。已配置的账号不得从上一轮记录/元数据里把它继承过来，否则套餐列会一直停在
// pending ——2026-10-14 实测：cline 凭据被识别为已配置后 configured 已是 true，套餐列仍显示
// pending，因为快速快照继承了未配置那一轮留下的缓存值。
function readInheritedPlanType(value) {
  const planType = String(value || '').trim();
  return planType && planType !== 'pending' ? planType : '';
}

function buildBaseAccountRecord(ctx, input) {
  return withGoRuntimeOverlay(ctx, buildNodeBaseAccountRecord(ctx, input));
}

function buildNodeBaseAccountRecord(ctx, input) {
  const {
    provider,
    accountRef,
    credentialRecord,
    stateInfo,
    runtimeAccount,
    cachedRecord
  } = input;
  const roleFlags = resolveAccountRoleFlags(ctx, provider, accountRef);
  const region = readAccountRegion(ctx, provider, accountRef);
  const agyMetadata = readViewAuthMetadata(provider, { credentialRecord, accountRef });
  const fastPresence = readFastAccountPresence(provider, credentialRecord, agyMetadata);
  const runtimeAuthMode = resolveRuntimeAuthMode(runtimeAccount);
  const stateAuthMode = String(stateInfo.authMode || '').trim();
  const apiKeyMode = Boolean(
    fastPresence.apiKeyMode
    || (runtimeAccount
      ? isApiCredentialAuthMode(runtimeAuthMode)
      : stateInfo.apiKeyMode)
  );
  const credentialAuthInvalid = isCodebuddyFamilyProvider(provider)
    && CODEBUDDY_AUTH_INVALID_REASONS.has(String(fastPresence.authReason || '').trim());
  const configured = !credentialAuthInvalid && Boolean(
    fastPresence.configured
    || runtimeAccount
  );
  const hasProviderUsage = QUOTA_USAGE_PROVIDERS.has(provider);
  // 库里的快照才是真相(终端标题每次都直接读它);内存里上一轮记录只在库里没有时兜底。
  // 反过来优先内存记录,新值就只能等后台重建 + 推送,重建一旦对该账号失败就永远停在旧值。
  const usageSnapshot = configured && !apiKeyMode && hasProviderUsage
    ? (
        readCachedUsageSnapshot(ctx, provider, accountRef)
        || (cachedRecord && cachedRecord.usageSnapshot)
        || null
      )
    : null;
  const metadata = configured && !apiKeyMode && hasProviderUsage
    ? readCachedAccountMetadata(ctx, provider, accountRef, usageSnapshot)
    : null;
  const agyUsageView = configured && !apiKeyMode
    ? buildViewUsageView(provider, {
        usageSnapshot,
        runtimeState: readEffectiveRuntimeState(runtimeAccount, stateInfo),
        account: {
          ...(runtimeAccount || {}),
          planType: (metadata && metadata.planType) || (cachedRecord && cachedRecord.planType) || 'oauth'
        }
      })
    : null;
  const effectiveUsageSnapshot = agyUsageView
    ? agyUsageView.usageSnapshot
    : usageSnapshot;
  const remainingPct = configured && !apiKeyMode && hasProviderUsage
    ? (
        agyUsageView
          ? agyUsageView.remainingPct
          : resolveAccountRemainingPct({
              stateRemainingPct: readOptionalNumber(stateInfo.remainingPct),
              runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
              cachedRemainingPct: cachedRecord && cachedRecord.remainingPct,
              usageSnapshot: effectiveUsageSnapshot,
              provider
            })
      )
    : null;
  const runtimeStatus = resolveCodebuddyCredentialRuntimeStatus(
    provider,
    fastPresence.authReason,
    resolveAgyRuntimeStatus(
      provider,
      deriveEffectiveRuntimeStatus(runtimeAccount, stateInfo),
      agyMetadata
    )
  );
  const runtimeBlocked = isBlockingRuntimeStatus(runtimeStatus);
  // 家族与 Cline 不在运行池中；仍须发布 healthy，清除浏览器保留的旧认证失败状态。
  const publishRuntimeStatus = runtimeBlocked || Boolean(runtimeAccount) || isCredentialOnlyProvider(provider);
  const visibleRemainingPct = runtimeBlocked ? null : remainingPct;
  const probeState = typeof ctx.getLastUsageProbeState === 'function'
    ? (ctx.getLastUsageProbeState(provider, accountRef) || null)
    : null;
  const probeError = probeState
    ? String(probeState.error || '')
    : (
        typeof ctx.getLastUsageProbeError === 'function'
          ? ctx.getLastUsageProbeError(provider, accountRef)
          : ''
      );
  const probeCheckedAt = Number((probeState && probeState.checkedAt) || 0);
  const hasPersistedIdentity = Boolean(
    pickOauthDisplayName(
      cachedRecord && cachedRecord.displayName,
      cachedRecord && cachedRecord.email,
      stateInfo.displayName
    )
  );
  const deferAuthJsonIdentity = shouldDeferAuthJsonIdentity(provider, {
    usageSnapshot: effectiveUsageSnapshot,
    hasPersistedIdentity
  });
  const baseUrl = apiKeyMode ? resolveApiKeyBaseUrl(provider, credentialRecord, runtimeAccount) : '';
  // 调度规则（账号级上游错误映射）只对第三方/自建上游的 API Key 账号开放，判定唯一来源见
  // account/official-upstream-endpoint（OAuth 与官方地址账号没有可对齐的错误码）。
  const customUpstream = isCustomUpstreamAccount({ provider, apiKeyMode, baseUrl });
  const displayName = apiKeyMode
    ? getApiKeyDisplayName(provider, { baseUrl })
    : pickOauthDisplayName(
        ...buildDisplayNameCandidates(provider, {
          phone: metadata && metadata.phone,
          metadataEmail: metadata && metadata.email,
          authMetadataEmail: resolveAuthMetadataEmail(provider, agyMetadata),
          runtimeAccountDisplayName: runtimeAccount && runtimeAccount.displayName,
          deferredIdentity: deferAuthJsonIdentity
        }),
        fastPresence.displayName,
        cachedRecord && cachedRecord.displayName,
        runtimeAccount && runtimeAccount.email,
        stateInfo.displayName
      );
  const status = resolveEffectiveAccountStatus(stateInfo.status);
  const authMode = runtimeAuthMode || stateAuthMode;
  const stateUpdatedAt = Number(stateInfo.updatedAt || 0);
  const oauthPendingState = resolveOauthPendingState({
    configured,
    apiKeyMode,
    authMode,
    updatedAt: stateUpdatedAt
  });
  const planType = configured
    ? (
        apiKeyMode
          ? 'api-key'
          : String(
              (agyUsageView && agyUsageView.planType)
              || readInheritedPlanType(metadata && metadata.planType)
              || readInheritedPlanType(cachedRecord && cachedRecord.planType)
              || 'oauth'
            )
      )
    : 'pending';
  const planName = configured && !apiKeyMode
    ? String(
        (metadata && metadata.planName)
        || (cachedRecord && cachedRecord.planName)
        || ''
      ).trim()
    : '';
  const usageThresholdPct = readUsageThresholdPct({
    fs: ctx.fs,
    aiHomeDir: resolveAiHomeDir(ctx)
  });
  const poolState = deriveAccountPoolState({
    provider,
    configured,
    apiKeyMode,
    runtimeAccount,
    accountStatus: status,
    runtimeStatus: runtimeBlocked ? runtimeStatus.status : (runtimeAccount && !apiKeyMode ? runtimeStatus.status : ''),
    planType,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    probeError,
    usageThresholdPct
  });
  const lastUsedAt = resolveAccountLastUsedAt(runtimeAccount, effectiveUsageSnapshot);
  const quotaState = poolState.quotaState || deriveQuotaState({
    provider,
    configured,
    apiKeyMode,
    planType,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    probeError
  });
  let schedulableState = poolState.schedulableState || deriveSchedulableState({
    provider,
    configured,
    apiKeyMode,
    accountStatus: status,
    runtimeStatus: runtimeBlocked ? runtimeStatus.status : (runtimeAccount && !apiKeyMode ? runtimeStatus.status : ''),
    planType,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    quotaState,
    usageThresholdPct
  });
  if (runtimeStatus.status === 'auth_invalid') {
    schedulableState = {
      status: 'blocked_by_runtime_status',
      reason: 'auth_invalid'
    };
  }
  const schedulableOverride = resolveSchedulableOverride(provider, {
    configured,
    runtimeAccount,
    source: agyMetadata
  });
  if (schedulableOverride) schedulableState = schedulableOverride;
  return {
    provider,
    accountRef,
    status,
    displayName,
    configured,
    apiKeyMode,
    isDefault: roleFlags.isDefault,
    isMobile: roleFlags.isMobile,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    upstreamErrorRules: readConfiguredAccountErrorRules(ctx, credentialRecord),
    upstreamErrorGroupIds: readConfiguredAccountErrorGroupIds(credentialRecord),
    updatedAt: resolveAccountUpdatedAt({
      configured,
      apiKeyMode,
      usageSnapshot: effectiveUsageSnapshot,
      probeCheckedAt,
      stateUpdatedAt,
      cachedUpdatedAt: cachedRecord && cachedRecord.updatedAt
    }),
    planType,
    planName: planName || undefined,
    region: region || undefined,
    // zcode 的**区域**（zai / bigmodel）：与上面的 region（kimi 的网络区域
    // china/overseas）语义不同，因此单独一个字段，不混用。
    zcodeRegion: String((runtimeAccount && runtimeAccount.zcodeRegion) || '').trim() || undefined,
    email: pickOauthDisplayName(
      !deferAuthJsonIdentity && metadata && metadata.email,
      agyMetadata && agyMetadata.email,
      cachedRecord && cachedRecord.email,
      runtimeAccount && runtimeAccount.email
    ),
    tokenUsage: readAccountTokenUsage(ctx, accountRef),
    authMode,
    authPending: oauthPendingState.pending,
    authPendingStale: oauthPendingState.stale,
    authPendingAgeMs: oauthPendingState.ageMs,
    baseUrl,
    customUpstream,
    // 窗口激活（5h 滚动限额探测）是否支持这个 provider：判定唯一来源是探测规格注册表，
    // 账号页据此决定是否显示入口（不在前端写 provider 清单）。
    windowActivationSupported: Boolean(getProbeSpec(provider)),
    // 账号是否进入别名自动选号池（默认参与）。请求热路径读运行池里的同一字段。
    aliasPoolParticipates: !(runtimeAccount && runtimeAccount.aliasPoolParticipates === false),
    // 账号活动（签到 / 领套餐）：动作清单来自 provider 描述符的 activity 能力。
    activityActions: listActivityActions(provider),
    // 该 provider 能否由**网关**服务（HTTP relay，不需要本机 CLI）：判定唯一来源是
    // provider 描述符的 relay 能力，前端据此决定是否给出「aih-server」目标
    // （chat 模式走网关 = 无 CLI 冷启动/无 CLI 侧模型名问题）。
    gatewayTargetSupported: providerSupportsGatewayRelay(provider),
    quotaStatus: quotaState.status,
    quotaReason: quotaState.reason || undefined,
    schedulableStatus: schedulableState.status,
    schedulableReason: schedulableState.reason || undefined,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    runtimeStatus: publishRuntimeStatus ? runtimeStatus.status : undefined,
    runtimeUntil: publishRuntimeStatus ? runtimeStatus.until : undefined,
    runtimeReason: publishRuntimeStatus ? runtimeStatus.reason : undefined
  };
}

function buildFastAccountsSnapshot(ctx) {
  const {
    state,
    accountStateIndex
  } = ctx;
  const liveState = getAccountsLiveState(state);
  ensureAccountsSnapshotLoaded(ctx, liveState);
  const roleSignature = resolveAccountRoleSignature(ctx);
  if (
    liveState.fastSnapshot
    && (Date.now() - liveState.fastSnapshotAt) < ACCOUNTS_FAST_SNAPSHOT_TTL_MS
    && liveState.roleSignature === roleSignature
  ) {
    return cloneFastSnapshot(liveState.fastSnapshot);
  }
  const runtimeAccountMap = buildRuntimeAccountMap(state);
  const accounts = [];

  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const accountRecords = listProviderAccountRecords(ctx, provider);
    const stateRows = listProviderStateRows(accountStateIndex, provider);
    const stateByRef = new Map(
      stateRows.map((row) => [
        String(row.accountRef || '').trim(),
        row
      ])
    );

    for (const credentialRecord of accountRecords) {
      const accountRef = String(credentialRecord && credentialRecord.accountRef || '').trim();
      if (!accountRef) continue;
      const key = normalizeAccountRef(accountRef);
      const stateInfo = stateByRef.get(accountRef) || {};
      const runtimeAccount = runtimeAccountMap.get(key) || null;
      const cachedRecord = liveState.records.get(key) || null;
      const record = buildBaseAccountRecord(ctx, {
        provider,
        accountRef,
        credentialRecord,
        stateInfo,
        runtimeAccount,
        cachedRecord
      });
      liveState.records.set(key, record);
      accounts.push(record);
    }
  }

  removeMissingLiveAccountRecords(
    ctx,
    new Set(accounts.map((record) => record.accountRef)),
    'snapshot_account_missing'
  );

  const snapshot = {
    accounts,
    hydrating: Boolean(liveState.hydrating),
      providerNativeCapabilities: buildProviderNativeCapabilityMap(SUPPORTED_SERVER_PROVIDERS)
  };
  liveState.roleSignature = roleSignature;
  persistAccountsSnapshot(ctx, liveState, {
    revision: liveState.revision,
    hydrating: snapshot.hydrating,
    accounts: snapshot.accounts
  });
  return cloneFastSnapshot(liveState.fastSnapshot);
}

function buildHydratedAccountRecord(ctx, input) {
  return withGoRuntimeOverlay(ctx, buildNodeHydratedAccountRecord(ctx, input));
}

function buildNodeHydratedAccountRecord(ctx, input) {
  const {
    provider,
    accountRef,
    credentialRecord,
    stateInfo,
    runtimeAccount
  } = input;
  const {
    state,
    checkStatus
  } = ctx;
  const liveState = getAccountsLiveState(state);
  const roleFlags = resolveAccountRoleFlags(ctx, provider, accountRef);
  const region = readAccountRegion(ctx, provider, accountRef);
  const liveStatus = checkStatus(provider, accountRef) || {};
  const liveAuthReason = String(liveStatus.authReason || liveStatus.reason || '').trim();
  const credentialAuthInvalid = isCodebuddyFamilyProvider(provider)
    && CODEBUDDY_AUTH_INVALID_REASONS.has(liveAuthReason);
  const accountName = String(liveStatus.accountName || '').trim();
  const configured = !credentialAuthInvalid && Boolean(liveStatus.configured);
  const apiKeyMode = configured
    ? (
        accountName.startsWith('API Key')
        || Boolean(stateInfo.apiKeyMode)
        || Boolean(runtimeAccount && runtimeAccount.apiKeyMode)
      )
    : false;
  const hasProviderUsage = QUOTA_USAGE_PROVIDERS.has(provider);
  const usageSnapshot = configured && !apiKeyMode && hasProviderUsage
    ? (readCachedUsageSnapshot(ctx, provider, accountRef) || (stateInfo && stateInfo.usageSnapshot) || null)
    : null;
  const agyUsageView = configured && !apiKeyMode
    ? buildViewUsageView(provider, {
        usageSnapshot,
        runtimeState: readEffectiveRuntimeState(runtimeAccount, stateInfo),
        account: runtimeAccount || { planType: 'oauth' }
      })
    : null;
  const effectiveUsageSnapshot = agyUsageView
    ? agyUsageView.usageSnapshot
    : usageSnapshot;
  const remainingPct = configured && !apiKeyMode && hasProviderUsage
    ? (
        agyUsageView
          ? agyUsageView.remainingPct
          : resolveAccountRemainingPct({
              stateRemainingPct: readOptionalNumber(stateInfo.remainingPct),
              runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
              cachedRemainingPct: null,
              usageSnapshot: effectiveUsageSnapshot,
              provider
            })
      )
    : null;
  const baseUrl = apiKeyMode ? resolveApiKeyBaseUrl(provider, credentialRecord, runtimeAccount) : '';
  // 调度规则（账号级上游错误映射）只对第三方/自建上游的 API Key 账号开放，判定唯一来源见
  // account/official-upstream-endpoint（OAuth 与官方地址账号没有可对齐的错误码）。
  const customUpstream = isCustomUpstreamAccount({ provider, apiKeyMode, baseUrl });
  const displayName = apiKeyMode
    ? getApiKeyDisplayName(provider, { baseUrl })
    : pickOauthDisplayName(
        ...buildDisplayNameCandidates(provider, {
          phone: effectiveUsageSnapshot && effectiveUsageSnapshot.account && effectiveUsageSnapshot.account.phone,
          metadataEmail: accountName,
          authMetadataEmail: null,
          runtimeAccountDisplayName: runtimeAccount && runtimeAccount.displayName
        }),
        stateInfo.displayName
      );
  const status = resolveEffectiveAccountStatus(stateInfo.status);
  const authMode = String(stateInfo.authMode || '').trim();
  const stateUpdatedAt = Number(stateInfo.updatedAt || 0);
  const oauthPendingState = resolveOauthPendingState({
    configured,
    apiKeyMode,
    authMode,
    updatedAt: stateUpdatedAt
  });

  let planType = configured ? (apiKeyMode ? 'api-key' : 'oauth') : 'pending';
  let planName = '';
  let email = '';
  try {
    // 套餐类型、套餐名与主标识的取法由用量端口模块决定；未声明的 provider 沿用上面的默认值。
    const usageStrategy = getProviderUsageStrategy(provider);
    const identity = typeof usageStrategy.liveAccountIdentity === 'function'
      ? usageStrategy.liveAccountIdentity({
        configured,
        apiKeyMode,
        usageSnapshot,
        effectiveUsageSnapshot,
        agyUsageView,
        cleanAccountName: () => cleanOauthDisplayName(accountName)
      })
      : null;
    if (identity) {
      if (identity.planType !== undefined) planType = identity.planType;
      if (identity.planName !== undefined) planName = identity.planName;
      if (identity.email !== undefined) email = identity.email;
    }
  } catch (_error) {}

  const runtimeStatus = resolveCodebuddyCredentialRuntimeStatus(
    provider,
    liveAuthReason,
    resolveAgyRuntimeStatus(
      provider,
      deriveEffectiveRuntimeStatus(runtimeAccount, stateInfo),
      liveStatus
    )
  );
  const runtimeBlocked = isBlockingRuntimeStatus(runtimeStatus);
  // 家族与 Cline 不在运行池中；仍须发布 healthy，清除浏览器保留的旧认证失败状态。
  const publishRuntimeStatus = runtimeBlocked || Boolean(runtimeAccount) || isCredentialOnlyProvider(provider);
  const visibleRemainingPct = runtimeBlocked ? null : remainingPct;
  const probeState = typeof ctx.getLastUsageProbeState === 'function'
    ? (ctx.getLastUsageProbeState(provider, accountRef) || null)
    : null;
  const probeError = probeState
    ? String(probeState.error || '')
    : (
        typeof ctx.getLastUsageProbeError === 'function'
          ? ctx.getLastUsageProbeError(provider, accountRef)
          : ''
      );
  const probeCheckedAt = Number((probeState && probeState.checkedAt) || 0);
  const usageThresholdPct = readUsageThresholdPct({
    fs: ctx.fs,
    aiHomeDir: resolveAiHomeDir(ctx)
  });
  const poolState = deriveAccountPoolState({
    provider,
    configured,
    apiKeyMode,
    runtimeAccount,
    accountStatus: status,
    runtimeStatus: runtimeBlocked ? runtimeStatus.status : (runtimeAccount && !apiKeyMode ? runtimeStatus.status : ''),
    planType,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    probeError,
    usageThresholdPct
  });
  const lastUsedAt = resolveAccountLastUsedAt(runtimeAccount, effectiveUsageSnapshot);
  const quotaState = poolState.quotaState || deriveQuotaState({
    provider,
    configured,
    apiKeyMode,
    planType,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    probeError
  });
  let schedulableState = poolState.schedulableState || deriveSchedulableState({
    provider,
    configured,
    apiKeyMode,
    accountStatus: status,
    runtimeStatus: runtimeBlocked ? runtimeStatus.status : (runtimeAccount && !apiKeyMode ? runtimeStatus.status : ''),
    planType,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    quotaState,
    usageThresholdPct
  });
  if (runtimeStatus.status === 'auth_invalid') {
    schedulableState = {
      status: 'blocked_by_runtime_status',
      reason: 'auth_invalid'
    };
  }
  const schedulableOverride = resolveSchedulableOverride(provider, {
    configured,
    runtimeAccount,
    source: liveStatus
  });
  if (schedulableOverride) schedulableState = schedulableOverride;
  const record = {
    provider,
    accountRef,
    status,
    displayName,
    configured,
    apiKeyMode,
    isDefault: roleFlags.isDefault,
    isMobile: roleFlags.isMobile,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    upstreamErrorRules: readConfiguredAccountErrorRules(ctx, credentialRecord),
    upstreamErrorGroupIds: readConfiguredAccountErrorGroupIds(credentialRecord),
    updatedAt: resolveAccountUpdatedAt({
      configured,
      apiKeyMode,
      usageSnapshot: effectiveUsageSnapshot,
      probeCheckedAt,
      stateUpdatedAt,
      cachedUpdatedAt: 0
    }),
    planType,
    planName: planName || undefined,
    region: region || undefined,
    // zcode 服务区域（zai / bigmodel）：同邮箱账号靠它区分，见 zcode-account-region。
    zcodeRegion: String((runtimeAccount && runtimeAccount.zcodeRegion) || '').trim() || undefined,
    email,
    tokenUsage: readAccountTokenUsage(ctx, accountRef),
    authMode,
    authPending: oauthPendingState.pending,
    authPendingStale: oauthPendingState.stale,
    authPendingAgeMs: oauthPendingState.ageMs,
    baseUrl,
    customUpstream,
    // 窗口激活（5h 滚动限额探测）是否支持这个 provider：判定唯一来源是探测规格注册表。
    windowActivationSupported: Boolean(getProbeSpec(provider)),
    // 账号是否进入别名自动选号池（默认参与）。请求热路径读运行池里的同一字段。
    aliasPoolParticipates: !(runtimeAccount && runtimeAccount.aliasPoolParticipates === false),
    // 账号活动（签到 / 领套餐）：与上面同源（描述符 activity 能力）。
    activityActions: listActivityActions(provider),
    // 该 provider 能否由网关服务（HTTP relay）——与上面的判定同源（描述符），
    // 前端据此给出「aih-server」目标。
    gatewayTargetSupported: providerSupportsGatewayRelay(provider),
    quotaStatus: quotaState.status,
    quotaReason: quotaState.reason || undefined,
    schedulableStatus: schedulableState.status,
    schedulableReason: schedulableState.reason || undefined
  };

  if (lastUsedAt) {
    record.lastUsedAt = lastUsedAt;
  }
  if (configured && !apiKeyMode) {
    // provider 自己的记录装饰（codex：workspace_id / workspace_error，与 Go 管理 API 同一事实）。
    decorateAccountRecord(provider, { record, credentialRecord });
  }
  if (publishRuntimeStatus) {
    record.runtimeStatus = runtimeStatus.status;
    record.runtimeUntil = runtimeStatus.until;
    record.runtimeReason = runtimeStatus.reason;
  }

  liveState.metadata.set(normalizeAccountRef(accountRef), {
    expiresAt: Date.now() + ACCOUNTS_USAGE_CACHE_TTL_MS,
    value: {
      email,
      planType,
      planName
    }
  });

  return record;
}

async function refreshLiveAccountRecord(ctx, provider, accountRef, options = {}) {
  const {
    state,
    fs,
    accountStateIndex,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    ensureUsageSnapshotAsync,
    loadServerRuntimeAccounts,
    applyReloadState
  } = ctx;
  const liveState = getAccountsLiveState(state);
  const key = normalizeAccountRef(accountRef);
  const skipUsageRefresh = Boolean(options.skipUsageRefresh);
  const skipRuntimeReload = Boolean(options.skipRuntimeReload);
  const stateInfo = readLatestAccountState(accountStateIndex, accountRef);
  const credentialRecord = readAccountCredentialRecord(fs, resolveAiHomeDir(ctx), accountRef);
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!key || !credentialRecord || credentialRecord.provider !== normalizedProvider) {
    if (key && normalizedProvider) {
      removeLiveAccountRecord(ctx, normalizedProvider, key, 'canonical_account_missing');
    }
    return null;
  }
  const authMetadata = readViewAuthMetadata(provider, { credentialRecord, accountRef });
  const presence = readFastAccountPresence(provider, credentialRecord, authMetadata);
  const currentRecord = liveState.records.get(key) || null;
  const apiKeyMode = Boolean(
    presence.apiKeyMode
    || (currentRecord && currentRecord.apiKeyMode)
    || stateInfo.apiKeyMode
  );

  // 刷新 = 一组**互相独立**的步骤，各自异步、各自捕获错误。
  // 原来这里是两条裸 await 串在一起：用量探测一抛错（zcode 的 3001 就是），
  // 运行时重载与记录重建全都不执行，整次刷新被判失败 —— 而它们本来毫无依赖。
  const currentSnapshot = currentRecord && currentRecord.usageSnapshot
    ? currentRecord.usageSnapshot
    : readCachedUsageSnapshot(ctx, provider, accountRef);
  const refreshSteps = buildStepRegistry([
    {
      id: 'usage', label: '用量探测',
      run: async () => {
        if (skipUsageRefresh || apiKeyMode || typeof ensureUsageSnapshotAsync !== 'function') return { skipped: true };
        liveState.usageSnapshots.delete(key);
        await ensureUsageSnapshotAsync(provider, accountRef, currentSnapshot, { forceRefresh: true });
        liveState.usageSnapshots.delete(key);
        return { refreshed: true };
      }
    },
    {
      id: 'runtime', label: '运行时重载',
      run: async () => {
        if (skipRuntimeReload || typeof loadServerRuntimeAccounts !== 'function'
          || typeof applyReloadState !== 'function') return { skipped: true };
        const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
          fs, accountStateIndex, getToolConfigDir, getProfileDir, checkStatus,
          aiHomeDir: ctx.aiHomeDir || '',
          serverPort: ctx.options && ctx.options.port,
          accountRuntimeGate: ctx.deps && ctx.deps.accountRuntimeGate
        }, ctx));
        applyReloadState(state, runtimeAccounts);
        notifyGoCoreProjection(ctx, 'upstreamErrorRules');
        return { reloaded: true };
      }
    }
  ]);
  const refreshReport = await runRefreshSteps(refreshSteps, { provider, accountRef, ctx }, {
    onStepDone(step, entry) {
      // 步骤失败必须留下痕迹：原来失败会整体抛出，现在被隔离了。
      if (!entry.ok) reportRefreshStepFailure(provider, accountRef, step.id, entry.error);
    }
  });
  if (options.reportOut) options.reportOut.value = refreshReport;

  const runtimeAccount = buildRuntimeAccountMap(state).get(key) || null;
  const nextStateInfo = readLatestAccountState(accountStateIndex, accountRef, stateInfo);
  const record = buildHydratedAccountRecord(ctx, {
    provider,
    accountRef,
    credentialRecord,
    stateInfo: nextStateInfo,
    runtimeAccount
  });
  const previous = liveState.records.get(key) || null;
  const previousSerialized = previous ? JSON.stringify(previous) : '';
  const nextSerialized = JSON.stringify(record);
  liveState.records.set(key, record);
  invalidateFastAccountsSnapshot(liveState);
  if (nextSerialized !== previousSerialized) {
    liveState.revision += 1;
    emitAccountsEvent(liveState, {
      type: 'account',
      revision: liveState.revision,
      account: serializePublicAccountRecord(record)
    });
  }
  persistAccountsSnapshot(ctx, liveState, {
    revision: liveState.revision,
    hydrating: Boolean(liveState.hydrating),
    accounts: Array.from(liveState.records.values())
  });
  return record;
}

// 同一账号同一错误只记一次,避免每轮重建(约 15 秒)刷屏。
const reportedHydrationFailures = new Map();

function reportHydrationFailure(accountRef, error) {
  const message = String((error && error.message) || error || 'unknown').slice(0, 300);
  if (reportedHydrationFailures.get(accountRef) === message) return;
  reportedHydrationFailures.set(accountRef, message);
  console.warn(`\x1b[33m[aih:accounts]\x1b[0m hydrate ${accountRef} failed: ${message}`);
}

function hydrateAccountsInBackground(ctx, force = false) {
  const { state, accountStateIndex } = ctx;
  const liveState = getAccountsLiveState(state);
  const now = Date.now();
  if (!force && liveState.lastHydratedAt > 0 && (now - liveState.lastHydratedAt) < ACCOUNTS_HYDRATE_TTL_MS) {
    return Promise.resolve(false);
  }
  if (liveState.hydrating) {
    liveState.queued = true;
    return liveState.hydrationPromise || Promise.resolve(false);
  }

  liveState.hydrating = true;

  const run = async () => {
    try {
      const runtimeAccountMap = buildRuntimeAccountMap(state);
      const queue = [];
      const canonicalKeys = new Set();

      for (const provider of SUPPORTED_SERVER_PROVIDERS) {
        const accountRecords = listProviderAccountRecords(ctx, provider);
        const stateRows = listProviderStateRows(accountStateIndex, provider);
        const stateByRef = new Map(
          stateRows.map((row) => [
            String(row.accountRef || '').trim(),
            row
          ])
        );

        for (const credentialRecord of accountRecords) {
          const accountRef = String(credentialRecord && credentialRecord.accountRef || '').trim();
          if (!accountRef) continue;
          canonicalKeys.add(normalizeAccountRef(accountRef));
          queue.push({
            provider,
            accountRef,
            credentialRecord,
            stateInfo: stateByRef.get(accountRef) || {},
            runtimeAccount: runtimeAccountMap.get(normalizeAccountRef(accountRef)) || null
          });
        }
      }

      for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index];
        try {
          // Batched hydration yields between records, so queued state may predate
          // a completed enable/disable request. Read durable state at apply time.
          const stateInfo = readLatestAccountState(
            accountStateIndex,
            item.accountRef,
            item.stateInfo
          );
          const record = buildHydratedAccountRecord(ctx, {
            ...item,
            stateInfo
          });
          const key = normalizeAccountRef(item.accountRef);
          const previous = liveState.records.get(key);
          const nextSerialized = JSON.stringify(record);
          const previousSerialized = previous ? JSON.stringify(previous) : '';
          liveState.records.set(key, record);
          if (nextSerialized !== previousSerialized) {
            invalidateFastAccountsSnapshot(liveState);
            liveState.revision += 1;
            emitAccountsEvent(liveState, {
              type: 'account',
              revision: liveState.revision,
              account: serializePublicAccountRecord(record)
            });
          }
        } catch (error) {
          // 单个账号失败不拖垮整轮重建,但必须留痕:它会让该账号的记录停在旧值。
          reportHydrationFailure(item.accountRef, error);
        }

        if (index % ACCOUNTS_HYDRATE_BATCH_SIZE === ACCOUNTS_HYDRATE_BATCH_SIZE - 1) {
          await nextTick();
        }
      }

      removeMissingLiveAccountRecords(ctx, canonicalKeys, 'canonical_account_missing');
    } finally {
      const runQueuedHydration = Boolean(liveState.queued);
      liveState.lastHydratedAt = Date.now();
      liveState.hydrating = false;
      persistAccountsSnapshot(ctx, liveState, {
        revision: liveState.revision,
        hydrating: false,
        accounts: Array.from(liveState.records.values())
      });
      if (runQueuedHydration) {
        liveState.queued = false;
        await hydrateAccountsInBackground(ctx, true).catch(() => {});
        return;
      }
      emitAccountsEvent(liveState, {
        type: 'hydrated',
        revision: liveState.revision,
        hydratedAt: liveState.lastHydratedAt
      });
    }
  };

  const hydrationPromise = new Promise((resolve) => {
    setTimeout(() => {
      run()
        .then(() => resolve(true))
        .catch(() => {
          liveState.hydrating = false;
          resolve(false);
        })
        .finally(() => {
          if (liveState.hydrationPromise === hydrationPromise) {
            liveState.hydrationPromise = null;
          }
        });
    }, 0);
  });
  liveState.hydrationPromise = hydrationPromise;
  return hydrationPromise;
}

function scheduleAccountsSnapshotRefresh(ctx, liveState) {
  setTimeout(() => {
    Promise.resolve()
      .then(() => {
        reloadRuntimeAccountsForLiveSnapshot(ctx);
      })
      .catch(() => {})
      .then(() => hydrateAccountsInBackground(ctx, true))
      .finally(() => {
        liveState.snapshotRefreshScheduled = false;
      });
  }, 0);
}

async function handleListAccountsFastRequest(ctx) {
  const { res, writeJson } = ctx;
  const snapshot = readAccountsFastSnapshot(ctx);
  writeJson(res, 200, {
    ok: true,
    accounts: snapshot.accounts,
    hydrating: snapshot.hydrating,
    providerNativeCapabilities: snapshot.providerNativeCapabilities
  });
  return true;
}

function readAccountsFastSnapshot(ctx) {
  hydrateAccountsInBackground(ctx).catch(() => {});
  return buildFastAccountsSnapshot(ctx);
}

function requestAccountsSnapshotRefresh(ctx) {
  const liveState = getAccountsLiveState(ctx.state);
  const requestedAt = Date.now();
  const alreadyRunning = Boolean(liveState.snapshotRefreshScheduled || liveState.hydrating);

  invalidateFastAccountsSnapshot(liveState);
  emitAccountsEvent(liveState, {
    type: 'snapshot-requested',
    revision: liveState.revision,
    requestedAt,
    hydrating: true
  });

  if (!liveState.snapshotRefreshScheduled) {
    liveState.snapshotRefreshScheduled = true;
    scheduleAccountsSnapshotRefresh(ctx, liveState);
  }

  return {
    requestedAt,
    alreadyRunning
  };
}

function handleAccountsWatchSnapshotRequest(ctx) {
  const { res, writeJson } = ctx;
  const result = requestAccountsSnapshotRefresh(ctx);
  writeJson(res, 202, {
    ok: true,
    accepted: true,
    alreadyRunning: result.alreadyRunning,
    requestedAt: result.requestedAt
  });
  return true;
}

function handleAccountsWatchRequest(ctx) {
  const {
    req,
    res,
    state
  } = ctx;
  const liveState = getAccountsLiveState(state);

  openSseStream(res);
  writeSseJson(res, { type: 'connected' });

  attachSseWatcher(liveState.watchers, req, res, {
    heartbeatMs: ACCOUNTS_WATCH_HEARTBEAT_MS,
    onWatcherRemoved: () => {
      if (liveState.watchers.size === 0 && liveState.webSocketWatchers.size === 0) {
        stopCanonicalAccountsPoller(liveState);
      }
    }
  });

  ensureCanonicalAccountsPoller(ctx);
  hydrateAccountsInBackground(ctx).catch(() => {});
  const snapshot = buildFastAccountsSnapshot(ctx);
  writeSseJson(res, {
    type: 'snapshot',
    revision: liveState.revision,
    accounts: snapshot.accounts,
    hydrating: snapshot.hydrating,
    providerNativeCapabilities: snapshot.providerNativeCapabilities
  });

  return true;
}

function handleAccountsWatchUpgrade(ctx) {
  const {
    req,
    socket,
    head,
    state
  } = ctx;
  const liveState = getAccountsLiveState(state);
  const server = getAccountsWatchWebSocketServer(liveState);

  server.handleUpgrade(req, socket, head, (client) => {
    try {
      attachAccountsWebSocketWatcher(liveState, client);
      sendAccountsWebSocketJson(client, { type: 'connected' });

      ensureCanonicalAccountsPoller(ctx);
      hydrateAccountsInBackground(ctx).catch(() => {});
      const snapshot = buildFastAccountsSnapshot(ctx);
      sendAccountsWebSocketJson(client, {
        type: 'snapshot',
        revision: liveState.revision,
        accounts: snapshot.accounts,
        hydrating: snapshot.hydrating,
        providerNativeCapabilities: snapshot.providerNativeCapabilities
      });
    } catch (_error) {
      try {
        client.close(1011, 'accounts_watch_failed');
      } catch (_innerError) {}
    }
  });

  return true;
}

module.exports = {
  handleListAccountsFastRequest,
  readAccountsFastSnapshot,
  handleAccountsWatchRequest,
  handleAccountsWatchSnapshotRequest,
  handleAccountsWatchUpgrade,
  refreshLiveAccountRecord,
  updateCachedAccountTokenUsage,
  removeLiveAccountRecord,
  emitAccountsAuthJobEvent,
  emitAccountsLiveEvent,
  emitAccountTokenConsumedEvent,
  countAccountsWatchListeners,
  __private: {
    getAccountsLiveState,
    buildCanonicalAccountsSignature,
    pollCanonicalAccountsOnce,
    stopCanonicalAccountsPoller,
    readFastAccountPresence,
    removeMissingLiveAccountRecords,
    refreshAccountsFromCanonicalSource
  }
};
