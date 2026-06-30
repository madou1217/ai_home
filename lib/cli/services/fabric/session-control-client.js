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
  appendTransportEvidenceLines,
  normalizeTransportEvidence
} = require('./transport-evidence');

const SESSION_CONTROL_COMMANDS = new Set(['attach', 'events', 'message', 'slash', 'stop']);

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseArgs(command, argv = [], env = process.env) {
  const action = normalizeSessionControlAction(command);
  const options = {
    help: false,
    json: false,
    action,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: '',
    profileId: '',
    nodeId: '',
    runId: '',
    cursor: 0,
    limit: 0,
    text: '',
    slashCommand: '',
    scope: 'run',
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
    if (token === '--run-id' || token === '--session-id' || token.startsWith('--run-id=') || token.startsWith('--session-id=')) {
      const flag = token.startsWith('--session-id') ? '--session-id' : '--run-id';
      const next = readOptionValue(argv, index, flag);
      options.runId = normalizeText(next.value, 160);
      index += next.consumed;
      continue;
    }
    if (token === '--cursor' || token.startsWith('--cursor=')) {
      const next = readOptionValue(argv, index, '--cursor');
      options.cursor = parsePositiveInteger(next.value, '--cursor', 0, 0, Number.MAX_SAFE_INTEGER);
      index += next.consumed;
      continue;
    }
    if (token === '--limit' || token.startsWith('--limit=')) {
      const next = readOptionValue(argv, index, '--limit');
      options.limit = parsePositiveInteger(next.value, '--limit', 0, 1, 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--text' || token.startsWith('--text=')) {
      const next = readOptionValue(argv, index, '--text');
      options.text = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (token === '--command' || token.startsWith('--command=')) {
      const next = readOptionValue(argv, index, '--command');
      options.slashCommand = normalizeText(next.value, 256);
      index += next.consumed;
      continue;
    }
    if (token === '--scope' || token.startsWith('--scope=')) {
      const next = readOptionValue(argv, index, '--scope');
      options.scope = normalizeText(next.value, 64) || 'run';
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

function normalizeSessionControlAction(value) {
  const action = normalizeText(value, 32).toLowerCase();
  if (!SESSION_CONTROL_COMMANDS.has(action)) {
    throw createError('unknown_fabric_session_command', `unknown fabric session command: ${action || 'empty'}`);
  }
  return action;
}

function buildSessionAttachUrl(endpoint) {
  return new URL('/v0/node-rpc/device-node-session-attach', normalizeHttpEndpoint(endpoint)).toString();
}

function buildSessionCommandUrl(endpoint) {
  return new URL('/v0/node-rpc/device-node-session-command', normalizeHttpEndpoint(endpoint)).toString();
}

function buildSessionRunEventsUrl(endpoint, options = {}) {
  const url = new URL('/v0/node-rpc/device-node-session-run-events', normalizeHttpEndpoint(endpoint));
  url.searchParams.set('nodeId', normalizeText(options.nodeId, 128));
  url.searchParams.set('runId', normalizeText(options.runId, 160));
  if (Number(options.cursor) > 0) url.searchParams.set('cursor', String(Number(options.cursor)));
  if (Number(options.limit) > 0) url.searchParams.set('limit', String(Number(options.limit)));
  return url.toString();
}

function buildSessionControlPayload(options = {}) {
  const base = {
    nodeId: normalizeText(options.nodeId, 128),
    sessionId: normalizeText(options.runId, 160)
  };
  if (options.action === 'attach') {
    return {
      ...base,
      cursor: Number(options.cursor) || 0,
      ...(Number(options.limit) > 0 ? { limit: Number(options.limit) } : {})
    };
  }
  if (options.action === 'message') {
    return {
      ...base,
      type: 'message',
      text: String(options.text || ''),
      idempotencyKey: buildIdempotencyKey(options, 'message')
    };
  }
  if (options.action === 'slash') {
    return {
      ...base,
      type: 'slash',
      command: normalizeText(options.slashCommand, 256),
      idempotencyKey: buildIdempotencyKey(options, 'slash')
    };
  }
  if (options.action === 'stop') {
    return {
      ...base,
      type: 'stop',
      scope: normalizeText(options.scope, 64) || 'run',
      idempotencyKey: buildIdempotencyKey(options, 'stop')
    };
  }
  return base;
}

function buildIdempotencyKey(options = {}, type = 'command') {
  const nodeId = normalizeText(options.nodeId, 128);
  const runId = normalizeText(options.runId, 160);
  const value = type === 'message'
    ? options.text
    : (type === 'stop' ? (normalizeText(options.scope, 64) || 'run') : options.slashCommand || '');
  const seed = `${nodeId}:${runId}:${type}:${value}`;
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `fabric-${type}-${(hash >>> 0).toString(36)}`;
}

function buildRequestTarget(profile, options = {}) {
  if (options.action === 'events') return buildSessionRunEventsUrl(profile.endpoint, options);
  if (options.action === 'attach') return buildSessionAttachUrl(profile.endpoint);
  return buildSessionCommandUrl(profile.endpoint);
}

function validateOptions(options = {}) {
  if (!options.nodeId) throw createError('missing_fabric_session_node_id', 'missing --node-id');
  if (!options.runId) throw createError('missing_fabric_session_run_id', 'missing --run-id');
  if (options.action === 'message' && !String(options.text || '').trim()) {
    throw createError('missing_fabric_session_text', 'missing --text');
  }
  if (options.action === 'slash' && !normalizeText(options.slashCommand, 256)) {
    throw createError('missing_fabric_session_slash_command', 'missing --command');
  }
}

function summarizeEvents(result) {
  const events = normalizeArray(result && result.events);
  const eventTypes = {};
  let terminalTail = '';
  events.forEach((event) => {
    const type = normalizeText(event && event.type, 64) || 'unknown';
    eventTypes[type] = (eventTypes[type] || 0) + 1;
    if (type === 'terminal-output') {
      terminalTail = appendTail(terminalTail, event.text || '', 4000);
    }
  });
  return {
    cursor: Number(result && result.cursor) || 0,
    completed: Boolean(result && (result.completed === true || result.status === 'completed')),
    eventCount: events.length,
    eventTypes,
    terminalTail
  };
}

function appendTail(current, value, maxLength) {
  const next = `${String(current || '')}${String(value || '')}`;
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

function evaluateResponse(profile, options, response) {
  const body = response && response.body && typeof response.body === 'object' ? response.body : {};
  const result = body.result && typeof body.result === 'object' ? body.result : null;
  const ok = response.status === 200 && response.ok === true && body.ok !== false && Boolean(result);
  return {
    ok,
    blocked: false,
    generatedAt: new Date().toISOString(),
    profile: buildProfileSummary(profile),
    target: {
      endpoint: profile.endpoint,
      nodeId: normalizeText(options.nodeId, 128),
      runId: normalizeText(options.runId, 160),
      action: options.action,
      url: buildRequestTarget(profile, options)
    },
    http: {
      status: response.status
    },
    ...normalizeTransportEvidence(body),
    result,
    summary: options.action === 'events' && result ? summarizeEvents(result) : null,
    blockers: ok ? [] : [normalizeText(body.error, 160) || `http_${response.status || 0}`]
  };
}

async function runFabricSessionControlClient(rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: '',
    profileId: '',
    nodeId: '',
    runId: '',
    action: '',
    cursor: 0,
    limit: 0,
    text: '',
    slashCommand: '',
    scope: 'run',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    ...rawOptions
  };
  options.action = normalizeSessionControlAction(options.action);
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  validateOptions(options);

  const store = loadControlPlaneProfileStore(options, deps);
  const profile = selectReadyProfile(store, options);
  const url = buildRequestTarget(profile, options);
  const isGet = options.action === 'events';
  const response = await fetchJson(url, {
    method: isGet ? 'GET' : 'POST',
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_session_control_request_timeout',
    headers: {
      accept: 'application/json',
      ...(!isGet ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${profile.deviceToken}`
    },
    ...(!isGet ? { body: JSON.stringify(buildSessionControlPayload(options)) } : {})
  }, deps);
  const report = evaluateResponse(profile, options, response);
  if (options.diagnosticsFile) writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

async function runFabricSessionControlClientCommand(command, args = [], deps = {}) {
  const options = parseArgs(command, Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runFabricSessionControlClient(options, deps);
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
    `AIH Fabric session ${report.target && report.target.action || ''}`,
    `  profile: ${report.profile && report.profile.name || ''} (${report.profile && report.profile.id || ''})`,
    `  endpoint: ${report.target && report.target.endpoint || ''}`,
    `  node_id: ${report.target && report.target.nodeId || ''}`,
    `  run_id: ${report.target && report.target.runId || ''}`,
    `  http: status=${report.http && report.http.status || 0}`
  ];
  if (report.summary) {
    lines.push(`  cursor: ${report.summary.cursor || 0}`);
    lines.push(`  events: ${report.summary.eventCount || 0}`);
    const types = Object.entries(report.summary.eventTypes || {})
      .map(([type, count]) => `${type}=${count}`)
      .join(' ');
    if (types) lines.push(`  event_types: ${types}`);
  }
  if (report.result) {
    lines.push(`  accepted: ${report.result.accepted === true ? 'yes' : (report.result.accepted === false ? 'no' : '')}`);
    lines.push(`  status: ${report.result.status || ''}`);
    lines.push(`  type: ${report.result.type || ''}`);
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
  buildSessionAttachUrl,
  buildSessionCommandUrl,
  buildSessionControlPayload,
  buildSessionRunEventsUrl,
  formatFabricSessionControlClientReport: formatReport,
  formatReport,
  parseArgs,
  parseFabricSessionControlClientArgs: parseArgs,
  runFabricSessionControlClient,
  runFabricSessionControlClientCommand,
  summarizeEvents
};
