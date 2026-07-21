#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const {
  connectFabricBroker
} = require('../lib/cli/services/fabric/broker-connect');
const { normalizeFabricServerId } = require('../lib/server/fabric-broker-session-registry');
const {
  managementKeyFromEnv,
  readManagementKey
} = require('./fabric-real-management-key');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9527';
const DEFAULT_SERVER_ID = 'broker-diagnostics-server';
const DEFAULT_TIMEOUT_MS = 10000;

function showHelp() {
  console.log(`AIH Fabric real broker diagnostics smoke

Usage:
  AIH_MANAGEMENT_KEY=<key> node scripts/fabric-real-broker-diagnostics-smoke.js [options]

Options:
  --endpoint <url>      Running AIH server/broker endpoint, default ${DEFAULT_ENDPOINT}.
  --server-id <id>      Broker server id, default ${DEFAULT_SERVER_ID}.
  --local-url <url>     Local AIH server URL reached by broker connector, default endpoint.
  --management-key <key>
                        Server Management Key. Prefer AIH_MANAGEMENT_KEY to avoid argv leaks.
  --management-key-file <path>
                        Read the Server Management Key from a local file.
  --timeout-ms <n>      Request/connect timeout, default ${DEFAULT_TIMEOUT_MS}.
  -h, --help            Show this help.

This script does not start a server, allocate a product port, install services,
or modify firewall/systemd. It verifies broker link offline diagnostics and
same-server-id recovery against an already running endpoint.
`);
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    throw new Error(`${flag} requires a value`);
  }
  return { value: String(value), consumed: 2 };
}

