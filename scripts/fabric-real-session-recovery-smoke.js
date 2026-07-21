#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const {
  connectFabricBroker
} = require('../lib/cli/services/fabric/broker-connect');
const { normalizeFabricServerId } = require('../lib/server/fabric-broker-session-registry');
const {
  brokerProxyBase,
  readManagementKey
} = require('./fabric-real-broker-diagnostics-smoke');
const { isAccountRef } = require('../lib/account/public-account-ref');
const {
  getHostAiHomeDir,
  prepareExistingEndpointStores,
  resolveExistingHostHome,
  resolveExistingNodeManagementKey,
  summarizeChild
} = require('./fabric-real-outbound-relay-smoke');

const DEFAULT_BROKER_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_LOCAL_URL = 'http://127.0.0.1:9527';
const DEFAULT_SERVER_ID = 'm5-recovery-local';
const DEFAULT_NODE_ID = 'm5-recovery-node';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_SESSION_TIMEOUT_MS = 120000;
const DEFAULT_CONSUMER_ID = 'm5-recovery-client';

function showHelp() {
  console.log(`AIH Fabric real session recovery smoke

Usage:
  AIH_MANAGEMENT_KEY=<aws-key> node scripts/fabric-real-session-recovery-smoke.js [options]

Options:
  --broker-endpoint <url>  AWS/current broker endpoint, default ${DEFAULT_BROKER_ENDPOINT}.
  --local-url <url>        Local AIH server reached by broker connector, default ${DEFAULT_LOCAL_URL}.
  --host-home <dir>        Host home used by local server/runtime, default AIH_HOST_HOME/HOME.
  --server-id <id>         Broker server id, default ${DEFAULT_SERVER_ID}.
  --node-id <id>           Local relay node id, default ${DEFAULT_NODE_ID}.
  --management-key <key>   AWS Server Management Key. Prefer AIH_MANAGEMENT_KEY to avoid argv leaks.
  --management-key-file <path>
                           File containing the AWS Server Management Key; the key is never printed.
  --session-provider <p>   Native provider, default codex.
  --session-account-ref <ref>
                           Optional native provider accountRef; defaults to model routing.
  --session-model <m>      Native model, default gpt-5.5.
  --session-project <p>    Project path for native session, default cwd.
  --interrupt <kind>       broker or relay, default broker.
  --diagnostics-file <p>   Optional sanitized JSON export path.
  --timeout-ms <n>         Control wait timeout, default ${DEFAULT_TIMEOUT_MS}.
  --session-timeout-ms <n> Session wait timeout, default ${DEFAULT_SESSION_TIMEOUT_MS}.
  -h, --help               Show this help.

This script uses the existing default ports only. It opens a real outbound
broker link to AWS, starts a real local relay client, starts a real native
session, interrupts the selected transport layer, then proves attach/resume and
post-recovery message delivery by cursor without duplicate events.
The local Server Management Key is read from the local Server configuration.
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
  if (value === undefined || isFlag(value)) throw new Error(`${flag} requires a value`);
  return { value: String(value), consumed: 2 };
}

function normalizeHttpEndpoint(value, flag) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid_protocol');
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function parsePositiveInteger(value, flag, fallback, min = 1000, max = 240000) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function normalizeNodeId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(id) ? id : '';
}

function normalizeInterruptKind(value) {
  const kind = String(value || 'broker').trim().toLowerCase();
  if (kind === 'broker' || kind === 'relay') return kind;
  throw new Error('--interrupt must be broker or relay');
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    brokerEndpoint: DEFAULT_BROKER_ENDPOINT,
    localUrl: DEFAULT_LOCAL_URL,
    hostHome: '',
    serverId: DEFAULT_SERVER_ID,
    nodeId: DEFAULT_NODE_ID,
    managementKey: String(env.AIH_MANAGEMENT_KEY || '').trim(),
    managementKeyFile: '',
    sessionProvider: 'codex',
    sessionAccountRef: '',
    sessionModel: 'gpt-5.5',
    sessionProjectPath: process.cwd(),
    interrupt: 'broker',
    diagnosticsFile: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS
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
    if (token === '--broker-endpoint' || token.startsWith('--broker-endpoint=')) {
      const next = readOptionValue(argv, index, '--broker-endpoint');
      options.brokerEndpoint = normalizeHttpEndpoint(next.value, '--broker-endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--local-url' || token.startsWith('--local-url=')) {
      const next = readOptionValue(argv, index, '--local-url');
      options.localUrl = normalizeHttpEndpoint(next.value, '--local-url');
      index += next.consumed;
      continue;
    }
    if (token === '--host-home' || token.startsWith('--host-home=')) {
      const next = readOptionValue(argv, index, '--host-home');
      options.hostHome = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--server-id' || token.startsWith('--server-id=')) {
      const next = readOptionValue(argv, index, '--server-id');
      options.serverId = normalizeFabricServerId(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = String(next.value || '').trim();
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
    if (token === '--session-provider' || token.startsWith('--session-provider=')) {
      const next = readOptionValue(argv, index, '--session-provider');
      options.sessionProvider = String(next.value || '').trim().toLowerCase();
      index += next.consumed;
      continue;
    }
    if (token === '--session-account-ref' || token.startsWith('--session-account-ref=')) {
      const next = readOptionValue(argv, index, '--session-account-ref');
      options.sessionAccountRef = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--session-model' || token.startsWith('--session-model=')) {
      const next = readOptionValue(argv, index, '--session-model');
      options.sessionModel = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--session-project' || token.startsWith('--session-project=')) {
      const next = readOptionValue(argv, index, '--session-project');
      options.sessionProjectPath = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--interrupt' || token.startsWith('--interrupt=')) {
      const next = readOptionValue(argv, index, '--interrupt');
      options.interrupt = normalizeInterruptKind(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS);
      index += next.consumed;
      continue;
    }
    if (token === '--session-timeout-ms' || token.startsWith('--session-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--session-timeout-ms');
      options.sessionTimeoutMs = parsePositiveInteger(next.value, '--session-timeout-ms', DEFAULT_SESSION_TIMEOUT_MS);
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (options.help) return options;
  options.brokerEndpoint = normalizeHttpEndpoint(options.brokerEndpoint, '--broker-endpoint');
  options.localUrl = normalizeHttpEndpoint(options.localUrl, '--local-url');
  options.serverId = normalizeFabricServerId(options.serverId);
  options.nodeId = normalizeNodeId(options.nodeId);
  options.interrupt = normalizeInterruptKind(options.interrupt);
  if (!options.serverId) throw new Error('--server-id must match Fabric server id rules');
  if (!options.nodeId) throw new Error('--node-id must match AIH remote node id rules');
  if (options.sessionAccountRef && !isAccountRef(options.sessionAccountRef)) {
    throw new Error('--session-account-ref must be a valid accountRef');
  }
  if (!options.managementKey && !options.managementKeyFile) {
    throw new Error(
      'missing Management Key: set AIH_MANAGEMENT_KEY, pass --management-key, or pass --management-key-file'
    );
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    return { parseError: true, raw: text };
  }
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const response = await fetchImpl(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    signal: options.signal || timeoutSignal(options.timeoutMs || 10000)
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await readJsonResponse(response)
  };
}

function createChildHandle(label, child) {
  const handle = {
    label,
    child,
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: '',
    exited: false,
    exitPromise: null
  };
  handle.exitPromise = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      handle.stdout = `${handle.stdout}${String(chunk)}`.slice(-6000);
    });
    child.stderr.on('data', (chunk) => {
      handle.stderr = `${handle.stderr}${String(chunk)}`.slice(-6000);
    });
    child.on('error', (error) => {
      handle.exited = true;
      handle.stderr = `${handle.stderr}${String(error && error.message || error)}`.slice(-6000);
      resolve(handle);
    });
    child.on('close', (code, signal) => {
      handle.exited = true;
      handle.exitCode = code;
      handle.signal = signal || '';
      resolve(handle);
    });
  });
  return handle;
}

function spawnAihProcess(label, hostHomeDir, args, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const child = spawn(process.execPath, [path.join(repoRoot, 'bin', 'ai-home.js'), ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AIH_HOST_HOME: hostHomeDir,
      REAL_HOME: hostHomeDir,
      HOME: hostHomeDir,
      AIH_SERVER_DISABLE_SOURCE_AUTO_RESTART: '1',
      AIH_SERVER_MODEL_USAGE_SCAN: '0',
      AIH_SERVER_LOG_REQUESTS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return createChildHandle(label, child);
}

async function stopChild(handle, timeoutMs = 3000) {
  if (!handle) return null;
  if (!handle.child || handle.exited) return summarizeChild(handle);
  try {
    handle.child.kill('SIGTERM');
  } catch (_error) {}
  await Promise.race([handle.exitPromise, sleep(timeoutMs)]);
  if (!handle.exited) {
    try {
      handle.child.kill('SIGKILL');
    } catch (_error) {}
    await Promise.race([handle.exitPromise, sleep(1000)]);
  }
  return summarizeChild(handle);
}

async function closeBrokerHandle(handle) {
  if (!handle || typeof handle.close !== 'function') return null;
  handle.close();
  if (!handle.closed || typeof handle.closed.then !== 'function') return null;
  return Promise.race([
    handle.closed,
    sleep(2000).then(() => ({ ok: false, reason: 'close_timeout' }))
  ]);
}

function randomSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

function buildPromptParts(prefix) {
  const words = prefix.split('_').filter(Boolean);
  const marker = `${prefix}_20260628`;
  const prompt = `Return exactly one token by joining these words with underscores and no extra text: ${words.join(' ')} 20260628.`;
  if (prompt.includes(marker)) throw new Error('prompt_must_not_contain_marker');
  return { marker, prompt };
}

function appendTail(current, value, maxLength = 8000) {
  const next = `${String(current || '')}${String(value || '')}`;
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

function appendTerminalEvents(current, events = []) {
  let next = String(current || '');
  (Array.isArray(events) ? events : []).forEach((event) => {
    if (event && event.type === 'terminal-output') {
      next = appendTail(next, event.text || '');
    }
  });
  return next;
}

function mergeEventCounts(current = {}, events = []) {
  const next = { ...current };
  (Array.isArray(events) ? events : []).forEach((event) => {
    const type = String(event && event.type || 'unknown');
    next[type] = (next[type] || 0) + 1;
  });
  return next;
}

function summarizeStatus(result = {}) {
  return {
    status: Number(result.status) || 0,
    ok: Boolean(result.ok),
    error: String(result.body && result.body.error || ''),
    ready: Boolean(result.body && result.body.ready)
  };
}

function pushRequestLog(log, entry) {
  log.push({
    phase: entry.phase || '',
    method: entry.method || 'GET',
    path: entry.path || '',
    status: Number(entry.status) || 0,
    ok: Boolean(entry.ok),
    error: String(entry.error || ''),
    rpc: String(entry.rpc || '')
  });
}

async function waitForProxyState(proxyBase, predicate, options = {}, deps = {}) {
  const timeoutMs = Number(options.timeoutMs) || 10000;
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt <= timeoutMs) {
    last = await fetchJson(`${proxyBase}/readyz`, {
      timeoutMs: Math.min(timeoutMs, 5000),
      fetchImpl: deps.fetchImpl
    }).catch((error) => ({
      status: 0,
      ok: false,
      body: { ok: false, error: String(error && error.message || error || 'fetch_failed') }
    }));
    if (predicate(last)) return last;
    await sleep(100);
  }
  const error = new Error('proxy_state_timeout');
  error.last = last;
  throw error;
}

async function waitForDeviceNodeOnline(endpoint, managementKey, nodeId, timeoutMs, deps = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await fetchJson(`${endpoint}/v0/node-rpc/device-nodes`, {
      timeoutMs: 3000,
      fetchImpl: deps.fetchImpl,
      headers: { authorization: `Bearer ${managementKey}` }
    }).catch((error) => ({
      status: 0,
      ok: false,
      body: { ok: false, error: String(error && error.message || error || 'device_nodes_failed') }
    }));
    const nodes = latest.body && latest.body.result && Array.isArray(latest.body.result.nodes)
      ? latest.body.result.nodes
      : [];
    const node = nodes.find((entry) => entry && entry.id === nodeId);
    if (node && node.connection && node.connection.status === 'online') return { response: latest, node };
    await sleep(250);
  }
  const error = new Error('relay_online_timeout');
  error.latest = latest;
  throw error;
}

async function waitForDeviceNodeNotOnline(endpoint, managementKey, nodeId, timeoutMs, deps = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await fetchJson(`${endpoint}/v0/node-rpc/device-nodes`, {
      timeoutMs: 3000,
      fetchImpl: deps.fetchImpl,
      headers: { authorization: `Bearer ${managementKey}` }
    }).catch((error) => ({
      status: 0,
      ok: false,
      body: { ok: false, error: String(error && error.message || error || 'device_nodes_failed') }
    }));
    const nodes = latest.body && latest.body.result && Array.isArray(latest.body.result.nodes)
      ? latest.body.result.nodes
      : [];
    const node = nodes.find((entry) => entry && entry.id === nodeId);
    if (!node || !node.connection || node.connection.status !== 'online') {
      return { response: latest, node: node || null };
    }
    await sleep(250);
  }
  const error = new Error('relay_offline_timeout');
  error.latest = latest;
  throw error;
}

async function requestServerApi(state, pathName, options = {}) {
  const method = options.method || 'GET';
  const response = await fetchJson(`${state.clientEndpoint}${pathName}`, {
    method,
    timeoutMs: options.timeoutMs || 10000,
    fetchImpl: state.deps.fetchImpl,
    headers: {
      authorization: `Bearer ${state.managementKey}`,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  pushRequestLog(state.requestLog, {
    phase: options.phase,
    method,
    path: pathName.split('?')[0],
    status: response.status,
    ok: response.ok && response.body && response.body.ok !== false,
    error: response.body && response.body.error,
    rpc: response.body && response.body.rpc
  });
  return response;
}

async function readEvents(state, fromCursor) {
  const cursor = Number(fromCursor) || 0;
  const response = await requestServerApi(
    state,
    `/v0/node-rpc/device-node-session-run-events?nodeId=${encodeURIComponent(state.nodeId)}&runId=${encodeURIComponent(state.runId)}&cursor=${encodeURIComponent(String(cursor))}&limit=100`,
    { phase: 'events', timeoutMs: 10000 }
  );
  const result = response.body && response.body.result && typeof response.body.result === 'object'
    ? response.body.result
    : {};
  const events = Array.isArray(result.events) ? result.events : [];
  state.terminalTail = appendTerminalEvents(state.terminalTail, events);
  state.eventCounts = mergeEventCounts(state.eventCounts, events);
  state.cursor = Math.max(state.cursor, Number(result.cursor) || state.cursor);
  return {
    status: response.status,
    ok: response.status === 200 && response.body && response.body.ok !== false,
    cursor: Number(result.cursor) || cursor,
    events,
    completed: result.completed === true || result.status === 'completed'
  };
}

async function waitForMarker(state, marker, fromCursor, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let resumeCursor = Number(fromCursor) || 0;
  let duplicateEvents = 0;
  while (Date.now() < deadline) {
    const batch = await readEvents(state, resumeCursor);
    duplicateEvents += batch.events.filter((event) => Number(event && event.cursor) <= resumeCursor).length;
    resumeCursor = Math.max(resumeCursor, batch.cursor);
    if (state.terminalTail.includes(marker)) {
      return {
        found: true,
        cursor: state.cursor,
        duplicateEvents
      };
    }
    await sleep(500);
  }
  return {
    found: false,
    cursor: state.cursor,
    duplicateEvents
  };
}

async function startSession(state, options) {
  const start = buildPromptParts('AIH_M5_RECOVERY_START_OK');
  state.startMarker = start.marker;
  const response = await requestServerApi(state, '/v0/node-rpc/device-node-session-start', {
    method: 'POST',
    phase: 'start',
    timeoutMs: 15000,
    body: {
      nodeId: state.nodeId,
      provider: options.sessionProvider,
      accountRef: options.sessionAccountRef,
      model: options.sessionModel,
      projectPath: options.sessionProjectPath,
      prompt: start.prompt,
      cols: 96,
      rows: 28
    }
  });
  state.runId = String(response.body && response.body.result && response.body.result.runId || '');
  return response;
}

async function ackSession(state, cursor, phase = 'ack') {
  return requestServerApi(state, '/v0/node-rpc/device-node-session-ack', {
    method: 'POST',
    phase,
    body: {
      nodeId: state.nodeId,
      sessionId: state.runId,
      cursor,
      consumerId: DEFAULT_CONSUMER_ID
    }
  });
}

async function attachSession(state, cursor, phase = 'attach') {
  return requestServerApi(state, '/v0/node-rpc/device-node-session-attach', {
    method: 'POST',
    phase,
    body: {
      nodeId: state.nodeId,
      sessionId: state.runId,
      cursor
    }
  });
}

async function sendMessage(state, options) {
  const message = buildPromptParts('AIH_M5_RECOVERY_MESSAGE_OK');
  state.messageMarker = message.marker;
  return requestServerApi(state, '/v0/node-rpc/device-node-session-command', {
    method: 'POST',
    phase: 'message',
    body: {
      nodeId: state.nodeId,
      type: 'message',
      sessionId: state.runId,
      text: message.prompt,
      idempotencyKey: `m5-recovery-message-${state.runId}-${options.interrupt}`
    }
  });
}

async function stopSession(state) {
  if (!state.runId) return null;
  return requestServerApi(state, '/v0/node-rpc/device-node-session-command', {
    method: 'POST',
    phase: 'stop',
    body: {
      nodeId: state.nodeId,
      type: 'stop',
      sessionId: state.runId,
      scope: 'run',
      idempotencyKey: `m5-recovery-stop-${state.runId}`
    }
  }).catch((error) => ({
    status: 0,
    ok: false,
    body: { ok: false, error: String(error && error.message || error || 'stop_failed') }
  }));
}

function createRelayArgs(localUrl, nodeId, nodeManagement) {
  const args = [
    'node',
    'relay',
    'connect',
    localUrl,
    '--node-id',
    nodeId,
    '--heartbeat-ms',
    '1000',
    '--connect-timeout-ms',
    '5000',
    '--reconnect-delay-ms',
    '500',
    '--max-attempts',
    '1'
  ];
  if (nodeManagement.passCliArg) args.push('--management-key', nodeManagement.key);
  return args;
}

async function interruptBroker(state, options, managementKey, connect) {
  const firstClosed = await closeBrokerHandle(state.brokerHandle);
  state.brokerHandle = null;
  const offline = await waitForProxyState(
    state.clientEndpoint,
    (result) => result.status === 503
      && result.body
      && result.body.error === 'fabric_broker_server_offline'
      && result.body.brokerStatus
      && result.body.brokerStatus.online === false,
    { timeoutMs: options.timeoutMs },
    state.deps
  );
  state.brokerHandle = await connect({
    brokerUrl: options.brokerEndpoint,
    serverId: options.serverId,
    managementKey,
    localUrl: options.localUrl,
    connectTimeoutMs: options.timeoutMs,
    requestTimeoutMs: options.timeoutMs,
    heartbeatMs: 1000
  }, { WebSocket: state.deps.WebSocket || WebSocket });
  const recovered = await waitForProxyState(
    state.clientEndpoint,
    (result) => result.status === 200 && result.body && result.body.ok === true,
    { timeoutMs: options.timeoutMs },
    state.deps
  );
  return {
    kind: 'broker',
    firstClosed,
    offline: {
      status: offline.status,
      ok: Boolean(offline.ok),
      error: offline.body && offline.body.error || '',
      brokerStatus: offline.body && offline.body.brokerStatus || null
    },
    recovered: summarizeStatus(recovered),
    secondSessionId: String(state.brokerHandle && state.brokerHandle.sessionId || '')
  };
}

async function interruptRelay(state, options, hostHomeDir, nodeManagement, repoRoot) {
  const stopped = await stopChild(state.relayHandle);
  state.relayHandle = null;
  const offline = await waitForDeviceNodeNotOnline(
    state.clientEndpoint,
    state.managementKey,
    options.nodeId,
    options.timeoutMs,
    state.deps
  );
  const failedAttach = await attachSession(state, state.cursor, 'relay-offline-attach').catch((error) => ({
    status: 0,
    ok: false,
    body: { ok: false, error: String(error && error.message || error || 'relay_offline_attach_failed') }
  }));
  const spawnProcess = state.deps.spawnAihProcess || spawnAihProcess;
  state.relayHandle = spawnProcess(
    'relay-client',
    hostHomeDir,
    createRelayArgs(options.localUrl, options.nodeId, nodeManagement),
    { repoRoot }
  );
  const online = await waitForDeviceNodeOnline(
    state.clientEndpoint,
    state.managementKey,
    options.nodeId,
    options.timeoutMs,
    state.deps
  );
  return {
    kind: 'relay',
    stopped,
    offline: {
      status: offline.response && offline.response.status || 0,
      nodeStatus: offline.node && offline.node.connection && offline.node.connection.status || 'missing',
      error: offline.response && offline.response.body && offline.response.body.error || ''
    },
    offlineAttach: {
      status: failedAttach.status,
      ok: failedAttach.status === 200 && failedAttach.body && failedAttach.body.ok !== false,
      error: failedAttach.body && failedAttach.body.error || ''
    },
    recovered: {
      online: online.node && online.node.connection && online.node.connection.status === 'online',
      transportKind: online.node && online.node.connection && online.node.connection.transportKind || '',
      transportId: online.node && online.node.connection && online.node.connection.transportId || ''
    }
  };
}

function writeDiagnosticsFile(filePath, payload, deps = {}) {
  if (!filePath) return null;
  const fsImpl = deps.fs || fs;
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
  fsImpl.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return filePath;
}

async function runSessionRecoverySmoke(rawOptions = {}, deps = {}) {
  const options = {
    brokerEndpoint: DEFAULT_BROKER_ENDPOINT,
    localUrl: DEFAULT_LOCAL_URL,
    serverId: DEFAULT_SERVER_ID,
    nodeId: DEFAULT_NODE_ID,
    sessionProvider: 'codex',
    sessionAccountRef: '',
    sessionModel: 'gpt-5.5',
    sessionProjectPath: process.cwd(),
    interrupt: 'broker',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    diagnosticsFile: '',
    ...rawOptions
  };
  options.brokerEndpoint = normalizeHttpEndpoint(options.brokerEndpoint, '--broker-endpoint');
  options.localUrl = normalizeHttpEndpoint(options.localUrl, '--local-url');
  options.serverId = normalizeFabricServerId(options.serverId);
  options.nodeId = normalizeNodeId(options.nodeId);
  options.interrupt = normalizeInterruptKind(options.interrupt);
  if (options.sessionAccountRef && !isAccountRef(options.sessionAccountRef)) {
    throw new Error('sessionAccountRef must be a valid accountRef');
  }
  const outboundManagementKey = readManagementKey(options, deps);
  const hostHomeDir = resolveExistingHostHome(options.hostHome, deps.env || process.env);
  const aiHomeDir = getHostAiHomeDir(hostHomeDir);
  const repoRoot = deps.repoRoot || path.resolve(__dirname, '..');
  const nodeManagement = (deps.resolveExistingNodeManagementKey || resolveExistingNodeManagementKey)(aiHomeDir, deps);
  const localManagementKey = String(
    nodeManagement.source === 'server-config' ? nodeManagement.key : ''
  ).trim();
  if (!localManagementKey) {
    throw new Error('missing local Server Management Key in the local Server configuration');
  }
  const connect = deps.connectFabricBroker || connectFabricBroker;
  const prepareStores = deps.prepareExistingEndpointStores || prepareExistingEndpointStores;
  const spawnProcess = deps.spawnAihProcess || spawnAihProcess;
  const state = {
    deps,
    clientEndpoint: brokerProxyBase(options.brokerEndpoint, options.serverId),
    nodeId: options.nodeId,
    managementKey: localManagementKey,
    runId: '',
    cursor: 0,
    terminalTail: '',
    eventCounts: {},
    requestLog: [],
    firstBrokerSessionId: '',
    brokerHandle: null,
    relayHandle: null
  };
  const startedAt = Date.now();
  let prepared = null;
  let beforeInterruptCursor = 0;
  let stop = null;

  try {
    const localReady = await fetchJson(`${options.localUrl}/readyz`, {
      timeoutMs: 5000,
      fetchImpl: deps.fetchImpl
    });
    state.brokerHandle = await connect({
      brokerUrl: options.brokerEndpoint,
      serverId: options.serverId,
      managementKey: outboundManagementKey,
      localUrl: options.localUrl,
      connectTimeoutMs: options.timeoutMs,
      requestTimeoutMs: options.timeoutMs,
      heartbeatMs: 1000
    }, { WebSocket: deps.WebSocket || WebSocket });
    state.firstBrokerSessionId = String(state.brokerHandle && state.brokerHandle.sessionId || '');
    const proxyReady = await waitForProxyState(
      state.clientEndpoint,
      (result) => result.status === 200 && result.body && result.body.ok === true,
      { timeoutMs: options.timeoutMs },
      deps
    );
    prepared = prepareStores({
      aiHomeDir,
      controlEndpoint: options.localUrl,
      nodeId: options.nodeId,
      nodeManagementKey: nodeManagement.key,
      managementKey: localManagementKey,
      deps
    });
    state.relayHandle = spawnProcess(
      'relay-client',
      hostHomeDir,
      createRelayArgs(options.localUrl, options.nodeId, nodeManagement),
      { repoRoot }
    );
    const online = await waitForDeviceNodeOnline(
      state.clientEndpoint,
      state.managementKey,
      options.nodeId,
      options.timeoutMs,
      deps
    );
    const start = await startSession(state, options);
    const startMarker = state.runId
      ? await waitForMarker(state, state.startMarker, 0, options.sessionTimeoutMs)
      : { found: false, cursor: state.cursor, duplicateEvents: 0 };
    beforeInterruptCursor = state.cursor;
    const ackBefore = await ackSession(state, beforeInterruptCursor, 'ack-before-interrupt');
    const interruption = options.interrupt === 'relay'
      ? await interruptRelay(state, options, hostHomeDir, nodeManagement, repoRoot)
      : await interruptBroker(state, options, outboundManagementKey, connect);
    const attach = await attachSession(state, beforeInterruptCursor, 'attach-after-recovery');
    const message = await sendMessage(state, options);
    const messageMarker = await waitForMarker(
      state,
      state.messageMarker,
      beforeInterruptCursor,
      options.sessionTimeoutMs
    );
    const ackAfter = await ackSession(state, state.cursor, 'ack-after-recovery');
    stop = await stopSession(state);
    await readEvents(state, state.cursor).catch(() => null);

    const ok = start.status === 200
      && Boolean(state.runId)
      && startMarker.found
      && ackBefore.status === 200
      && attach.status === 200
      && message.status === 200
      && messageMarker.found
      && messageMarker.duplicateEvents === 0
      && ackAfter.status === 200
      && stop.status === 200;
    const report = {
      ok,
      mode: 'm5-session-recovery',
      interrupt: options.interrupt,
      brokerEndpoint: options.brokerEndpoint,
      localUrl: options.localUrl,
      client: {
        endpoint: state.clientEndpoint,
        viaProxy: true
      },
      serverId: options.serverId,
      nodeId: options.nodeId,
      managementKeySource: nodeManagement.source,
      broker: {
        firstSessionId: state.firstBrokerSessionId,
        interruption
      },
      relay: {
        online: online.node && online.node.connection && online.node.connection.status === 'online',
        transportKind: online.node && online.node.connection && online.node.connection.transportKind || '',
        transportId: online.node && online.node.connection && online.node.connection.transportId || ''
      },
      authentication: {
        method: 'management_key',
        configured: Boolean(state.managementKey)
      },
      session: {
        provider: options.sessionProvider,
        accountRef: options.sessionAccountRef,
        model: options.sessionModel,
        projectPath: options.sessionProjectPath,
        runIdPresent: Boolean(state.runId),
        startStatus: start.status,
        startMarkerFound: startMarker.found,
        beforeInterruptCursor,
        attachStatus: attach.status,
        messageStatus: message.status,
        messageMarkerFound: messageMarker.found,
        duplicateEventsAfterRecovery: messageMarker.duplicateEvents,
        finalCursor: state.cursor,
        cursorAdvanced: state.cursor > beforeInterruptCursor,
        eventCounts: state.eventCounts,
        ackBeforeStatus: ackBefore.status,
        ackAfterStatus: ackAfter.status,
        stopStatus: stop.status,
        terminalTail: state.terminalTail
      },
      diagnostics: {
        exportedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        localReady: summarizeStatus(localReady),
        proxyReady: summarizeStatus(proxyReady),
        requestLog: state.requestLog
      },
      children: [state.relayHandle].filter(Boolean).map(summarizeChild)
    };
    const diagnosticsFile = writeDiagnosticsFile(options.diagnosticsFile, report, deps);
    if (diagnosticsFile) report.diagnostics.file = diagnosticsFile;
    return report;
  } catch (error) {
    const report = {
      ok: false,
      mode: 'm5-session-recovery',
      interrupt: options.interrupt,
      brokerEndpoint: options.brokerEndpoint,
      localUrl: options.localUrl,
      client: {
        endpoint: state.clientEndpoint,
        viaProxy: true
      },
      serverId: options.serverId,
      nodeId: options.nodeId,
      error: String(error && (error.code || error.message) || error || 'm5_session_recovery_failed'),
      message: String(error && error.message || error || ''),
      session: {
        runIdPresent: Boolean(state.runId),
        beforeInterruptCursor,
        finalCursor: state.cursor,
        eventCounts: state.eventCounts,
        terminalTail: state.terminalTail
      },
      diagnostics: {
        exportedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        last: error && error.last ? error.last : undefined,
        latest: error && error.latest ? error.latest : undefined,
        requestLog: state.requestLog
      },
      preparation: prepared ? { managementKeyConfigured: Boolean(prepared.managementKey) } : null,
      children: [state.relayHandle].filter(Boolean).map(summarizeChild)
    };
    const diagnosticsFile = writeDiagnosticsFile(options.diagnosticsFile, report, deps);
    if (diagnosticsFile) report.diagnostics.file = diagnosticsFile;
    return report;
  } finally {
    if (!stop && state.runId && state.managementKey) {
      await stopSession(state).catch(() => null);
    }
    await stopChild(state.relayHandle);
    await closeBrokerHandle(state.brokerHandle);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`[aih] ${String(error && error.message || error)}`);
    console.error('Usage: node scripts/fabric-real-session-recovery-smoke.js [--broker-endpoint URL] [--management-key-file PATH]');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runSessionRecoverySmoke(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-real-session-recovery-smoke] ${String(error && error.stack || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPromptParts,
  parseArgs,
  runSessionRecoverySmoke,
  waitForMarker,
  writeDiagnosticsFile
};
