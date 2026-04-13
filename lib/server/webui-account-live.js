'use strict';

const path = require('node:path');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const {
  readTrustedUsageSnapshot,
  getMinRemainingPctFromUsageSnapshot
} = require('./accounts');
const { normalizeAccountUsageSnapshot } = require('./account-usage-view');
const { extractCodexMetadata } = require('./web-account-transfer');
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

const ACCOUNTS_HYDRATE_TTL_MS = 15_000;
const ACCOUNTS_HYDRATE_BATCH_SIZE = 6;
const ACCOUNTS_WATCH_HEARTBEAT_MS = 30_000;
const ACCOUNTS_USAGE_CACHE_TTL_MS = 15_000;
const ACCOUNTS_FAST_SNAPSHOT_TTL_MS = 3_000;

const PROVIDER_GLOBAL_DIR = {
  codex: '.codex',
  gemini: '.gemini',
  claude: '.claude'
};

function makeAccountKey(provider, accountId) {
  return `${provider}:${accountId}`;
}

function readOptionalNumber(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function resolveUsageSnapshotRemaining(snapshot) {
  return getMinRemainingPctFromUsageSnapshot(snapshot);
}

function resolveAccountRemainingPct(values) {
  const snapshot = values && values.usageSnapshot;
  const snapshotRemaining = resolveUsageSnapshotRemaining(snapshot);
  if (snapshot && snapshotRemaining == null) {
    return null;
  }
  return readOptionalNumber(
    values && values.stateRemainingPct,
    values && values.runtimeRemainingPct,
    values && values.cachedRemainingPct,
    snapshotRemaining
  );
}

function resolveAccountExhausted(values) {
  const configured = Boolean(values && values.configured);
  const apiKeyMode = Boolean(values && values.apiKeyMode);
  if (!configured || apiKeyMode) return false;
  const snapshot = values && values.usageSnapshot;
  const snapshotRemaining = resolveUsageSnapshotRemaining(snapshot);
  if (snapshot) {
    return Number.isFinite(snapshotRemaining) ? snapshotRemaining <= 0 : false;
  }
  const remainingPct = resolveAccountRemainingPct(values);
  if (!Number.isFinite(remainingPct)) return false;
  return Boolean(values && values.stateExhausted) && remainingPct <= 0;
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

function normalizeUsageProbeReason(value) {
  return String(value || '').trim().slice(0, 500);
}

function deriveAccountUsageState(values) {
  const configured = Boolean(values && values.configured);
  const apiKeyMode = Boolean(values && values.apiKeyMode);
  if (!configured || apiKeyMode) {
    return { status: '', reason: '' };
  }
  const remainingPct = readOptionalNumber(values && values.remainingPct);
  if (Number.isFinite(remainingPct)) {
    return { status: 'available', reason: '' };
  }
  const snapshot = values && values.usageSnapshot;
  if (snapshot) {
    const snapshotRemaining = resolveUsageSnapshotRemaining(snapshot);
    if (Number.isFinite(snapshotRemaining)) {
      return { status: 'available', reason: '' };
    }
  }
  const probeError = normalizeUsageProbeReason(values && values.probeError);
  if (probeError) {
    return { status: 'probe_failed', reason: probeError };
  }
  if (snapshot) {
    return {
      status: 'provider_unavailable',
      reason: 'provider_returned_no_numeric_usage'
    };
  }
  return { status: 'pending', reason: '' };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function getAccountsLiveState(state) {
  if (!state.__webUiAccountsLive) {
    state.__webUiAccountsLive = {
      records: new Map(),
      metadata: new Map(),
      usageSnapshots: new Map(),
      watchers: new Set(),
      loadedFromDisk: false,
      hydrating: false,
      queued: false,
      lastHydratedAt: 0,
      revision: 0,
      fastSnapshot: null,
      fastSnapshotAt: 0
    };
  }
  return state.__webUiAccountsLive;
}

function cloneFastSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      accounts: [],
      hydrating: false
    };
  }
  return {
    accounts: Array.isArray(snapshot.accounts) ? snapshot.accounts.slice() : [],
    hydrating: Boolean(snapshot.hydrating)
  };
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

function readCachedAccountMetadata(ctx, provider, accountId, configDir) {
  const { state, fs } = ctx;
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

  try {
    if (provider === 'codex') {
      const authPath = path.join(configDir, 'auth.json');
      if (fs.existsSync(authPath)) {
        value = extractCodexMetadata(JSON.parse(fs.readFileSync(authPath, 'utf8')));
      }
    }
  } catch (_error) {}

  liveState.metadata.set(key, {
    expiresAt: Date.now() + ACCOUNTS_USAGE_CACHE_TTL_MS,
    value
  });
  return value;
}

function emitAccountsEvent(liveState, payload) {
  broadcastSseJson(liveState.watchers, payload);
}

function invalidateFastAccountsSnapshot(liveState) {
  if (!liveState) return;
  liveState.fastSnapshot = null;
  liveState.fastSnapshotAt = 0;
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
      configured: Boolean(entry.row.configured),
      apiKeyMode: Boolean(entry.row.apiKeyMode || entry.row.api_key_mode),
      exhausted: Boolean(entry.row.exhausted),
      remainingPct: readOptionalNumber(entry.row.remainingPct, entry.row.remaining_pct),
      displayName: String(entry.row.displayName || entry.row.display_name || '').trim(),
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

function readFastAccountPresence(fs, provider, profileDir, configDir) {
  const apiEnvPath = path.join(profileDir, '.aih_env.json');
  if (fs.existsSync(apiEnvPath)) {
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
  const fastPresence = readFastAccountPresence(fs, provider, profileDir, configDir);
  const metadata = fastPresence.configured && !fastPresence.apiKeyMode
    ? readCachedAccountMetadata(ctx, provider, accountId, configDir)
    : null;
  const apiKeyMode = Boolean(
    fastPresence.apiKeyMode
    || stateInfo.apiKeyMode
    || stateInfo.api_key_mode
    || (runtimeAccount && (runtimeAccount.apiKeyMode || runtimeAccount.authType === 'api-key'))
  );
  const configured = Boolean(
    fastPresence.configured
    || runtimeAccount
  );
  const usageSnapshot = configured && !apiKeyMode
    ? (
        (cachedRecord && cachedRecord.usageSnapshot)
        || readCachedUsageSnapshot(ctx, provider, accountId)
        || null
      )
    : null;
  const remainingPct = configured && !apiKeyMode
    ? resolveAccountRemainingPct({
        stateRemainingPct: readOptionalNumber(stateInfo.remainingPct, stateInfo.remaining_pct),
        runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
        cachedRemainingPct: cachedRecord && cachedRecord.remainingPct,
        usageSnapshot
      })
    : null;
  const runtimeStatus = deriveAccountRuntimeStatus(runtimeAccount);
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
  const usageState = deriveAccountUsageState({
    configured,
    apiKeyMode,
    remainingPct,
    usageSnapshot,
    probeError
  });
  const displayName = String(
    (metadata && metadata.email)
    || (cachedRecord && cachedRecord.displayName)
    || (runtimeAccount && (runtimeAccount.email || runtimeAccount.accountId))
    || stateInfo.displayName
    || stateInfo.display_name
    || `${provider}-${accountId}`
  ).trim();

  return {
    provider,
    accountId,
    displayName,
    configured,
    apiKeyMode,
    exhausted: resolveAccountExhausted({
      configured,
      apiKeyMode,
      stateExhausted: stateInfo.exhausted,
      stateRemainingPct: readOptionalNumber(stateInfo.remainingPct, stateInfo.remaining_pct),
      runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
      cachedRemainingPct: cachedRecord && cachedRecord.remainingPct,
      usageSnapshot
    }),
    remainingPct,
    usageSnapshot,
    updatedAt: resolveAccountUpdatedAt({
      configured,
      apiKeyMode,
      usageSnapshot,
      probeCheckedAt,
      stateUpdatedAt: Number(stateInfo.updatedAt || stateInfo.updated_at || 0),
      cachedUpdatedAt: cachedRecord && cachedRecord.updatedAt
    }),
    planType: configured
      ? (
          apiKeyMode
            ? 'api-key'
            : String((metadata && metadata.planType) || (cachedRecord && cachedRecord.planType) || 'oauth')
        )
      : 'pending',
    email: String(
      (metadata && metadata.email)
      || (cachedRecord && cachedRecord.email)
      || (runtimeAccount && runtimeAccount.email)
      || ''
    ).trim(),
    configDir,
    profileDir,
    runtimeStatus: runtimeAccount && !apiKeyMode ? runtimeStatus.status : undefined,
    runtimeUntil: runtimeAccount && !apiKeyMode ? runtimeStatus.until : undefined,
    runtimeReason: runtimeAccount && !apiKeyMode ? runtimeStatus.reason : undefined,
    usageStatus: usageState.status && usageState.status !== 'available' ? usageState.status : undefined,
    usageReason: usageState.status && usageState.status !== 'available' ? usageState.reason : undefined
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
  if (
    liveState.fastSnapshot
    && (Date.now() - liveState.fastSnapshotAt) < ACCOUNTS_FAST_SNAPSHOT_TTL_MS
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
      liveState.records.delete(key);
      liveState.metadata.delete(key);
      liveState.usageSnapshots.delete(key);
    }
  }

  const snapshot = {
    accounts,
    hydrating: Boolean(liveState.hydrating)
  };
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
  const usageSnapshot = configured && !apiKeyMode
    ? readCachedUsageSnapshot(ctx, provider, accountId)
    : null;
  const remainingPct = configured && !apiKeyMode
    ? resolveAccountRemainingPct({
        stateRemainingPct: readOptionalNumber(stateInfo.remaining_pct, stateInfo.remainingPct),
        runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
        cachedRemainingPct: null,
        usageSnapshot
      })
    : null;
  const displayName = configured && accountName && accountName !== 'Unknown'
    ? accountName
    : (String(stateInfo.display_name || '').trim() || `${provider}-${accountId}`);

  let planType = configured ? (apiKeyMode ? 'api-key' : 'oauth') : 'pending';
  let email = '';
  try {
    if (provider === 'codex' && configured && !apiKeyMode) {
      const authPath = path.join(configDir, 'auth.json');
      if (fs.existsSync(authPath)) {
        const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        const meta = extractCodexMetadata(authData);
        planType = meta.planType || 'free';
        email = meta.email || '';
      }
    } else if (provider === 'gemini' && configured) {
      const settingsPath = path.join(profileDir, '.gemini', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        planType = settings && settings.security && settings.security.auth
          ? (settings.security.auth.selectedType || 'oauth')
          : 'oauth';
      }
      if (accountName && accountName !== 'Unknown' && !accountName.startsWith('API Key')) {
        email = accountName;
      }
    } else if (provider === 'claude' && configured) {
      planType = apiKeyMode ? 'api-key' : 'oauth';
      if (accountName && accountName !== 'Unknown' && !accountName.startsWith('API Key')) {
        email = accountName;
      }
    }
  } catch (_error) {}

  const runtimeStatus = deriveAccountRuntimeStatus(runtimeAccount);
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
  const usageState = deriveAccountUsageState({
    configured,
    apiKeyMode,
    remainingPct,
    usageSnapshot,
    probeError
  });

  const record = {
    provider,
    accountId,
    displayName,
    configured,
    apiKeyMode,
    exhausted: resolveAccountExhausted({
      configured,
      apiKeyMode,
      stateExhausted: stateInfo.exhausted,
      stateRemainingPct: readOptionalNumber(stateInfo.remaining_pct, stateInfo.remainingPct),
      runtimeRemainingPct: runtimeAccount && runtimeAccount.remainingPct,
      cachedRemainingPct: null,
      usageSnapshot
    }),
    remainingPct,
    usageSnapshot,
    updatedAt: resolveAccountUpdatedAt({
      configured,
      apiKeyMode,
      usageSnapshot,
      probeCheckedAt,
      stateUpdatedAt: Number(stateInfo.updated_at || 0),
      cachedUpdatedAt: 0
    }),
    planType,
    email,
    configDir,
    profileDir,
    usageStatus: usageState.status && usageState.status !== 'available' ? usageState.status : undefined,
    usageReason: usageState.status && usageState.status !== 'available' ? usageState.reason : undefined
  };

  if (runtimeAccount && !apiKeyMode) {
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

async function refreshLiveAccountRecord(ctx, provider, accountId) {
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

  if (typeof ensureUsageSnapshotAsync === 'function' && !apiKeyMode) {
    const currentSnapshot = currentRecord && currentRecord.usageSnapshot
      ? currentRecord.usageSnapshot
      : readCachedUsageSnapshot(ctx, provider, accountId);
    liveState.usageSnapshots.delete(key);
    await ensureUsageSnapshotAsync(provider, accountId, currentSnapshot, { forceRefresh: true });
    liveState.usageSnapshots.delete(key);
  }

  if (typeof loadServerRuntimeAccounts === 'function' && typeof applyReloadState === 'function') {
    const runtimeAccounts = loadServerRuntimeAccounts({
      fs,
      accountStateIndex,
      getToolAccountIds,
      getToolConfigDir,
      getProfileDir,
      checkStatus,
      aiHomeDir: ctx.aiHomeDir || ''
    });
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
      account: record
    });
  }
  persistAccountsSnapshot(ctx, liveState, {
    revision: liveState.revision,
    hydrating: Boolean(liveState.hydrating),
    accounts: Array.from(liveState.records.values())
  });
  return record;
}

async function hydrateAccountsInBackground(ctx, force = false) {
  const { state, accountStateIndex, getToolAccountIds } = ctx;
  const liveState = getAccountsLiveState(state);
  const now = Date.now();
  if (!force && liveState.lastHydratedAt > 0 && (now - liveState.lastHydratedAt) < ACCOUNTS_HYDRATE_TTL_MS) {
    return;
  }
  if (liveState.hydrating) {
    liveState.queued = true;
    return;
  }

  liveState.hydrating = true;

  const run = async () => {
    try {
      const runtimeAccountMap = buildRuntimeAccountMap(state);
      const queue = [];

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
              account: record
            });
          }
        } catch (_error) {
          // Ignore individual hydration failures and keep base snapshot.
        }

        if (index % ACCOUNTS_HYDRATE_BATCH_SIZE === ACCOUNTS_HYDRATE_BATCH_SIZE - 1) {
          await nextTick();
        }
      }
    } finally {
      liveState.lastHydratedAt = Date.now();
      liveState.hydrating = false;
      persistAccountsSnapshot(ctx, liveState, {
        revision: liveState.revision,
        hydrating: false,
        accounts: Array.from(liveState.records.values())
      });
      emitAccountsEvent(liveState, {
        type: 'hydrated',
        revision: liveState.revision,
        hydratedAt: liveState.lastHydratedAt
      });
      if (liveState.queued) {
        liveState.queued = false;
        hydrateAccountsInBackground(ctx, true).catch(() => {});
      }
    }
  };

  setTimeout(() => {
    run().catch(() => {
      liveState.hydrating = false;
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
    hydrating: snapshot.hydrating
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

  hydrateAccountsInBackground(ctx).catch(() => {});
  const snapshot = buildFastAccountsSnapshot(ctx);
  writeSseJson(res, {
    type: 'snapshot',
    revision: liveState.revision,
    accounts: snapshot.accounts,
    hydrating: snapshot.hydrating
  });

  return true;
}

module.exports = {
  handleListAccountsFastRequest,
  handleAccountsWatchRequest,
  refreshLiveAccountRecord
};
