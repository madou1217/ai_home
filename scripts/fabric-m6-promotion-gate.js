#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  buildSshArgs,
  shQuote
} = require('./fabric-real-vps-deploy');
const {
  formatTransportHeartbeat
} = require('../lib/cli/services/fabric/registry-heartbeat');
const {
  DEFAULT_ENDPOINT,
  DEFAULT_ICE_SERVERS,
  DEFAULT_ICE_TRANSPORT_POLICY,
  DEFAULT_RPC_SAMPLE_COUNT,
  normalizeIceServerList,
  runWebrtcDatachannelSmoke,
  writeDiagnosticsFile
} = require('./fabric-real-webrtc-datachannel-smoke');
const {
  DEFAULT_WEBTRANSPORT_PATH,
  runWebTransportSmoke
} = require('./fabric-real-webtransport-smoke');
const {
  runDiagnosis: runMultipathDiagnosis
} = require('./fabric-multipath-diagnosis');
const {
  runFabricTransportEcho
} = require('../lib/cli/services/fabric/transport-echo');
const {
  classifyDefaultPortUdpProbe,
  runDefaultPortUdpProbe
} = require('./fabric-default-udp-probe');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SAMPLE_COUNT = 5;
const DEFAULT_BROWSER_CHANNEL = 'chrome';
const DEFAULT_SSH_TARGET = 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com';
const DEFAULT_SSH_KEY = '~/.ssh/aws.pem';
const DEFAULT_REMOTE_DIR = '/home/ubuntu/aih-fabric-current';
const DEFAULT_NODE_ID = 'aws-current-node';
const DEFAULT_PORT = 9527;
const DEFAULT_SECURE_PROBE_PAGE_URL = 'https://example.com/';
const DEFAULT_RELAY_ECHO_PATH = '/v0/fabric/transport/echo';
const DEFAULT_RELAY_COUNT = 20;
const DEFAULT_RELAY_PAYLOAD_SIZE = 64;
const DEFAULT_DIRECT_WEBRTC_MAX_P95_MS = 1500;
const DEFAULT_PROMOTION_TTL_MS = 24 * 60 * 60 * 1000;
const DIRECT_CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx']);

