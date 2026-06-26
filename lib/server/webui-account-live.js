'use strict';

const path = require('node:path');
const WebSocket = require('ws');
const {
  readAccountStatusFile,
  resolveEffectiveAccountStatus
} = require('../account/status-file');
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
  readTrustedUsageSnapshot
} = require('./accounts');
const { withAccountQueryListFns } = require('./account-load-args');
const { normalizeAccountUsageSnapshot } = require('./account-usage-view');
const {
  buildAgyEffectiveUsageView,
  normalizeAgyPlanType
} = require('./agy-account-usage-view');
const {
  ensureAccountsSnapshotLoaded,
  persistAccountsSnapshot
} = require('./webui-accounts-cache');
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
const { readAgyAuthMetadata } = require('../account/agy-auth-metadata');
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

const ACCOUNTS_HYDRATE_TTL_MS = 15_000;
const ACCOUNTS_HYDRATE_BATCH_SIZE = 6;
const ACCOUNTS_WATCH_HEARTBEAT_MS = 30_000;
const ACCOUNTS_USAGE_CACHE_TTL_MS = 15_000;
const ACCOUNTS_FAST_SNAPSHOT_TTL_MS = 3_000;
const ACCOUNTS_CANONICAL_POLL_MS = 500;

const PROVIDER_GLOBAL_DIR = {
  codex: '.codex',
  gemini: '.gemini',
  claude: '.claude',
  agy: '.gemini'
};

// Canonical runtime account key (`provider:accountId`) — single definition in
// account-identity; this local alias keeps existing call sites readable.
const {
  getRuntimeAccountKey,
  resolveAccountUniqueKey,
  resolveAccountUniqueKeyFromObject
} = require('../account/account-identity');
const {
  isApiCredentialAccount,
  isApiCredentialAuthMode,
  resolveRuntimeAuthMode
} = require('../account/runtime-auth-mode');
const { upsertAccountRef } = require('./account-ref-store');