function normalizeHttpEndpoint(value, flag) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad_protocol');
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function parsePositiveInteger(value, flag, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1000 || number > 180000) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${flag} must be an integer between 1000 and 180000`);
  }
  return number;
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    endpoint: DEFAULT_ENDPOINT,
    localUrl: '',
    serverId: DEFAULT_SERVER_ID,
    managementKey: managementKeyFromEnv(env),
    managementKeyFile: '',
    timeoutMs: DEFAULT_TIMEOUT_MS
  };

  for (let index = 0; index < argv.length;) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--local-url' || token.startsWith('--local-url=')) {
      const next = readOptionValue(argv, index, '--local-url');
      options.localUrl = normalizeHttpEndpoint(next.value, '--local-url');
      index += next.consumed;
      continue;
    }
    if (token === '--server-id' || token.startsWith('--server-id=')) {
      const next = readOptionValue(argv, index, '--server-id');
      options.serverId = normalizeFabricServerId(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const next = readOptionValue(argv, index, '--management-key');
      options.managementKey = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--management-key-file' || token.startsWith('--management-key-file=')) {
      const next = readOptionValue(argv, index, '--management-key-file');
      options.managementKeyFile = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--token' || token.startsWith('--token=')) {
      const next = readOptionValue(argv, index, '--token');
      options.managementKey = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--token-file' || token.startsWith('--token-file=')) {
      const next = readOptionValue(argv, index, '--token-file');
      options.managementKeyFile = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms');
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (options.help) return options;
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  options.localUrl = options.localUrl ? normalizeHttpEndpoint(options.localUrl, '--local-url') : options.endpoint;
  options.serverId = normalizeFabricServerId(options.serverId);
  if (!options.serverId) throw new Error('--server-id must match Fabric server id rules');
  return options;
}

function brokerProxyBase(endpoint, serverId) {
  return `${endpoint.replace(/\/+$/, '')}/v0/fabric/broker/servers/${encodeURIComponent(serverId)}/proxy`;
}

async function fetchJson(url, options = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller ? controller.signal : undefined
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_error) {
      body = { raw: text };
    }
    return {
      status: response.status,
      ok: response.ok,
      body
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForProxyState(proxyBase, predicate, options = {}, deps = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    last = await fetchJson(`${proxyBase}/readyz`, { timeoutMs }, deps).catch((error) => ({
      status: 0,
      ok: false,
      body: { ok: false, error: String((error && error.message) || error || 'fetch_failed') }
    }));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const error = new Error('broker_proxy_state_timeout');
  error.last = last;
  throw error;
}

function summarizeReadyz(result) {
  return {
    status: result.status,
    ok: Boolean(result.ok),
    ready: Boolean(result.body && result.body.ready),
    error: String(result.body && result.body.error || '')
  };
}

async function closeBrokerHandle(handle) {
  if (!handle || typeof handle.close !== 'function') return null;
  handle.close();
  if (!handle.closed || typeof handle.closed.then !== 'function') return null;
  return Promise.race([
    handle.closed,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'close_timeout' }), 2000))
  ]);
}

async function runBrokerDiagnosticsSmoke(rawOptions = {}, deps = {}) {
  const options = {
    endpoint: DEFAULT_ENDPOINT,
    localUrl: '',
    serverId: DEFAULT_SERVER_ID,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...rawOptions
  };
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  options.localUrl = options.localUrl ? normalizeHttpEndpoint(options.localUrl, '--local-url') : options.endpoint;
  options.serverId = normalizeFabricServerId(options.serverId);
  if (!options.serverId) throw new Error('--server-id must match Fabric server id rules');
  const managementKey = readManagementKey(options, deps);
  const proxyBase = brokerProxyBase(options.endpoint, options.serverId);
  const connect = deps.connectFabricBroker || connectFabricBroker;

  let firstHandle = null;
  let secondHandle = null;
  let firstSessionId = '';
  try {
    firstHandle = await connect({
      brokerUrl: options.endpoint,
      serverId: options.serverId,
      managementKey,
      localUrl: options.localUrl,
      connectTimeoutMs: options.timeoutMs,
      requestTimeoutMs: options.timeoutMs,
      heartbeatMs: 1000
    }, { WebSocket });
    firstSessionId = firstHandle.sessionId;

    const beforeDisconnect = await waitForProxyState(
      proxyBase,
      (result) => result.status === 200 && result.body && result.body.ok === true,
      { timeoutMs: options.timeoutMs },
      deps
    );
    const firstClosed = await closeBrokerHandle(firstHandle);
    firstHandle = null;
    const offline = await waitForProxyState(
      proxyBase,
      (result) => result.status === 503
        && result.body
        && result.body.error === 'fabric_broker_server_offline'
        && result.body.brokerStatus
        && result.body.brokerStatus.online === false
        && result.body.brokerStatus.lastDisconnected,
      { timeoutMs: options.timeoutMs },
      deps
    );

    secondHandle = await connect({
      brokerUrl: options.endpoint,
      serverId: options.serverId,
      managementKey,
      localUrl: options.localUrl,
      connectTimeoutMs: options.timeoutMs,
      requestTimeoutMs: options.timeoutMs,
      heartbeatMs: 1000
    }, { WebSocket });
    const recovered = await waitForProxyState(
      proxyBase,
      (result) => result.status === 200 && result.body && result.body.ok === true,
      { timeoutMs: options.timeoutMs },
      deps
    );

    return {
      ok: true,
      mode: 'existing-endpoint-broker-diagnostics',
      endpoint: options.endpoint,
      proxyBase,
      serverId: options.serverId,
      localUrl: options.localUrl,
      broker: {
        firstSessionId,
        firstClosed,
        secondSessionId: secondHandle.sessionId
      },
      checks: {
        beforeDisconnect: summarizeReadyz(beforeDisconnect),
        offline: {
          status: offline.status,
          ok: Boolean(offline.ok),
          error: offline.body.error,
          brokerStatus: offline.body.brokerStatus
        },
        recovered: summarizeReadyz(recovered)
      }
    };
  } finally {
    await closeBrokerHandle(firstHandle);
    await closeBrokerHandle(secondHandle);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.help) {
    showHelp();
    return;
  }
  try {
    const result = await runBrokerDiagnosticsSmoke(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const payload = {
      ok: false,
      error: String((error && error.message) || error || 'fabric_broker_diagnostics_failed'),
      last: error && error.last ? error.last : undefined
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  brokerProxyBase,
  parseArgs,
  readManagementKey,
  runBrokerDiagnosticsSmoke,
  waitForProxyState
};
