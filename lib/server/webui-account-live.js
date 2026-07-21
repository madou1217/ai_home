'use strict';

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
const { readClaudeOauthCredential } = require('../account/claude-credential');
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
  const mobileAccountRef = provider === 'codex' && aiHomeDir
    ? readCodexDesktopAccountRef(ctx, aiHomeDir)
    : '';
  return {
    isDefault: defaultAccountRef === String(accountRef),
    isMobile: provider === 'codex' && mobileAccountRef === String(accountRef)
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

function buildAccountArtifactSignature(credentials) {
  return [
    Number(credentials && credentials.envUpdatedAt) || 0,
    Number(credentials && credentials.nativeAuthUpdatedAt) || 0
  ].join(',');
}

function buildCanonicalAccountsSignature(ctx) {
  if (!ctx) return '';
  const { accountStateIndex } = ctx;
  const parts = [`roles:${resolveAccountRoleSignature(ctx)}`];
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
      parts.push([
        accountRef,
        buildStateRowSignature(stateByRef.get(accountRef)),
        buildAccountArtifactSignature(accountRecord)
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

function readFastAccountPresence(provider, record, authMetadata = null, options = {}) {
  const dbCredentials = record ? record.env : {};
  const nativeAuth = record ? record.nativeAuth : {};
  if (Object.keys(dbCredentials).length > 0) {
    if (provider === 'agy') {
      return {
        configured: Boolean(
          String(dbCredentials.AGY_ACCESS_TOKEN || dbCredentials.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim()
          || (authMetadata && authMetadata.configured)
        ),
        apiKeyMode: false
      };
    }
    return {
      configured: true,
      apiKeyMode: provider !== 'agy' && provider !== 'opencode'
    };
  }

  if (provider === 'codex') {
    const tokens = nativeAuth.auth && nativeAuth.auth.tokens;
    return {
      configured: Boolean(tokens && String(tokens.access_token || '').trim()),
      apiKeyMode: false
    };
  }

  if (provider === 'gemini') {
    const oauth = nativeAuth.oauthCreds || {};
    const accounts = nativeAuth.googleAccounts || {};
    return {
      configured: Boolean(
        String(oauth.access_token || oauth.refresh_token || '').trim()
        || String(accounts.active || '').trim()
      ),
      apiKeyMode: false
    };
  }

  if (provider === 'claude') {
    return {
      configured: readClaudeOauthCredential(nativeAuth, options).configured,
      apiKeyMode: false
    };
  }

  if (provider === 'agy') {
    return {
      configured: Boolean(authMetadata && authMetadata.configured),
      apiKeyMode: false
    };
  }

  if (provider === 'opencode') {
    return {
      configured: Boolean(nativeAuth.auth && Object.keys(nativeAuth.auth).length > 0),
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
    accountRef,
    credentialRecord,
    stateInfo,
    runtimeAccount,
    cachedRecord
  } = input;
  const roleFlags = resolveAccountRoleFlags(ctx, provider, accountRef);
  const agyMetadata = provider === 'agy'
    ? readAgyAuthMetadata({ credentialRecord, accountRef })
    : null;
  const fastPresence = readFastAccountPresence(provider, credentialRecord, agyMetadata);
  const runtimeAuthMode = resolveRuntimeAuthMode(runtimeAccount);
  const stateAuthMode = String(stateInfo.authMode || '').trim();
  const apiKeyMode = Boolean(
    fastPresence.apiKeyMode
    || (runtimeAccount
      ? isApiCredentialAuthMode(runtimeAuthMode)
      : stateInfo.apiKeyMode)
  );
  const configured = Boolean(
    fastPresence.configured
    || runtimeAccount
  );
  const hasProviderUsage = ['codex', 'gemini', 'claude', 'agy'].includes(provider);
  const usageSnapshot = configured && !apiKeyMode && hasProviderUsage
    ? (
        (cachedRecord && cachedRecord.usageSnapshot)
        || readCachedUsageSnapshot(ctx, provider, accountRef)
        || null
      )
    : null;
  const metadata = configured && !apiKeyMode && hasProviderUsage
    ? readCachedAccountMetadata(ctx, provider, accountRef, usageSnapshot)
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
              stateRemainingPct: readOptionalNumber(stateInfo.remainingPct),
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
  const deferAuthJsonIdentity = Boolean(
    provider === 'codex'
    && effectiveUsageSnapshot
    && String(effectiveUsageSnapshot.fallbackSource || '').trim() === 'auth_json'
    && hasPersistedIdentity
  );
  const baseUrl = apiKeyMode ? resolveApiKeyBaseUrl(provider, credentialRecord, runtimeAccount) : '';
  const displayName = apiKeyMode
    ? getApiKeyDisplayName(provider, { baseUrl })
    : pickOauthDisplayName(
        !deferAuthJsonIdentity && metadata && metadata.email,
        agyMetadata && agyMetadata.email,
        provider === 'opencode' && runtimeAccount && runtimeAccount.displayName,
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
    quotaState
  });
  if (provider === 'agy' && configured && !runtimeAccount && !Boolean(agyMetadata && agyMetadata.hasRefreshToken)) {
    schedulableState = {
      status: 'blocked_by_policy',
      reason: 'agy_access_token_required'
    };
  }
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
  const liveStatus = checkStatus(provider, accountRef) || {};
  const accountName = String(liveStatus.accountName || '').trim();
  const configured = Boolean(liveStatus.configured);
  const apiKeyMode = configured
    ? (
        accountName.startsWith('API Key')
        || Boolean(stateInfo.apiKeyMode)
        || Boolean(runtimeAccount && runtimeAccount.apiKeyMode)
      )
    : false;
  const hasProviderUsage = ['codex', 'gemini', 'claude', 'agy'].includes(provider);
  const usageSnapshot = configured && !apiKeyMode && hasProviderUsage
    ? readCachedUsageSnapshot(ctx, provider, accountRef)
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
              stateRemainingPct: readOptionalNumber(stateInfo.remainingPct),
              runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
              cachedRemainingPct: null,
              usageSnapshot: effectiveUsageSnapshot,
              provider
            })
      )
    : null;
  const baseUrl = apiKeyMode ? resolveApiKeyBaseUrl(provider, credentialRecord, runtimeAccount) : '';
  const displayName = apiKeyMode
    ? getApiKeyDisplayName(provider, { baseUrl })
    : pickOauthDisplayName(
        accountName,
        provider === 'opencode' && runtimeAccount && runtimeAccount.displayName,
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
  let email = '';
  try {
    if (provider === 'codex' && configured && !apiKeyMode) {
      const snapshotAccount = usageSnapshot && usageSnapshot.account ? usageSnapshot.account : null;
      planType = String(snapshotAccount && snapshotAccount.planType || 'oauth').trim() || 'oauth';
      email = String(snapshotAccount && snapshotAccount.email || '').trim();
    } else if (provider === 'gemini' && configured) {
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
    quotaState
  });
  if (provider === 'agy' && configured && !runtimeAccount && !Boolean(liveStatus && liveStatus.hasRefreshToken)) {
    schedulableState = {
      status: 'blocked_by_policy',
      reason: 'agy_access_token_required'
    };
  }
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

  liveState.metadata.set(normalizeAccountRef(accountRef), {
    expiresAt: Date.now() + ACCOUNTS_USAGE_CACHE_TTL_MS,
    value: {
      email,
      planType
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
  const stateInfo = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
    ? (accountStateIndex.getAccountState(accountRef) || {})
    : {};
  const credentialRecord = readAccountCredentialRecord(fs, resolveAiHomeDir(ctx), accountRef);
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (!key || !credentialRecord || credentialRecord.provider !== normalizedProvider) {
    if (key && normalizedProvider) {
      removeLiveAccountRecord(ctx, normalizedProvider, key, 'canonical_account_missing');
    }
    return null;
  }
  const authMetadata = provider === 'agy'
    ? readAgyAuthMetadata({ credentialRecord, accountRef })
    : null;
  const presence = readFastAccountPresence(provider, credentialRecord, authMetadata);
  const currentRecord = liveState.records.get(key) || null;
  const apiKeyMode = Boolean(
    presence.apiKeyMode
    || (currentRecord && currentRecord.apiKeyMode)
    || stateInfo.apiKeyMode
  );

  if (!skipUsageRefresh && typeof ensureUsageSnapshotAsync === 'function' && !apiKeyMode) {
    const currentSnapshot = currentRecord && currentRecord.usageSnapshot
      ? currentRecord.usageSnapshot
      : readCachedUsageSnapshot(ctx, provider, accountRef);
    liveState.usageSnapshots.delete(key);
    await ensureUsageSnapshotAsync(provider, accountRef, currentSnapshot, { forceRefresh: true });
    liveState.usageSnapshots.delete(key);
  }

  if (!skipRuntimeReload && typeof loadServerRuntimeAccounts === 'function' && typeof applyReloadState === 'function') {
    const runtimeAccounts = loadServerRuntimeAccounts(withAccountQueryListFns({
      fs,
      accountStateIndex,
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
    ? (accountStateIndex.getAccountState(accountRef) || {})
    : stateInfo;
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
          const record = buildHydratedAccountRecord(ctx, item);
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
        } catch (_error) {
          // Ignore individual hydration failures and keep base snapshot.
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
  readAccountsFastSnapshot,
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
    readFastAccountPresence,
    removeMissingLiveAccountRecords,
    refreshAccountsFromCanonicalSource
  }
};
