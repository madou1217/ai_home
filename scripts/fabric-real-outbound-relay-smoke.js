#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { upsertRemoteNode } = require('../lib/server/remote/node-registry');
const { writeRemoteSecret } = require('../lib/server/remote/secret-store');
const { readServerConfig, writeServerConfig } = require('../lib/server/server-config-store');
const {
  createControlPlaneDeviceInvite,
  consumeControlPlaneDeviceInvite
} = require('../lib/server/control-plane-device-pairing');

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_NODE_ID = 'relay-smoke-node';
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 1000;
const DEFAULT_SESSION_TIMEOUT_MS = 90000;
const OUTPUT_TAIL_BYTES = 6000;

function showHelp() {
  console.log(`AIH Fabric real outbound relay smoke

Usage:
  node scripts/fabric-real-outbound-relay-smoke.js [options]

Options:
  --node-id <id>        Remote node id, default ${DEFAULT_NODE_ID}.
  --endpoint <url>      Use an already running Control Plane endpoint instead of starting temp servers.
  --client-endpoint <url>
                         Device/client API endpoint. Defaults to --endpoint; use a broker proxy base to
                         verify client->broker->server while the relay still dials --endpoint.
  --host-home <dir>     Host home used by the running endpoint, default AIH_HOST_HOME/HOME.
  --node-join-url <url> Register the smoke node through the real node join API instead of writing endpoint files.
  --device-pair-url <url>
                         Pair the smoke device through the real Fabric device pair API instead of writing endpoint files.
  --timeout-ms <n>      End-to-end wait timeout, default ${DEFAULT_TIMEOUT_MS}.
  --control-port <n>    Control Plane port. Omit or pass 0 to auto-pick.
  --node-port <n>       Local node server port. Omit or pass 0 to auto-pick.
  --session-provider <p> Start a real native session through the relay, for example codex.
  --session-account <id> Native provider account id for session smoke.
  --session-model <m>   Optional native model for session smoke.
  --session-project <p> Optional project path for session smoke, default current working directory.
  --session-prompt <p>  Prompt sent to the remote runtime for session smoke.
  --expect-output <txt> Required marker expected from terminal output in session smoke.
  --expect-artifact    Require an artifact_ref event and fetch it through device-node-session-artifact.
  --artifact-threshold <n>
                         Optional per-session artifact threshold, min 256 bytes.
  --session-timeout-ms <n>
                         Session output wait timeout, default ${DEFAULT_SESSION_TIMEOUT_MS}.
  --keep-temp           Keep the temporary AIH_HOST_HOME directories for debugging.
  -h, --help            Show this help.

The script starts two real AIH server processes with isolated AIH_HOST_HOME
directories, starts a real "aih node relay connect" child process, pairs a
device against the Control Plane store, calls device-node endpoints over the
relay, and prints a sanitized JSON report. It never prints management keys or
device tokens.

When --endpoint is provided, the script does not start any server or allocate
ports. It writes the test node/device records into the endpoint's host home,
starts only an outbound relay client, and calls the existing endpoint. This is
the mode used for default-port VPS verification.

When --node-join-url and --device-pair-url are provided with --endpoint, the
script prepares the node/device through those real HTTP APIs instead of sharing
a host-home filesystem. This is the cross-machine mode: the node process can run
on a different host from the Control Plane as long as the endpoint URL is
reachable from the node.
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

function parseOptionalPort(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535) {
    throw new Error(`${flag} must be a TCP port or 0`);
  }
  return number;
}

function parsePositiveInteger(value, flag, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    nodeId: DEFAULT_NODE_ID,
    endpoint: '',
    clientEndpoint: '',
    hostHome: '',
    nodeJoinUrl: '',
    devicePairUrl: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    controlPort: 0,
    nodePort: 0,
    sessionProvider: '',
    sessionAccountId: '',
    sessionModel: '',
    sessionProjectPath: '',
    sessionPrompt: '',
    expectOutput: '',
    expectArtifact: false,
    sessionArtifactThreshold: 0,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    keepTemp: false
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
    if (token === '--keep-temp') {
      options.keepTemp = true;
      index += 1;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = String(next.value || '').trim();
      index += next.consumed;
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
    if (token === '--node-join-url' || token.startsWith('--node-join-url=')) {
      const next = readOptionValue(argv, index, '--node-join-url');
      options.nodeJoinUrl = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--device-pair-url' || token.startsWith('--device-pair-url=')) {
      const next = readOptionValue(argv, index, '--device-pair-url');
      options.devicePairUrl = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', undefined, 1000, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--control-port' || token.startsWith('--control-port=')) {
      const next = readOptionValue(argv, index, '--control-port');
      options.controlPort = parseOptionalPort(next.value, '--control-port');
      index += next.consumed;
      continue;
    }
    if (token === '--node-port' || token.startsWith('--node-port=')) {
      const next = readOptionValue(argv, index, '--node-port');
      options.nodePort = parseOptionalPort(next.value, '--node-port');
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
    if (token === '--session-prompt' || token.startsWith('--session-prompt=')) {
      const next = readOptionValue(argv, index, '--session-prompt');
      options.sessionPrompt = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (token === '--expect-output' || token.startsWith('--expect-output=')) {
      const next = readOptionValue(argv, index, '--expect-output');
      options.expectOutput = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--expect-artifact') {
      options.expectArtifact = true;
      index += 1;
      continue;
    }
    if (token === '--artifact-threshold' || token.startsWith('--artifact-threshold=')) {
      const next = readOptionValue(argv, index, '--artifact-threshold');
      options.sessionArtifactThreshold = parsePositiveInteger(next.value, '--artifact-threshold', undefined, 256, 1048576);
      index += next.consumed;
      continue;
    }
    if (token === '--session-timeout-ms' || token.startsWith('--session-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--session-timeout-ms');
      options.sessionTimeoutMs = parsePositiveInteger(
        next.value,
        '--session-timeout-ms',
        undefined,
        1000,
        180000
      );
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (!options.help && !/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(options.nodeId)) {
    throw new Error('--node-id must match AIH remote node id rules');
  }
  if (!options.help) {
    validateEndpointModeOptions(options);
    validateSessionSmokeOptions(options);
  }
  return options;
}

function hasSessionSmokeOptions(options = {}) {
  return Boolean(
    options.sessionProvider
    || options.sessionAccountId
    || options.sessionModel
    || options.sessionProjectPath
    || options.sessionPrompt
    || options.expectOutput
    || options.expectArtifact
    || options.sessionArtifactThreshold
  );
}

function normalizeHttpEndpoint(value, flag) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function validateEndpointModeOptions(options = {}) {
  if (options.clientEndpoint && !options.endpoint) {
    throw new Error('--client-endpoint requires --endpoint');
  }
  if (!options.endpoint) return;
  if (Number(options.controlPort) > 0 || Number(options.nodePort) > 0) {
    throw new Error('--control-port/--node-port cannot be used with --endpoint');
  }
  if (Boolean(options.nodeJoinUrl) !== Boolean(options.devicePairUrl)) {
    throw new Error('--node-join-url and --device-pair-url must be provided together');
  }
  [options.nodeJoinUrl, options.devicePairUrl].filter(Boolean).forEach((value) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('invalid protocol');
      }
    } catch (_error) {
      throw new Error('--node-join-url/--device-pair-url must be valid http(s) URLs');
    }
  });
}

function validateSessionSmokeOptions(options = {}) {
  if (!hasSessionSmokeOptions(options)) return;
  if (!options.endpoint) throw new Error('session smoke requires --endpoint');
  if (!options.sessionProvider) throw new Error('session smoke requires --session-provider');
  if (!options.sessionAccountId) throw new Error('session smoke requires --session-account');
  if (!options.sessionPrompt) throw new Error('session smoke requires --session-prompt');
  if (!options.expectOutput) throw new Error('session smoke requires --expect-output');
  if (String(options.sessionPrompt).includes(options.expectOutput)) {
    throw new Error('--session-prompt must not contain --expect-output; the marker must come from model output');
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) return reject(error);
        resolve(port);
      });
    });
    server.once('error', reject);
  });
}

async function resolvePort(requestedPort) {
  const port = Number(requestedPort || 0);
  return port > 0 ? port : getFreePort();
}

function randomSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

function appendTail(current, chunk, maxBytes = OUTPUT_TAIL_BYTES) {
  const next = `${String(current || '')}${Buffer.from(chunk).toString('utf8')}`;
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
      handle.exitCode = null;
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
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }
  const response = await fetchImpl(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    signal: options.signal || timeoutSignal(options.timeoutMs || 5000)
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await readJsonResponse(response)
  };
}

function resolveExistingHostHome(input = '', env = process.env) {
  const raw = String(input || env.AIH_HOST_HOME || env.REAL_HOME || env.HOME || os.homedir() || '').trim();
  if (!raw) {
    throw new Error('--host-home is required when no AIH_HOST_HOME/HOME is available');
  }
  return path.resolve(raw.replace(/^~(?=\/|$)/, env.HOME || os.homedir() || ''));
}

function getHostAiHomeDir(hostHomeDir) {
  return path.join(hostHomeDir, '.ai_home');
}

function buildDeviceScopes() {
  return ['control-plane:read', 'nodes:read', 'sessions:read', 'sessions:write', 'status:read'];
}

function prepareExistingEndpointStores(input) {
  const {
    aiHomeDir,
    controlEndpoint,
    nodeId,
    nodeManagementKey,
    deps = {}
  } = input;
  const fsImpl = deps.fs || fs;
  fsImpl.mkdirSync(aiHomeDir, { recursive: true });

  const node = upsertRemoteNode({
    id: nodeId,
    name: 'Existing Endpoint Relay Smoke Node',
    role: 'worker',
    endpointPolicy: 'relay',
    preferredTransports: ['relay'],
    capabilities: ['status', 'sessions'],
    tags: ['smoke', 'outbound-relay', 'existing-endpoint']
  }, { fs: fsImpl, aiHomeDir });
  writeRemoteSecret(node.authRef, { managementKey: nodeManagementKey }, {
    fs: fsImpl,
    aiHomeDir
  });

  const invite = createControlPlaneDeviceInvite({
    name: 'Existing Endpoint Relay Smoke Device',
    controlEndpoint,
    scopes: buildDeviceScopes()
  }, { fs: fsImpl, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: {
      id: 'existing-endpoint-relay-smoke-device',
      name: 'Existing Endpoint Relay Smoke Device',
      platform: process.platform
    }
  }, { fs: fsImpl, aiHomeDir });

  return {
    node,
    device: paired.device,
    deviceToken: paired.token
  };
}

function usesApiEndpointPreparation(options = {}) {
  return Boolean(options.nodeJoinUrl || options.devicePairUrl);
}

async function prepareExistingEndpointViaApi(input = {}) {
  const {
    controlEndpoint,
    nodeId,
    nodeManagementKey,
    nodeJoinUrl,
    devicePairUrl,
    deps = {}
  } = input;

  let join = null;
  try {
    join = await fetchJson(nodeJoinUrl, {
      method: 'POST',
      timeoutMs: deps.timeoutMs || 10000,
      fetchImpl: deps.fetchImpl,
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        node: {
          id: nodeId,
          name: 'API Endpoint Relay Smoke Node',
          transportKind: 'relay',
          managementKey: nodeManagementKey
        }
      })
    });
  } catch (error) {
    const next = new Error(`node_join_request_failed:${String((error && error.message) || error || 'unknown')}`);
    next.code = 'node_join_request_failed';
    next.phase = 'node_join';
    throw next;
  }
  if (join.status !== 200 || !join.body || join.body.ok === false) {
    const error = new Error('node_join_failed');
    error.code = 'node_join_failed';
    error.status = join.status;
    error.body = join.body;
    throw error;
  }

  let pair = null;
  try {
    pair = await fetchJson(devicePairUrl, {
      method: 'POST',
      timeoutMs: deps.timeoutMs || 10000,
      fetchImpl: deps.fetchImpl,
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        device: {
          id: 'api-endpoint-relay-smoke-device',
          name: 'API Endpoint Relay Smoke Device',
          platform: process.platform
        }
      })
    });
  } catch (error) {
    const next = new Error(`device_pair_request_failed:${String((error && error.message) || error || 'unknown')}`);
    next.code = 'device_pair_request_failed';
    next.phase = 'device_pair';
    throw next;
  }
  const pairResult = pair.body && pair.body.result && typeof pair.body.result === 'object'
    ? pair.body.result
    : {};
  const deviceToken = String(pairResult.token || '');
  if (pair.status !== 200 || !pair.body || pair.body.ok === false || !deviceToken) {
    const error = new Error('device_pair_failed');
    error.code = 'device_pair_failed';
    error.status = pair.status;
    error.body = pair.body;
    throw error;
  }

  return {
    node: join.body.node || (join.body.result && join.body.result.node) || null,
    device: pairResult.device || null,
    deviceToken,
    preparation: {
      mode: 'api',
      controlEndpoint,
      joinStatus: join.status,
      pairStatus: pair.status
    }
  };
}

function resolveExistingNodeManagementKey(aiHomeDir, deps = {}) {
  const fsImpl = deps.fs || fs;
  const serverConfig = readServerConfig({ fs: fsImpl, aiHomeDir });
  const configured = String(serverConfig && serverConfig.managementKey || '').trim();
  if (configured) {
    return {
      key: configured,
      source: 'server-config',
      passCliArg: false
    };
  }
  return {
    key: randomSecret('node'),
    source: 'generated',
    passCliArg: true
  };
}

function buildSessionStartPayload(options = {}) {
  const payload = {
    nodeId: options.nodeId,
    provider: options.sessionProvider,
    accountId: options.sessionAccountId,
    prompt: options.sessionPrompt,
    projectPath: options.sessionProjectPath || process.cwd(),
    model: options.sessionModel || '',
    cols: 100,
    rows: 30
  };
  if (Number(options.sessionArtifactThreshold) > 0) {
    payload.artifactThreshold = Number(options.sessionArtifactThreshold);
  }
  return payload;
}

function appendEventText(current, events) {
  let next = String(current || '');
  (Array.isArray(events) ? events : []).forEach((event) => {
    if (event && event.type === 'terminal-output') {
      next = appendTail(next, event.text || '');
    }
  });
  return next;
}

function summarizeRunEvents(events) {
  const counts = {};
  (Array.isArray(events) ? events : []).forEach((event) => {
    const type = String(event && event.type || 'unknown');
    counts[type] = (counts[type] || 0) + 1;
  });
  return counts;
}

async function postRunInput(endpoint, token, payload, deps = {}) {
  return fetchJson(`${endpoint}/v0/node-rpc/device-node-session-run-input`, {
    method: 'POST',
    timeoutMs: deps.timeoutMs || 5000,
    fetchImpl: deps.fetchImpl,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

async function postRunAbort(endpoint, token, payload, deps = {}) {
  return fetchJson(`${endpoint}/v0/node-rpc/device-node-session-run-abort`, {
    method: 'POST',
    timeoutMs: deps.timeoutMs || 5000,
    fetchImpl: deps.fetchImpl,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

async function fetchRunEvents(endpoint, token, input = {}, deps = {}) {
  const url = `${endpoint}/v0/node-rpc/device-node-session-run-events?nodeId=${encodeURIComponent(input.nodeId)}&runId=${encodeURIComponent(input.runId)}&cursor=${encodeURIComponent(String(input.cursor || 0))}&limit=100`;
  return fetchJson(url, {
    timeoutMs: 5000,
    fetchImpl: deps.fetchImpl,
    headers: {
      authorization: `Bearer ${token}`
    }
  });
}

function collectArtifactRefs(events = []) {
  const refs = [];
  (Array.isArray(events) ? events : []).forEach((event) => {
    if (!event || event.type !== 'artifact_ref') return;
    const artifact = event.artifact && typeof event.artifact === 'object' ? event.artifact : {};
    const artifactId = String(event.artifactId || event.artifact_id || artifact.artifactId || artifact.artifact_id || '').trim();
    if (!artifactId) return;
    refs.push({
      artifactId,
      kind: String(event.artifactKind || artifact.kind || '').trim(),
      byteLength: Number(event.byteLength || event.byte_length || artifact.byteLength || artifact.byte_length) || 0
    });
  });
  return refs;
}

async function fetchSessionArtifact(endpoint, token, input = {}, deps = {}) {
  const url = `${endpoint}/v0/node-rpc/device-node-session-artifact?nodeId=${encodeURIComponent(input.nodeId)}&artifactId=${encodeURIComponent(input.artifactId)}`;
  return fetchJson(url, {
    timeoutMs: 5000,
    fetchImpl: deps.fetchImpl,
    headers: {
      authorization: `Bearer ${token}`
    }
  });
}

async function fetchNewArtifacts(endpoint, token, input = {}, deps = {}) {
  const seenArtifactIds = input.seenArtifactIds || new Set();
  const refs = collectArtifactRefs(input.events);
  const fetched = [];
  let contentTail = '';

  for (const ref of refs) {
    if (seenArtifactIds.has(ref.artifactId)) continue;
    seenArtifactIds.add(ref.artifactId);
    let response = null;
    try {
      response = await fetchSessionArtifact(endpoint, token, {
        nodeId: input.nodeId,
        artifactId: ref.artifactId
      }, deps);
    } catch (error) {
      fetched.push({
        artifactId: ref.artifactId,
        status: 0,
        ok: false,
        error: String((error && error.message) || error || 'artifact_fetch_failed'),
        refByteLength: ref.byteLength
      });
      continue;
    }
    const result = response.body && response.body.result && typeof response.body.result === 'object'
      ? response.body.result
      : {};
    const artifact = result.artifact && typeof result.artifact === 'object' ? result.artifact : {};
    const content = String(result.content || '');
    if (content) contentTail = appendTail(contentTail, content);
    fetched.push({
      artifactId: ref.artifactId,
      status: response.status,
      ok: response.status === 200 && response.body && response.body.ok !== false && Boolean(content),
      kind: String(artifact.kind || ref.kind || '').trim(),
      byteLength: Buffer.byteLength(content, 'utf8'),
      declaredByteLength: Number(artifact.byteLength || artifact.byte_length || ref.byteLength) || 0,
      preview: redactSensitiveText(String(artifact.preview || '').slice(0, 240))
    });
  }

  return { fetched, contentTail };
}

function summarizeArtifacts(items = [], required = false) {
  const source = Array.isArray(items) ? items : [];
  const fetched = source.filter((item) => item && item.ok);
  return {
    required: Boolean(required),
    refs: source.length,
    fetched: fetched.length,
    bytes: fetched.reduce((sum, item) => sum + (Number(item.byteLength) || 0), 0),
    ok: !required || fetched.length > 0,
    items: source.slice(-20).map((item) => ({
      artifactId: item.artifactId,
      status: Number(item.status) || 0,
      ok: Boolean(item.ok),
      kind: String(item.kind || ''),
      byteLength: Number(item.byteLength) || 0,
      declaredByteLength: Number(item.declaredByteLength || item.refByteLength) || 0,
      ...(item.error ? { error: item.error } : {}),
      ...(item.preview ? { preview: item.preview } : {})
    }))
  };
}

function mergeEventCounts(current = {}, events = []) {
  const next = { ...current };
  Object.entries(summarizeRunEvents(events)).forEach(([key, value]) => {
    next[key] = (next[key] || 0) + value;
  });
  return next;
}

async function waitForSessionRunCompletion(input = {}, deps = {}) {
  const endpoint = String(input.clientEndpoint || input.controlEndpoint || '').replace(/\/+$/, '');
  const deadline = Date.now() + Math.max(500, Number(input.timeoutMs) || 3000);
  let cursor = Number(input.cursor) || 0;
  let terminalTail = String(input.terminalTail || '');
  let eventCounts = { ...(input.eventCounts || {}) };
  let latestEventsStatus = 0;
  let completed = false;

  while (Date.now() < deadline) {
    const events = await fetchRunEvents(endpoint, input.deviceToken, {
      nodeId: input.nodeId,
      runId: input.runId,
      cursor
    }, deps).catch((error) => ({
      status: 0,
      body: {
        ok: false,
        error: String((error && error.message) || error || 'events_failed')
      }
    }));
    latestEventsStatus = events.status;
    const result = events.body && events.body.result && typeof events.body.result === 'object'
      ? events.body.result
      : {};
    const batch = Array.isArray(result.events) ? result.events : [];
    terminalTail = appendEventText(terminalTail, batch);
    eventCounts = mergeEventCounts(eventCounts, batch);
    cursor = Math.max(cursor, Number(result.cursor) || cursor);
    completed = result.completed === true || result.status === 'completed';
    if (completed) break;
    await sleep(250);
  }

  return {
    completed,
    cursor,
    terminalTail,
    eventCounts,
    latestEventsStatus
  };
}

async function runDeviceNodeSessionSmoke(input = {}, deps = {}) {
  const {
    controlEndpoint,
    clientEndpoint,
    deviceToken,
    options
  } = input;
  const apiEndpoint = String(clientEndpoint || controlEndpoint || '').replace(/\/+$/, '');
  const timeoutMs = Math.max(1000, Number(options.sessionTimeoutMs) || DEFAULT_SESSION_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const payload = buildSessionStartPayload(options);
  const promptHash = crypto.createHash('sha256').update(payload.prompt).digest('hex').slice(0, 16);
  let runId = '';
  let cursor = 0;
  let terminalTail = '';
  let eventCounts = {};
  const seenArtifactIds = new Set();
  const artifactFetches = [];
  let latestEventsStatus = 0;
  let quit = null;

  const start = await fetchJson(`${apiEndpoint}/v0/node-rpc/device-node-session-start`, {
    method: 'POST',
    timeoutMs: 10000,
    fetchImpl: deps.fetchImpl,
    headers: {
      authorization: `Bearer ${deviceToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  runId = String(start.body && start.body.result && start.body.result.runId || '');
  if (start.status !== 200 || !runId) {
    return {
      ok: false,
      enabled: true,
      error: 'session_start_failed',
      startStatus: start.status,
      startOk: start.body && start.body.ok !== false,
      runIdPresent: Boolean(runId),
      provider: options.sessionProvider,
      accountId: options.sessionAccountId,
      model: options.sessionModel || '',
      projectPath: payload.projectPath,
      promptHash,
      promptBytes: Buffer.byteLength(payload.prompt, 'utf8'),
      expectedOutputFound: false,
      terminalTail: ''
    };
  }

  try {
    while (Date.now() < deadline) {
      const events = await fetchRunEvents(apiEndpoint, deviceToken, {
        nodeId: options.nodeId,
        runId,
        cursor
      }, deps);
      latestEventsStatus = events.status;
      const result = events.body && events.body.result && typeof events.body.result === 'object'
        ? events.body.result
        : {};
      const batch = Array.isArray(result.events) ? result.events : [];
      eventCounts = mergeEventCounts(eventCounts, batch);
      terminalTail = appendEventText(terminalTail, batch);
      const artifacts = await fetchNewArtifacts(apiEndpoint, deviceToken, {
        nodeId: options.nodeId,
        events: batch,
        seenArtifactIds
      }, deps);
      artifactFetches.push(...artifacts.fetched);
      if (artifacts.contentTail) {
        terminalTail = appendTail(terminalTail, artifacts.contentTail);
      }
      cursor = Math.max(cursor, Number(result.cursor) || cursor);
      if (redactSensitiveText(terminalTail).includes(options.expectOutput)) {
        break;
      }
      await sleep(500);
    }

    const expectedOutputFound = redactSensitiveText(terminalTail).includes(options.expectOutput);
    const artifactSummary = summarizeArtifacts(artifactFetches, options.expectArtifact);
    quit = await postRunInput(apiEndpoint, deviceToken, {
      nodeId: options.nodeId,
      runId,
      input: '/quit',
      appendNewline: true
    }, deps).catch((error) => ({
      status: 0,
      ok: false,
      body: {
        ok: false,
        error: String((error && error.message) || error || 'quit_failed')
      }
    }));
    let cleanup = await waitForSessionRunCompletion({
      controlEndpoint,
      clientEndpoint: apiEndpoint,
      deviceToken,
      nodeId: options.nodeId,
      runId,
      cursor,
      terminalTail,
      eventCounts,
      timeoutMs: 3000
    }, deps);
    cursor = cleanup.cursor;
    terminalTail = cleanup.terminalTail;
    eventCounts = cleanup.eventCounts;
    latestEventsStatus = cleanup.latestEventsStatus || latestEventsStatus;
    if (!cleanup.completed) {
      const abort = await postRunAbort(apiEndpoint, deviceToken, {
        nodeId: options.nodeId,
        runId
      }, deps).catch((error) => ({
        status: 0,
        ok: false,
        body: {
          ok: false,
          error: String((error && error.message) || error || 'abort_failed')
        }
      }));
      const afterInterrupt = await waitForSessionRunCompletion({
        controlEndpoint,
        clientEndpoint: apiEndpoint,
        deviceToken,
        nodeId: options.nodeId,
        runId,
        cursor,
        terminalTail,
        eventCounts,
        timeoutMs: 3000
      }, deps);
      cursor = afterInterrupt.cursor;
      terminalTail = afterInterrupt.terminalTail;
      eventCounts = afterInterrupt.eventCounts;
      latestEventsStatus = afterInterrupt.latestEventsStatus || latestEventsStatus;
      cleanup = {
        ...afterInterrupt,
        abort: {
          status: abort.status,
          ok: abort.body && abort.body.ok !== false,
          accepted: Boolean(abort.body && abort.body.result && abort.body.result.accepted)
        }
      };
    }

    return {
      ok: expectedOutputFound && cleanup.completed === true && artifactSummary.ok,
      enabled: true,
      provider: options.sessionProvider,
      accountId: options.sessionAccountId,
      model: options.sessionModel || '',
      projectPath: payload.projectPath,
      promptHash,
      promptBytes: Buffer.byteLength(payload.prompt, 'utf8'),
      startStatus: start.status,
      runIdPresent: Boolean(runId),
      expectedOutputFound,
      cursor,
      latestEventsStatus,
      eventCounts,
      artifacts: artifactSummary,
      terminalTail: redactSensitiveText(terminalTail),
      quit: {
        status: quit.status,
        ok: quit.body && quit.body.ok !== false,
        accepted: Boolean(quit.body && quit.body.result && quit.body.result.accepted)
      },
      cleanup: {
        completed: cleanup.completed,
        ...(cleanup.abort ? { abort: cleanup.abort } : {})
      }
    };
  } finally {
    if (!quit && runId) {
      await postRunInput(controlEndpoint, deviceToken, {
        nodeId: options.nodeId,
        runId,
        input: '/quit',
        appendNewline: true
      }, deps).catch(() => null);
    }
  }
}

async function waitForHealth(endpoint, timeoutMs, deps = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const result = await fetchJson(`${endpoint}/healthz`, {
        timeoutMs: 1500,
        fetchImpl: deps.fetchImpl
      });
      if (result.status === 200 && result.body && result.body.ok === true) {
        return result;
      }
      lastError = `http_${result.status}`;
    } catch (error) {
      lastError = String((error && (error.code || error.message)) || error || 'fetch_failed');
    }
    await sleep(150);
  }
  const error = new Error(`health_timeout:${endpoint}:${lastError}`);
  error.code = 'health_timeout';
  throw error;
}

