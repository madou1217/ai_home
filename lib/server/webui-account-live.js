'use strict';

const WebSocket = require('ws');
const {
  openSseStream,
  broadcastSseJson,
  attachSseWatcher,
  removeSseWatcher
} = require('./webui-sse-broadcaster');
const { serializeAuthJob } = require('./web-account-auth');
const { normalizeApiUsageByFormat } = require('../usage/model-usage-api-record');
const {
  buildProviderNativeCapabilityMap
} = require('../provider-native-capability-registry');
const { withAccountQueryListFns } = require('./account-load-args');
const { notifyGoCoreProjection } = require('./go-core-projection-sync');

const ACCOUNTS_WATCH_HEARTBEAT_MS = 30_000;

// 本地瞬时事件：只有 Node 运行时知道，Go 的账号事件流里没有。
// 账号行/快照（account / snapshot / account-removed / hydrated / snapshot-requested）
// 全部以 Go /v1/management/webui/accounts/live + /watch 为唯一权威。
const LOCAL_WATCH_EVENT_TYPES = new Set([
  'auth-job',
  'token-consumed',
  'account-activity',
  'import-job',
  'account-refresh-job'
]);

function normalizeAccountRef(accountRef) {
  const normalized = String(accountRef || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(normalized) ? normalized : '';
}

function getGoHost(ctx) {
  return ctx && ctx.deps && ctx.deps.goCoreSync ? ctx.deps.goCoreSync : null;
}

function isGoAvailable(goHost, requiredMethod) {
  return Boolean(
    goHost
    && typeof goHost[requiredMethod] === 'function'
    && (typeof goHost.isEnabled !== 'function' || goHost.isEnabled())
  );
}

function goAccountRefFor(goHost, nodeRef) {
  const ref = String(nodeRef || '').trim();
  if (!ref || !goHost || typeof goHost.goAccountRefFor !== 'function') return ref;
  const mapped = String(goHost.goAccountRefFor(ref) || '').trim();
  return mapped || ref;
}

function nodeAccountRefFor(goHost, goRef) {
  const ref = String(goRef || '').trim();
  if (!ref || !goHost || typeof goHost.nodeAccountRefFor !== 'function') return ref;
  const mapped = String(goHost.nodeAccountRefFor(ref) || '').trim();
  return mapped || ref;
}

function translateAccountRow(goHost, row) {
  if (!row || typeof row !== 'object') return row;
  const mapped = nodeAccountRefFor(goHost, row.accountRef);
  if (!mapped || mapped === row.accountRef) return row;
  return { ...row, accountRef: mapped };
}

function translateAccountRows(goHost, rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => translateAccountRow(goHost, row));
}

function getAccountsLiveState(state) {
  if (!state || typeof state !== 'object') {
    return {
      records: new Map(),
      relayWatchers: new Set(),
      webSocketWatchers: new Set(),
      webSocketServer: null,
      lastLiveSnapshot: null,
      revision: 0
    };
  }
  if (!state.__webUiAccountsLive) {
    state.__webUiAccountsLive = {
      records: new Map(),
      relayWatchers: new Set(),
      webSocketWatchers: new Set(),
      webSocketServer: null,
      lastLiveSnapshot: null,
      revision: 0
    };
  }
  if (!state.__webUiAccountsLive.records) state.__webUiAccountsLive.records = new Map();
  if (!state.__webUiAccountsLive.relayWatchers) state.__webUiAccountsLive.relayWatchers = new Set();
  if (!state.__webUiAccountsLive.webSocketWatchers) state.__webUiAccountsLive.webSocketWatchers = new Set();
  return state.__webUiAccountsLive;
}

function upsertCachedRow(liveState, row) {
  if (!liveState || !row || !row.accountRef) return;
  liveState.records.set(row.accountRef, row);
  const snap = liveState.lastLiveSnapshot;
  if (!snap || !Array.isArray(snap.accounts)) return;
  const idx = snap.accounts.findIndex((item) => item && item.accountRef === row.accountRef);
  if (idx >= 0) {
    snap.accounts[idx] = row;
  } else {
    snap.accounts.push(row);
  }
}

