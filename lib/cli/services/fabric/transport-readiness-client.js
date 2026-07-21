'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_TIMEOUT_MS,
  buildProfileSummary,
  createError,
  fetchJson,
  loadControlPlaneProfileStore,
  normalizeHttpEndpoint,
  normalizeText,
  parsePositiveInteger,
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath,
  selectReadyProfile
} = require('./server-profile-client');

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_NODE_ID = 'aws-current-node';
const DEFAULT_PURPOSE = 'runtime';

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: DEFAULT_ENDPOINT,
    profileId: '',
    nodeId: DEFAULT_NODE_ID,
    purpose: DEFAULT_PURPOSE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    requireRelayMeasurement: true
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
    if (token === '--no-require-relay-measurement') {
      options.requireRelayMeasurement = false;
      index += 1;
      continue;
    }
    if (token === '--ai-home-dir' || token.startsWith('--ai-home-dir=')) {
      const next = readOptionValue(argv, index, '--ai-home-dir');
      options.aiHomeDir = resolveLocalPath(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--profile-id' || token.startsWith('--profile-id=')) {
      const next = readOptionValue(argv, index, '--profile-id');
      options.profileId = normalizeText(next.value, 96);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = normalizeText(next.value, 128);
      index += next.consumed;
      continue;
    }
    if (token === '--purpose' || token.startsWith('--purpose=')) {
      const next = readOptionValue(argv, index, '--purpose');
      options.purpose = normalizeText(next.value, 64) || DEFAULT_PURPOSE;
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    throw createError('invalid_option', `unknown option: ${token}`);
  }

  options.aiHomeDir = options.aiHomeDir ? resolveLocalPath(options.aiHomeDir) : resolveDefaultAiHomeDir(env);
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  return options;
}

function buildReadinessUrl(endpoint, options = {}) {
  const url = new URL('/v0/fabric/transport/readiness', normalizeHttpEndpoint(endpoint));
  const nodeId = normalizeText(options.nodeId, 128);
  const purpose = normalizeText(options.purpose, 64) || DEFAULT_PURPOSE;
  if (nodeId) url.searchParams.set('nodeId', nodeId);
  if (purpose) url.searchParams.set('purpose', purpose);
  return url.toString();
}

function summarizeNodeReadiness(readiness, nodeId) {
  const nodes = Array.isArray(readiness && readiness.nodes) ? readiness.nodes : [];
  const wanted = normalizeText(nodeId, 128);
  const node = nodes.find((item) => !wanted || String(item && item.node && item.node.id || '') === wanted) || nodes[0] || null;
  const relayFallback = node && node.relayFallback && typeof node.relayFallback === 'object'
    ? node.relayFallback
    : null;
  return {
    nodeId: node && node.node ? String(node.node.id || '') : '',
    defaultTransport: String(node && node.defaultTransport || ''),
    fallbackReady: Boolean(node && node.fallbackReady),
    relayMeasurementPass: Boolean(relayFallback && relayFallback.measurementPass),
    relayRttMs: relayFallback && relayFallback.measurement && relayFallback.measurement.rttMs
      ? relayFallback.measurement.rttMs
      : null
  };
}

function evaluateReport(profile, readiness, unauth, authorized, options = {}) {
  const summary = readiness && readiness.summary && typeof readiness.summary === 'object'
    ? readiness.summary
    : {};
  const node = summarizeNodeReadiness(readiness, options.nodeId);
  const checks = {
    unauthRejected: unauth.status === 401,
    authorizedRead: authorized.status === 200 && authorized.ok === true,
    rpcOk: authorized.body && authorized.body.ok === true && authorized.body.rpc === 'fabric.transport.readiness',
    nodeFound: Number(summary.nodes || 0) > 0 && (!options.nodeId || node.nodeId === options.nodeId),
    fallbackReady: summary.fallbackReady === true && node.fallbackReady === true,
    relayMeasurementPass: options.requireRelayMeasurement === false || node.relayMeasurementPass === true
  };
  const blockers = Object.entries(checks)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  return {
    ok: blockers.length === 0,
    generatedAt: new Date().toISOString(),
    profile: buildProfileSummary(profile),
    target: {
      endpoint: profile.endpoint,
      nodeId: normalizeText(options.nodeId, 128),
      purpose: normalizeText(options.purpose, 64) || DEFAULT_PURPOSE,
      readinessUrl: buildReadinessUrl(profile.endpoint, options)
    },
    http: {
      unauthenticatedStatus: unauth.status,
      authorizedStatus: authorized.status
    },
    checks,
    summary: {
      nodes: Number(summary.nodes || 0),
      defaultTransport: String(summary.defaultTransport || ''),
      defaultTransports: Array.isArray(summary.defaultTransports) ? summary.defaultTransports : [],
      fallbackReady: summary.fallbackReady === true,
      promotionReady: summary.promotionReady === true,
      promotedTransports: Array.isArray(summary.promotedTransports) ? summary.promotedTransports : [],
      blockers: Array.isArray(summary.blockers) ? summary.blockers : []
    },
    node,
    readiness: {
      generatedAt: normalizeText(readiness && readiness.generatedAt, 64),
      purpose: normalizeText(readiness && readiness.purpose, 64),
      nodeId: normalizeText(readiness && readiness.nodeId, 128)
    },
    blockers
  };
}

