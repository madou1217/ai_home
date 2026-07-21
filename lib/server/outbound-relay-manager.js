'use strict';

const {
  DEFAULT_RECONNECT_DELAY_MS,
  calculateReconnectDelay
} = require('../runtime/reconnect-backoff');
const { normalizeFabricServerId } = require('./fabric-broker-session-registry');
const { normalizeOutboundRelayConfig } = require('./outbound-relay-config-store');

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 120_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;

function lifecycleError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boundedRatio(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function normalizeLocalUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw lifecycleError('invalid_outbound_relay_local_url');
    }
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (error) {
    if (error && error.code === 'invalid_outbound_relay_local_url') throw error;
    throw lifecycleError('invalid_outbound_relay_local_url');
  }
}

function defaultSleep(delayMs, context = {}) {
  return new Promise((resolve) => {
    const signal = context.signal;
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    if (signal) signal.addEventListener('abort', finish, { once: true });
  });
}

function sanitizeDiagnostic(value, managementKey) {
  let text = String(value == null ? '' : value).trim();
  if (managementKey) text = text.split(managementKey).join('[redacted]');
  return text.slice(0, 512);
}

function createOutboundRelayManager(input = {}, deps = {}) {
  const serverId = normalizeFabricServerId(input.stableServerId || input.serverId);
  if (!serverId) throw lifecycleError('missing_outbound_relay_server_id');
  const localUrl = normalizeLocalUrl(input.localUrl);
  const localClientKey = String(input.localClientKey || '').trim();
  const connect = typeof deps.connectFabricBroker === 'function'
    ? deps.connectFabricBroker
    : async () => { throw lifecycleError('outbound_relay_connector_unavailable'); };
  const sleep = deps.sleep || defaultSleep;
  const random = deps.random || Math.random;
  const connectionOptions = {
    connectTimeoutMs: positiveNumber(input.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS),
    requestTimeoutMs: positiveNumber(input.requestTimeoutMs, 30_000),
    heartbeatMs: positiveNumber(input.heartbeatMs, DEFAULT_HEARTBEAT_MS),
    reconnectDelayMs: positiveNumber(input.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS),
    reconnectMaxDelayMs: positiveNumber(input.reconnectMaxDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS),
    reconnectJitterRatio: boundedRatio(input.reconnectJitterRatio, DEFAULT_RECONNECT_JITTER_RATIO)
  };
  connectionOptions.reconnectMaxDelayMs = Math.max(
    connectionOptions.reconnectDelayMs,
    connectionOptions.reconnectMaxDelayMs
  );

  let running = false;
  let configuration = normalizeOutboundRelayConfig([]);
  const jobs = new Map();

  function buildConnectOptions(relay) {
    return {
      brokerUrl: relay.endpoint,
      serverId,
      localUrl,
      localClientKey,
      managementKey: relay.managementKey,
      ...connectionOptions
    };
  }

  async function waitForRetry(job, delayMs) {
    const controller = new AbortController();
    job.sleepController = controller;
    let resolveCancelled;
    const cancelled = new Promise((resolve) => {
      resolveCancelled = resolve;
    });
    const onAbort = () => resolveCancelled();
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const pendingSleep = Promise.resolve()
      .then(() => sleep(delayMs, {
        endpoint: job.config.endpoint,
        signal: controller.signal
      }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        throw error;
      });
    try {
      await Promise.race([pendingSleep, cancelled]);
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
      if (job.sleepController === controller) job.sleepController = null;
    }
  }

  async function runJob(job) {
    while (running && !job.cancelled) {
      job.attempts += 1;
      job.status = 'connecting';
      job.retryDelayMs = 0;
      try {
        const handle = await connect(buildConnectOptions(job.config), deps);
        if (!handle || !handle.closed || typeof handle.close !== 'function') {
          throw lifecycleError('invalid_outbound_relay_connection_handle');
        }
        if (!running || job.cancelled) {
          handle.close();
          break;
        }
        job.handle = handle;
        job.status = 'online';
        job.sessionId = String(handle.sessionId || '');
        job.connectedAt = Number(handle.diagnostics && handle.diagnostics.connectedAt) || Date.now();
        job.lastError = '';
        const result = await handle.closed;
        if (job.handle === handle) job.handle = null;
        if (!running || job.cancelled) break;
        job.lastError = sanitizeDiagnostic(
          result && (result.error || result.closeReason || result.reason),
          job.config.managementKey
        );
      } catch (error) {
        job.handle = null;
        if (!running || job.cancelled) break;
        job.lastError = sanitizeDiagnostic(
          (error && (error.code || error.message)) || error,
          job.config.managementKey
        );
      }
      if (!running || job.cancelled) break;
      job.sessionId = '';
      const delayMs = calculateReconnectDelay(job.attempts, connectionOptions, random);
      job.status = 'waiting';
      job.retryDelayMs = delayMs;
      await waitForRetry(job, delayMs);
    }
    job.handle = null;
    job.sleepController = null;
    job.retryDelayMs = 0;
    job.status = 'stopped';
  }

  function startJob(relay) {
    const job = {
      config: relay,
      cancelled: false,
      status: 'connecting',
      attempts: 0,
      retryDelayMs: 0,
      sessionId: '',
      connectedAt: 0,
      lastError: '',
      handle: null,
      sleepController: null,
      loopPromise: null
    };
    jobs.set(relay.endpoint, job);
    job.loopPromise = runJob(job);
    return job;
  }

  async function stopJob(job) {
    if (!job) return;
    job.cancelled = true;
    if (job.sleepController) job.sleepController.abort();
    if (job.handle) {
      try { job.handle.close(); } catch (_error) {}
    }
    if (job.loopPromise) await job.loopPromise;
    if (jobs.get(job.config.endpoint) === job) jobs.delete(job.config.endpoint);
  }

  async function applyConfiguration(value) {
    const nextConfiguration = normalizeOutboundRelayConfig(value);
    configuration = nextConfiguration;
    if (!running) return getSnapshot();
    const nextByEndpoint = new Map(nextConfiguration.relays.map((relay) => [relay.endpoint, relay]));
    const stopping = [];
    jobs.forEach((job, endpoint) => {
      const next = nextByEndpoint.get(endpoint);
      if (!next || !next.enabled || next.managementKey !== job.config.managementKey) {
        stopping.push(stopJob(job));
        return;
      }
      job.config = next;
    });
    await Promise.all(stopping);
    nextConfiguration.relays.forEach((relay) => {
      if (relay.enabled && !jobs.has(relay.endpoint)) startJob(relay);
    });
    return getSnapshot();
  }

  async function start(value = configuration) {
    const nextConfiguration = normalizeOutboundRelayConfig(value);
    if (running) return applyConfiguration(nextConfiguration);
    configuration = nextConfiguration;
    running = true;
    nextConfiguration.relays.forEach((relay) => {
      if (relay.enabled) startJob(relay);
    });
    return getSnapshot();
  }

  async function stop() {
    if (!running && jobs.size === 0) return getSnapshot();
    running = false;
    const activeJobs = Array.from(jobs.values());
    activeJobs.forEach((job) => {
      job.cancelled = true;
      if (job.sleepController) job.sleepController.abort();
      if (job.handle) {
        try { job.handle.close(); } catch (_error) {}
      }
    });
    await Promise.all(activeJobs.map((job) => job.loopPromise));
    jobs.clear();
    return getSnapshot();
  }

  function getSnapshot() {
    return {
      running,
      serverId,
      localUrl,
      relays: configuration.relays.map((relay) => {
        const job = jobs.get(relay.endpoint);
        return {
          endpoint: relay.endpoint,
          name: relay.name,
          enabled: relay.enabled,
          managementKeyConfigured: Boolean(relay.managementKey),
          status: !relay.enabled ? 'disabled' : (!running ? 'stopped' : (job ? job.status : 'stopped')),
          attempts: job ? job.attempts : 0,
          retryDelayMs: job ? job.retryDelayMs : 0,
          sessionId: job ? job.sessionId : '',
          connectedAt: job ? job.connectedAt : 0,
          lastError: job ? job.lastError : ''
        };
      })
    };
  }

  return {
    getSnapshot,
    reconcile: applyConfiguration,
    start,
    stop,
    update: applyConfiguration
  };
}

module.exports = {
  createOutboundRelayManager
};
