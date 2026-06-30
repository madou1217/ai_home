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
  normalizeOptionalHttpEndpoint,
  normalizeText,
  parsePositiveInteger,
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath,
  selectReadyProfile
} = require('./server-profile-client');
const {
  runFabricNodesClient
} = require('./nodes-client');
const {
  appendTransportEvidenceLines,
  normalizeTransportEvidence
} = require('./transport-evidence');

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: '',
    profileId: '',
    nodeId: '',
    provider: '',
    prompt: '',
    projectId: '',
    projectPath: '',
    accountId: '',
    model: '',
    sessionId: '',
    artifactThreshold: 0,
    cols: 0,
    rows: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: ''
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
    if (token === '--provider' || token.startsWith('--provider=')) {
      const next = readOptionValue(argv, index, '--provider');
      options.provider = normalizeText(next.value, 64).toLowerCase();
      index += next.consumed;
      continue;
    }
    if (token === '--prompt' || token.startsWith('--prompt=')) {
      const next = readOptionValue(argv, index, '--prompt');
      options.prompt = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (token === '--project-id' || token.startsWith('--project-id=')) {
      const next = readOptionValue(argv, index, '--project-id');
      options.projectId = normalizeText(next.value, 128);
      index += next.consumed;
      continue;
    }
    if (token === '--project-path' || token.startsWith('--project-path=')) {
      const next = readOptionValue(argv, index, '--project-path');
      options.projectPath = normalizeText(next.value, 2048);
      index += next.consumed;
      continue;
    }
    if (token === '--account-id' || token.startsWith('--account-id=')) {
      const next = readOptionValue(argv, index, '--account-id');
      options.accountId = normalizeText(next.value, 128);
      index += next.consumed;
      continue;
    }
    if (token === '--model' || token.startsWith('--model=')) {
      const next = readOptionValue(argv, index, '--model');
      options.model = normalizeText(next.value, 160);
      index += next.consumed;
      continue;
    }
    if (token === '--session-id' || token.startsWith('--session-id=')) {
      const next = readOptionValue(argv, index, '--session-id');
      options.sessionId = normalizeText(next.value, 160);
      index += next.consumed;
      continue;
    }
    if (token === '--artifact-threshold' || token.startsWith('--artifact-threshold=')) {
      const next = readOptionValue(argv, index, '--artifact-threshold');
      options.artifactThreshold = parsePositiveInteger(next.value, '--artifact-threshold', 0, 1, 1024 * 1024 * 1024);
      index += next.consumed;
      continue;
    }
    if (token === '--cols' || token.startsWith('--cols=')) {
      const next = readOptionValue(argv, index, '--cols');
      options.cols = parsePositiveInteger(next.value, '--cols', 0, 1, 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--rows' || token.startsWith('--rows=')) {
      const next = readOptionValue(argv, index, '--rows');
      options.rows = parsePositiveInteger(next.value, '--rows', 0, 1, 1000);
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
    if (!isFlag(token) && !options.nodeId) {
      options.nodeId = normalizeText(token, 128);
      index += 1;
      continue;
    }
    throw createError('invalid_option', `unknown option: ${token}`);
  }

  options.aiHomeDir = options.aiHomeDir ? resolveLocalPath(options.aiHomeDir) : resolveDefaultAiHomeDir(env);
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  return options;
}

function buildSessionStartUrl(endpoint) {
  return new URL('/v0/node-rpc/device-node-session-start', normalizeHttpEndpoint(endpoint)).toString();
}

function findStartAction(node, provider) {
  const id = `start-session:${normalizeText(provider, 64).toLowerCase()}`;
  return normalizeArray(node && node.actions).find((action) => action && action.id === id) || null;
}

function selectProjectPath(node, options = {}) {
  const explicit = normalizeText(options.projectPath, 2048);
  if (explicit) return explicit;
  const projectId = normalizeText(options.projectId, 128);
  const projects = normalizeArray(node && node.projects);
  const project = projectId
    ? projects.find((item) => normalizeText(item && item.id, 128) === projectId)
    : projects[0];
  return normalizeText(project && project.displayPath, 2048);
}

function buildStartPayload(options = {}, node = {}) {
  const payload = {
    nodeId: normalizeText(options.nodeId, 128),
    provider: normalizeText(options.provider, 64).toLowerCase(),
    accountId: normalizeText(options.accountId, 128),
    prompt: String(options.prompt || ''),
    projectPath: selectProjectPath(node, options),
    model: normalizeText(options.model, 160),
    sessionId: normalizeText(options.sessionId, 160)
  };
  if (Number(options.artifactThreshold) > 0) payload.artifactThreshold = Number(options.artifactThreshold);
  if (Number(options.cols) > 0) payload.cols = Number(options.cols);
  if (Number(options.rows) > 0) payload.rows = Number(options.rows);
  return payload;
}

function buildBlockedReport(profile, nodesReport, options, action, blockers) {
  const node = nodesReport && nodesReport.targetNode ? nodesReport.targetNode : null;
  return {
    ok: false,
    blocked: true,
    generatedAt: new Date().toISOString(),
    profile: buildProfileSummary(profile),
    target: {
      endpoint: profile.endpoint,
      nodeId: normalizeText(options.nodeId, 128),
      provider: normalizeText(options.provider, 64).toLowerCase(),
      sessionStartUrl: buildSessionStartUrl(profile.endpoint)
    },
    node: node ? {
      id: node.id,
      name: node.name,
      capabilities: node.capabilities,
      runtimeGaps: node.runtimeGaps
    } : null,
    action: action || null,
    http: {
      registryAuthorizedStatus: nodesReport && nodesReport.http ? nodesReport.http.authorizedStatus : 0,
      sessionStartStatus: 0
    },
    result: null,
    blockers: normalizeArray(blockers).map((item) => normalizeText(item, 160)).filter(Boolean)
  };
}

function evaluateStartResponse(profile, nodesReport, options, payload, response) {
  const body = response && response.body && typeof response.body === 'object' ? response.body : {};
  const result = body.result && typeof body.result === 'object' ? body.result : null;
  const ok = response.status === 200 && response.ok === true && body.ok === true && Boolean(result);
  const blockers = ok ? [] : [normalizeText(body.error, 160) || `http_${response.status || 0}`];
  return {
    ok,
    blocked: false,
    generatedAt: new Date().toISOString(),
    profile: buildProfileSummary(profile),
    target: {
      endpoint: profile.endpoint,
      nodeId: normalizeText(options.nodeId, 128),
      provider: normalizeText(options.provider, 64).toLowerCase(),
      sessionStartUrl: buildSessionStartUrl(profile.endpoint)
    },
    node: nodesReport && nodesReport.targetNode ? {
      id: nodesReport.targetNode.id,
      name: nodesReport.targetNode.name,
      capabilities: nodesReport.targetNode.capabilities,
      runtimeGaps: nodesReport.targetNode.runtimeGaps
    } : null,
    request: {
      provider: payload.provider,
      accountId: payload.accountId,
      projectPath: payload.projectPath,
      model: payload.model,
      promptPresent: Boolean(payload.prompt),
      artifactThreshold: payload.artifactThreshold || 0
    },
    http: {
      registryAuthorizedStatus: nodesReport && nodesReport.http ? nodesReport.http.authorizedStatus : 0,
      sessionStartStatus: response.status
    },
    ...normalizeTransportEvidence(body),
    result,
    blockers
  };
}

async function runFabricSessionStartClient(rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: '',
    profileId: '',
    nodeId: '',
    provider: '',
    prompt: '',
    projectId: '',
    projectPath: '',
    accountId: '',
    model: '',
    sessionId: '',
    artifactThreshold: 0,
    cols: 0,
    rows: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    ...rawOptions
  };
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  if (!options.nodeId) throw createError('missing_fabric_session_node_id', 'missing --node-id');
  if (!options.provider) throw createError('missing_fabric_session_provider', 'missing --provider');

  const store = loadControlPlaneProfileStore(options, deps);
  const profile = selectReadyProfile(store, options);
  const nodesReport = await (deps.runFabricNodesClient || runFabricNodesClient)({
    aiHomeDir: options.aiHomeDir,
    endpoint: profile.endpoint,
    profileId: profile.id,
    nodeId: options.nodeId,
    timeoutMs: options.timeoutMs
  }, deps);
  if (!nodesReport || nodesReport.ok !== true) {
    return buildBlockedReport(profile, nodesReport, options, null, ['fabric_nodes_read_failed']);
  }
  const action = findStartAction(nodesReport.targetNode, options.provider);
  if (!action || action.enabled !== true) {
    const blockers = action && normalizeArray(action.blockers).length > 0
      ? action.blockers
      : ['start_session_action_not_enabled'];
    const report = buildBlockedReport(profile, nodesReport, options, action, blockers);
    if (options.diagnosticsFile) writeDiagnosticsFile(options.diagnosticsFile, report);
    return report;
  }
  if (!String(options.prompt || '').trim()) {
    throw createError('missing_fabric_session_prompt', 'missing --prompt');
  }

  const payload = buildStartPayload(options, nodesReport.targetNode);
  const response = await fetchJson(buildSessionStartUrl(profile.endpoint), {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_session_start_request_timeout',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${profile.deviceToken}`
    },
    body: JSON.stringify(payload)
  }, deps);
  const report = evaluateStartResponse(profile, nodesReport, options, payload, response);
  if (options.diagnosticsFile) writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