function deleteCachedRow(liveState, accountRef) {
  if (!liveState || !accountRef) return false;
  const deleted = liveState.records.delete(accountRef);
  const snap = liveState.lastLiveSnapshot;
  if (snap && Array.isArray(snap.accounts)) {
    snap.accounts = snap.accounts.filter((item) => !item || item.accountRef !== accountRef);
  }
  return deleted;
}

async function fetchGoLiveSnapshot(ctx, filter = {}) {
  const goHost = getGoHost(ctx);
  if (!isGoAvailable(goHost, 'webuiRequest')) {
    return {
      ok: false,
      status: 503,
      error: 'go_core_unavailable',
      message: '账号实时列表由 Go 提供，当前不可用'
    };
  }
  const params = new URLSearchParams();
  const provider = String(filter.provider || '').trim().toLowerCase();
  const ref = String(filter.ref || '').trim();
  if (provider) params.set('provider', provider);
  if (ref) params.set('ref', goAccountRefFor(goHost, ref));
  const query = params.toString();
  const response = await goHost.webuiRequest({
    method: 'GET',
    path: `/v1/management/webui/accounts/live${query ? `?${query}` : ''}`
  }).catch(() => null);

  if (!response) {
    return {
      ok: false,
      status: 503,
      error: 'go_core_unavailable',
      message: '账号实时列表由 Go 提供，当前不可用'
    };
  }
  const status = Number(response.status) || 0;
  if (response.ok !== true || !response.data || !Array.isArray(response.data.accounts)) {
    const errorCode = String(
      (response.data && (response.data.error || response.data.code))
      || response.errorCode
      || 'go_core_unavailable'
    ).trim();
    if (status >= 400 && status < 500 && response.data && typeof response.data === 'object') {
      return { ok: false, status, data: response.data };
    }
    return {
      ok: false,
      status: status >= 500 ? status : 503,
      error: status === 0 || errorCode === 'network_error' ? 'go_core_unavailable' : errorCode,
      message: String((response.data && response.data.message) || '账号实时列表由 Go 提供，当前不可用')
    };
  }

  const accounts = translateAccountRows(goHost, response.data.accounts);
  const revision = Number(response.data.revision) || 0;
  const hydrating = Boolean(response.data.hydrating);
  const providerNativeCapabilities = (
    response.data.providerNativeCapabilities
    && typeof response.data.providerNativeCapabilities === 'object'
  )
    ? response.data.providerNativeCapabilities
    : buildProviderNativeCapabilityMap();

  const liveState = getAccountsLiveState(ctx && ctx.state);
  if (!provider && !ref) {
    liveState.records.clear();
    for (const row of accounts) {
      if (row && row.accountRef) liveState.records.set(row.accountRef, row);
    }
    liveState.revision = revision;
    liveState.lastLiveSnapshot = {
      revision,
      accounts: accounts.map((row) => ({ ...row })),
      hydrating,
      providerNativeCapabilities
    };
  } else {
    for (const row of accounts) upsertCachedRow(liveState, row);
    if (ref && accounts.length === 0) deleteCachedRow(liveState, ref);
  }

  return {
    ok: true,
    accounts,
    revision,
    hydrating,
    providerNativeCapabilities
  };
}

async function handleListAccountsFastRequest(ctx) {
  const { res, writeJson, url } = ctx;
  const provider = String(url && url.searchParams && url.searchParams.get('provider') || '').trim().toLowerCase();
  const ref = String(url && url.searchParams && url.searchParams.get('ref') || '').trim();
  const snap = await fetchGoLiveSnapshot(ctx, { provider, ref });
  if (!snap.ok) {
    if (snap.data) {
      writeJson(res, snap.status, snap.data);
    } else {
      writeJson(res, snap.status || 503, {
        ok: false,
        error: snap.error || 'go_core_unavailable',
        message: snap.message || '账号实时列表由 Go 提供，当前不可用'
      });
    }
    return true;
  }
  writeJson(res, 200, {
    ok: true,
    accounts: snap.accounts,
    hydrating: snap.hydrating,
    providerNativeCapabilities: snap.providerNativeCapabilities,
    goAssembled: true
  });
  return true;
}