async function waitForDeviceNodeOnline(endpoint, token, nodeId, timeoutMs, deps = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await fetchJson(`${endpoint}/v0/node-rpc/device-nodes`, {
      timeoutMs: 2000,
      fetchImpl: deps.fetchImpl,
      headers: {
        authorization: `Bearer ${token}`
      }
    }).catch((error) => ({
      status: 0,
      ok: false,
      body: { ok: false, error: String((error && error.message) || error || 'device_nodes_failed') }
    }));
    const nodes = latest.body && latest.body.result && Array.isArray(latest.body.result.nodes)
      ? latest.body.result.nodes
      : [];
    const node = nodes.find((entry) => entry && entry.id === nodeId);
    if (node && node.connection && node.connection.status === 'online') {
      return { response: latest, node };
    }
    await sleep(200);
  }
  const error = new Error('relay_online_timeout');
  error.code = 'relay_online_timeout';
  error.latest = latest;
  throw error;
}

function prepareStores(input) {
  const {
    controlAiHomeDir,
    nodeAiHomeDir,
    controlEndpoint,
    nodeId,
    nodePort,
    nodeManagementKey,
    deps = {}
  } = input;
  const fsImpl = deps.fs || fs;
  fsImpl.mkdirSync(controlAiHomeDir, { recursive: true });
  fsImpl.mkdirSync(nodeAiHomeDir, { recursive: true });

  const node = upsertRemoteNode({
    id: nodeId,
    name: 'Relay Smoke Node',
    role: 'worker',
    endpointPolicy: 'relay',
    preferredTransports: ['relay'],
    capabilities: ['status', 'sessions'],
    tags: ['smoke', 'outbound-relay']
  }, { fs: fsImpl, aiHomeDir: controlAiHomeDir });
  writeRemoteSecret(node.authRef, { managementKey: nodeManagementKey }, {
    fs: fsImpl,
    aiHomeDir: controlAiHomeDir
  });
  writeServerConfig({
    host: '127.0.0.1',
    port: nodePort,
    managementKey: nodeManagementKey,
    openNetwork: false
  }, { fs: fsImpl, aiHomeDir: nodeAiHomeDir });

  const invite = createControlPlaneDeviceInvite({
    name: 'Relay Smoke Device',
    controlEndpoint,
    scopes: buildDeviceScopes()
  }, { fs: fsImpl, aiHomeDir: controlAiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: {
      id: 'relay-smoke-device',
      name: 'Relay Smoke Device',
      platform: process.platform
    }
  }, { fs: fsImpl, aiHomeDir: controlAiHomeDir });

  return {
    node,
    device: paired.device,
    deviceToken: paired.token
  };
}

