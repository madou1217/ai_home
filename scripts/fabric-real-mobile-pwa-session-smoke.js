#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadPlaywright } = require('./playwright-require');

const {
  buildDeviceScopes,
  resolveExistingNodeManagementKey,
  resolveExistingHostHome
} = require('./fabric-real-outbound-relay-smoke');

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_NODE_ID = 'm4-8-7-mobile-node';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_SESSION_TIMEOUT_MS = 120000;
const DEFAULT_ARTIFACT_THRESHOLD = 256;
const OUTPUT_TAIL_BYTES = 6000;

function showHelp() {
  console.log(`AIH Fabric real mobile/PWA session smoke

Usage:
  npx --yes --package playwright node scripts/fabric-real-mobile-pwa-session-smoke.js [options]

Options:
  --endpoint <url>      AWS/current Control Plane endpoint, default ${DEFAULT_ENDPOINT}.
  --client-endpoint <url>
                        Device/client API endpoint. Defaults to --endpoint.
  --host-home <dir>    Host home used by local relay/runtime, default AIH_HOST_HOME/HOME.
  --node-id <id>       Remote node id, default ${DEFAULT_NODE_ID}.
  --session-provider <provider>
                        Native provider, default codex.
  --session-account <id>
                        Native provider account id, default 1.
  --session-model <model>
                        Native model, default gpt-5.5.
  --session-project <path>
                        Project path for the native session, default cwd.
  --existing-node       Use an already registered Fabric node instead of creating
                        a temporary legacy relay node.
  --timeout-ms <n>     Relay/device wait timeout, default ${DEFAULT_TIMEOUT_MS}.
  --session-timeout-ms <n>
                        Mobile browser session wait timeout, default ${DEFAULT_SESSION_TIMEOUT_MS}.
  --headed             Show the browser window.
  -h, --help           Show this help.

The script creates real AWS node/device invites over HTTP, starts a real local
outbound relay, opens a real Chromium mobile viewport, and executes the session
client flow from inside the browser page with fetch + bearer token. It does not
open a new product port and does not use old VPS targets.

When --existing-node is set, the script only creates a real mobile device pair
and targets the provided Fabric node id. This is the current AWS node inventory
path and does not create a temporary legacy relay node.
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

function parsePositiveInteger(value, flag, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeNodeId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]{1,63}$/.test(id) ? id : '';
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    endpoint: DEFAULT_ENDPOINT,
    clientEndpoint: '',
    hostHome: '',
    nodeId: DEFAULT_NODE_ID,
    sessionProvider: 'codex',
    sessionAccountId: '1',
    sessionModel: 'gpt-5.5',
    sessionProjectPath: process.cwd(),
    existingNode: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    headed: false
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
    if (token === '--headed') {
      options.headed = true;
      index += 1;
      continue;
    }
    if (token === '--existing-node') {
      options.existingNode = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--client-endpoint' || token.startsWith('--client-endpoint=')) {
      const next = readOptionValue(argv, index, '--client-endpoint');
      options.clientEndpoint = normalizeHttpEndpoint(next.value, '--client-endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--host-home' || token.startsWith('--host-home=')) {
      const next = readOptionValue(argv, index, '--host-home');
      options.hostHome = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--session-provider' || token.startsWith('--session-provider=')) {
      const next = readOptionValue(argv, index, '--session-provider');
      options.sessionProvider = String(next.value || '').trim().toLowerCase();
      index += next.consumed;
      continue;
    }
    if (token === '--session-account' || token.startsWith('--session-account=')) {
      const next = readOptionValue(argv, index, '--session-account');
      options.sessionAccountId = String(next.value || '').trim();
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
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 1000, 180000);
      index += next.consumed;
      continue;
    }
    if (token === '--session-timeout-ms' || token.startsWith('--session-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--session-timeout-ms');
      options.sessionTimeoutMs = parsePositiveInteger(next.value, '--session-timeout-ms', DEFAULT_SESSION_TIMEOUT_MS, 1000, 240000);
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  options.nodeId = normalizeNodeId(options.nodeId);
  if (!options.help && !options.nodeId) throw new Error('--node-id must match AIH remote node id rules');
  if (!options.clientEndpoint) options.clientEndpoint = options.endpoint;
  return options;
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

function randomSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

function appendTail(current, chunk, maxBytes = OUTPUT_TAIL_BYTES) {
  const next = `${String(current || '')}${String(chunk || '')}`;
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) return next;
  return next.slice(Math.max(0, next.length - maxBytes));
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
      handle.stdout = appendTail(handle.stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      handle.stderr = appendTail(handle.stderr, chunk);
    });
    child.on('error', (error) => {
      handle.exited = true;
      handle.stderr = appendTail(handle.stderr, String(error && error.message || error));
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

async function stopChild(handle) {
  if (!handle || handle.exited) return;
  try {
    handle.child.kill('SIGTERM');
  } catch (_error) {}
  await Promise.race([
    handle.exitPromise,
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  if (!handle.exited) {
    try {
      handle.child.kill('SIGKILL');
    } catch (_error) {}
    await Promise.race([
      handle.exitPromise,
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
  }
}

function summarizeChild(handle) {
  return {
    label: handle.label,
    pid: handle.child && handle.child.pid || null,
    exited: Boolean(handle.exited),
    exitCode: handle.exitCode,
    signal: handle.signal || '',
    stdoutTail: handle.stdout || '',
    stderrTail: handle.stderr || ''
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

async function createAwsInviteUrls(input = {}, deps = {}) {
  const endpoint = String(input.endpoint || '').replace(/\/+$/, '');
  const nodeId = normalizeNodeId(input.nodeId);
  if (!endpoint || !nodeId) throw new Error('invalid_invite_input');
  const nodeInvite = await fetchJson(`${endpoint}/v0/webui/nodes/invites`, {
    method: 'POST',
    timeoutMs: deps.timeoutMs || 10000,
    fetchImpl: deps.fetchImpl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId,
      name: 'M4 8.7 Mobile PWA Smoke Node',
      controlEndpoint: endpoint,
      transportKind: 'relay',
      preferredTransports: ['relay'],
      capabilities: ['status', 'sessions'],
      bootstrapTarget: 'linux'
    })
  });
  const deviceInvite = await fetchJson(`${endpoint}/v0/webui/control-plane/devices/invites`, {
    method: 'POST',
    timeoutMs: deps.timeoutMs || 10000,
    fetchImpl: deps.fetchImpl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'M4 8.7 Mobile PWA Smoke Device',
      controlEndpoint: endpoint,
      scopes: buildDeviceScopes()
    })
  });
  const joinUrl = String(nodeInvite.body && nodeInvite.body.joinUrl || '');
  const pairUrl = String(deviceInvite.body && (deviceInvite.body.pairUrl || deviceInvite.body.webPairUrl) || '');
  if (nodeInvite.status !== 200 || nodeInvite.body && nodeInvite.body.ok === false || !joinUrl) {
    const error = new Error('node_invite_create_failed');
    error.status = nodeInvite.status;
    error.body = nodeInvite.body;
    throw error;
  }
  if (deviceInvite.status !== 200 || deviceInvite.body && deviceInvite.body.ok === false || !pairUrl) {
    const error = new Error('device_invite_create_failed');
    error.status = deviceInvite.status;
    error.body = deviceInvite.body;
    throw error;
  }
  return {
    joinUrl,
    pairUrl,
    nodeInviteId: String(nodeInvite.body && nodeInvite.body.invite && nodeInvite.body.invite.id || ''),
    deviceInviteId: String(deviceInvite.body && deviceInvite.body.invite && deviceInvite.body.invite.id || '')
  };
}

async function createDeviceInviteUrl(input = {}, deps = {}) {
  const endpoint = String(input.endpoint || '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('invalid_device_invite_input');
  const deviceInvite = await fetchJson(`${endpoint}/v0/webui/control-plane/devices/invites`, {
    method: 'POST',
    timeoutMs: deps.timeoutMs || 10000,
    fetchImpl: deps.fetchImpl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Mobile PWA Current Node Smoke Device',
      controlEndpoint: endpoint,
      scopes: buildDeviceScopes()
    })
  });
  const pairUrl = String(deviceInvite.body && (deviceInvite.body.pairUrl || deviceInvite.body.webPairUrl) || '');
  if (deviceInvite.status !== 200 || deviceInvite.body && deviceInvite.body.ok === false || !pairUrl) {
    const error = new Error('device_invite_create_failed');
    error.status = deviceInvite.status;
    error.body = deviceInvite.body;
    throw error;
  }
  return {
    pairUrl,
    deviceInviteId: String(deviceInvite.body && deviceInvite.body.invite && deviceInvite.body.invite.id || '')
  };
}

async function prepareDeviceViaApi(input = {}, deps = {}) {
  const pair = await fetchJson(input.pairUrl, {
    method: 'POST',
    timeoutMs: deps.timeoutMs || 10000,
    fetchImpl: deps.fetchImpl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device: {
        id: 'mobile-pwa-current-node-smoke-device',
        name: 'Mobile PWA Current Node Smoke Device',
        platform: 'mobile-pwa-browser'
      }
    })
  });
  const result = pair.body && pair.body.result && typeof pair.body.result === 'object'
    ? pair.body.result
    : {};
  const token = String(result.token || pair.body && pair.body.token || '');
  if (pair.status !== 200 || pair.body && pair.body.ok === false || !token) {
    const error = new Error('device_pair_failed');
    error.status = pair.status;
    error.body = pair.body;
    throw error;
  }
  return {
    device: result.device || null,
    deviceToken: token,
    preparation: {
      mode: 'api',
      pairStatus: pair.status
    }
  };
}

async function prepareNodeAndDeviceViaApi(input = {}, deps = {}) {
  const nodeManagementKey = input.nodeManagementKey || randomSecret('node');
  const join = await fetchJson(input.joinUrl, {
    method: 'POST',
    timeoutMs: deps.timeoutMs || 10000,
    fetchImpl: deps.fetchImpl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      node: {
        id: input.nodeId,
        name: 'M4 8.7 Mobile PWA Smoke Node',
        transportKind: 'relay',
        managementKey: nodeManagementKey
      }
    })
  });
  if (join.status !== 200 || join.body && join.body.ok === false) {
    const error = new Error('node_join_failed');
    error.status = join.status;
    error.body = join.body;
    throw error;
  }

  const pair = await fetchJson(input.pairUrl, {
    method: 'POST',
    timeoutMs: deps.timeoutMs || 10000,
    fetchImpl: deps.fetchImpl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device: {
        id: 'm4-8-7-mobile-pwa-smoke-device',
        name: 'M4 8.7 Mobile PWA Smoke Device',
        platform: 'mobile-pwa-browser'
      }
    })
  });
  const result = pair.body && pair.body.result && typeof pair.body.result === 'object'
    ? pair.body.result
    : {};
  const token = String(result.token || pair.body && pair.body.token || '');
  if (pair.status !== 200 || pair.body && pair.body.ok === false || !token) {
    const error = new Error('device_pair_failed');
    error.status = pair.status;
    error.body = pair.body;
    throw error;
  }

  return {
    nodeManagementKey,
    node: join.body && (join.body.node || join.body.result && join.body.result.node) || null,
    device: result.device || null,
    deviceToken: token,
    preparation: {
      mode: 'api',
      joinStatus: join.status,
      pairStatus: pair.status
    }
  };
}

async function waitForDeviceNodeOnline(endpoint, token, nodeId, timeoutMs, deps = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await fetchJson(`${endpoint}/v0/node-rpc/device-nodes`, {
      timeoutMs: 3000,
      fetchImpl: deps.fetchImpl,
      headers: { authorization: `Bearer ${token}` }
    }).catch((error) => ({
      status: 0,
      ok: false,
      body: { ok: false, error: String(error && error.message || error || 'device_nodes_failed') }
    }));
    const nodes = latest.body && latest.body.result && Array.isArray(latest.body.result.nodes)
      ? latest.body.result.nodes
      : [];
    const node = nodes.find((entry) => entry && entry.id === nodeId);
    if (node && node.connection && node.connection.status === 'online') {
      return { response: latest, node };
    }
    await sleep(250);
  }
  const error = new Error('relay_online_timeout');
  error.code = 'relay_online_timeout';
  error.latest = latest;
  throw error;
}

function buildPromptParts(prefix) {
  const marker = `${prefix}_20260628`;
  return {
    marker,
    prompt: `Reply with exactly this marker and no other text: ${marker}`
  };
}

function buildMobileBrowserInput(options, deviceToken) {
  const start = buildPromptParts('AIH_MOBILE_PWA_START_OK');
  const message = buildPromptParts('AIH_MOBILE_PWA_MESSAGE_OK');
  return {
    endpoint: options.clientEndpoint,
    nodeId: options.nodeId,
    deviceToken,
    session: {
      provider: options.sessionProvider,
      accountId: options.sessionAccountId,
      model: options.sessionModel,
      projectPath: options.sessionProjectPath,
      artifactThreshold: DEFAULT_ARTIFACT_THRESHOLD,
      startPrompt: start.prompt,
      startMarker: start.marker,
      messagePrompt: message.prompt,
      messageMarker: message.marker,
      timeoutMs: options.sessionTimeoutMs
    }
  };
}

async function mobileBrowserClientEvaluate(input) {
  const endpoint = String(input.endpoint || '').replace(/\/+$/, '');
  const token = String(input.deviceToken || '');
  const nodeId = String(input.nodeId || '');
  const session = input.session || {};
  const phaseTimeoutMs = Math.max(1000, Number(session.timeoutMs) || 60000);
  const requestTimeoutMs = Math.max(5000, Math.min(15000, Math.floor(phaseTimeoutMs / 2)));
  let cursor = 0;
  let terminalTail = '';
  let runId = '';
  const eventCounts = {};
  const artifactIds = new Set();
  const artifacts = [];
  const requestLog = [];
  const approvalRequests = [];

  function trace(stage, details = {}) {
    if (typeof window === 'undefined') return;
    if (typeof console === 'undefined' || typeof console.info !== 'function') return;
    try {
      console.info(`[aih-mobile-smoke] ${stage} ${JSON.stringify(details).slice(0, 600)}`);
    } catch (_error) {
      console.info(`[aih-mobile-smoke] ${stage}`);
    }
  }

  function append(current, value, maxLength) {
    const next = `${String(current || '')}${String(value || '')}`;
    return next.length > maxLength ? next.slice(next.length - maxLength) : next;
  }

  function countEvents(events) {
    (Array.isArray(events) ? events : []).forEach((event) => {
      const type = String(event && event.type || 'unknown');
      eventCounts[type] = (eventCounts[type] || 0) + 1;
    });
  }

  function appendTerminalEvents(events) {
    (Array.isArray(events) ? events : []).forEach((event) => {
      if (!event || typeof event !== 'object') return;
      const type = String(event.type || '');
      const parts = [];
      if (type === 'terminal-output') parts.push(event.text || '');
      if (typeof event.delta === 'string') parts.push(event.delta);
      if (typeof event.content === 'string') parts.push(event.content);
      if (typeof event.text === 'string' && type !== 'terminal-output') parts.push(event.text);
      parts.filter(Boolean).forEach((part) => {
        terminalTail = append(terminalTail, part, 8000);
      });
    });
  }

  function collectArtifactRefs(events) {
    const refs = [];
    (Array.isArray(events) ? events : []).forEach((event) => {
      if (!event || event.type !== 'artifact_ref') return;
      const artifact = event.artifact && typeof event.artifact === 'object' ? event.artifact : {};
      const artifactId = String(event.artifactId || event.artifact_id || artifact.artifactId || artifact.artifact_id || '').trim();
      if (!artifactId || artifactIds.has(artifactId)) return;
      artifactIds.add(artifactId);
      refs.push({ artifactId });
    });
    return refs;
  }

  function pushRequestLog(entry) {
    const last = requestLog[requestLog.length - 1];
    if (last
      && last.path === entry.path
      && last.method === entry.method
      && last.status === entry.status
      && last.ok === entry.ok
      && last.rpc === entry.rpc
      && last.error === entry.error) {
      last.repeat = Number(last.repeat || 1) + 1;
      return;
    }
    requestLog.push({ ...entry, repeat: 1 });
  }

  async function request(path, options = {}) {
    const method = options.method || 'GET';
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), Number(options.timeoutMs) || requestTimeoutMs)
      : null;
    try {
      trace('request:start', { method, path });
      const response = await fetch(`${endpoint}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body ? { 'content-type': 'application/json' } : {})
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller ? controller.signal : undefined
      });
      const text = await response.text();
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch (_error) {
        body = { parseError: true, raw: text };
      }
      pushRequestLog({
        path,
        method,
        status: response.status,
        ok: response.ok,
        rpc: String(body && body.rpc || ''),
        error: String(body && body.error || '')
      });
      trace('request:done', { method, path, status: response.status, ok: response.ok });
      return { status: response.status, ok: response.ok, body };
    } catch (error) {
      pushRequestLog({
        path,
        method,
        status: 0,
        ok: false,
        rpc: '',
        error: String(error && (error.name || error.message) || error || 'browser_fetch_failed')
      });
      trace('request:failed', { method, path, error: String(error && (error.name || error.message) || error || 'browser_fetch_failed') });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fetchArtifacts(events) {
    const refs = collectArtifactRefs(events);
    for (const ref of refs) {
      const response = await request(`/v0/node-rpc/device-node-session-artifact?nodeId=${encodeURIComponent(nodeId)}&artifactId=${encodeURIComponent(ref.artifactId)}`);
      const result = response.body && response.body.result || {};
      if (response.status === 200 && result.content) {
        terminalTail = append(terminalTail, result.content, 8000);
      }
      artifacts.push({
        artifactId: ref.artifactId,
        status: response.status,
        ok: response.status === 200 && response.body && response.body.ok !== false,
        byteLength: Number(result.artifact && result.artifact.byteLength) || 0
      });
    }
  }

  async function readEvents(fromCursor) {
    const response = await request(`/v0/node-rpc/device-node-session-run-events?nodeId=${encodeURIComponent(nodeId)}&runId=${encodeURIComponent(runId)}&cursor=${encodeURIComponent(String(fromCursor || 0))}&limit=100`);
    const result = response.body && response.body.result || {};
    const events = Array.isArray(result.events) ? result.events : [];
    countEvents(events);
    appendTerminalEvents(events);
    events.forEach((event) => {
      if (!event || event.type !== 'approval_request') return;
      const approvalId = String(event.approvalId || event.approval_id || event.promptId || event.prompt_id || '').trim();
      if (!approvalId) return;
      approvalRequests.push({ approvalId, cursor: Number(event.cursor) || 0 });
    });
    await fetchArtifacts(events);
    cursor = Math.max(cursor, Number(result.cursor) || cursor);
    return {
      status: response.status,
      ok: response.status === 200 && response.body && response.body.ok !== false,
      cursor: Number(result.cursor) || fromCursor || 0,
      completed: result.completed === true || result.status === 'completed',
      events
    };
  }

  async function readEventsBestEffort(fromCursor) {
    try {
      return await readEvents(fromCursor);
    } catch (error) {
      pushRequestLog({
        path: '/v0/node-rpc/device-node-session-run-events',
        method: 'GET',
        status: 0,
        ok: false,
        rpc: '',
        error: String(error && error.message || error || 'read_events_failed')
      });
      return null;
    }
  }

  function commandSummary(response) {
    const result = response && response.body && response.body.result || {};
    return {
      status: Number(response && response.status) || 0,
      accepted: Boolean(result.accepted),
      type: result.type || '',
      scope: result.scope || '',
      command: result.command || '',
      decision: result.decision || '',
      skipped: result.skipped === true,
      reason: result.reason || '',
      approvalId: result.approvalId || '',
      runId: result.runId || '',
      sessionRef: result.sessionRef || '',
      cursor: Number(result.cursor) || 0,
      resumed: result.resumed === true,
      resumedFromRunId: result.resumedFromRunId || '',
      provider: result.provider || '',
      statusText: result.status || '',
      error: String(response && response.body && response.body.error || '')
    };
  }

  async function stopRun(stage) {
    if (!runId) {
      return {
        status: 0,
        accepted: false,
        type: '',
        scope: '',
        command: '',
        decision: '',
        skipped: true,
        reason: 'run_not_started',
        approvalId: '',
        error: ''
      };
    }
    try {
      const response = await request('/v0/node-rpc/device-node-session-command', {
        method: 'POST',
        body: {
          nodeId,
          type: 'stop',
          sessionId: runId,
          scope: 'run',
          idempotencyKey: `mobile-stop-${runId}-${String(stage || 'failed').replace(/[^a-z0-9_.-]/gi, '-')}`
        }
      });
      return commandSummary(response);
    } catch (error) {
      return {
        status: 0,
        accepted: false,
        type: 'stop',
        scope: 'run',
        command: '',
        decision: '',
        skipped: false,
        reason: '',
        approvalId: '',
        error: String(error && error.message || error || 'stop_failed')
      };
    }
  }

  function failureReport(stage, reason, extra = {}) {
    return {
      ok: false,
      failureStage: stage,
      failureReason: reason,
      viewport,
      runIdPresent: Boolean(runId),
      startStatus: Number(extra.startStatus) || 0,
      markers: {
        start: Boolean(extra.startMarkerFound),
        message: Boolean(extra.messageMarkerFound)
      },
      commands: extra.commands || {},
      final: {
        cursor,
        eventCounts
      },
      artifacts: {
        refs: artifacts.length,
        fetched: artifacts.filter((item) => item.ok).length,
        bytes: artifacts.reduce((sum, item) => sum + (Number(item.byteLength) || 0), 0)
      },
      requestLog,
      terminalTail,
      ...extra
    };
  }

  async function waitForMarker(marker, fromCursor) {
    let resumeCursor = Number(fromCursor) || cursor;
    let duplicateEvents = 0;
    const deadline = Date.now() + phaseTimeoutMs;
    while (Date.now() < deadline) {
      let batch;
      try {
        batch = await readEvents(resumeCursor);
      } catch (error) {
        return {
          found: false,
          cursor,
          duplicateEvents,
          failed: true,
          error: String(error && (error.name || error.message) || error || 'read_events_failed')
        };
      }
      duplicateEvents += batch.events.filter((event) => Number(event && event.cursor) <= resumeCursor).length;
      resumeCursor = Math.max(resumeCursor, batch.cursor);
      if (terminalTail.includes(marker)) {
        return {
          found: true,
          cursor,
          duplicateEvents
        };
      }
      if (batch.completed) {
        return {
          found: false,
          cursor,
          duplicateEvents,
          completed: true
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return {
      found: false,
      cursor,
      duplicateEvents
    };
  }

  async function waitForCompletion(fromCursor) {
    let resumeCursor = Number(fromCursor) || cursor;
    let duplicateEvents = 0;
    const deadline = Date.now() + phaseTimeoutMs;
    while (Date.now() < deadline) {
      let batch;
      try {
        batch = await readEvents(resumeCursor);
      } catch (error) {
        return {
          completed: false,
          cursor,
          duplicateEvents,
          failed: true,
          error: String(error && (error.name || error.message) || error || 'read_events_failed')
        };
      }
      duplicateEvents += batch.events.filter((event) => Number(event && event.cursor) <= resumeCursor).length;
      resumeCursor = Math.max(resumeCursor, batch.cursor);
      if (batch.completed) {
        return {
          completed: true,
          cursor,
          duplicateEvents
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return {
      completed: false,
      cursor,
      duplicateEvents
    };
  }

  const viewport = {
    width: typeof innerWidth === 'number' ? innerWidth : 0,
    height: typeof innerHeight === 'number' ? innerHeight : 0,
    devicePixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : 0,
    maxTouchPoints: typeof navigator !== 'undefined' ? Number(navigator.maxTouchPoints) || 0 : 0,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  };
  if (typeof document !== 'undefined' && document.body) {
    document.body.innerHTML = '<main><h1>AIH Mobile PWA Smoke</h1><pre id="status">running</pre></main>';
  }

  const start = await request('/v0/node-rpc/device-node-session-start', {
    method: 'POST',
    body: {
      nodeId,
      provider: session.provider,
      accountId: session.accountId,
      model: session.model,
      projectPath: session.projectPath,
      prompt: session.startPrompt,
      artifactThreshold: session.artifactThreshold,
      cols: 96,
      rows: 28
    }
  });
  runId = String(start.body && start.body.result && start.body.result.runId || '');
  trace('session:start', { status: start.status, runIdPresent: Boolean(runId) });
  if (start.status !== 200 || !runId) {
    return failureReport('session_start', 'session_start_failed', {
      startStatus: start.status,
      startError: String(start.body && start.body.error || '')
    });
  }

  const startMarker = await waitForMarker(session.startMarker, cursor);
  trace('marker:start', { found: startMarker.found, failed: startMarker.failed === true, completed: startMarker.completed === true, cursor });
  if (!startMarker.found) {
    const stop = await stopRun('start-marker-missing');
    await readEventsBestEffort(cursor);
    return failureReport('start_marker', startMarker.failed ? 'start_marker_events_failed' : 'start_marker_not_found', {
      startStatus: start.status,
      startMarkerFound: false,
      startMarkerCursor: startMarker.cursor,
      markerCompleted: startMarker.completed === true,
      markerError: startMarker.error || '',
      commands: { stop }
    });
  }

  const attach = await request('/v0/node-rpc/device-node-session-attach', {
    method: 'POST',
    body: {
      nodeId,
      sessionId: runId,
      cursor
    }
  });
  if (attach.status !== 200 || attach.body && attach.body.ok === false) {
    const stop = await stopRun('attach-failed');
    await readEventsBestEffort(cursor);
    return failureReport('attach', 'session_attach_failed', {
      startStatus: start.status,
      startMarkerFound: true,
      attachStatus: attach.status,
      attach: {
        status: attach.status,
        ok: attach.ok,
        rpc: String(attach.body && attach.body.rpc || ''),
        error: String(attach.body && attach.body.error || '')
      },
      commands: { stop }
    });
  }

  const disconnectedCursor = cursor;
  const messageSourceRunId = runId;
  await new Promise((resolve) => setTimeout(resolve, 750));

  const messageAck = await request('/v0/node-rpc/device-node-session-command', {
    method: 'POST',
    body: {
      nodeId,
      type: 'message',
      sessionId: runId,
      text: session.messagePrompt,
      idempotencyKey: `mobile-message-${runId}`
    }
  });
  if (messageAck.status !== 200 || messageAck.body && messageAck.body.ok === false) {
    const stop = await stopRun('message-failed');
    await readEventsBestEffort(cursor);
    return failureReport('message_command', 'message_command_failed', {
      startStatus: start.status,
      startMarkerFound: true,
      messageMarkerFound: false,
      attachStatus: attach.status,
      disconnectedCursor,
      commands: {
        message: commandSummary(messageAck),
        stop
      }
    });
  }

  const messageResult = messageAck.body && messageAck.body.result || {};
  const messageAckRunId = String(messageResult.runId || '').trim();
  const messageResumed = messageResult.resumed === true && Boolean(messageAckRunId);
  const messageRun = {
    resumed: messageResumed,
    fromRunId: messageSourceRunId,
    runId: messageResumed ? messageAckRunId : messageSourceRunId,
    cursor: Number(messageResult.cursor) || 0,
    sessionRef: String(messageResult.sessionRef || '')
  };
  if (messageResumed) {
    runId = messageAckRunId;
    cursor = messageRun.cursor;
  }
  const messageResumeFromCursor = messageResumed ? cursor : disconnectedCursor;
  const messageResume = await waitForMarker(session.messageMarker, messageResumeFromCursor);
  trace('marker:message', { found: messageResume.found, failed: messageResume.failed === true, completed: messageResume.completed === true, cursor });
  if (!messageResume.found) {
    const stop = await stopRun('message-marker-missing');
    await readEventsBestEffort(cursor);
    return failureReport('message_marker', messageResume.failed ? 'message_marker_events_failed' : 'message_marker_not_found', {
      startStatus: start.status,
      startMarkerFound: true,
      messageMarkerFound: false,
      markerCompleted: messageResume.completed === true,
      markerError: messageResume.error || '',
      attachStatus: attach.status,
      disconnectedCursor,
      messageRun,
      resumedCursor: messageResume.cursor,
      reconnect: {
        resumedFromCursor: messageResumeFromCursor,
        resumedFromRunId: messageRun.fromRunId,
        resumedRunId: messageRun.runId,
        duplicateEvents: messageResume.duplicateEvents,
        markerFoundAfterResume: false
      },
      commands: {
        message: commandSummary(messageAck),
        stop
      }
    });
  }

  const messageCompletion = await waitForCompletion(cursor);
  if (!messageCompletion.completed) {
    const stop = await stopRun('message-completion-missing');
    await readEventsBestEffort(cursor);
    return failureReport('message_completion', messageCompletion.failed ? 'message_completion_events_failed' : 'message_run_not_completed', {
      startStatus: start.status,
      startMarkerFound: true,
      messageMarkerFound: true,
      markerError: messageCompletion.error || '',
      attachStatus: attach.status,
      disconnectedCursor,
      messageRun,
      resumedCursor: messageResume.cursor,
      reconnect: {
        resumedFromCursor: messageResumeFromCursor,
        resumedFromRunId: messageRun.fromRunId,
        resumedRunId: messageRun.runId,
        duplicateEvents: messageResume.duplicateEvents,
        markerFoundAfterResume: true
      },
      messageCompletion: {
        completed: false,
        cursor: messageCompletion.cursor,
        duplicateEvents: messageCompletion.duplicateEvents
      },
      commands: {
        message: commandSummary(messageAck),
        stop
      }
    });
  }

  const slashAck = await request('/v0/node-rpc/device-node-session-command', {
    method: 'POST',
    body: {
      nodeId,
      type: 'slash',
      sessionId: runId,
      command: '/status',
      idempotencyKey: `mobile-slash-${runId}`
    }
  });
  const slashUnsupported = slashAck.status === 400
    && String(slashAck.body && slashAck.body.error || '') === 'headless_session_slash_unsupported';
  const slashResult = slashAck.body && slashAck.body.result || {};
  if (slashAck.status !== 200 || slashAck.body && slashAck.body.ok === false || slashResult.type !== 'slash') {
    const stop = await stopRun('slash-failed');
    await readEventsBestEffort(cursor);
    return failureReport('slash_command', slashUnsupported ? 'headless_session_slash_unsupported' : 'slash_command_failed', {
      startStatus: start.status,
      startMarkerFound: true,
      messageMarkerFound: true,
      attachStatus: attach.status,
      disconnectedCursor,
      messageRun,
      resumedCursor: messageResume.cursor,
      reconnect: {
        resumedFromCursor: messageResumeFromCursor,
        resumedFromRunId: messageRun.fromRunId,
        resumedRunId: messageRun.runId,
        duplicateEvents: messageResume.duplicateEvents,
        markerFoundAfterResume: true
      },
      commands: {
        message: commandSummary(messageAck),
        slash: {
          ...commandSummary(slashAck),
          unsupported: slashUnsupported
        },
        stop
      }
    });
  }

  await readEvents(cursor);
  const approvalRequest = approvalRequests[approvalRequests.length - 1] || null;
  const approvalAck = approvalRequest
    ? await request('/v0/node-rpc/device-node-session-command', {
      method: 'POST',
      body: {
        nodeId,
        type: 'approval_response',
        sessionId: runId,
        approvalId: approvalRequest.approvalId,
        decision: 'approve',
        response: '1',
        idempotencyKey: `mobile-approval-${runId}`
      }
    })
    : {
      status: 0,
      ok: true,
      body: {
        result: {
          accepted: false,
          type: 'approval_response',
          decision: '',
          skipped: true,
          reason: 'no_approval_request'
        }
      }
    };
  const stop = await stopRun('completed');
  const finalEvents = await readEvents(cursor);

  const commandResults = {
    message: messageAck.body && messageAck.body.result || {},
    slash: slashAck.body && slashAck.body.result || {},
    approval: approvalAck.body && approvalAck.body.result || {},
    stop
  };
  const ok = startMarker.found
    && attach.status === 200
    && messageAck.status === 200
    && messageResume.found
    && messageResume.duplicateEvents === 0
    && slashAck.status === 200
    && commandResults.slash.type === 'slash'
    && commandResults.approval.type === 'approval_response'
    && (commandResults.approval.skipped === true || approvalAck.status === 200)
    && stop.status === 200
    && commandResults.stop.type === 'stop';

  return {
    ok,
    viewport,
    runIdPresent: Boolean(runId),
    startStatus: start.status,
    attachStatus: attach.status,
    attach: {
      status: attach.status,
      ok: attach.ok,
      rpc: String(attach.body && attach.body.rpc || ''),
      error: String(attach.body && attach.body.error || '')
    },
    disconnectedCursor,
    messageRun,
    resumedCursor: messageResume.cursor,
    messageCompletion: {
      completed: messageCompletion.completed,
      cursor: messageCompletion.cursor,
      duplicateEvents: messageCompletion.duplicateEvents
    },
    reconnect: {
      resumedFromCursor: messageResumeFromCursor,
      resumedFromRunId: messageRun.fromRunId,
      resumedRunId: messageRun.runId,
      duplicateEvents: messageResume.duplicateEvents,
      markerFoundAfterResume: messageResume.found
    },
    markers: {
      start: startMarker.found,
      message: messageResume.found
    },
    commands: {
      message: {
        ...commandSummary(messageAck),
        status: messageAck.status,
        accepted: Boolean(commandResults.message.accepted),
        type: commandResults.message.type || ''
      },
      slash: {
        status: slashAck.status,
        accepted: Boolean(commandResults.slash.accepted),
        type: commandResults.slash.type || '',
        command: commandResults.slash.command || '',
        unsupported: slashUnsupported,
        error: String(slashAck.body && slashAck.body.error || '')
      },
      approval: {
        status: approvalAck.status,
        accepted: Boolean(commandResults.approval.accepted),
        type: commandResults.approval.type || '',
        decision: commandResults.approval.decision || '',
        skipped: commandResults.approval.skipped === true,
        reason: commandResults.approval.reason || '',
        approvalId: commandResults.approval.approvalId || (approvalRequest && approvalRequest.approvalId) || ''
      },
      stop: {
        status: stop.status,
        accepted: Boolean(stop.accepted),
        type: stop.type || '',
        scope: stop.scope || '',
        error: stop.error || ''
      }
    },
    final: {
      completed: finalEvents.completed,
      cursor,
      eventCounts
    },
    artifacts: {
      refs: artifacts.length,
      fetched: artifacts.filter((item) => item.ok).length,
      bytes: artifacts.reduce((sum, item) => sum + (Number(item.byteLength) || 0), 0)
    },
    requestLog,
    terminalTail
  };
}

async function runMobileBrowserClient(input = {}, deps = {}) {
  const playwright = deps.playwright || loadPlaywright();
  const browser = await playwright.chromium.launch({
    headless: !input.headed
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 AIH-Mobile-PWA-Smoke'
    });
    const page = await context.newPage();
    const consoleMessages = [];
    const pageErrors = [];
    const networkEvents = [];
    const pushNetworkEvent = (event) => {
      networkEvents.push(event);
      if (networkEvents.length > 80) networkEvents.shift();
    };
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() });
      if (consoleMessages.length > 80) consoleMessages.shift();
    });
    page.on('pageerror', (error) => {
      pageErrors.push(String(error && error.message || error));
    });
    page.on('request', (request) => {
      pushNetworkEvent({ type: 'request', method: request.method(), url: request.url() });
    });
    page.on('response', (response) => {
      pushNetworkEvent({ type: 'response', status: response.status(), url: response.url() });
    });
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      pushNetworkEvent({
        type: 'requestfailed',
        method: request.method(),
        url: request.url(),
        error: failure && failure.errorText || ''
      });
    });
    await page.goto('data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Cmeta%20name%3Dviewport%20content%3D%22width%3Ddevice-width%2Cinitial-scale%3D1%22%3E%3Ctitle%3EAIH%20Mobile%20PWA%20Smoke%3C%2Ftitle%3E%3Cbody%3E%3C%2Fbody%3E', {
      waitUntil: 'domcontentloaded'
    });
    const evaluateTimeoutMs = Math.max(5000, Number(input.browserInput && input.browserInput.session && input.browserInput.session.timeoutMs || 60000) + 10000);
    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        const error = new Error('mobile_browser_evaluate_timeout');
        error.code = 'mobile_browser_evaluate_timeout';
        reject(error);
      }, evaluateTimeoutMs);
      if (timeoutTimer && typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    });
    let result;
    try {
      result = await Promise.race([
        page.evaluate(mobileBrowserClientEvaluate, input.browserInput),
        timeoutPromise
      ]);
    } catch (error) {
      if (String(error && (error.code || error.message) || '') === 'mobile_browser_evaluate_timeout') {
        result = {
          ok: false,
          failureStage: 'browser_evaluate',
          failureReason: 'mobile_browser_evaluate_timeout',
          error: String(error && error.message || error || '')
        };
      } else {
        throw error;
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
    await context.close();
    return {
      ...result,
      browser: {
        engine: 'chromium',
        mobileViewport: '390x844',
        consoleErrors: consoleMessages.filter((item) => item.type === 'error').length,
        consoleTail: consoleMessages.slice(-20),
        pageErrors,
        networkTail: networkEvents.slice(-30)
      }
    };
  } finally {
    await browser.close();
  }
}