function readAccountsFastSnapshot(ctx) {
  const liveState = getAccountsLiveState(ctx && ctx.state);
  const cached = liveState.lastLiveSnapshot;
  if (cached && Array.isArray(cached.accounts)) {
    return {
      revision: cached.revision,
      accounts: cached.accounts.map((row) => ({ ...row })),
      hydrating: Boolean(cached.hydrating),
      providerNativeCapabilities: cached.providerNativeCapabilities || buildProviderNativeCapabilityMap()
    };
  }
  return {
    revision: liveState.revision,
    accounts: [],
    hydrating: false,
    providerNativeCapabilities: buildProviderNativeCapabilityMap()
  };
}

async function refreshLiveAccountRecord(ctx, provider, accountRef) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedRef = normalizeAccountRef(accountRef);
  if (!normalizedProvider || !normalizedRef) return null;
  const liveState = getAccountsLiveState(ctx && ctx.state);
  const goHost = getGoHost(ctx);
  if (!isGoAvailable(goHost, 'webuiRequest')) {
    return liveState.records.get(normalizedRef) || null;
  }
  const snap = await fetchGoLiveSnapshot(ctx, { provider: normalizedProvider, ref: normalizedRef });
  if (!snap.ok) {
    return liveState.records.get(normalizedRef) || null;
  }
  return snap.accounts[0] || null;
}

async function refreshAccountsFromCanonicalSource(ctx) {
  const goHost = getGoHost(ctx);
  if (isGoAvailable(goHost, 'requestAccountsSnapshot')) {
    await goHost.requestAccountsSnapshot().catch(() => null);
  }
  const snap = await fetchGoLiveSnapshot(ctx);
  const liveState = getAccountsLiveState(ctx && ctx.state);
  if (!snap.ok) {
    return { accounts: Array.from(liveState.records.values()), revision: liveState.revision };
  }
  return { accounts: snap.accounts, revision: snap.revision };
}

function removeLiveAccountRecord(ctx, provider, accountRef) {
  if (!ctx || !ctx.state) return false;
  const liveState = getAccountsLiveState(ctx.state);
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedRef = normalizeAccountRef(accountRef);
  if (!normalizedProvider || !normalizedRef) return false;
  const deleted = deleteCachedRow(liveState, normalizedRef);
  liveState.revision += 1;
  return deleted;
}