function summarizeChild(handle) {
  const redact = redactSensitiveText;
  return {
    label: handle.label,
    pid: handle.child && handle.child.pid || 0,
    exited: Boolean(handle.exited),
    exitCode: handle.exitCode,
    signal: handle.signal || '',
    stdoutTail: redact(handle.stdout),
    stderrTail: redact(handle.stderr)
  };
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1***:***@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>')
    .replace(/((?:management|client|api)[_-]?key["']?\s*[:=]\s*["']?)[^"',\s]+/gi, '$1<redacted>')
    .trim();
}

async function stopChild(handle, timeoutMs = 3000) {
  if (!handle || !handle.child || handle.exited) return summarizeChild(handle);
  try {
    handle.child.kill('SIGTERM');
  } catch (_error) {}
  await Promise.race([
    handle.exitPromise,
    sleep(timeoutMs)
  ]);
  if (!handle.exited) {
    try {
      handle.child.kill('SIGKILL');
    } catch (_error) {}
    await Promise.race([
      handle.exitPromise,
      sleep(1000)
    ]);
  }
  return summarizeChild(handle);
}

async function runExistingEndpointRelaySmoke(rawOptions = {}, deps = {}) {
  const options = {
    help: false,
    nodeId: DEFAULT_NODE_ID,
    endpoint: '',
    clientEndpoint: '',
    hostHome: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    ...rawOptions
  };
  const repoRoot = deps.repoRoot || path.resolve(__dirname, '..');
  const controlEndpoint = String(options.endpoint || '').replace(/\/+$/, '');
  const clientEndpoint = String(options.clientEndpoint || controlEndpoint).replace(/\/+$/, '');
  const hostHomeDir = resolveExistingHostHome(options.hostHome, deps.env || process.env);
  const aiHomeDir = getHostAiHomeDir(hostHomeDir);
  const nodeManagement = resolveExistingNodeManagementKey(aiHomeDir, deps);
  const children = [];
  let deviceToken = '';
  let preparation = { mode: usesApiEndpointPreparation(options) ? 'api' : 'filesystem' };
  let online = null;
  let sessions = null;
  let session = { enabled: false };

  try {
    const prepared = usesApiEndpointPreparation(options)
      ? await prepareExistingEndpointViaApi({
        controlEndpoint,
        nodeId: options.nodeId,
        nodeManagementKey: nodeManagement.key,
        nodeJoinUrl: options.nodeJoinUrl,
        devicePairUrl: options.devicePairUrl,
        deps
      })
      : prepareExistingEndpointStores({
        aiHomeDir,
        controlEndpoint,
        nodeId: options.nodeId,
        nodeManagementKey: nodeManagement.key,
        deps
      });
    deviceToken = prepared.deviceToken;
    preparation = prepared.preparation || preparation;

    await waitForHealth(controlEndpoint, options.timeoutMs, deps);

    const relayArgs = [
      'node',
      'relay',
      'connect',
      controlEndpoint,
      '--node-id',
      options.nodeId,
      '--heartbeat-ms',
      String(DEFAULT_HEARTBEAT_MS),
      '--connect-timeout-ms',
      String(DEFAULT_CONNECT_TIMEOUT_MS),
      '--reconnect-delay-ms',
      '500',
      '--max-attempts',
      '1'
    ];
    if (nodeManagement.passCliArg) {
      relayArgs.push('--management-key', nodeManagement.key);
    }
    children.push(spawnAihProcess('relay-client', hostHomeDir, relayArgs, { repoRoot }));

    online = await waitForDeviceNodeOnline(
      clientEndpoint,
      deviceToken,
      options.nodeId,
      options.timeoutMs,
      deps
    );
    sessions = await fetchJson(
      `${clientEndpoint}/v0/node-rpc/device-node-sessions?nodeId=${encodeURIComponent(options.nodeId)}&limit=5`,
      {
        timeoutMs: options.timeoutMs,
        fetchImpl: deps.fetchImpl,
        headers: {
          authorization: `Bearer ${deviceToken}`
        }
      }
    );

    if (hasSessionSmokeOptions(options)) {
      session = await runDeviceNodeSessionSmoke({
        controlEndpoint,
        clientEndpoint,
        deviceToken,
        options
      }, deps);
    }

    const sessionResult = sessions.body && sessions.body.result ? sessions.body.result : {};
    const nodeView = online.node || {};
    const connection = nodeView.connection || {};
    const transports = Array.isArray(nodeView.transports) ? nodeView.transports : [];
    const baseOk = sessions.status === 200
      && sessions.body
      && sessions.body.ok !== false
      && connection.status === 'online'
      && connection.transportKind === 'relay';
    return {
      ok: baseOk && (!session.enabled || session.ok),
      mode: 'existing-endpoint-relay',
      nodeId: options.nodeId,
      managementKeySource: nodeManagement.source,
      preparation,
      control: {
        endpoint: controlEndpoint,
        health: true
      },
      client: {
        endpoint: clientEndpoint,
        viaProxy: clientEndpoint !== controlEndpoint
      },
      node: {
        endpoint: controlEndpoint,
        health: true
      },
      relay: {
        online: connection.status === 'online',
        status: connection.status || '',
        transportKind: connection.transportKind || '',
        transportId: connection.transportId || '',
        sessionIdPresent: Boolean(connection.sessionId),
        transportKinds: transports.map((transport) => transport.kind).filter(Boolean),
        transportStatuses: transports.map((transport) => `${transport.kind}:${transport.status}`).filter(Boolean)
      },
      device: {
        paired: Boolean(deviceToken),
        scopes: buildDeviceScopes()
      },
      sessions: {
        status: sessions.status,
        ok: sessions.body && sessions.body.ok !== false,
        rpc: String(sessions.body && sessions.body.rpc || ''),
        total: Number(sessionResult.summary && sessionResult.summary.total) || 0,
        returned: Array.isArray(sessionResult.sessions) ? sessionResult.sessions.length : 0
      },
      session,
      children: children.map(summarizeChild)
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'existing-endpoint-relay',
      nodeId: options.nodeId,
      error: String((error && (error.code || error.message)) || error || 'existing_endpoint_relay_smoke_failed'),
      message: redactSensitiveText(String((error && error.message) || error || '')),
      phase: String((error && error.phase) || ''),
      latestDeviceNodes: error && error.latest ? error.latest.body : undefined,
      preparation,
      control: {
        endpoint: controlEndpoint
      },
      client: {
        endpoint: clientEndpoint,
        viaProxy: clientEndpoint !== controlEndpoint
      },
      node: {
        endpoint: controlEndpoint
      },
      sessions: sessions ? {
        status: sessions.status,
        body: sessions.body
      } : null,
      session,
      children: children.map(summarizeChild)
    };
  } finally {
    for (const handle of children.slice().reverse()) {
      await stopChild(handle);
    }
  }
}

async function runOutboundRelaySmoke(rawOptions = {}, deps = {}) {
  const options = {
    help: false,
    nodeId: DEFAULT_NODE_ID,
    endpoint: '',
    hostHome: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    controlPort: 0,
    nodePort: 0,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    keepTemp: false,
    ...rawOptions
  };
  if (options.endpoint) {
    return runExistingEndpointRelaySmoke(options, deps);
  }
  const repoRoot = deps.repoRoot || path.resolve(__dirname, '..');
  const tempRoot = deps.tempRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-relay-smoke-'));
  const controlHostHome = path.join(tempRoot, 'control-host');
  const nodeHostHome = path.join(tempRoot, 'node-host');
  const controlAiHomeDir = path.join(controlHostHome, '.ai_home');
  const nodeAiHomeDir = path.join(nodeHostHome, '.ai_home');
  const controlPort = await resolvePort(options.controlPort);
  const nodePort = await resolvePort(options.nodePort);
  const controlEndpoint = `http://127.0.0.1:${controlPort}`;
  const nodeEndpoint = `http://127.0.0.1:${nodePort}`;
  const controlManagementKey = randomSecret('control');
  const nodeManagementKey = randomSecret('node');
  const children = [];
  let deviceToken = '';
  let online = null;
  let sessions = null;

  try {
    const prepared = prepareStores({
      controlAiHomeDir,
      nodeAiHomeDir,
      controlEndpoint,
      nodeId: options.nodeId,
      nodePort,
      nodeManagementKey,
      deps
    });
    deviceToken = prepared.deviceToken;

    children.push(spawnAihProcess('control-server', controlHostHome, [
      'server',
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(controlPort),
      '--management-key',
      controlManagementKey,
      '--provider',
      'codex',
      '--codex-client-version',
      '0.0.0-smoke',
      '--no-model-usage-scan',
      '--no-request-log'
    ], { repoRoot }));
    children.push(spawnAihProcess('node-server', nodeHostHome, [
      'server',
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(nodePort),
      '--management-key',
      nodeManagementKey,
      '--provider',
      'codex',
      '--codex-client-version',
      '0.0.0-smoke',
      '--no-model-usage-scan',
      '--no-request-log'
    ], { repoRoot }));

    await waitForHealth(controlEndpoint, options.timeoutMs, deps);
    await waitForHealth(nodeEndpoint, options.timeoutMs, deps);

    children.push(spawnAihProcess('relay-client', nodeHostHome, [
      'node',
      'relay',
      'connect',
      controlEndpoint,
      '--node-id',
      options.nodeId,
      '--heartbeat-ms',
      String(DEFAULT_HEARTBEAT_MS),
      '--connect-timeout-ms',
      String(DEFAULT_CONNECT_TIMEOUT_MS),
      '--reconnect-delay-ms',
      '500',
      '--max-attempts',
      '1'
    ], { repoRoot }));

    online = await waitForDeviceNodeOnline(
      controlEndpoint,
      deviceToken,
      options.nodeId,
      options.timeoutMs,
      deps
    );
    sessions = await fetchJson(
      `${controlEndpoint}/v0/node-rpc/device-node-sessions?nodeId=${encodeURIComponent(options.nodeId)}&limit=5`,
      {
        timeoutMs: options.timeoutMs,
        fetchImpl: deps.fetchImpl,
        headers: {
          authorization: `Bearer ${deviceToken}`
        }
      }
    );

    const sessionResult = sessions.body && sessions.body.result ? sessions.body.result : {};
    const nodeView = online.node || {};
    const connection = nodeView.connection || {};
    const transports = Array.isArray(nodeView.transports) ? nodeView.transports : [];
    const report = {
      ok: sessions.status === 200
        && sessions.body
        && sessions.body.ok !== false
        && connection.status === 'online'
        && connection.transportKind === 'relay',
      mode: 'outbound-relay',
      nodeId: options.nodeId,
      control: {
        endpoint: controlEndpoint,
        port: controlPort,
        health: true
      },
      node: {
        endpoint: nodeEndpoint,
        port: nodePort,
        health: true
      },
      relay: {
        online: connection.status === 'online',
        status: connection.status || '',
        transportKind: connection.transportKind || '',
        transportId: connection.transportId || '',
        sessionIdPresent: Boolean(connection.sessionId),
        transportKinds: transports.map((transport) => transport.kind).filter(Boolean),
        transportStatuses: transports.map((transport) => `${transport.kind}:${transport.status}`).filter(Boolean)
      },
      device: {
        paired: Boolean(deviceToken),
        scopes: buildDeviceScopes()
      },
      sessions: {
        status: sessions.status,
        ok: sessions.body && sessions.body.ok !== false,
        rpc: String(sessions.body && sessions.body.rpc || ''),
        total: Number(sessionResult.summary && sessionResult.summary.total) || 0,
        returned: Array.isArray(sessionResult.sessions) ? sessionResult.sessions.length : 0
      },
      session: { enabled: false },
      tempRoot: options.keepTemp ? tempRoot : '',
      children: children.map(summarizeChild)
    };
    return report;
  } catch (error) {
    return {
      ok: false,
      mode: 'outbound-relay',
      nodeId: options.nodeId,
      error: String((error && (error.code || error.message)) || error || 'relay_smoke_failed'),
      latestDeviceNodes: error && error.latest ? error.latest.body : undefined,
      control: {
        endpoint: controlEndpoint,
        port: controlPort
      },
      node: {
        endpoint: nodeEndpoint,
        port: nodePort
      },
      sessions: sessions ? {
        status: sessions.status,
        body: sessions.body
      } : null,
      tempRoot: options.keepTemp ? tempRoot : '',
      children: children.map(summarizeChild)
    };
  } finally {
    for (const handle of children.slice().reverse()) {
      await stopChild(handle);
    }
    if (!options.keepTemp) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (_error) {}
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[aih] ${String((error && error.message) || error)}`);
    console.error('Usage: node scripts/fabric-real-outbound-relay-smoke.js [--node-id ID] [--timeout-ms N]');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runOutboundRelaySmoke(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-real-outbound-relay-smoke] ${String((error && error.stack) || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDeviceScopes,
  buildSessionStartPayload,
  getHostAiHomeDir,
  hasSessionSmokeOptions,
  parseArgs,
  prepareExistingEndpointViaApi,
  prepareExistingEndpointStores,
  prepareStores,
  resolveExistingNodeManagementKey,
  resolveExistingHostHome,
  runDeviceNodeSessionSmoke,
  runExistingEndpointRelaySmoke,
  runOutboundRelaySmoke,
  summarizeChild
};