function makeAccountKey(provider, accountId) {
  return getRuntimeAccountKey(provider, accountId);
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

function resolveStableAccountKey(ctx, provider, accountId, runtimeAccount, cachedRecord) {
  const explicit = String(
    runtimeAccount && runtimeAccount.uniqueKey
    || cachedRecord && cachedRecord.uniqueKey
    || ''
  ).trim();
  if (explicit) return explicit;
  if (
    ctx
    && ctx.fs
    && typeof ctx.getProfileDir === 'function'
    && typeof ctx.getToolConfigDir === 'function'
  ) {
    const resolved = resolveAccountUniqueKey({
      fs: ctx.fs,
      path,
      provider,
      accountId,
      getProfileDir: ctx.getProfileDir,
      getToolConfigDir: ctx.getToolConfigDir,
      identityKind: runtimeAccount && isApiCredentialAccount(runtimeAccount)
        ? resolveRuntimeAuthMode(runtimeAccount)
        : undefined
    });
    if (resolved && !resolved.degraded && resolved.uniqueKey) return String(resolved.uniqueKey || '').trim();
  }
  const source = runtimeAccount || cachedRecord;
  if (source && (source.apiKeyMode || String(source.authType || '').trim().toLowerCase() === 'api-key')) return '';
  const resolved = resolveAccountUniqueKeyFromObject(source);
  return resolved && !resolved.degraded ? String(resolved.uniqueKey || '').trim() : '';
}

function resolveAccountLastUsedAt(runtimeAccount) {
  const lastSuccessAt = Number(runtimeAccount && runtimeAccount.lastSuccessAt);
  if (!Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0) return null;
  return lastSuccessAt;
}

function readEffectiveRuntimeState(runtimeAccount, stateInfo) {
  if (stateInfo && Object.prototype.hasOwnProperty.call(stateInfo, 'runtimeState')) return stateInfo.runtimeState;
  if (stateInfo && Object.prototype.hasOwnProperty.call(stateInfo, 'runtime_state')) return stateInfo.runtime_state;
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

function resolveAiHomeDir(ctx, profileDir) {
  const explicit = String((ctx && ctx.aiHomeDir) || (ctx && ctx.deps && ctx.deps.aiHomeDir) || '').trim();
  if (explicit) return explicit;
  const dir = String(profileDir || '').trim();
  return dir ? path.dirname(path.dirname(path.dirname(dir))) : '';
}

function resolveAccountRef(ctx, provider, accountId, uniqueKey) {
  const aiHomeDir = resolveAiHomeDir(ctx, typeof ctx.getProfileDir === 'function'
    ? ctx.getProfileDir(provider, accountId)
    : '');
  return upsertAccountRef(ctx.fs, aiHomeDir, {
    provider,
    accountId,
    uniqueKey: String(uniqueKey || '').trim()
  }, { bestEffort: true });
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (_error) {
    return '';
  }
}

function readCodexDesktopAccountId(ctx, aiHomeDir) {
  const state = parseJsonFileSafe(ctx.fs, path.join(aiHomeDir, 'codex-desktop-hook-state.json')) || {};
  const accountId = String(state.desktopAccountId || '').trim();
  return /^\d+$/.test(accountId) ? accountId : '';
}

function resolveAccountRoleFlags(ctx, provider, accountId, profileDir) {
  const aiHomeDir = resolveAiHomeDir(ctx, profileDir);
  const providerDir = aiHomeDir
    ? path.join(aiHomeDir, 'profiles', provider)
    : path.dirname(profileDir);
  const defaultAccountId = readTextFileSafe(ctx.fs, path.join(providerDir, '.aih_default'));
  const mobileAccountId = provider === 'codex' && aiHomeDir
    ? readCodexDesktopAccountId(ctx, aiHomeDir)
    : '';
  return {
    isDefault: defaultAccountId === String(accountId),
    isMobile: provider === 'codex' && mobileAccountId === String(accountId)
  };
}

function resolveProviderProfilesDir(ctx, provider) {
  const explicit = String((ctx && ctx.aiHomeDir) || (ctx && ctx.deps && ctx.deps.aiHomeDir) || '').trim();
  if (explicit) return path.join(explicit, 'profiles', provider);
  return '';
}

function resolveAccountRoleSignature(ctx) {
  const parts = [];
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const providerDir = resolveProviderProfilesDir(ctx, provider);
    const defaultId = providerDir
      ? readTextFileSafe(ctx.fs, path.join(providerDir, '.aih_default'))
      : '';
    parts.push(`${provider}:${/^\d+$/.test(defaultId) ? defaultId : ''}`);
  }
  const explicitAiHomeDir = String((ctx && ctx.aiHomeDir) || (ctx && ctx.deps && ctx.deps.aiHomeDir) || '').trim();
  const codexDir = resolveProviderProfilesDir(ctx, 'codex');
  const aiHomeDir = explicitAiHomeDir || (codexDir ? path.dirname(path.dirname(codexDir)) : '');
  const mobileId = aiHomeDir ? readCodexDesktopAccountId(ctx, aiHomeDir) : '';
  parts.push(`codex-mobile:${mobileId}`);
  return parts.join('|');
}

function readProfileEnv(fs, profileDir) {
  return parseJsonFileSafe(fs, path.join(profileDir, '.aih_env.json')) || {};
}

function resolveApiKeyBaseUrl(provider, fs, profileDir, runtimeAccount) {
  const runtimeBaseUrl = String(
    (runtimeAccount && (runtimeAccount.baseUrl || runtimeAccount.openaiBaseUrl))
    || ''
  ).trim();
  if (runtimeBaseUrl) return runtimeBaseUrl;

  const env = readProfileEnv(fs, profileDir);
  if (provider === 'codex') return String(env.OPENAI_BASE_URL || '').trim();
  if (provider === 'claude') return String(env.ANTHROPIC_BASE_URL || '').trim();
  if (provider === 'gemini') return String(env.GEMINI_BASE_URL || env.GOOGLE_BASE_URL || '').trim();
  return '';
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
    planType: values && values.planType,
    remainingPct: values && values.remainingPct,
    usageSnapshot: values && values.usageSnapshot,
    quotaState
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
    getToolAccountIds,
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
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    aiHomeDir: ctx.aiHomeDir || '',
    serverPort: ctx.options && ctx.options.port
  }, ctx));
  applyReloadState(state, runtimeAccounts);
  return true;
}

function getAccountsLiveState(state) {
  if (!state.__webUiAccountsLive) {
    state.__webUiAccountsLive = {
      records: new Map(),
      metadata: new Map(),
      usageSnapshots: new Map(),
      watchers: new Set(),
      webSocketWatchers: new Set(),
      webSocketServer: null,
      loadedFromDisk: false,
      hydrating: false,
      queued: false,
      snapshotRefreshScheduled: false,
      canonicalPoller: null,
      canonicalSignature: '',
      hydrationPromise: null,
      lastHydratedAt: 0,
      revision: 0,
      roleSignature: '',
      fastSnapshot: null,
      fastSnapshotAt: 0
    };
  }
  return state.__webUiAccountsLive;
}

function readPathRevision(fs, filePath) {
  try {
    if (!filePath || !fs || typeof fs.existsSync !== 'function' || !fs.existsSync(filePath)) return 'missing';
    const stat = fs.statSync(filePath);
    return `${Number(stat.size) || 0}:${Math.floor(Number(stat.mtimeMs) || 0)}`;
  } catch (_error) {
    return 'missing';
  }
}

function buildStateRowSignature(row) {
  if (!row || typeof row !== 'object') return '';
  return [
    row.status,
    row.configured,
    row.apiKeyMode,
    row.api_key_mode,
    row.authMode,
    row.auth_mode,
    row.remainingPct,
    row.remaining_pct,
    row.displayName,
    row.display_name,
    row.updatedAt,
    row.updated_at,
    JSON.stringify(row.runtimeState || row.runtime_state || null)
  ].map((value) => String(value == null ? '' : value)).join(',');
}