function updateCachedAccountTokenUsage() {
  // tokenUsage 由 Go /v1/management/webui/accounts/live 直接装配，Node 不再维护磁盘投影。
  return null;
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

function broadcastAccountsWebSocketJson(liveState, watchers, payload) {
  for (const watcher of [...watchers]) {
    try {
      if (!sendAccountsWebSocketJson(watcher.client, payload)) {
        removeAccountsWebSocketWatcher(liveState, watcher);
      }
    } catch (_error) {
      removeAccountsWebSocketWatcher(liveState, watcher);
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

function emitAccountsEvent(liveState, payload) {
  if (!liveState || !payload || typeof payload !== 'object') return;
  const type = String(payload.type || '');
  if (!LOCAL_WATCH_EVENT_TYPES.has(type)) return;
  if (liveState.relayWatchers && liveState.relayWatchers.size > 0) {
    broadcastSseJson(liveState.relayWatchers, payload);
  }
  if (liveState.webSocketWatchers && liveState.webSocketWatchers.size > 0) {
    broadcastAccountsWebSocketJson(liveState, liveState.webSocketWatchers, payload);
  }
}

function emitAccountsLiveEvent(ctx, payload) {
  if (!ctx || !ctx.state) return;
  emitAccountsEvent(getAccountsLiveState(ctx.state), payload);
}

function emitAccountsAuthJobEvent(ctx, job) {
  if (!ctx || !job) return;
  emitAccountsLiveEvent(ctx, {
    type: 'auth-job',
    job: serializeAuthJob(job)
  });
}

function emitAccountActivityEvent(state, activity) {
  if (!state || !activity) return;
  emitAccountsLiveEvent({ state }, {
    type: 'account-activity',
    activity,
    at: Date.now()
  });
}

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
  const occurredAt = Number(payload.timestampMs) || Date.now();
  emitAccountsEvent(getAccountsLiveState(state), {
    type: 'token-consumed',
    provider,
    accountRef,
    model: String(payload.model || '').trim(),
    tokens: {
      input: inputTokens,
      output: outputTokens,
      total: totalTokens
    },
    occurredAt
  });
}

function countAccountsWatchListeners(ctx) {
  if (!ctx || !ctx.state) return 0;
  const liveState = getAccountsLiveState(ctx.state);
  return liveState.relayWatchers.size + liveState.webSocketWatchers.size;
}

// handleAccountsWatchSnapshotRequest：请求 Go 强制重建并广播最新快照。
async function handleAccountsWatchSnapshotRequest(ctx) {
  const { res, writeJson } = ctx;
  const goHost = getGoHost(ctx);
  if (!isGoAvailable(goHost, 'requestAccountsSnapshot')) {
    writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: '账号快照由 Go 提供，当前不可用' });
    return true;
  }
  const result = await goHost.requestAccountsSnapshot().catch(() => null);
  if (result && result.ok === true && result.data) {
    writeJson(res, Number(result.status) || 202, result.data);
    return true;
  }
  writeJson(res, 503, {
    ok: false,
    error: (result && result.errorCode) || 'go_core_unavailable',
    message: '账号快照由 Go 提供，当前不可用'
  });
  return true;
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
  notifyGoCoreProjection(ctx, 'upstreamErrorRules');
  return true;
}

const reconciledImportJobs = new Set();
const RECONCILED_IMPORT_JOB_LIMIT = 100;

function reconcileAfterImportJob(ctx, payload) {
  if (!payload || payload.type !== 'import-job') return;
  const job = payload.job;
  const jobId = String(job && job.id || '');
  const status = String(job && job.status || '');
  if (!jobId || (status !== 'succeeded' && status !== 'failed')) return;
  if (reconciledImportJobs.has(jobId)) return;
  reconciledImportJobs.add(jobId);
  if (reconciledImportJobs.size > RECONCILED_IMPORT_JOB_LIMIT) {
    const oldest = reconciledImportJobs.values().next().value;
    reconciledImportJobs.delete(oldest);
  }
  Promise.resolve()
    .then(async () => {
      const goHost = getGoHost(ctx);
      if (goHost && typeof goHost.reconcileAccounts === 'function') {
        try { await goHost.reconcileAccounts(); } catch (_error) {}
      }
      try { reloadRuntimeAccountsForLiveSnapshot(ctx); } catch (_error) {}
    })
    .catch(() => {});
}

// translateGoAccountRefs 把 Go 的 accountRef 换回 Node 凭据库的键。
function translateGoAccountRefs(goHost, payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const mapper = goHost && typeof goHost.nodeAccountRefFor === 'function'
    ? goHost.nodeAccountRefFor
    : null;
  if (!mapper) return payload;
  const translate = (value) => {
    const ref = String(value || '').trim();
    if (!ref) return value;
    const mapped = String(mapper(ref) || '').trim();
    return mapped || value;
  };
  if (payload.type === 'snapshot' && Array.isArray(payload.accounts)) {
    let changed = false;
    const accounts = payload.accounts.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const next = translate(row.accountRef);
      if (next === row.accountRef) return row;
      changed = true;
      return { ...row, accountRef: next };
    });
    return changed ? { ...payload, accounts } : payload;
  }
  if (payload.type === 'account' && payload.account && typeof payload.account === 'object') {
    const next = translate(payload.account.accountRef);
    if (next === payload.account.accountRef) return payload;
    return { ...payload, account: { ...payload.account, accountRef: next } };
  }
  if (payload.type === 'account-removed') {
    const next = translate(payload.accountRef);
    return next === payload.accountRef ? payload : { ...payload, accountRef: next };
  }
  return payload;
}

function parseWatchBlockPayload(goHost, block, onPayload) {
  if (!block || !block.trim()) return null;
  const lines = block.split('\n');
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  let payload;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch (_error) {
    return null;
  }
  if (typeof onPayload === 'function') onPayload(payload);
  return translateGoAccountRefs(goHost, payload);
}

function translateAccountsWatchBlock(goHost, block, onPayload) {
  const lines = block.split('\n');
  let isDataFrame = false;
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      isDataFrame = true;
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!isDataFrame) return block;
  let payload;
  try {
    payload = JSON.parse(dataLines.join('\n'));
  } catch (_error) {
    return block;
  }
  if (typeof onPayload === 'function') onPayload(payload);
  return 'data: ' + JSON.stringify(translateGoAccountRefs(goHost, payload));
}

