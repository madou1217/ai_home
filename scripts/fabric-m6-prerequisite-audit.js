#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_ENDPOINT,
  DEFAULT_RPC_SAMPLE_COUNT,
  normalizeIceServerList,
  runWebrtcDatachannelSmoke,
  sanitizeIceServerUrls,
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
  runPreflight
} = require('./fabric-m3-daemon-preflight');
const {
  classifyDefaultPortUdpProbe,
  runDefaultPortUdpProbe
} = require('./fabric-default-udp-probe');
const {
  buildHttpsUrlFromEndpoint,
  classifyMultipath,
  classifyTurnRelay,
  classifyWebTransport
} = require('./fabric-m6-promotion-gate');

const DEFAULT_PAGE_PATH = '/ui/fabric/webrtc-diagnostics';
const DEFAULT_SECURE_PROBE_PAGE_URL = 'https://example.com/';
const DEFAULT_SSH_TARGET = 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com';
const DEFAULT_SSH_KEY = '~/.ssh/aws.pem';
const DEFAULT_REMOTE_DIR = '/home/ubuntu/aih-fabric-current';
const DEFAULT_NODE_ID = 'aws-current-node';
const DEFAULT_PORT = 9527;
const DEFAULT_SAMPLE_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_BROWSER_CHANNEL = 'chrome';