function buildAccountArtifactSignature(ctx, provider, accountId) {
  const { fs, getProfileDir, getToolConfigDir } = ctx;
  const profileDir = typeof getProfileDir === 'function' ? getProfileDir(provider, accountId) : '';
  const configDir = typeof getToolConfigDir === 'function' ? getToolConfigDir(provider, accountId) : '';
  const filePaths = [
    profileDir,
    profileDir ? path.join(profileDir, '.aih_env.json') : '',
    profileDir ? path.join(profileDir, '.aih_status') : '',
    profileDir ? path.join(profileDir, '.aih_usage.json') : '',
    configDir ? path.join(configDir, 'auth.json') : '',
    configDir ? path.join(configDir, 'oauth_creds.json') : '',
    configDir ? path.join(configDir, 'antigravity-oauth-token') : ''
  ];
  return filePaths.map((filePath) => readPathRevision(fs, filePath)).join(',');
}

function buildCanonicalAccountsSignature(ctx) {
  if (!ctx || typeof ctx.getToolAccountIds !== 'function') return '';
  const { accountStateIndex, getToolAccountIds } = ctx;
  const parts = [`roles:${resolveAccountRoleSignature(ctx)}`];
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const accountIds = (getToolAccountIds(provider) || [])
      .map((accountId) => String(accountId || '').trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const stateRows = listProviderStateRows(accountStateIndex, provider, accountIds);
    const stateById = new Map(
      stateRows.map((row) => [
        String(row.accountId || row.account_id || '').trim(),
        row
      ])
    );
    parts.push(provider);
    for (const accountId of accountIds) {
      parts.push([
        accountId,
        buildStateRowSignature(stateById.get(String(accountId))),
        buildAccountArtifactSignature(ctx, provider, accountId)
      ].join(':'));
    }
  }
  return parts.join('|');
}

function invalidateCanonicalDerivedCaches(liveState) {
  if (!liveState) return;
  liveState.metadata.clear();
  liveState.usageSnapshots.clear();
  invalidateFastAccountsSnapshot(liveState);
}