async function runMobilePwaSessionSmoke(options = {}, deps = {}) {
  const endpoint = String(options.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const clientEndpoint = String(options.clientEndpoint || endpoint).replace(/\/+$/, '');
  const hostHomeDir = resolveExistingHostHome(options.hostHome, process.env);
  const nodeManagement = resolveExistingNodeManagementKey(path.join(hostHomeDir, '.ai_home'));
  const repoRoot = path.resolve(__dirname, '..');
  const children = [];
  let inviteUrls = null;
  let prepared = null;
  let online = null;
  try {
    await fetchJson(`${endpoint}/readyz`, { timeoutMs: 5000, fetchImpl: deps.fetchImpl });
    if (options.existingNode === true) {
      const deviceInvite = await createDeviceInviteUrl({ endpoint }, deps);
      prepared = await prepareDeviceViaApi({ pairUrl: deviceInvite.pairUrl }, deps);
      const browserInput = buildMobileBrowserInput({
        ...options,
        endpoint,
        clientEndpoint
      }, prepared.deviceToken);
      const mobile = await runMobileBrowserClient({
        headed: options.headed,
        browserInput
      }, deps);
      return {
        ok: Boolean(mobile.ok),
        mode: 'mobile-pwa-existing-node',
        endpoint,
        client: {
          endpoint: clientEndpoint,
          viaProxy: clientEndpoint !== endpoint
        },
        nodeId: options.nodeId,
        preparation: {
          mode: 'existing-node-device-pair',
          pairStatus: prepared.preparation.pairStatus,
          deviceInviteId: deviceInvite.deviceInviteId
        },
        device: {
          paired: Boolean(prepared.deviceToken),
          scopes: buildDeviceScopes()
        },
        mobile,
        children: []
      };
    }
    inviteUrls = await createAwsInviteUrls({ endpoint, nodeId: options.nodeId }, deps);
    prepared = await prepareNodeAndDeviceViaApi({
      nodeId: options.nodeId,
      joinUrl: inviteUrls.joinUrl,
      pairUrl: inviteUrls.pairUrl,
      nodeManagementKey: nodeManagement.key
    }, deps);

    const relayArgs = [
      'node',
      'relay',
      'connect',
      endpoint,
      '--node-id',
      options.nodeId,
      '--heartbeat-ms',
      '1000',
      '--connect-timeout-ms',
      '5000',
      '--reconnect-delay-ms',
      '500',
      '--max-attempts',
      '1'
    ];
    if (nodeManagement.passCliArg) {
      relayArgs.push('--management-key', prepared.nodeManagementKey);
    }
    children.push(spawnAihProcess('relay-client', hostHomeDir, relayArgs, { repoRoot }));

    online = await waitForDeviceNodeOnline(clientEndpoint, prepared.deviceToken, options.nodeId, options.timeoutMs, deps);
    const browserInput = buildMobileBrowserInput({
      ...options,
      endpoint,
      clientEndpoint
    }, prepared.deviceToken);
    const mobile = await runMobileBrowserClient({
      headed: options.headed,
      browserInput
    }, deps);

    return {
      ok: Boolean(mobile.ok),
      mode: 'mobile-pwa-browser',
      endpoint,
      client: {
        endpoint: clientEndpoint,
        viaProxy: clientEndpoint !== endpoint
      },
      nodeId: options.nodeId,
      managementKeySource: nodeManagement.source,
      preparation: {
        mode: 'api',
        joinStatus: prepared.preparation.joinStatus,
        pairStatus: prepared.preparation.pairStatus,
        nodeInviteId: inviteUrls.nodeInviteId,
        deviceInviteId: inviteUrls.deviceInviteId
      },
      relay: {
        online: online.node && online.node.connection && online.node.connection.status === 'online',
        status: online.node && online.node.connection && online.node.connection.status || '',
        transportKind: online.node && online.node.connection && online.node.connection.transportKind || '',
        transportId: online.node && online.node.connection && online.node.connection.transportId || ''
      },
      device: {
        paired: Boolean(prepared.deviceToken),
        scopes: buildDeviceScopes()
      },
      mobile,
      children: children.map(summarizeChild)
    };
  } catch (error) {
    return {
      ok: false,
      mode: options.existingNode === true ? 'mobile-pwa-existing-node' : 'mobile-pwa-browser',
      endpoint,
      client: {
        endpoint: clientEndpoint,
        viaProxy: clientEndpoint !== endpoint
      },
      nodeId: options.nodeId,
      error: String(error && (error.code || error.message) || error || 'mobile_pwa_smoke_failed'),
      message: String(error && error.message || error || ''),
      preparation: prepared && prepared.preparation || null,
      relay: online && online.node && online.node.connection || null,
      children: children.map(summarizeChild)
    };
  } finally {
    for (const child of children.slice().reverse()) {
      await stopChild(child);
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[aih] ${String(error && error.message || error)}`);
    console.error('Usage: npx --yes --package playwright node scripts/fabric-real-mobile-pwa-session-smoke.js [--endpoint URL]');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runMobilePwaSessionSmoke(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-real-mobile-pwa-session-smoke] ${String(error && error.stack || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildMobileBrowserInput,
  createDeviceInviteUrl,
  createAwsInviteUrls,
  mobileBrowserClientEvaluate,
  parseArgs,
  prepareDeviceViaApi,
  prepareNodeAndDeviceViaApi,
  runMobilePwaSessionSmoke
};