function showHelp() {
  console.log(`AIH Fabric M6 prerequisite audit

Usage:
  node scripts/fabric-m6-prerequisite-audit.js [options]

Options:
  --endpoint <url>              AWS/current endpoint, default ${DEFAULT_ENDPOINT}.
  --ssh <user@host>             SSH target, default ${DEFAULT_SSH_TARGET}.
  --ssh-key <pem>               SSH key, default ${DEFAULT_SSH_KEY}.
  --remote-dir <path>           AWS current dir, default ${DEFAULT_REMOTE_DIR}.
  --node-id <id>                Fabric node id, default ${DEFAULT_NODE_ID}.
  --port <n>                    AIH server port, default ${DEFAULT_PORT}.
  --turn-ice-server <url>       Controlled TURN URL. Can be passed multiple times.
  --turn-username <value>       TURN username.
  --turn-credential <value>     TURN credential.
  --webtransport-url <url>      WebTransport URL, default HTTPS probe on endpoint ${DEFAULT_WEBTRANSPORT_PATH}.
  --webtransport-page-url <url> Secure browser page URL, default ${DEFAULT_SECURE_PROBE_PAGE_URL}.
  --sample-count <n>            TURN relay RTT samples, default ${DEFAULT_SAMPLE_COUNT}.
  --rpc-sample-count <n>        TURN DataChannel RPC samples, default ${DEFAULT_RPC_SAMPLE_COUNT}.
  --timeout-ms <n>              Browser probe timeout, default ${DEFAULT_TIMEOUT_MS}.
  --browser-channel <c>         Playwright browser channel, default ${DEFAULT_BROWSER_CHANNEL}; use bundled for Chromium.
  --diagnostics-dir <path>      Write individual probe JSON files under this directory.
  --diagnostics-file <path>     Write aggregate audit JSON.
  --headed                      Show browser windows for browser-backed probes.
  --skip-preflight              Skip AWS current daemon/registry preflight.
  --skip-turn-udp-probe         Skip default UDP ${DEFAULT_PORT} reachability probe for self-hosted TURN feasibility.
  --skip-turn-smoke             Do not run relay-only TURN smoke even when credentials exist.
  --skip-webtransport           Skip WebTransport endpoint probe.
  --skip-multipath              Skip MPTCP/OpenMPTCPRouter diagnosis.
  --fail-on-blocked             Exit non-zero when no advanced transport prerequisite is promotion-ready.
  --json                        Print JSON only.
  -h, --help                    Show this help.

Environment defaults are read only when present:
  AIH_TURN_ICE_SERVER / AIH_TURN_ICE_SERVERS
  AIH_TURN_USERNAME
  AIH_TURN_CREDENTIAL
  AIH_WEBTRANSPORT_URL / AIH_M6_WEBTRANSPORT_URL
  AIH_WEBTRANSPORT_PAGE_URL / AIH_M6_WEBTRANSPORT_PAGE_URL

The audit is read-only. It does not import provider credentials, open product
ports, install TURN/QUIC software, or touch retired VPS targets.
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

function resolveLocalPath(value) {
  return path.resolve(String(value || '').replace(/^~(?=\/|$)/, process.env.HOME || ''));
}

function normalizeHttpUrl(value, flag) {
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

function normalizeBrowserChannel(value) {
  const normalized = normalizeText(value, 120);
  if (!normalized) return '';
  if (['bundled', 'chromium', 'playwright'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

function splitList(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function envValue(env, names) {
  for (const name of names) {
    const value = normalizeText(env && env[name], 4096);
    if (value) return value;
  }
  return '';
}

function buildDefaultWebTransportUrl(endpoint) {
  return buildHttpsUrlFromEndpoint(endpoint, DEFAULT_WEBTRANSPORT_PATH);
}

function buildPageUrl(endpoint) {
  return `${String(endpoint || '').replace(/\/+$/, '')}${DEFAULT_PAGE_PATH}`;
}

function parseArgs(argv = [], env = process.env) {
  const envTurnServers = splitList(envValue(env, ['AIH_TURN_ICE_SERVERS', 'AIH_TURN_ICE_SERVER']));
  const options = {
    help: false,
    json: false,
    endpoint: DEFAULT_ENDPOINT,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    nodeId: DEFAULT_NODE_ID,
    port: DEFAULT_PORT,
    turnIceServers: envTurnServers,
    turnUsername: envValue(env, ['AIH_TURN_USERNAME']),
    turnCredential: envValue(env, ['AIH_TURN_CREDENTIAL']),
    webTransportUrl: envValue(env, ['AIH_WEBTRANSPORT_URL', 'AIH_M6_WEBTRANSPORT_URL']),
    webTransportPageUrl: envValue(env, ['AIH_WEBTRANSPORT_PAGE_URL', 'AIH_M6_WEBTRANSPORT_PAGE_URL']) || DEFAULT_SECURE_PROBE_PAGE_URL,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    rpcSampleCount: DEFAULT_RPC_SAMPLE_COUNT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    browserChannel: DEFAULT_BROWSER_CHANNEL,
    diagnosticsDir: '',
    diagnosticsFile: '',
    headed: false,
    skipPreflight: false,
    skipTurnUdpProbe: false,
    skipTurnSmoke: false,
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
    if (token === '--skip-preflight') {
      options.skipPreflight = true;
      index += 1;
      continue;
    }
    if (token === '--skip-turn-udp-probe') {
      options.skipTurnUdpProbe = true;
      index += 1;
      continue;
    }
    if (token === '--skip-turn-smoke') {
      options.skipTurnSmoke = true;
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
      options.endpoint = normalizeHttpUrl(next.value, '--endpoint');
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
    if (token === '--remote-dir' || token.startsWith('--remote-dir=')) {
      const next = readOptionValue(argv, index, '--remote-dir');
      options.remoteDir = normalizeText(next.value, 1024);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = normalizeText(next.value, 256);
      index += next.consumed;
      continue;
    }
    if (token === '--port' || token.startsWith('--port=')) {
      const next = readOptionValue(argv, index, '--port');
      options.port = parsePositiveInteger(next.value, '--port', DEFAULT_PORT, 1, 65535);
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
      options.webTransportUrl = normalizeHttpUrl(next.value, '--webtransport-url');
      index += next.consumed;
      continue;
    }
    if (token === '--webtransport-page-url' || token.startsWith('--webtransport-page-url=')) {
      const next = readOptionValue(argv, index, '--webtransport-page-url');
      options.webTransportPageUrl = normalizeHttpUrl(next.value, '--webtransport-page-url');
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

  options.endpoint = normalizeHttpUrl(options.endpoint, '--endpoint');
  if (!options.webTransportUrl) options.webTransportUrl = buildDefaultWebTransportUrl(options.endpoint);
  options.webTransportPageUrl = normalizeHttpUrl(options.webTransportPageUrl, '--webtransport-page-url');
  if (!path.posix.isAbsolute(options.remoteDir)) throw new Error('--remote-dir must be absolute');
  if (!options.sshTarget) throw new Error('--ssh is required');
  if (!options.nodeId) throw new Error('--node-id is required');
  return options;
}

function diagnosticsPath(options, name) {
  if (!options.diagnosticsDir) return '';
  return path.join(options.diagnosticsDir, `${name}.json`);
}

function buildTurnConfig(options = {}) {
  const allUrls = normalizeIceServerList(options.turnIceServers || [], { useDefaultStun: false });
  const turnUrls = allUrls.filter((url) => /^turns?:/i.test(url));
  const nonTurnUrls = allUrls.filter((url) => !/^turns?:/i.test(url));
  const username = normalizeText(options.turnUsername, 256);
  const credential = String(options.turnCredential || '');
  const blockers = [];

  if (allUrls.length === 0) blockers.push('turn_ice_server_not_configured');
  if (allUrls.length > 0 && turnUrls.length === 0) blockers.push('turn_ice_server_not_turn_url');
  if (turnUrls.length > 0 && !username) blockers.push('turn_username_missing');
  if (turnUrls.length > 0 && !credential) blockers.push('turn_credential_missing');

  return {
    configured: blockers.length === 0,
    allUrls,
    turnUrls,
    nonTurnUrls,
    username,
    credential,
    blockers
  };
}

function redactedTurnConfiguration(config = {}) {
  return {
    iceServers: sanitizeIceServerUrls(config.allUrls || []),
    turnServers: sanitizeIceServerUrls(config.turnUrls || []),
    ignoredIceServers: sanitizeIceServerUrls(config.nonTurnUrls || []),
    username: config.username ? '<set>' : '',
    credential: config.credential ? '<redacted>' : ''
  };
}

function classifyAwsPreflight(report = {}) {
  const blockers = [];
  if (!report.ok) blockers.push('aws_preflight_failed');
  if (Array.isArray(report.remainingGate)) {
    report.remainingGate.forEach((item) => {
      const blocker = normalizeText(item, 256);
      if (blocker) blockers.push(blocker);
    });
  }
  return {
    ran: true,
    candidateReady: Boolean(report.ok),
    promotionReady: Boolean(report.ok),
    target: report.target || {},
    server: report.server || {},
    serviceStatus: report.serviceStatus || {},
    registry: report.registry || {},
    residue: Array.isArray(report.residue) ? report.residue : [],
    blockers: Array.from(new Set(blockers))
  };
}

function classifyTurnPrerequisite(config = {}, report = null, error = null, skipped = false, defaultPortUdp = null) {
  const udp = defaultPortUdp || null;
  if (skipped) {
    return {
      skipped: true,
      reason: 'skip_turn_smoke',
      candidateReady: false,
      promotionReady: false,
      configuration: redactedTurnConfiguration(config),
      defaultPortUdp: udp || undefined,
      blockers: ['turn_relay_smoke_skipped']
    };
  }
  if (!config.configured) {
    const blockers = Array.from(new Set([
      ...(config.blockers || ['turn_ice_server_not_configured']),
      ...((udp && udp.ran && !udp.candidateReady) ? (udp.blockers || []) : [])
    ]));
    return {
      ran: false,
      candidateReady: false,
      promotionReady: false,
      configuration: redactedTurnConfiguration(config),
      defaultPortUdp: udp || undefined,
      blockers
    };
  }
  if (error) {
    return {
      ran: true,
      candidateReady: false,
      promotionReady: false,
      configuration: redactedTurnConfiguration(config),
      defaultPortUdp: udp || undefined,
      error: { message: String(error && error.message || error || 'turn_relay_probe_failed') },
      blockers: ['turn_relay_probe_failed']
    };
  }
  return {
    ...classifyTurnRelay(report || {}, true),
    configuration: redactedTurnConfiguration(config),
    defaultPortUdp: udp || undefined
  };
}

function classifyWebTransportPrerequisite(report = null, error = null, options = {}) {
  if (error) {
    return {
      ran: true,
      candidateReady: false,
      promotionReady: false,
      webTransportUrl: options.webTransportUrl || '',
      error: { message: String(error && error.message || error || 'webtransport_probe_failed') },
      blockers: ['webtransport_probe_failed']
    };
  }
  const gate = classifyWebTransport(report || {});
  const blockers = gate.blockers.slice();
  try {
    const parsed = new URL(options.webTransportUrl || gate.webTransportUrl || '');
    if (parsed.protocol !== 'https:') blockers.push('webtransport_url_not_https');
  } catch (_error) {
    blockers.push('webtransport_url_invalid');
  }
  return {
    ...gate,
    pageUrl: options.webTransportPageUrl || '',
    blockers: Array.from(new Set(blockers)),
    promotionReady: gate.promotionReady && blockers.length === 0
  };
}

function classifyMultipathPrerequisite(report = null, error = null) {
  if (error) {
    return {
      ran: true,
      candidateReady: false,
      promotionReady: false,
      error: { message: String(error && error.message || error || 'multipath_probe_failed') },
      blockers: ['multipath_probe_failed']
    };
  }
  return classifyMultipath(report || {});
}

async function runProbe(name, runner) {
  try {
    return { name, report: await runner(), error: null };
  } catch (error) {
    return { name, report: null, error };
  }
}

function appendPrefixedBlockers(blockers, name, gate) {
  if (!gate || gate.skipped) return;
  (gate.blockers || []).forEach((blocker) => {
    const text = normalizeText(blocker, 256);
    if (text) blockers.push(`${name}:${text}`);
  });
}

function buildDiagnosticConcurrencySummary(gates = {}) {
  const blockers = [];
  Object.entries(gates || {}).forEach(([name, gate]) => {
    if (!gate || gate.skipped) return;
    (gate.blockers || []).forEach((blocker) => {
      const text = normalizeText(blocker, 256);
      if (text === 'turn_default_udp_probe_busy') blockers.push(`${name}:${text}`);
    });
  });
  return {
    blocked: blockers.length > 0,
    blockers: Array.from(new Set(blockers)),
    reason: blockers.length > 0
      ? 'Another Fabric transport diagnostic is already binding the default UDP probe port.'
      : '',
    nextAction: blockers.length > 0
      ? 'Run only one default UDP transport diagnostic at a time, then re-run prerequisites or cloud-edge.'
      : ''
  };
}

function buildDiagnosticContextSummary(gates = {}) {
  const blockers = [];
  Object.entries(gates || {}).forEach(([name, gate]) => {
    if (!gate || gate.skipped) return;
    (gate.blockers || []).forEach((blocker) => {
      const text = normalizeText(blocker, 256);
      if (text === 'turn_default_udp_target_local_only') blockers.push(`${name}:${text}`);
    });
  });
  return {
    blocked: blockers.length > 0,
    blockers: Array.from(new Set(blockers)),
    reason: blockers.length > 0
      ? 'The UDP probe ran on the target node itself, so it cannot prove client-to-cloud UDP reachability.'
      : '',
    nextAction: blockers.length > 0
      ? 'Run the cloud-edge diagnostic from the client side, or pass an explicit remote SSH target that represents the node.'
      : ''
  };
}

function buildSummary(gates = {}) {
  const baseReady = !gates.aws || gates.aws.skipped || gates.aws.promotionReady === true;
  const readyTransports = [];
  if (baseReady && gates.turn && gates.turn.promotionReady) readyTransports.push('webrtc-turn-relay');
  if (baseReady && gates.webtransport && gates.webtransport.promotionReady) readyTransports.push('webtransport');
  if (baseReady && gates.multipath && gates.multipath.promotionReady) readyTransports.push('multipath');

  const blockers = [];
  appendPrefixedBlockers(blockers, 'aws', gates.aws);
  appendPrefixedBlockers(blockers, 'turn', gates.turn);
  appendPrefixedBlockers(blockers, 'webtransport', gates.webtransport);
  appendPrefixedBlockers(blockers, 'multipath', gates.multipath);
  const diagnosticConcurrency = buildDiagnosticConcurrencySummary(gates);
  const diagnosticContext = buildDiagnosticContextSummary(gates);

  return {
    baseReady,
    promotionReady: readyTransports.length > 0,
    readyTransports,
    blockers: Array.from(new Set(blockers)),
    diagnosticConcurrency,
    diagnosticContext
  };
}

async function runPrerequisiteAudit(options = {}, deps = {}) {
  options = {
    endpoint: DEFAULT_ENDPOINT,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    nodeId: DEFAULT_NODE_ID,
    port: DEFAULT_PORT,
    turnIceServers: [],
    turnUsername: '',
    turnCredential: '',
    webTransportUrl: '',
    webTransportPageUrl: DEFAULT_SECURE_PROBE_PAGE_URL,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    rpcSampleCount: DEFAULT_RPC_SAMPLE_COUNT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    browserChannel: DEFAULT_BROWSER_CHANNEL,
    diagnosticsDir: '',
    diagnosticsFile: '',
    headed: false,
    skipPreflight: false,
    skipTurnUdpProbe: false,
    skipTurnSmoke: false,
    skipWebTransport: false,
    skipMultipath: false,
    ...options
  };
  options.endpoint = normalizeHttpUrl(options.endpoint, '--endpoint');
  if (!options.webTransportUrl) options.webTransportUrl = buildDefaultWebTransportUrl(options.endpoint);
  const diagnosticsDir = options.diagnosticsDir || '';
  if (diagnosticsDir) fs.mkdirSync(diagnosticsDir, { recursive: true });
  const startedAt = Date.now();
  const turnConfig = buildTurnConfig(options);
  const probes = {};

  if (!options.skipPreflight) {
    probes.aws = await runProbe('aws', () => (deps.runPreflight || runPreflight)({
      sshTarget: options.sshTarget,
      sshKey: options.sshKey,
      remoteDir: options.remoteDir,
      nodeId: options.nodeId,
      port: options.port
    }, deps));
    if (probes.aws.report && diagnosticsDir) {
      await writeDiagnosticsFile(diagnosticsPath({ diagnosticsDir }, 'aws-preflight'), probes.aws.report);
    }
  }

  if (!options.skipTurnUdpProbe) {
    probes.turnUdp = await runProbe('turn-default-udp', () => (deps.runDefaultPortUdpProbe || runDefaultPortUdpProbe)(options, deps));
    if (probes.turnUdp.report && diagnosticsDir) {
      await writeDiagnosticsFile(diagnosticsPath({ diagnosticsDir }, 'turn-default-udp'), probes.turnUdp.report);
    }
  }

  if (turnConfig.configured && !options.skipTurnSmoke) {
    probes.turn = await runProbe('turn', () => (deps.runWebrtcDatachannelSmoke || runWebrtcDatachannelSmoke)({
      endpoint: options.endpoint,
      pageUrl: buildPageUrl(options.endpoint),
      iceServerUrls: turnConfig.turnUrls,
      iceUsername: turnConfig.username,
      iceCredential: turnConfig.credential,
      iceTransportPolicy: 'relay',
      sampleCount: options.sampleCount,
      rpcSampleCount: options.rpcSampleCount,
      timeoutMs: options.timeoutMs,
      diagnosticsFile: diagnosticsPath({ diagnosticsDir }, 'turn-relay'),
      browserChannel: options.browserChannel,
      headed: options.headed === true
    }, deps));
  }

  if (!options.skipWebTransport) {
    probes.webtransport = await runProbe('webtransport', () => (deps.runWebTransportSmoke || runWebTransportSmoke)({
      endpoint: options.endpoint,
      pageUrl: options.webTransportPageUrl,
      webTransportUrl: options.webTransportUrl,
      timeoutMs: Math.min(options.timeoutMs, 30000),
      diagnosticsFile: diagnosticsPath({ diagnosticsDir }, 'webtransport'),
      browserChannel: options.browserChannel,
      headed: options.headed === true
    }, deps));
  }

  if (!options.skipMultipath) {
    probes.multipath = await runProbe('multipath', () => (deps.runMultipathDiagnosis || runMultipathDiagnosis)({
      endpoint: options.endpoint,
      sshTarget: options.sshTarget,
      sshKey: options.sshKey,
      json: true
    }));
    if (probes.multipath.report && diagnosticsDir) {
      await writeDiagnosticsFile(diagnosticsPath({ diagnosticsDir }, 'multipath'), probes.multipath.report);
    }
  }

  const gates = {
    aws: options.skipPreflight
      ? { skipped: true, reason: 'skip_preflight', promotionReady: true, blockers: [] }
      : probes.aws && probes.aws.error
        ? {
          ran: true,
          candidateReady: false,
          promotionReady: false,
          error: { message: String(probes.aws.error && probes.aws.error.message || probes.aws.error) },
          blockers: ['aws_preflight_probe_failed']
        }
        : classifyAwsPreflight(probes.aws && probes.aws.report || {}),
    turn: classifyTurnPrerequisite(
      turnConfig,
      probes.turn && probes.turn.report,
      probes.turn && probes.turn.error,
      Boolean(turnConfig.configured && options.skipTurnSmoke),
      classifyDefaultPortUdpProbe(
        probes.turnUdp && probes.turnUdp.report,
        probes.turnUdp && probes.turnUdp.error,
        options.skipTurnUdpProbe
      )
    ),
    webtransport: options.skipWebTransport
      ? { skipped: true, reason: 'skip_webtransport', promotionReady: false, blockers: [] }
      : classifyWebTransportPrerequisite(
        probes.webtransport && probes.webtransport.report,
        probes.webtransport && probes.webtransport.error,
        options
      ),
    multipath: options.skipMultipath
      ? { skipped: true, reason: 'skip_multipath', promotionReady: false, blockers: [] }
      : classifyMultipathPrerequisite(
        probes.multipath && probes.multipath.report,
        probes.multipath && probes.multipath.error
      )
  };

  const report = {
    ok: true,
    mode: 'fabric-m6-prerequisite-audit',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    target: {
      endpoint: options.endpoint,
      ssh: options.sshTarget,
      remoteDir: options.remoteDir,
      nodeId: options.nodeId,
      port: options.port
    },
    diagnosticsDir,
    gates,
    summary: buildSummary(gates)
  };
  if (options.diagnosticsFile) await writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

function formatReport(report = {}) {
  const summary = report.summary || {};
  const lines = [];
  lines.push('AIH Fabric M6 prerequisite audit');
  lines.push(`  endpoint: ${report.target && report.target.endpoint || ''}`);
  lines.push(`  base_ready: ${summary.baseReady ? 'yes' : 'no'}`);
  lines.push(`  promotion_ready: ${summary.promotionReady ? 'yes' : 'no'}`);
  lines.push(`  ready_transports: ${(summary.readyTransports || []).join(', ') || 'none'}`);
  if (summary.diagnosticConcurrency && summary.diagnosticConcurrency.blocked) {
    lines.push('  diagnostic_concurrency: blocked');
    lines.push(`    - ${summary.diagnosticConcurrency.reason}`);
    lines.push(`    - ${summary.diagnosticConcurrency.nextAction}`);
  }
  if (summary.diagnosticContext && summary.diagnosticContext.blocked) {
    lines.push('  diagnostic_context: blocked');
    lines.push(`    - ${summary.diagnosticContext.reason}`);
    lines.push(`    - ${summary.diagnosticContext.nextAction}`);
  }
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
  const report = await runPrerequisiteAudit(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  if (options.failOnBlocked && !report.summary.promotionReady) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-m6-prerequisite-audit] ${String(error && error.message || error)}`);
    process.exit(1);
  });
}

module.exports = {
  buildDefaultWebTransportUrl,
  buildSummary,
  buildTurnConfig,
  classifyAwsPreflight,
  classifyDefaultPortUdpProbe,
  classifyMultipathPrerequisite,
  classifyTurnPrerequisite,
  classifyWebTransportPrerequisite,
  buildDiagnosticConcurrencySummary,
  buildDiagnosticContextSummary,
  formatReport,
  parseArgs,
  runDefaultPortUdpProbe,
  runPrerequisiteAudit
};