async function refreshAccountsFromCanonicalSource(ctx, options = {}) {
  if (!ctx || !ctx.state) return false;
  const liveState = getAccountsLiveState(ctx.state);
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

function ensureCanonicalAccountsPoller(ctx) {
  if (!ctx || !ctx.state) return;
  const liveState = getAccountsLiveState(ctx.state);
  if (liveState.canonicalPoller) return;
  liveState.canonicalSignature = buildCanonicalAccountsSignature(ctx);
  liveState.canonicalPoller = setInterval(() => {
    pollCanonicalAccountsOnce(ctx).catch(() => {});
  }, ACCOUNTS_CANONICAL_POLL_MS);
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
  return publicRecord;
}

function serializePublicAccountRecords(records) {
  return (Array.isArray(records) ? records : []).map(serializePublicAccountRecord);
}

function readCachedUsageSnapshot(ctx, provider, accountId) {
  const { state, fs, getProfileDir } = ctx;
  const liveState = getAccountsLiveState(state);
  const key = makeAccountKey(provider, accountId);
  const cached = liveState.usageSnapshots.get(key);
  if (cached && Number(cached.expiresAt) > Date.now()) {
    return cached.value;
  }
  const snapshot = normalizeAccountUsageSnapshot(
    readTrustedUsageSnapshot({ fs, getProfileDir }, provider, accountId)
  );
  liveState.usageSnapshots.set(key, {
    expiresAt: Date.now() + ACCOUNTS_USAGE_CACHE_TTL_MS,
    value: snapshot
  });
  return snapshot;
}

function readCachedAccountMetadata(ctx, provider, accountId, usageSnapshot) {
  const { state } = ctx;
  const liveState = getAccountsLiveState(state);
  const key = makeAccountKey(provider, accountId);
  const cached = liveState.metadata.get(key);
  if (cached && Number(cached.expiresAt) > Date.now()) {
    return cached.value;
  }

  let value = {
    email: '',
    planType: ''
  };

  if ((provider === 'codex' || provider === 'agy' || provider === 'claude') && usageSnapshot && usageSnapshot.account) {
    const snapshotPlanType = String(usageSnapshot.account.planType || '').trim();
    value = {
      email: String(usageSnapshot.account.email || '').trim(),
      planType: provider === 'agy'
        ? normalizeAgyPlanType(usageSnapshot.account.subscriptionTier, snapshotPlanType)
        : snapshotPlanType
    };
  }

  liveState.metadata.set(key, {
    expiresAt: Date.now() + ACCOUNTS_USAGE_CACHE_TTL_MS,
    value
  });
  return value;
}

function emitAccountsEvent(liveState, payload) {
  broadcastSseJson(liveState.watchers, payload);
  broadcastAccountsWebSocketJson(liveState.webSocketWatchers, payload);
}

function emitAccountsLiveEvent(ctx, payload) {
  if (!ctx || !ctx.state) return;
  const liveState = getAccountsLiveState(ctx && ctx.state);
  emitAccountsEvent(liveState, payload);
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
}

function broadcastAccountsWebSocketJson(watchers, payload) {
  for (const watcher of [...watchers]) {
    try {
      if (!sendAccountsWebSocketJson(watcher.client, payload)) {
        watchers.delete(watcher);
        if (watcher.heartbeat) clearInterval(watcher.heartbeat);
      }
    } catch (_error) {
      watchers.delete(watcher);
      if (watcher.heartbeat) clearInterval(watcher.heartbeat);
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

function removeLiveAccountRecord(ctx, provider, accountId, reason = '') {
  if (!ctx || !ctx.state) return false;
  const liveState = getAccountsLiveState(ctx.state);
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedProvider || !normalizedAccountId) return false;
  const key = makeAccountKey(normalizedProvider, normalizedAccountId);
  const existed = liveState.records.delete(key);
  liveState.metadata.delete(key);
  liveState.usageSnapshots.delete(key);
  invalidateFastAccountsSnapshot(liveState);
  liveState.revision += 1;
  emitAccountsEvent(liveState, {
    type: 'account-removed',
    revision: liveState.revision,
    provider: normalizedProvider,
    accountId: normalizedAccountId,
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

function listProviderStateRows(accountStateIndex, provider, accountIds) {
  if (accountStateIndex && typeof accountStateIndex.listStates === 'function') {
    return accountStateIndex.listStates(provider);
  }
  return (Array.isArray(accountIds) ? accountIds : [])
    .map((accountId) => ({
      accountId: String(accountId || '').trim(),
      row: accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
        ? accountStateIndex.getAccountState(provider, accountId)
        : null
    }))
    .filter((entry) => Boolean(entry.row))
    .map((entry) => ({
      provider,
      accountId: String(entry.row.accountId || entry.row.account_id || entry.accountId).trim(),
      status: String(entry.row.status || 'up').trim().toLowerCase() === 'down' ? 'down' : 'up',
      configured: Boolean(entry.row.configured),
      apiKeyMode: Boolean(entry.row.apiKeyMode || entry.row.api_key_mode),
      runtimeState: entry.row.runtimeState || entry.row.runtime_state || null,
      remainingPct: readOptionalNumber(entry.row.remainingPct, entry.row.remaining_pct),
      displayName: cleanOauthDisplayName(entry.row.displayName || entry.row.display_name),
      authMode: String(entry.row.authMode || entry.row.auth_mode || '').trim(),
      updatedAt: Number(entry.row.updatedAt || entry.row.updated_at) || 0
    }));
}

function buildRuntimeAccountMap(state) {
  const map = new Map();
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const items = Array.isArray(state.accounts && state.accounts[provider])
      ? state.accounts[provider]
      : [];
    for (const account of items) {
      const accountId = String(account && (account.id || account.accountId) || '').trim();
      if (!accountId) continue;
      map.set(makeAccountKey(provider, accountId), account);
    }
  }
  return map;
}

function readFastAccountPresence(fs, provider, profileDir, configDir, authMetadata = null) {
  const apiEnvPath = path.join(profileDir, '.aih_env.json');
  if (fs.existsSync(apiEnvPath)) {
    if (provider === 'agy') {
      const env = readProfileEnv(fs, profileDir);
      return {
        configured: Boolean(
          String(env.AGY_ACCESS_TOKEN || env.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim()
          || (authMetadata && authMetadata.configured)
        ),
        apiKeyMode: false
      };
    }
    return {
      configured: true,
      apiKeyMode: true
    };
  }

  const usagePath = path.join(profileDir, '.aih_usage.json');
  if (fs.existsSync(usagePath)) {
    return {
      configured: true,
      apiKeyMode: false
    };
  }

  const globalDir = PROVIDER_GLOBAL_DIR[provider] || `.${provider}`;
  const providerDir = configDir || path.join(profileDir, globalDir);

  if (provider === 'codex') {
    return {
      configured: fs.existsSync(path.join(providerDir, 'auth.json')),
      apiKeyMode: false
    };
  }

  if (provider === 'gemini') {
    return {
      configured: (
        fs.existsSync(path.join(providerDir, 'oauth_creds.json'))
        || fs.existsSync(path.join(providerDir, 'google_accounts.json'))
      ),
      apiKeyMode: false
    };
  }

  if (provider === 'claude') {
    return {
      configured: (
        fs.existsSync(path.join(providerDir, '.credentials.json'))
        || fs.existsSync(path.join(providerDir, 'settings.json'))
      ),
      apiKeyMode: false
    };
  }

  if (provider === 'agy') {
    return {
      configured: Boolean(authMetadata && authMetadata.configured),
      apiKeyMode: false
    };
  }

  return {
    configured: false,
    apiKeyMode: false
  };
}

function buildBaseAccountRecord(ctx, input) {
  const {
    provider,
    accountId,
    stateInfo,
    runtimeAccount,
    cachedRecord
  } = input;
  const {
    fs,
    getToolConfigDir,
    getProfileDir
  } = ctx;

  const configDir = getToolConfigDir(provider, accountId);
  const profileDir = getProfileDir(provider, accountId);
  const roleFlags = resolveAccountRoleFlags(ctx, provider, accountId, profileDir);
  const agyMetadata = provider === 'agy' ? readAgyAuthMetadata(fs, path, profileDir) : null;
  const fastPresence = readFastAccountPresence(fs, provider, profileDir, configDir, agyMetadata);
  const runtimeAuthMode = resolveRuntimeAuthMode(runtimeAccount);
  const stateAuthMode = String(stateInfo.authMode || stateInfo.auth_mode || '').trim();
  const apiKeyMode = Boolean(
    fastPresence.apiKeyMode
    || (runtimeAccount
      ? isApiCredentialAuthMode(runtimeAuthMode)
      : (stateInfo.apiKeyMode || stateInfo.api_key_mode))
  );
  const configured = Boolean(
    fastPresence.configured
    || runtimeAccount
  );
  const hasProviderUsage = ['codex', 'gemini', 'claude', 'agy'].includes(provider);
  const usageSnapshot = configured && !apiKeyMode && hasProviderUsage
    ? (
        (cachedRecord && cachedRecord.usageSnapshot)
        || readCachedUsageSnapshot(ctx, provider, accountId)
        || null
      )
    : null;
  const metadata = configured && !apiKeyMode && hasProviderUsage
    ? readCachedAccountMetadata(ctx, provider, accountId, usageSnapshot)
    : null;
  const agyUsageView = provider === 'agy' && configured && !apiKeyMode
    ? buildAgyEffectiveUsageView({
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
              stateRemainingPct: readOptionalNumber(stateInfo.remainingPct, stateInfo.remaining_pct),
              runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
              cachedRemainingPct: cachedRecord && cachedRecord.remainingPct,
              usageSnapshot: effectiveUsageSnapshot,
              provider
            })
      )
    : null;
  const runtimeStatus = resolveAgyRuntimeStatus(
    provider,
    deriveEffectiveRuntimeStatus(runtimeAccount, stateInfo),
    agyMetadata
  );
  const runtimeBlocked = isBlockingRuntimeStatus(runtimeStatus);
  const visibleRemainingPct = runtimeBlocked ? null : remainingPct;
  const probeState = typeof ctx.getLastUsageProbeState === 'function'
    ? (ctx.getLastUsageProbeState(provider, accountId) || null)
    : null;
  const probeError = probeState
    ? String(probeState.error || '')
    : (
        typeof ctx.getLastUsageProbeError === 'function'
          ? ctx.getLastUsageProbeError(provider, accountId)
          : ''
      );
  const probeCheckedAt = Number((probeState && probeState.checkedAt) || 0);
  const hasPersistedIdentity = Boolean(
    pickOauthDisplayName(
      cachedRecord && cachedRecord.displayName,
      cachedRecord && cachedRecord.email,
      stateInfo.displayName,
      stateInfo.display_name
    )
  );
  const deferAuthJsonIdentity = Boolean(
    provider === 'codex'
    && effectiveUsageSnapshot
    && String(effectiveUsageSnapshot.fallbackSource || '').trim() === 'auth_json'
    && hasPersistedIdentity
  );
  const baseUrl = apiKeyMode ? resolveApiKeyBaseUrl(provider, fs, profileDir, runtimeAccount) : '';
  const displayName = apiKeyMode
    ? getApiKeyDisplayName(provider, { baseUrl })
    : pickOauthDisplayName(
        !deferAuthJsonIdentity && metadata && metadata.email,
        agyMetadata && agyMetadata.email,
        provider === 'opencode' && runtimeAccount && runtimeAccount.displayName,
        cachedRecord && cachedRecord.displayName,
        runtimeAccount && runtimeAccount.email,
        stateInfo.displayName,
        stateInfo.display_name
      );
  const status = resolveEffectiveAccountStatus(
    stateInfo.status,
    readAccountStatusFile(fs, profileDir)
  );
  const authMode = runtimeAuthMode || stateAuthMode;
  const stateUpdatedAt = Number(stateInfo.updatedAt || stateInfo.updated_at || 0);
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
              || (metadata && metadata.planType)
              || (cachedRecord && cachedRecord.planType)
              || 'oauth'
            )
      )
    : 'pending';
  const poolState = deriveAccountPoolState({
    provider,
    configured,
    apiKeyMode,
    accountStatus: status,
    runtimeStatus: runtimeBlocked ? runtimeStatus.status : (runtimeAccount && !apiKeyMode ? runtimeStatus.status : ''),
    planType,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    probeError
  });
  const lastUsedAt = resolveAccountLastUsedAt(runtimeAccount);
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
    quotaState
  });
  if (provider === 'agy' && configured && !runtimeAccount && !Boolean(agyMetadata && agyMetadata.hasRefreshToken)) {
    schedulableState = {
      status: 'blocked_by_policy',
      reason: 'agy_access_token_required'
    };
  }
  const uniqueKey = resolveStableAccountKey(ctx, provider, accountId, runtimeAccount, cachedRecord);
  return {
    provider,
    accountId,
    uniqueKey,
    accountRef: resolveAccountRef(ctx, provider, accountId, uniqueKey),
    status,
    displayName,
    configured,
    apiKeyMode,
    isDefault: roleFlags.isDefault,
    isMobile: roleFlags.isMobile,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    updatedAt: resolveAccountUpdatedAt({
      configured,
      apiKeyMode,
      usageSnapshot: effectiveUsageSnapshot,
      probeCheckedAt,
      stateUpdatedAt,
      cachedUpdatedAt: cachedRecord && cachedRecord.updatedAt
    }),
    planType,
    email: pickOauthDisplayName(
      !deferAuthJsonIdentity && metadata && metadata.email,
      agyMetadata && agyMetadata.email,
      cachedRecord && cachedRecord.email,
      runtimeAccount && runtimeAccount.email
    ),
    authMode,
    authPending: oauthPendingState.pending,
    authPendingStale: oauthPendingState.stale,
    authPendingAgeMs: oauthPendingState.ageMs,
    baseUrl,
    configDir,
    profileDir,
    quotaStatus: quotaState.status,
    quotaReason: quotaState.reason || undefined,
    schedulableStatus: schedulableState.status,
    schedulableReason: schedulableState.reason || undefined,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    runtimeStatus: runtimeBlocked || (runtimeAccount && !apiKeyMode) ? runtimeStatus.status : undefined,
    runtimeUntil: runtimeBlocked || (runtimeAccount && !apiKeyMode) ? runtimeStatus.until : undefined,
    runtimeReason: runtimeBlocked || (runtimeAccount && !apiKeyMode) ? runtimeStatus.reason : undefined
  };
}

function buildFastAccountsSnapshot(ctx) {
  const {
    state,
    accountStateIndex,
    getToolAccountIds
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
    const accountIds = getToolAccountIds(provider);
    const stateRows = listProviderStateRows(accountStateIndex, provider, accountIds);
    const stateById = new Map(
      stateRows.map((row) => [
        String(row.accountId || row.account_id || '').trim(),
        row
      ])
    );

    for (const accountId of accountIds) {
      const key = makeAccountKey(provider, accountId);
      const stateInfo = stateById.get(String(accountId)) || {};
      const runtimeAccount = runtimeAccountMap.get(key) || null;
      const cachedRecord = liveState.records.get(key) || null;
      const record = buildBaseAccountRecord(ctx, {
        provider,
        accountId,
        stateInfo,
        runtimeAccount,
        cachedRecord
      });
      liveState.records.set(key, record);
      accounts.push(record);
    }
  }

  for (const key of [...liveState.records.keys()]) {
    const [provider, accountId] = key.split(':');
    const exists = accounts.some((record) => record.provider === provider && record.accountId === accountId);
    if (!exists) {
      removeLiveAccountRecord(ctx, provider, accountId, 'snapshot_account_missing');
    }
  }

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
  const {
    provider,
    accountId,
    stateInfo,
    runtimeAccount
  } = input;
  const {
    state,
    fs,
    checkStatus,
    getToolConfigDir,
    getProfileDir
  } = ctx;
  const liveState = getAccountsLiveState(state);
  const configDir = getToolConfigDir(provider, accountId);
  const profileDir = getProfileDir(provider, accountId);
  const roleFlags = resolveAccountRoleFlags(ctx, provider, accountId, profileDir);
  const liveStatus = checkStatus(provider, profileDir) || {};
  const accountName = String(liveStatus.accountName || '').trim();
  const configured = Boolean(liveStatus.configured);
  const apiKeyMode = configured
    ? (
        accountName.startsWith('API Key')
        || Boolean(stateInfo.api_key_mode)
        || Boolean(stateInfo.apiKeyMode)
        || Boolean(runtimeAccount && runtimeAccount.apiKeyMode)
      )
    : false;
  const hasProviderUsage = ['codex', 'gemini', 'claude', 'agy'].includes(provider);
  const usageSnapshot = configured && !apiKeyMode && hasProviderUsage
    ? readCachedUsageSnapshot(ctx, provider, accountId)
    : null;
  const agyUsageView = provider === 'agy' && configured && !apiKeyMode
    ? buildAgyEffectiveUsageView({
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
              stateRemainingPct: readOptionalNumber(stateInfo.remaining_pct, stateInfo.remainingPct),
              runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
              cachedRemainingPct: null,
              usageSnapshot: effectiveUsageSnapshot,
              provider
            })
      )
    : null;
  const baseUrl = apiKeyMode ? resolveApiKeyBaseUrl(provider, fs, profileDir, runtimeAccount) : '';
  const displayName = apiKeyMode
    ? getApiKeyDisplayName(provider, { baseUrl })
    : pickOauthDisplayName(
        accountName,
        provider === 'opencode' && runtimeAccount && runtimeAccount.displayName,
        stateInfo.display_name,
        stateInfo.displayName
      );
  const status = resolveEffectiveAccountStatus(
    stateInfo.status,
    readAccountStatusFile(fs, profileDir)
  );
  const authMode = String(stateInfo.authMode || stateInfo.auth_mode || '').trim();
  const stateUpdatedAt = Number(stateInfo.updatedAt || stateInfo.updated_at || 0);
  const oauthPendingState = resolveOauthPendingState({
    configured,
    apiKeyMode,
    authMode,
    updatedAt: stateUpdatedAt
  });

  let planType = configured ? (apiKeyMode ? 'api-key' : 'oauth') : 'pending';
  let email = '';
  try {
    if (provider === 'codex' && configured && !apiKeyMode) {
      const snapshotAccount = usageSnapshot && usageSnapshot.account ? usageSnapshot.account : null;
      planType = String(snapshotAccount && snapshotAccount.planType || 'oauth').trim() || 'oauth';
      email = String(snapshotAccount && snapshotAccount.email || '').trim();
    } else if (provider === 'gemini' && configured) {
      const settingsPath = path.join(profileDir, '.gemini', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        planType = settings && settings.security && settings.security.auth
          ? (settings.security.auth.selectedType || 'oauth')
          : 'oauth';
      }
      email = cleanOauthDisplayName(accountName);
    } else if (provider === 'claude' && configured) {
      const snapshotAccount = !apiKeyMode && effectiveUsageSnapshot && effectiveUsageSnapshot.account ? effectiveUsageSnapshot.account : null;
      const snapshotEmail = String((snapshotAccount && snapshotAccount.email) || '').trim();
      const snapshotName = String((snapshotAccount && snapshotAccount.fullName) || '').trim();
      planType = apiKeyMode
        ? 'api-key'
        : String((snapshotAccount && snapshotAccount.planType) || 'oauth').trim() || 'oauth';
      // Prefer the identity from /api/oauth/profile over checkStatus' token
      // placeholder ("Access Token: sk-..."), which carries no email.
      email = snapshotEmail || snapshotName || cleanOauthDisplayName(accountName);
    } else if (provider === 'agy' && configured) {
      planType = agyUsageView ? agyUsageView.planType : 'oauth';
      email = cleanOauthDisplayName(accountName);
    }
  } catch (_error) {}

  const runtimeStatus = resolveAgyRuntimeStatus(
    provider,
    deriveEffectiveRuntimeStatus(runtimeAccount, stateInfo),
    liveStatus
  );
  const runtimeBlocked = isBlockingRuntimeStatus(runtimeStatus);
  const visibleRemainingPct = runtimeBlocked ? null : remainingPct;
  const probeState = typeof ctx.getLastUsageProbeState === 'function'
    ? (ctx.getLastUsageProbeState(provider, accountId) || null)
    : null;
  const probeError = probeState
    ? String(probeState.error || '')
    : (
        typeof ctx.getLastUsageProbeError === 'function'
          ? ctx.getLastUsageProbeError(provider, accountId)
          : ''
      );
  const probeCheckedAt = Number((probeState && probeState.checkedAt) || 0);
  const poolState = deriveAccountPoolState({
    provider,
    configured,
    apiKeyMode,
    accountStatus: status,
    runtimeStatus: runtimeBlocked ? runtimeStatus.status : (runtimeAccount && !apiKeyMode ? runtimeStatus.status : ''),
    planType,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    probeError
  });
  const lastUsedAt = resolveAccountLastUsedAt(runtimeAccount);
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
    quotaState
  });
  if (provider === 'agy' && configured && !runtimeAccount && !Boolean(liveStatus && liveStatus.hasRefreshToken)) {
    schedulableState = {
      status: 'blocked_by_policy',
      reason: 'agy_access_token_required'
    };
  }
  const uniqueKey = resolveStableAccountKey(ctx, provider, accountId, runtimeAccount, null);
  const record = {
    provider,
    accountId,
    uniqueKey,
    accountRef: resolveAccountRef(ctx, provider, accountId, uniqueKey),
    status,
    displayName,
    configured,
    apiKeyMode,
    isDefault: roleFlags.isDefault,
    isMobile: roleFlags.isMobile,
    remainingPct: visibleRemainingPct,
    usageSnapshot: effectiveUsageSnapshot,
    updatedAt: resolveAccountUpdatedAt({
      configured,
      apiKeyMode,
      usageSnapshot: effectiveUsageSnapshot,
      probeCheckedAt,
      stateUpdatedAt,
      cachedUpdatedAt: 0
    }),
    planType,
    email,
    authMode,
    authPending: oauthPendingState.pending,
    authPendingStale: oauthPendingState.stale,
    authPendingAgeMs: oauthPendingState.ageMs,
    baseUrl,
    configDir,
    profileDir,
    quotaStatus: quotaState.status,
    quotaReason: quotaState.reason || undefined,
    schedulableStatus: schedulableState.status,
    schedulableReason: schedulableState.reason || undefined
  };

  if (lastUsedAt) {
    record.lastUsedAt = lastUsedAt;
  }
  if (runtimeBlocked || (runtimeAccount && !apiKeyMode)) {
    record.runtimeStatus = runtimeStatus.status;
    record.runtimeUntil = runtimeStatus.until;
    record.runtimeReason = runtimeStatus.reason;
  }

  liveState.metadata.set(makeAccountKey(provider, accountId), {
    expiresAt: Date.now() + ACCOUNTS_USAGE_CACHE_TTL_MS,
    value: {
      email,
      planType
    }
  });

  return record;
}

