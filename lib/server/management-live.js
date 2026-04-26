'use strict';

const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');

const MANAGEMENT_WATCH_HEARTBEAT_MS = 30_000;
const MANAGEMENT_WATCH_POLL_MS = 1_500;

function getManagementLiveState(state) {
  if (!state.__managementLive) {
    state.__managementLive = {
      watchers: new Set(),
      poller: null,
      revision: 0,
      lastSerialized: '',
      lastSignatureRevision: 0
    };
  }
  return state.__managementLive;
}

function sortManagementAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts.slice() : []).sort((left, right) => {
    const providerCompare = String(left && left.provider || '').localeCompare(String(right && right.provider || ''));
    if (providerCompare !== 0) return providerCompare;
    return String(left && left.id || '').localeCompare(String(right && right.id || ''));
  });
}

function buildManagementSnapshotPayload(state, options, deps, revision) {
  return {
    type: 'snapshot',
    revision: Number(revision) || 0,
    status: deps.buildManagementStatusPayload(state, options),
    metrics: deps.buildManagementMetricsPayload(state),
    accounts: sortManagementAccounts(
      (deps.buildManagementAccountsPayload(state, {
        fs: deps.fs,
        getProfileDir: deps.getProfileDir,
        getToolConfigDir: deps.getToolConfigDir
      }) || {}).accounts
    )
  };
}

function buildComparableManagementSnapshot(snapshot) {
  return JSON.stringify({
    status: {
      ...(snapshot && snapshot.status ? snapshot.status : {}),
      uptimeSec: 0
    },
    metrics: snapshot && snapshot.metrics ? snapshot.metrics : {},
    accounts: snapshot && Array.isArray(snapshot.accounts) ? snapshot.accounts : []
  });
}

function captureManagementSnapshot(state, options, deps) {
  const liveState = getManagementLiveState(state);
  const candidate = buildManagementSnapshotPayload(state, options, deps, liveState.revision);
  const serialized = buildComparableManagementSnapshot(candidate);
  const changed = serialized !== liveState.lastSerialized;
  if (changed) {
    liveState.lastSerialized = serialized;
    liveState.revision += 1;
  }
  return {
    changed,
    payload: buildManagementSnapshotPayload(state, options, deps, liveState.revision)
  };
}

function stopManagementWatchPoller(liveState) {
  if (!liveState || !liveState.poller) return;
  clearInterval(liveState.poller);
  liveState.poller = null;
}

function ensureManagementWatchPoller(ctx) {
  const { state, options, deps } = ctx;
  const liveState = getManagementLiveState(state);
  if (liveState.poller || liveState.watchers.size === 0) return;
  liveState.poller = setInterval(() => {
    const { changed, payload } = captureManagementSnapshot(state, options, deps);
    if (!changed || liveState.watchers.size === 0) return;
    broadcastSseJson(liveState.watchers, payload, {
      onWatcherRemoved: () => {
        if (liveState.watchers.size === 0) {
          stopManagementWatchPoller(liveState);
        }
      }
    });
  }, MANAGEMENT_WATCH_POLL_MS);
  if (typeof liveState.poller.unref === 'function') {
    liveState.poller.unref();
  }
}

function notifyManagementWatchers(ctx) {
  const { state, options, deps } = ctx;
  const liveState = getManagementLiveState(state);
  const { changed, payload } = captureManagementSnapshot(state, options, deps);
  if (!changed || liveState.watchers.size === 0) return false;
  broadcastSseJson(liveState.watchers, payload, {
    onWatcherRemoved: () => {
      if (liveState.watchers.size === 0) {
        stopManagementWatchPoller(liveState);
      }
    }
  });
  return true;
}

function handleManagementWatchRequest(ctx) {
  const { req, res, state, options, deps } = ctx;
  const liveState = getManagementLiveState(state);

  openSseStream(res);
  writeSseJson(res, { type: 'connected' });
  attachSseWatcher(liveState.watchers, req, res, {
    heartbeatMs: MANAGEMENT_WATCH_HEARTBEAT_MS,
    onWatcherRemoved: () => {
      if (liveState.watchers.size === 0) {
        stopManagementWatchPoller(liveState);
      }
    }
  });

  const { payload } = captureManagementSnapshot(state, options, deps);
  writeSseJson(res, payload);
  ensureManagementWatchPoller({ state, options, deps });
  return true;
}

module.exports = {
  handleManagementWatchRequest,
  notifyManagementWatchers
};