function showHelp() {
  console.log(`AIH Fabric M6 transport promotion gate

Usage:
  node scripts/fabric-m6-promotion-gate.js [options]

Options:
  --endpoint <url>          AWS/current endpoint, default ${DEFAULT_ENDPOINT}.
  --ssh <user@host>         SSH target for multipath diagnosis, default ${DEFAULT_SSH_TARGET}.
  --ssh-key <pem>           SSH key, default ${DEFAULT_SSH_KEY}.
  --remote-dir <path>       Remote AWS current checkout, default ${DEFAULT_REMOTE_DIR}.
  --node-id <id>            Fabric node id for publishing promotion, default ${DEFAULT_NODE_ID}.
  --port <n>                Default transport/TURN UDP port to probe, default ${DEFAULT_PORT}.
  --sample-count <n>        WebRTC RTT samples, default ${DEFAULT_SAMPLE_COUNT}.
  --rpc-sample-count <n>    WebRTC DataChannel RPC echo samples, default ${DEFAULT_RPC_SAMPLE_COUNT}.
  --relay-count <n>         Relay echo samples, default ${DEFAULT_RELAY_COUNT}.
  --relay-payload-size <n>  Relay echo payload bytes, default ${DEFAULT_RELAY_PAYLOAD_SIZE}.
  --timeout-ms <n>          Browser probe timeout, default ${DEFAULT_TIMEOUT_MS}.
  --browser-channel <c>     Playwright browser channel, default ${DEFAULT_BROWSER_CHANNEL}; use bundled for Chromium.
  --turn-ice-server <url>   TURN server URL. Can be passed multiple times.
  --turn-username <value>   TURN username.
  --turn-credential <value> TURN credential.
  --webtransport-url <url>  WebTransport URL, default HTTPS probe on the endpoint.
  --webtransport-page-url <url>
                            Secure browser page URL, default ${DEFAULT_SECURE_PROBE_PAGE_URL}.
  --diagnostics-dir <path>  Write individual probe JSON files under this directory.
  --diagnostics-file <path> Write the aggregate gate report to this JSON file.
  --headed                  Show browser windows for browser-backed probes.
  --skip-relay              Skip relay fallback baseline probe.
  --skip-webrtc            Skip direct/STUN WebRTC DataChannel probe.
  --skip-turn              Skip TURN relay-only WebRTC probe.
  --skip-turn-udp-probe    Skip default-port UDP reachability probe.
  --skip-webtransport      Skip WebTransport probe.
  --skip-multipath         Skip MPTCP/OpenMPTCPRouter diagnosis.
  --allow-direct-webrtc-promotion
                           Allow verified direct/STUN WebRTC DataChannel promotion without TURN.
  --direct-webrtc-max-p95-ms <n>
                           Maximum direct WebRTC p95 RTT for promotion, default ${DEFAULT_DIRECT_WEBRTC_MAX_P95_MS}.
  --publish-promotion       Publish a passing WebRTC promotion to the node registry over SSH.
  --promotion-ttl-ms <n>    Promotion expiry TTL, default ${DEFAULT_PROMOTION_TTL_MS}.
  --promotion-evidence-ref <path>
                           Evidence reference stored in registry promotion metadata.
  --fail-on-blocked        Exit non-zero when promotionReady=false.
  --json                   Print JSON only.
  -h, --help               Show this help.

The gate runs real probes and separates "candidate works" from "safe default
promotion". It does not open new product ports, import provider credentials, or
touch old VPS targets.
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

function normalizeText(value, maxLength = 4096) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEndpoint(value, flag = '--endpoint') {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid_protocol');
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function parsePositiveInteger(value, flag, fallback, min = 1, max = 240000) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function resolveLocalPath(value) {
  return path.resolve(String(value || '').replace(/^~(?=\/|$)/, process.env.HOME || ''));
}

function normalizeBrowserChannel(value) {
  const normalized = normalizeText(value, 120);
  if (!normalized) return '';
  if (['bundled', 'chromium', 'playwright'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

function normalizeNodeId(value, flag = '--node-id') {
  const normalized = normalizeText(value, 128)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  if (/^[a-z0-9][a-z0-9_.-]{1,127}$/.test(normalized)) return normalized;
  throw new Error(`${flag} must be a valid Fabric node id`);
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    json: false,
    endpoint: DEFAULT_ENDPOINT,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    nodeId: DEFAULT_NODE_ID,
    port: DEFAULT_PORT,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    rpcSampleCount: DEFAULT_RPC_SAMPLE_COUNT,
    relayCount: DEFAULT_RELAY_COUNT,
    relayPayloadSize: DEFAULT_RELAY_PAYLOAD_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    browserChannel: DEFAULT_BROWSER_CHANNEL,
    turnIceServers: [],
    turnUsername: '',
    turnCredential: '',
    webTransportUrl: '',
    webTransportPageUrl: DEFAULT_SECURE_PROBE_PAGE_URL,
    diagnosticsDir: '',
    diagnosticsFile: '',
    headed: false,
    allowDirectWebrtcPromotion: false,
    directWebrtcMaxP95Ms: DEFAULT_DIRECT_WEBRTC_MAX_P95_MS,
    publishPromotion: false,
    promotionTtlMs: DEFAULT_PROMOTION_TTL_MS,
    promotionEvidenceRef: '',
    skipRelay: false,
    skipWebrtc: false,
    skipTurn: false,
    skipTurnUdpProbe: false,
    skipWebTransport: false,
    skipMultipath: false,
    failOnBlocked: false
  };

  for (let index = 0; index < argv.length;) {
    const token = normalizeText(argv[index], 256);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--headed') {
      options.headed = true;
      index += 1;
      continue;
    }
    if (token === '--allow-direct-webrtc-promotion') {
      options.allowDirectWebrtcPromotion = true;
      index += 1;
      continue;
    }
    if (token === '--publish-promotion') {
      options.publishPromotion = true;
      index += 1;
      continue;
    }
    if (token === '--direct-webrtc-max-p95-ms' || token.startsWith('--direct-webrtc-max-p95-ms=')) {
      const next = readOptionValue(argv, index, '--direct-webrtc-max-p95-ms');
      options.directWebrtcMaxP95Ms = parsePositiveInteger(next.value, '--direct-webrtc-max-p95-ms', DEFAULT_DIRECT_WEBRTC_MAX_P95_MS, 1, 60000);
      index += next.consumed;
      continue;
    }
    if (token === '--skip-relay') {
      options.skipRelay = true;
      index += 1;
      continue;
    }
    if (token === '--skip-webrtc') {
      options.skipWebrtc = true;
      index += 1;
      continue;
    }
    if (token === '--skip-turn') {
      options.skipTurn = true;
      index += 1;
      continue;
    }
    if (token === '--skip-turn-udp-probe') {
      options.skipTurnUdpProbe = true;
      index += 1;
      continue;
    }
    if (token === '--skip-webtransport') {
      options.skipWebTransport = true;
      index += 1;
      continue;
    }
    if (token === '--skip-multipath') {
      options.skipMultipath = true;
      index += 1;
      continue;
    }
    if (token === '--fail-on-blocked') {
      options.failOnBlocked = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--ssh' || token.startsWith('--ssh=')) {
      const next = readOptionValue(argv, index, '--ssh');
      options.sshTarget = normalizeText(next.value, 512);
      index += next.consumed;
      continue;
    }
    if (token === '--ssh-key' || token.startsWith('--ssh-key=')) {
      const next = readOptionValue(argv, index, '--ssh-key');
      options.sshKey = resolveLocalPath(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = normalizeNodeId(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--remote-dir' || token.startsWith('--remote-dir=')) {
      const next = readOptionValue(argv, index, '--remote-dir');
      options.remoteDir = normalizeText(next.value, 1024);
      index += next.consumed;
      continue;
    }
    if (token === '--promotion-ttl-ms' || token.startsWith('--promotion-ttl-ms=')) {
      const next = readOptionValue(argv, index, '--promotion-ttl-ms');
      options.promotionTtlMs = parsePositiveInteger(next.value, '--promotion-ttl-ms', DEFAULT_PROMOTION_TTL_MS, 60_000, 7 * 24 * 60 * 60 * 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--promotion-evidence-ref' || token.startsWith('--promotion-evidence-ref=')) {
      const next = readOptionValue(argv, index, '--promotion-evidence-ref');
      options.promotionEvidenceRef = normalizeText(next.value, 256);
      index += next.consumed;
      continue;
    }
    if (token === '--port' || token.startsWith('--port=')) {
      const next = readOptionValue(argv, index, '--port');
      options.port = parsePositiveInteger(next.value, '--port', DEFAULT_PORT, 1, 65535);
      index += next.consumed;
      continue;
    }
    if (token === '--sample-count' || token.startsWith('--sample-count=')) {
      const next = readOptionValue(argv, index, '--sample-count');
      options.sampleCount = parsePositiveInteger(next.value, '--sample-count', DEFAULT_SAMPLE_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--rpc-sample-count' || token.startsWith('--rpc-sample-count=')) {
      const next = readOptionValue(argv, index, '--rpc-sample-count');
      options.rpcSampleCount = parsePositiveInteger(next.value, '--rpc-sample-count', DEFAULT_RPC_SAMPLE_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--relay-count' || token.startsWith('--relay-count=')) {
      const next = readOptionValue(argv, index, '--relay-count');
      options.relayCount = parsePositiveInteger(next.value, '--relay-count', DEFAULT_RELAY_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--relay-payload-size' || token.startsWith('--relay-payload-size=')) {
      const next = readOptionValue(argv, index, '--relay-payload-size');
      options.relayPayloadSize = parsePositiveInteger(next.value, '--relay-payload-size', DEFAULT_RELAY_PAYLOAD_SIZE, 1, 262144);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 1000, 240000);
      index += next.consumed;
      continue;
    }
    if (token === '--browser-channel' || token.startsWith('--browser-channel=')) {
      const next = readOptionValue(argv, index, '--browser-channel');
      options.browserChannel = normalizeBrowserChannel(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--turn-ice-server' || token.startsWith('--turn-ice-server=')) {
      const next = readOptionValue(argv, index, '--turn-ice-server');
      options.turnIceServers.push(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--turn-username' || token.startsWith('--turn-username=')) {
      const next = readOptionValue(argv, index, '--turn-username');
      options.turnUsername = normalizeText(next.value, 256);
      index += next.consumed;
      continue;
    }
    if (token === '--turn-credential' || token.startsWith('--turn-credential=')) {
      const next = readOptionValue(argv, index, '--turn-credential');
      options.turnCredential = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (token === '--webtransport-url' || token.startsWith('--webtransport-url=')) {
      const next = readOptionValue(argv, index, '--webtransport-url');
      options.webTransportUrl = normalizeEndpoint(next.value, '--webtransport-url');
      index += next.consumed;
      continue;
    }
    if (token === '--webtransport-page-url' || token.startsWith('--webtransport-page-url=')) {
      const next = readOptionValue(argv, index, '--webtransport-page-url');
      options.webTransportPageUrl = normalizeEndpoint(next.value, '--webtransport-page-url');
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-dir' || token.startsWith('--diagnostics-dir=')) {
      const next = readOptionValue(argv, index, '--diagnostics-dir');
      options.diagnosticsDir = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  options.endpoint = normalizeEndpoint(options.endpoint, '--endpoint');
  options.nodeId = normalizeNodeId(options.nodeId);
  if (!path.posix.isAbsolute(options.remoteDir)) throw new Error('--remote-dir must be absolute');
  if (!options.sshTarget) throw new Error('--ssh is required');
  if (options.turnIceServers.length > 0 && (!options.turnUsername || !options.turnCredential)) {
    throw new Error('--turn-username and --turn-credential are required when --turn-ice-server is used');
  }
  return options;
}

function nodeRuntimePath(remoteDir) {
  return path.posix.join(
    remoteDir || DEFAULT_REMOTE_DIR,
    '.node-runtime',
    'node-v22.16.0-linux-x64',
    'bin',
    'node'
  );
}

function defaultNodeTokenFile(options = {}) {
  return path.posix.join(
    options.remoteDir || DEFAULT_REMOTE_DIR,
    '.aih-host-home',
    '.ai_home',
    'fabric',
    `${options.nodeId || DEFAULT_NODE_ID}.token`
  );
}

function numericMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 10) / 10 : 0;
}

function buildPromotionTransport(report = {}, options = {}, deps = {}) {
  const summary = report.summary || {};
  const gate = report.gates && report.gates.webrtc || {};
  if (summary.promotionReady !== true || gate.promotionReady !== true) return null;
  const now = Number(typeof deps.now === 'function' ? deps.now() : Date.now()) || Date.now();
  const ttl = Number(options.promotionTtlMs || DEFAULT_PROMOTION_TTL_MS) || DEFAULT_PROMOTION_TTL_MS;
  return {
    kind: 'webrtc',
    health: 'online',
    promotion: {
      remoteRequestReady: true,
      mode: normalizeText(gate.promotionMode || gate.mode || 'direct', 64),
      evidenceRef: normalizeText(options.promotionEvidenceRef || report.diagnosticsDir || report.generatedAt, 256),
      rttP95Ms: numericMetric(gate.rtt && gate.rtt.p95),
      rpcP95Ms: numericMetric(gate.rpc && gate.rpc.rtt && gate.rpc.rtt.p95),
      promotedAt: now,
      expiresAt: now + ttl
    }
  };
}

function buildRemotePromotionPublishCommand(options = {}, transportArg = '') {
  const remoteDir = options.remoteDir || DEFAULT_REMOTE_DIR;
  const nodePath = nodeRuntimePath(remoteDir);
  const hostHome = path.posix.join(remoteDir, '.aih-host-home');
  const port = Number(options.port || DEFAULT_PORT) || DEFAULT_PORT;
  const args = [
    'bin/ai-home.js',
    'fabric',
    'registry',
    'agent',
    `http://127.0.0.1:${port}`,
    '--once',
    '--node-id',
    options.nodeId || DEFAULT_NODE_ID,
    '--token-file',
    defaultNodeTokenFile(options),
    '--status',
    'online',
    '--relay-status',
    'online',
    '--transport',
    'relay=online',
    '--transport',
    transportArg,
    '--probe-transport',
    `relay=ws://127.0.0.1:${port}${DEFAULT_RELAY_ECHO_PATH}`,
    '--probe-timeout-ms',
    '10000',
    '--probe-count',
    String(options.relayCount || DEFAULT_RELAY_COUNT),
    '--probe-payload-size',
    String(options.relayPayloadSize || DEFAULT_RELAY_PAYLOAD_SIZE),
    '--runtime-diagnostics',
    '--json'
  ];
  const prefix = [
    `cd ${shQuote(remoteDir)}`,
    `NODE=${shQuote(nodePath)}`,
    'if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi'
  ].join(' && ');
  const command = [
    `AIH_HOST_HOME=${shQuote(hostHome)}`,
    '"$NODE"',
    ...args.map((arg) => shQuote(arg))
  ].join(' ');
  return `${prefix} && ${command}`;
}