async function refreshLiveAccountRecord(ctx, provider, accountId, options = {}) {
  const {
    state,
    fs,
    accountStateIndex,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus,
    ensureUsageSnapshotAsync,
    loadServerRuntimeAccounts,
    applyReloadState
  } = ctx;
  const liveState = getAccountsLiveState(state);
  const key = makeAccountKey(provider, accountId);
  const skipUsageRefresh = Boolean(options.skipUsageRefresh);
  const skipRuntimeReload = Boolean(options.skipRuntimeReload);
  const stateInfo = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? (accountStateIndex.getAccountState(provider, accountId) || {})
    : {};
  const presence = readFastAccountPresence(
    fs,
    provider,
    getProfileDir(provider, accountId),
    getToolConfigDir(provider, accountId)
  );
  const currentRecord = liveState.records.get(key) || null;
  const apiKeyMode = Boolean(
    presence.apiKeyMode
    || (currentRecord && currentRecord.apiKeyMode)
    || stateInfo.apiKeyMode
    || stateInfo.api_key_mode
  );

  if (!skipUsageRefresh && typeof ensureUsageSnapshotAsync === 'function' && !apiKeyMode) {
    const currentSnapshot = currentRecord && currentRecord.usageSnapshot
      ? currentRecord.usageSnapshot
      : readCachedUsageSnapshot(ctx, provider, accountId);
    liveState.usageSnapshots.delete(key);
    await ensureUsageSnapshotAsync(provider, accountId, currentSnapshot, { forceRefresh: true });
    liveState.usageSnapshots.delete(key);
  }

  if (!skipRuntimeReload && typeof loadServerRuntimeAccounts === 'function' && typeof applyReloadState === 'function') {
    const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
      fs,
      accountStateIndex,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      checkStatus,
      aiHomeDir: ctx.aiHomeDir || '',
      serverPort: ctx.options && ctx.options.port
    }, ctx));
    applyReloadState(state, runtimeAccounts);
  }

  const runtimeAccount = buildRuntimeAccountMap(state).get(key) || null;
  const nextStateInfo = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? (accountStateIndex.getAccountState(provider, accountId) || {})
    : stateInfo;
  const record = buildHydratedAccountRecord(ctx, {
    provider,
    accountId,
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

function hydrateAccountsInBackground(ctx, force = false) {
  const { state, accountStateIndex, getToolAccountIds } = ctx;
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
        const accountIds = getToolAccountIds(provider);
        const stateRows = listProviderStateRows(accountStateIndex, provider, accountIds);
        const stateById = new Map(
          stateRows.map((row) => [
            String(row.accountId || row.account_id || '').trim(),
            row
          ])
        );

        for (const accountId of accountIds) {
          canonicalKeys.add(makeAccountKey(provider, accountId));
          queue.push({
            provider,
            accountId,
            stateInfo: stateById.get(String(accountId)) || {},
            runtimeAccount: runtimeAccountMap.get(makeAccountKey(provider, accountId)) || null
          });
        }
      }

      for (let index = 0; index < queue.length; index += 1) {
        const item = queue[index];
        try {
          const record = buildHydratedAccountRecord(ctx, item);
          const key = makeAccountKey(item.provider, item.accountId);
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
        } catch (_error) {
          // Ignore individual hydration failures and keep base snapshot.
        }

        if (index % ACCOUNTS_HYDRATE_BATCH_SIZE === ACCOUNTS_HYDRATE_BATCH_SIZE - 1) {
          await nextTick();
        }
      }

      for (const key of [...liveState.records.keys()]) {
        if (canonicalKeys.has(key)) continue;
        const [provider, accountId] = key.split(':');
        removeLiveAccountRecord(ctx, provider, accountId, 'canonical_account_missing');
      }
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
  hydrateAccountsInBackground(ctx).catch(() => {});
  const snapshot = buildFastAccountsSnapshot(ctx);
  writeJson(res, 200, {
    ok: true,
    accounts: snapshot.accounts,
    hydrating: snapshot.hydrating,
    providerNativeCapabilities: snapshot.providerNativeCapabilities
  });
  return true;
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
    heartbeatMs: ACCOUNTS_WATCH_HEARTBEAT_MS
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
  handleAccountsWatchRequest,
  handleAccountsWatchSnapshotRequest,
  handleAccountsWatchUpgrade,
  refreshLiveAccountRecord,
  removeLiveAccountRecord,
  emitAccountsAuthJobEvent,
  emitAccountsLiveEvent,
  __private: {
    buildCanonicalAccountsSignature,
    pollCanonicalAccountsOnce,
    refreshAccountsFromCanonicalSource
  }
};