async function runTransportReadinessClientSmoke(rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: DEFAULT_ENDPOINT,
    profileId: '',
    nodeId: DEFAULT_NODE_ID,
    purpose: DEFAULT_PURPOSE,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    requireRelayMeasurement: true,
    ...rawOptions
  };
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  const store = loadControlPlaneProfileStore(options, deps);
  const profile = selectReadyProfile(store, options);
  const readinessUrl = buildReadinessUrl(profile.endpoint, options);
  const unauth = await fetchJson(readinessUrl, {
    timeoutMs: options.timeoutMs,
    timeoutCode: 'readiness_request_timeout',
    headers: { accept: 'application/json' }
  }, deps);
  const authorized = await fetchJson(readinessUrl, {
    timeoutMs: options.timeoutMs,
    timeoutCode: 'readiness_request_timeout',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${profile.managementKey}`
    }
  }, deps);
  const readiness = authorized.body && authorized.body.result && typeof authorized.body.result === 'object'
    ? authorized.body.result
    : {};
  const report = evaluateReport(profile, readiness, unauth, authorized, options);
  if (options.diagnosticsFile) writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

async function runFabricTransportReadinessClientCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runTransportReadinessClientSmoke(options, deps);
  return {
    ...report,
    json: options.json === true
  };
}

function writeDiagnosticsFile(filePath, report) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function formatReport(report = {}) {
  const lines = [
    'AIH Fabric transport readiness',
    `  profile: ${report.profile && report.profile.name || ''} (${report.profile && report.profile.id || ''})`,
    `  endpoint: ${report.target && report.target.endpoint || ''}`,
    `  node_id: ${report.target && report.target.nodeId || ''}`,
    `  http: unauth=${report.http && report.http.unauthenticatedStatus || 0} auth=${report.http && report.http.authorizedStatus || 0}`,
    `  default_transport: ${report.summary && report.summary.defaultTransport || ''}`,
    `  fallback_ready: ${report.summary && report.summary.fallbackReady ? 'yes' : 'no'}`,
    `  relay_measurement_pass: ${report.node && report.node.relayMeasurementPass ? 'yes' : 'no'}`,
    `  promotion_ready: ${report.summary && report.summary.promotionReady ? 'yes' : 'no'}`
  ];
  const blockers = Array.isArray(report.blockers) ? report.blockers : [];
  if (blockers.length) {
    lines.push('  readiness_blockers:');
    blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }
  const transportBlockers = report.summary && Array.isArray(report.summary.blockers) ? report.summary.blockers : [];
  if (transportBlockers.length) {
    lines.push('  transport_blockers:');
    transportBlockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }
  lines.push(`  result: ${report.ok ? 'pass' : 'fail'}`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_NODE_ID,
  DEFAULT_PURPOSE,
  DEFAULT_TIMEOUT_MS,
  buildReadinessUrl,
  evaluateReport,
  formatFabricTransportReadinessClientReport: formatReport,
  formatReport,
  parseArgs,
  parseFabricTransportReadinessClientArgs: parseArgs,
  runFabricTransportReadinessClient: runTransportReadinessClientSmoke,
  runFabricTransportReadinessClientCommand,
  runTransportReadinessClientSmoke,
  selectReadyProfile
};