function trimOutput(value, maxLength = 4096) {
  const text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function parseLastJsonLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (_error) {
      // Ignore shell noise and continue scanning older lines.
    }
  }
  return null;
}

async function publishPromotionToRegistry(report = {}, options = {}, deps = {}) {
  const transport = buildPromotionTransport(report, options, deps);
  if (!transport) {
    return {
      requested: true,
      ok: false,
      skipped: true,
      reason: 'promotion_not_ready'
    };
  }
  const transportArg = formatTransportHeartbeat(transport);
  const remoteCommand = buildRemotePromotionPublishCommand(options, transportArg);
  const spawnImpl = deps.spawn || spawn;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawnImpl('ssh', [
      ...buildSshArgs(options),
      options.sshTarget,
      remoteCommand
    ], {
      env: deps.env || process.env
    });
    child.stdout.on('data', (chunk) => {
      stdout += Buffer.from(chunk).toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.from(chunk).toString('utf8');
    });
    child.on('error', (error) => {
      resolve({
        requested: true,
        ok: false,
        skipped: false,
        transport: 'webrtc',
        error: normalizeText(error && error.message || error, 512),
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      });
    });
    child.on('close', (status, signal) => {
      const payload = parseLastJsonLine(stdout);
      resolve({
        requested: true,
        ok: status === 0 && (!payload || payload.ok !== false),
        skipped: false,
        transport: 'webrtc',
        nodeId: options.nodeId || DEFAULT_NODE_ID,
        status,
        signal: signal || '',
        promotion: transport.promotion,
        result: payload ? {
          attempts: Number(payload.attempts || 0),
          failures: Number(payload.failures || 0),
          counts: payload.lastResult && payload.lastResult.result && payload.lastResult.result.registry
            ? payload.lastResult.result.registry.counts || {}
            : {}
        } : null,
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr)
      });
    });
  });
}