function createAccountsWatchTranslator(goHost, onPayload) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let output = '';
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        output += translateAccountsWatchBlock(goHost, block, onPayload) + '\n\n';
        index = buffer.indexOf('\n\n');
      }
      return output;
    },
    flush() {
      if (!buffer) return '';
      const rest = buffer;
      buffer = '';
      return translateAccountsWatchBlock(goHost, rest, onPayload);
    }
  };
}

async function handleAccountsWatchRequest(ctx) {
  const { req, res, state } = ctx;
  const goHost = getGoHost(ctx);
  if (!isGoAvailable(goHost, 'watchAccounts')) {
    ctx.writeJson(res, 503, { ok: false, error: 'go_core_unavailable', message: '账号实时视图由 Go 提供，当前不可用' });
    return true;
  }
  const stream = await goHost.watchAccounts().catch(() => null);
  if (!stream || stream.ok !== true || !stream.body) {
    ctx.writeJson(res, 503, {
      ok: false,
      error: (stream && stream.errorCode) || 'go_core_unavailable',
      status: stream && stream.status || 0,
      detail: stream && stream.errorMessage || '',
      message: '账号实时视图由 Go 提供，当前不可用'
    });
    return true;
  }

  const liveState = getAccountsLiveState(state);
  openSseStream(res);
  const watcher = attachSseWatcher(liveState.relayWatchers, req, res, {
    heartbeatMs: ACCOUNTS_WATCH_HEARTBEAT_MS
  });

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const translator = createAccountsWatchTranslator(
    goHost,
    (payload) => reconcileAfterImportJob(ctx, payload)
  );
  let closed = false;
  const abort = () => {
    if (closed) return;
    closed = true;
    try { stream.abort?.(); } catch (_error) {}
    try { reader.cancel().catch(() => {}); } catch (_error) {}
  };
  res.on('close', abort);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const output = translator.push(decoder.decode(value, { stream: true }));
      if (output) res.write(output);
    }
    const tail = translator.flush();
    if (tail) res.write(tail);
  } catch (_error) {
    // 浏览器或 Go 任一端断开：EventSource 会自行重连。
  } finally {
    removeSseWatcher(liveState.relayWatchers, watcher);
    if (!res.writableEnded) res.end();
    abort();
  }
  return true;
}

async function pumpGoWatchToWebSocket(ctx, goHost, client) {
  if (!isGoAvailable(goHost, 'watchAccounts')) return;
  const stream = await goHost.watchAccounts().catch(() => null);
  if (!stream || stream.ok !== true || !stream.body) return;
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let closed = false;
  const abort = () => {
    if (closed) return;
    closed = true;
    try { stream.abort?.(); } catch (_error) {}
    try { reader.cancel().catch(() => {}); } catch (_error) {}
  };
  client.on('close', abort);
  client.on('error', abort);
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const payload = parseWatchBlockPayload(
          goHost,
          block,
          (raw) => reconcileAfterImportJob(ctx, raw)
        );
        if (payload && client.readyState === WebSocket.OPEN) {
          sendAccountsWebSocketJson(client, payload);
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } catch (_error) {
    // 连接关闭或 Go 流中断由客户端重连处理。
  } finally {
    abort();
  }
}

async function handleAccountsWatchUpgrade(ctx) {
  const { req, socket, head, state } = ctx;
  const liveState = getAccountsLiveState(state);
  const server = getAccountsWatchWebSocketServer(liveState);

  server.handleUpgrade(req, socket, head, async (client) => {
    try {
      const snap = await fetchGoLiveSnapshot(ctx);
      if (!snap.ok) {
        try { client.close(1013, 'go_core_unavailable'); } catch (_err) {}
        return;
      }
      if (client.readyState !== WebSocket.OPEN) return;
      attachAccountsWebSocketWatcher(liveState, client);
      sendAccountsWebSocketJson(client, { type: 'connected' });
      sendAccountsWebSocketJson(client, {
        type: 'snapshot',
        revision: snap.revision,
        accounts: snap.accounts,
        hydrating: snap.hydrating,
        providerNativeCapabilities: snap.providerNativeCapabilities
      });
      pumpGoWatchToWebSocket(ctx, getGoHost(ctx), client).catch(() => {});
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
  emitAccountActivityEvent,
  emitAccountsLiveEvent,
  emitAccountTokenConsumedEvent,
  countAccountsWatchListeners,
  __private: {
    getAccountsLiveState,
    refreshAccountsFromCanonicalSource
  }
};