async function runFabricSessionStartClientCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runFabricSessionStartClient(options, deps);
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
    'AIH Fabric session start',
    `  profile: ${report.profile && report.profile.name || ''} (${report.profile && report.profile.id || ''})`,
    `  endpoint: ${report.target && report.target.endpoint || ''}`,
    `  node_id: ${report.target && report.target.nodeId || ''}`,
    `  provider: ${report.target && report.target.provider || ''}`,
    `  action: ${report.blocked ? 'blocked' : (report.ok ? 'started' : 'failed')}`,
    `  http: registry_auth=${report.http && report.http.registryAuthorizedStatus || 0} session_start=${report.http && report.http.sessionStartStatus || 0}`
  ];
  if (report.result) {
    lines.push(`  run_id: ${report.result.runId || report.result.run_id || ''}`);
    lines.push(`  session_id: ${report.result.sessionId || report.result.session_id || report.result.runId || ''}`);
    lines.push(`  status: ${report.result.status || ''}`);
  }
  appendTransportEvidenceLines(lines, report);
  const blockers = normalizeArray(report.blockers);
  if (blockers.length > 0) {
    lines.push('  blockers:');
    blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }
  lines.push(`  result: ${report.ok ? 'pass' : 'fail'}`);
  return lines.join('\n');
}

module.exports = {
  buildSessionStartUrl,
  buildStartPayload,
  evaluateStartResponse,
  findStartAction,
  formatFabricSessionStartClientReport: formatReport,
  formatReport,
  parseArgs,
  parseFabricSessionStartClientArgs: parseArgs,
  runFabricSessionStartClient,
  runFabricSessionStartClientCommand
};