function diagnosticsPath(options, name) {
  if (!options.diagnosticsDir) return '';
  return path.join(options.diagnosticsDir, `${name}.json`);
}

function buildPageUrl(endpoint, suffix) {
  return `${String(endpoint || '').replace(/\/+$/, '')}${suffix}`;
}

function buildHttpsUrlFromEndpoint(endpoint, suffix) {
  const parsed = new URL(endpoint);
  parsed.protocol = 'https:';
  parsed.pathname = suffix;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function buildWebSocketUrlFromEndpoint(endpoint, suffix) {
  const parsed = new URL(endpoint);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = suffix;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function hasRelayCandidate(report = {}) {
  const peers = [report.offerer, report.answerer, report.peer].filter(Boolean);
  return peers.some((peer) => {
    const local = peer.localCandidateKinds || {};
    const remote = peer.remoteCandidateKinds || {};
    const selected = peer.selectedCandidatePair || {};
    return Number(local.relay || 0) > 0
      || Number(remote.relay || 0) > 0
      || selected.localCandidateType === 'relay'
      || selected.remoteCandidateType === 'relay';
  });
}

function selectedPair(report = {}) {
  return report && report.offerer && report.offerer.selectedCandidatePair
    || report && report.peer && report.peer.selectedCandidatePair
    || null;
}

function isDirectCandidateType(type) {
  return DIRECT_CANDIDATE_TYPES.has(normalizeText(type, 32).toLowerCase());
}

function hasDirectCandidatePair(report = {}) {
  const pair = selectedPair(report);
  const local = normalizeText(pair && pair.localCandidateType, 32).toLowerCase();
  const remote = normalizeText(pair && pair.remoteCandidateType, 32).toLowerCase();
  if (!local || !remote) return false;
  if (local === 'relay' || remote === 'relay') return false;
  return isDirectCandidateType(local) && isDirectCandidateType(remote);
}

function hasCandidateKind(kinds = {}, predicate) {
  return Object.entries(kinds).some(([kind, count]) => {
    return Number(count || 0) > 0 && predicate(kind);
  });
}

function hasDirectCandidateKinds(report = {}) {
  const peers = [report.offerer, report.answerer, report.peer].filter(Boolean);
  if (peers.length === 0) return false;
  let hasDirectLocal = false;
  let hasDirectRemote = false;
  for (const peer of peers) {
    const local = peer.localCandidateKinds || {};
    const remote = peer.remoteCandidateKinds || {};
    if (hasCandidateKind(local, (kind) => normalizeText(kind, 32).toLowerCase() === 'relay')) return false;
    if (hasCandidateKind(remote, (kind) => normalizeText(kind, 32).toLowerCase() === 'relay')) return false;
    hasDirectLocal = hasDirectLocal || hasCandidateKind(local, isDirectCandidateType);
    hasDirectRemote = hasDirectRemote || hasCandidateKind(remote, isDirectCandidateType);
  }
  return hasDirectLocal && hasDirectRemote;
}

function hasDirectCandidateEvidence(report = {}) {
  return hasDirectCandidatePair(report) || hasDirectCandidateKinds(report);
}

function appendUnique(items, values) {
  values.forEach((value) => {
    const text = normalizeText(value, 256);
    if (text && !items.includes(text)) items.push(text);
  });
  return items;
}

function classifyWebrtcDirect(report = {}, options = {}, turnGate = {}) {
  const blockers = [];
  if (!report.ok) blockers.push('webrtc_datachannel_smoke_failed');
  const rpc = report.rpc || {};
  if (!rpc.ok) blockers.push('remote_rpc_webrtc_adapter_not_ready');
  const allowDirect = options.allowDirectWebrtcPromotion === true;
  if (allowDirect) {
    const rtt = report.rtt || {};
    const maxP95 = parsePositiveInteger(
      options.directWebrtcMaxP95Ms,
      '--direct-webrtc-max-p95-ms',
      DEFAULT_DIRECT_WEBRTC_MAX_P95_MS,
      1,
      60000
    );
    const minSamples = Math.max(1, Number(options.sampleCount) || DEFAULT_SAMPLE_COUNT);
    if (!hasDirectCandidateEvidence(report)) blockers.push('webrtc_direct_pair_not_verified');
    if (Number(rtt.count || 0) < minSamples) blockers.push('webrtc_direct_rtt_samples_missing');
    if (!Number.isFinite(Number(rtt.p95))) blockers.push('webrtc_direct_p95_missing');
    else if (Number(rtt.p95) > maxP95) blockers.push('webrtc_direct_p95_over_threshold');
  } else if (!turnGate.promotionReady) {
    blockers.push('turn_relay_gate_not_ready');
  }
  return {
    ran: true,
    candidateReady: Boolean(report.ok),
    promotionReady: blockers.length === 0,
    promotionMode: allowDirect ? 'direct' : 'turn-relay-required',
    directPromotion: allowDirect ? {
      allowed: true,
      maxP95Ms: Number(options.directWebrtcMaxP95Ms || DEFAULT_DIRECT_WEBRTC_MAX_P95_MS),
      selectedCandidatePair: selectedPair(report),
      directPairVerified: hasDirectCandidatePair(report),
      directCandidateKindsVerified: hasDirectCandidateKinds(report),
      directCandidateVerified: hasDirectCandidateEvidence(report)
    } : {
      allowed: false
    },
    mode: report.mode || 'webrtc-datachannel-smoke',
    rtt: report.rtt || {},
    rpc,
    selectedCandidatePair: selectedPair(report),
    candidateKinds: {
      offererLocal: report.offerer && report.offerer.localCandidateKinds || {},
      offererRemote: report.offerer && report.offerer.remoteCandidateKinds || {},
      answererLocal: report.answerer && report.answerer.localCandidateKinds || {},
      answererRemote: report.answerer && report.answerer.remoteCandidateKinds || {}
    },
    blockers
  };
}

function classifyTurnRelay(report = {}, configured, defaultPortUdp = null) {
  const udp = defaultPortUdp || null;
  if (!configured) {
    const blockers = ['turn_ice_server_not_configured'];
    if (udp && udp.ran && !udp.candidateReady) appendUnique(blockers, udp.blockers || []);
    return {
      ran: false,
      candidateReady: false,
      promotionReady: false,
      defaultPortUdp: udp || undefined,
      blockers
    };
  }
  const blockers = [];
  if (!report.ok) blockers.push('turn_relay_datachannel_smoke_failed');
  if (!hasRelayCandidate(report)) blockers.push('turn_relay_candidate_missing');
  return {
    ran: true,
    candidateReady: Boolean(report.ok && hasRelayCandidate(report)),
    promotionReady: blockers.length === 0,
    rtt: report.rtt || {},
    iceServers: report.iceServers || [],
    iceTransportPolicy: report.iceTransportPolicy || 'relay',
    defaultPortUdp: udp || undefined,
    blockers
  };
}

function classifyRelayBaseline(report = {}) {
  const blockers = [];
  if (!report.ok) blockers.push('relay_echo_failed');
  if (Number(report.successes || 0) < Number(report.count || 0)) blockers.push('relay_echo_incomplete');
  if (Number(report.rttMs && report.rttMs.count || 0) < Number(report.count || 0)) blockers.push('relay_rtt_samples_missing');
  return {
    ran: true,
    candidateReady: Boolean(report.ok),
    promotionReady: blockers.length === 0,
    target: report.target || '',
    count: Number(report.count || 0),
    successes: Number(report.successes || 0),
    payloadSize: Number(report.payloadSize || 0),
    rtt: report.rttMs || {},
    failures: Array.isArray(report.failures) ? report.failures : [],
    blockers: Array.from(new Set(blockers))
  };
}

function classifyWebTransport(report = {}) {
  const probe = report.probe || {};
  const blockers = [];
  if (!report.ok) {
    blockers.push(probe.failureReason || 'webtransport_smoke_failed');
  }
  if (!probe.isSecureContext) blockers.push('webtransport_secure_context_missing');
  if (probe.webTransportType !== 'function') blockers.push('webtransport_browser_api_unavailable');
  if (
    probe.failureReason === 'webtransport_connect_failed'
    && probe.isSecureContext
    && probe.webTransportType === 'function'
  ) {
    blockers.push('webtransport_h3_endpoint_missing');
  }
  return {
    ran: true,
    candidateReady: Boolean(report.ok),
    promotionReady: blockers.length === 0,
    webTransportUrl: report.webTransportUrl || '',
    connectMs: Number(probe.connectMs || 0),
    streamRttMs: Number(probe.streamRttMs || 0),
    failureReason: probe.failureReason || '',
    blockers: Array.from(new Set(blockers))
  };
}

function classifyMultipath(report = {}) {
  const summary = report.summary || {};
  return {
    ran: true,
    candidateReady: Boolean(summary.defaultPortReachable),
    promotionReady: Boolean(summary.promotionReady),
    verdict: summary.verdict || '',
    blockers: Array.isArray(summary.blockers) ? summary.blockers : [],
    local: summary.local || {},
    remote: summary.remote || {},
    openMptcpRouterDetected: Boolean(summary.openMptcpRouterDetected)
  };
}

function classifyErroredProbe(error, blocker) {
  return {
    ran: true,
    candidateReady: false,
    promotionReady: false,
    error: {
      message: String(error && error.message || error || blocker)
    },
    blockers: [blocker]
  };
}

async function runProbe(name, runner) {
  try {
    return { name, report: await runner(), error: null };
  } catch (error) {
    return { name, report: null, error };
  }
}

function collectGateNames(gates = {}, predicate = () => false) {
  return Object.entries(gates)
    .filter(([, gate]) => gate && !gate.skipped && predicate(gate))
    .map(([name]) => name);
}

function buildSummary(gates = {}, options = {}) {
  const allBlockers = [];
  Object.entries(gates).forEach(([name, gate]) => {
    if (!gate || gate.skipped) return;
    if (gate.promotionReady) return;
    appendUnique(allBlockers, (gate.blockers || []).map((item) => `${name}:${item}`));
  });
  const relayGate = gates.relay || null;
  const promoted = Object.entries(gates)
    .filter(([name]) => name !== 'relay')
    .filter(([, gate]) => gate && gate.promotionReady)
    .map(([name]) => name);
  const fallbackReady = Boolean(relayGate && relayGate.promotionReady);
  const fallbackTransport = fallbackReady ? 'relay' : 'none';
  const defaultTransport = promoted.length > 0 ? promoted[0] : fallbackTransport;
  const defaultTransportScope = promoted.length > 0
    ? 'promoted_transport'
    : (fallbackReady ? 'fallback_transport' : 'none');
  return {
    promotionReady: promoted.length > 0,
    promotedTransports: promoted,
    defaultTransport,
    defaultTransportScope,
    fallbackRequired: promoted.length === 0,
    fallbackTransport,
    fallbackReady,
    candidateTransports: collectGateNames(gates, (gate) => gate.candidateReady === true),
    blockedTransports: collectGateNames(gates, (gate) => gate.promotionReady !== true && Array.isArray(gate.blockers) && gate.blockers.length > 0),
    promotionPolicy: {
      webrtc: options.allowDirectWebrtcPromotion === true ? 'direct_allowed' : 'turn_relay_required',
      directWebrtcMaxP95Ms: Number(options.directWebrtcMaxP95Ms || DEFAULT_DIRECT_WEBRTC_MAX_P95_MS)
    },
    blockers: promoted.length > 0 ? [] : allBlockers,
    nonPromotedGateBlockers: allBlockers
  };
}

async function runPromotionGate(options = {}, deps = {}) {
  options = {
    endpoint: DEFAULT_ENDPOINT,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    nodeId: DEFAULT_NODE_ID,
    port: DEFAULT_PORT,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    rpcSampleCount: DEFAULT_RPC_SAMPLE_COUNT,
    relayCount: DEFAULT_RELAY_COUNT,
    relayPayloadSize: DEFAULT_RELAY_PAYLOAD_SIZE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    browserChannel: DEFAULT_BROWSER_CHANNEL,
    turnIceServers: [],
    turnUsername: '',
    turnCredential: '',
    webTransportUrl: '',
    webTransportPageUrl: DEFAULT_SECURE_PROBE_PAGE_URL,
    diagnosticsDir: '',
    diagnosticsFile: '',
    headed: false,
    allowDirectWebrtcPromotion: false,
    directWebrtcMaxP95Ms: DEFAULT_DIRECT_WEBRTC_MAX_P95_MS,
    publishPromotion: false,
    promotionTtlMs: DEFAULT_PROMOTION_TTL_MS,
    promotionEvidenceRef: '',
    skipRelay: false,
    skipWebrtc: false,
    skipTurn: false,
    skipTurnUdpProbe: false,
    skipWebTransport: false,
    skipMultipath: false,
    ...options
  };
  const startedAt = Date.now();
  const endpoint = normalizeEndpoint(options.endpoint || DEFAULT_ENDPOINT);
  const diagnosticsDir = options.diagnosticsDir || '';
  if (diagnosticsDir) fs.mkdirSync(diagnosticsDir, { recursive: true });

  const turnConfigured = Array.isArray(options.turnIceServers) && options.turnIceServers.length > 0;
  const probes = {};

  if (!options.skipRelay) {
    probes.relay = await runProbe('relay', () => (deps.runFabricTransportEcho || runFabricTransportEcho)([
      buildWebSocketUrlFromEndpoint(endpoint, DEFAULT_RELAY_ECHO_PATH),
      '--count',
      String(options.relayCount),
      '--payload-size',
      String(options.relayPayloadSize),
      '--timeout-ms',
      String(Math.min(options.timeoutMs, 30000)),
      '--json'
    ], deps));
    if (probes.relay.report && diagnosticsDir) {
      await writeDiagnosticsFile(diagnosticsPath({ diagnosticsDir }, 'relay'), probes.relay.report);
    }
  }

  if (!options.skipTurn && !options.skipTurnUdpProbe) {
    probes.turnUdp = await runProbe('turn-default-udp', () => (deps.runDefaultPortUdpProbe || runDefaultPortUdpProbe)({
      endpoint,
      sshTarget: options.sshTarget,
      sshKey: options.sshKey,
      remoteDir: options.remoteDir,
      port: options.port
    }, deps));
    if (probes.turnUdp.report && diagnosticsDir) {
      await writeDiagnosticsFile(diagnosticsPath({ diagnosticsDir }, 'turn-default-udp'), probes.turnUdp.report);
    }
  }

  if (!options.skipTurn && turnConfigured) {
    probes.turn = await runProbe('turn', () => (deps.runWebrtcDatachannelSmoke || runWebrtcDatachannelSmoke)({
      endpoint,
      pageUrl: buildPageUrl(endpoint, '/ui/fabric/webrtc-diagnostics'),
      iceServerUrls: normalizeIceServerList(options.turnIceServers, { useDefaultStun: false }),
      iceUsername: options.turnUsername,
      iceCredential: options.turnCredential,
      iceTransportPolicy: 'relay',
      sampleCount: options.sampleCount,
      rpcSampleCount: options.rpcSampleCount,
      timeoutMs: options.timeoutMs,
      diagnosticsFile: diagnosticsPath({ diagnosticsDir }, 'turn-relay'),
      browserChannel: options.browserChannel,
      headed: options.headed === true
    }, deps));
  }

  const defaultPortUdp = classifyDefaultPortUdpProbe(
    probes.turnUdp && probes.turnUdp.report,
    probes.turnUdp && probes.turnUdp.error,
    Boolean(options.skipTurn || options.skipTurnUdpProbe)
  );
  const turnGate = options.skipTurn
    ? { skipped: true, reason: 'skip_turn' }
    : probes.turn
      ? probes.turn.error
        ? classifyErroredProbe(probes.turn.error, 'turn_relay_probe_failed')
        : classifyTurnRelay(probes.turn.report, true, defaultPortUdp)
      : classifyTurnRelay(null, false, defaultPortUdp);

  if (!options.skipWebrtc) {
    probes.webrtc = await runProbe('webrtc', () => (deps.runWebrtcDatachannelSmoke || runWebrtcDatachannelSmoke)({
      endpoint,
      pageUrl: buildPageUrl(endpoint, '/ui/fabric/webrtc-diagnostics'),
      iceServerUrls: DEFAULT_ICE_SERVERS.slice(),
      iceTransportPolicy: DEFAULT_ICE_TRANSPORT_POLICY,
      sampleCount: options.sampleCount,
      rpcSampleCount: options.rpcSampleCount,
      timeoutMs: options.timeoutMs,
      diagnosticsFile: diagnosticsPath({ diagnosticsDir }, 'webrtc-direct'),
      browserChannel: options.browserChannel,
      headed: options.headed === true
    }, deps));
  }

  if (!options.skipWebTransport) {
    probes.webtransport = await runProbe('webtransport', () => (deps.runWebTransportSmoke || runWebTransportSmoke)({
      endpoint,
      pageUrl: options.webTransportPageUrl || DEFAULT_SECURE_PROBE_PAGE_URL,
      webTransportUrl: options.webTransportUrl || buildHttpsUrlFromEndpoint(endpoint, DEFAULT_WEBTRANSPORT_PATH),
      timeoutMs: Math.min(options.timeoutMs, 30000),
      diagnosticsFile: diagnosticsPath({ diagnosticsDir }, 'webtransport'),
      browserChannel: options.browserChannel,
      headed: options.headed === true
    }, deps));
  }

  if (!options.skipMultipath) {
    probes.multipath = await runProbe('multipath', () => (deps.runMultipathDiagnosis || runMultipathDiagnosis)({
      endpoint,
      sshTarget: options.sshTarget,
      sshKey: options.sshKey,
      json: true
    }));
    if (probes.multipath.report && diagnosticsDir) {
      await writeDiagnosticsFile(diagnosticsPath({ diagnosticsDir }, 'multipath'), probes.multipath.report);
    }
  }

  const gates = {
    relay: options.skipRelay
      ? { skipped: true, reason: 'skip_relay' }
      : probes.relay && probes.relay.error
        ? classifyErroredProbe(probes.relay.error, 'relay_probe_failed')
        : classifyRelayBaseline(probes.relay && probes.relay.report || {}),
    webrtc: options.skipWebrtc
      ? { skipped: true, reason: 'skip_webrtc' }
      : probes.webrtc && probes.webrtc.error
        ? classifyErroredProbe(probes.webrtc.error, 'webrtc_datachannel_probe_failed')
        : classifyWebrtcDirect(probes.webrtc && probes.webrtc.report || {}, options, turnGate),
    turn: turnGate,
    webtransport: options.skipWebTransport
      ? { skipped: true, reason: 'skip_webtransport' }
      : probes.webtransport && probes.webtransport.error
        ? classifyErroredProbe(probes.webtransport.error, 'webtransport_probe_failed')
        : classifyWebTransport(probes.webtransport && probes.webtransport.report || {}),
    multipath: options.skipMultipath
      ? { skipped: true, reason: 'skip_multipath' }
      : probes.multipath && probes.multipath.error
        ? classifyErroredProbe(probes.multipath.error, 'multipath_probe_failed')
        : classifyMultipath(probes.multipath && probes.multipath.report || {})
  };

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    target: {
      endpoint,
      ssh: options.sshTarget,
      remoteDir: options.remoteDir,
      nodeId: options.nodeId,
      port: options.port
    },
    diagnosticsDir,
    gates,
    summary: buildSummary(gates, options)
  };
  if (options.publishPromotion) {
    report.publishPromotion = await publishPromotionToRegistry(report, options, deps);
    report.summary.promotionPublished = report.publishPromotion.ok === true;
    if (!report.publishPromotion.ok) report.ok = false;
  }
  if (options.diagnosticsFile) await writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

function formatReport(report = {}) {
  const lines = [];
  lines.push('AIH Fabric M6 transport promotion gate');
  lines.push(`  endpoint: ${report.target && report.target.endpoint || ''}`);
  lines.push(`  promotion_ready: ${report.summary && report.summary.promotionReady ? 'yes' : 'no'}`);
  lines.push(`  default_transport: ${report.summary && report.summary.defaultTransport || 'relay'}`);
  lines.push(`  default_transport_scope: ${report.summary && report.summary.defaultTransportScope || ''}`);
  lines.push(`  fallback_transport: ${report.summary && report.summary.fallbackTransport || ''}`);
  lines.push(`  webrtc_policy: ${report.summary && report.summary.promotionPolicy && report.summary.promotionPolicy.webrtc || ''}`);
  Object.entries(report.gates || {}).forEach(([name, gate]) => {
    if (gate.skipped) {
      lines.push(`  ${name}: skipped (${gate.reason || 'skip'})`);
      return;
    }
    lines.push(`  ${name}: candidate=${gate.candidateReady ? 'yes' : 'no'} promotion=${gate.promotionReady ? 'yes' : 'no'}`);
    (gate.blockers || []).forEach((blocker) => lines.push(`    - ${blocker}`));
  });
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runPromotionGate(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  if (report.ok === false || (options.failOnBlocked && !report.summary.promotionReady)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-m6-promotion-gate] ${String(error && error.message || error)}`);
    process.exit(1);
  });
}

module.exports = {
  buildHttpsUrlFromEndpoint,
  buildWebSocketUrlFromEndpoint,
  buildSummary,
  classifyDefaultPortUdpProbe,
  classifyRelayBaseline,
  classifyMultipath,
  classifyTurnRelay,
  classifyWebTransport,
  classifyWebrtcDirect,
  formatReport,
  buildPromotionTransport,
  buildRemotePromotionPublishCommand,
  parseArgs,
  publishPromotionToRegistry,
  runPromotionGate
};
