'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_ENDPOINT,
  DEFAULT_NODE_ID
} = require('./transport-readiness-client');
const {
  DEFAULT_TIMEOUT_MS,
  createError,
  normalizeHttpEndpoint,
  normalizeText,
  parsePositiveInteger,
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath
} = require('./server-profile-client');
const {
  runFabricNodesClient
} = require('./nodes-client');
const {
  runFabricTransportStatusCommand
} = require('./transport-status');
const {
  runFabricSessionStartClient
} = require('./session-start-client');
const {
  runFabricSessionControlClient
} = require('./session-control-client');
const {
  buildClosurePlan,
  formatClosurePlan
} = require('./closure-plan');
const {
  buildFailureLedger,
  formatFailureLedger
} = require('./failure-ledger');
const {
  formatFabricClosureStatusReport,
  projectClosureStatusReport
} = require('./closure-status-report');

const DEFAULT_PROVIDER = 'opencode';
const DEFAULT_SESSION_TIMEOUT_MS = 120000;
const DEFAULT_EVENT_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_EVENT_LIMIT = 200;
const KNOWN_PROVIDERS = ['codex', 'claude', 'agy', 'opencode'];

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    failOnIncomplete: false,
    skipSession: false,
    skipCloudEdge: false,
    withPromotionGate: false,
    allowDirectWebrtcPromotion: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: DEFAULT_ENDPOINT,
    profileId: '',
    nodeId: '',
    provider: DEFAULT_PROVIDER,
    projectId: '',
    projectPath: '',
    accountRef: '',
    model: '',
    prompt: '',
    sessionMarker: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    eventTimeoutMs: DEFAULT_EVENT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    eventLimit: DEFAULT_EVENT_LIMIT,
    diagnosticsFile: '',
    handoffFile: ''
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
    if (token === '--fail-on-incomplete') {
      options.failOnIncomplete = true;
      index += 1;
      continue;
    }
    if (token === '--skip-session') {
      options.skipSession = true;
      index += 1;
      continue;
    }
    if (token === '--skip-cloud-edge') {
      options.skipCloudEdge = true;
      index += 1;
      continue;
    }
    if (token === '--with-promotion-gate') {
      options.withPromotionGate = true;
      index += 1;
      continue;
    }
    if (token === '--allow-direct-webrtc-promotion') {
      options.allowDirectWebrtcPromotion = true;
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
    if (token === '--account-ref' || token.startsWith('--account-ref=')) {
      const next = readOptionValue(argv, index, '--account-ref');
      options.accountRef = normalizeText(next.value, 96);
      index += next.consumed;
      continue;
    }
    if (token === '--model' || token.startsWith('--model=')) {
      const next = readOptionValue(argv, index, '--model');
      options.model = normalizeText(next.value, 160);
      index += next.consumed;
      continue;
    }
    if (token === '--prompt' || token.startsWith('--prompt=')) {
      const next = readOptionValue(argv, index, '--prompt');
      options.prompt = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (token === '--session-marker' || token === '--marker' || token.startsWith('--session-marker=') || token.startsWith('--marker=')) {
      const flag = token.startsWith('--marker') ? '--marker' : '--session-marker';
      const next = readOptionValue(argv, index, flag);
      options.sessionMarker = normalizeText(next.value, 256);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--session-timeout-ms' || token.startsWith('--session-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--session-timeout-ms');
      options.sessionTimeoutMs = parsePositiveInteger(next.value, '--session-timeout-ms', DEFAULT_SESSION_TIMEOUT_MS, 250, 240000);
      index += next.consumed;
      continue;
    }
    if (token === '--event-timeout-ms' || token.startsWith('--event-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--event-timeout-ms');
      options.eventTimeoutMs = parsePositiveInteger(next.value, '--event-timeout-ms', DEFAULT_EVENT_TIMEOUT_MS, 250, 240000);
      index += next.consumed;
      continue;
    }
    if (token === '--poll-interval-ms' || token.startsWith('--poll-interval-ms=')) {
      const next = readOptionValue(argv, index, '--poll-interval-ms');
      options.pollIntervalMs = parsePositiveInteger(next.value, '--poll-interval-ms', DEFAULT_POLL_INTERVAL_MS, 100, 60000);
      index += next.consumed;
      continue;
    }
    if (token === '--event-limit' || token.startsWith('--event-limit=')) {
      const next = readOptionValue(argv, index, '--event-limit');
      options.eventLimit = parsePositiveInteger(next.value, '--event-limit', DEFAULT_EVENT_LIMIT, 1, 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = resolveOutputFilePath(next.value, '--diagnostics-file');
      index += next.consumed;
      continue;
    }
    if (token === '--handoff-file' || token.startsWith('--handoff-file=')) {
      const next = readOptionValue(argv, index, '--handoff-file');
      options.handoffFile = resolveOutputFilePath(next.value, '--handoff-file');
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
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  options.provider = normalizeText(options.provider, 64).toLowerCase() || DEFAULT_PROVIDER;
  options.nodeId = normalizeText(options.nodeId, 128) || DEFAULT_NODE_ID;
  return options;
}

function resolveOutputFilePath(value, flag) {
  const raw = String(value || '').trim();
  if (!raw) throw createError('invalid_option', `${flag} requires a value`);
  return path.resolve(raw);
}

function addFlagValue(args, flag, value) {
  if (value !== undefined && value !== null && String(value).trim()) {
    args.push(flag, String(value));
  }
}

function buildTransportStatusArgs(options = {}) {
  const args = [];
  addFlagValue(args, '--endpoint', options.endpoint);
  addFlagValue(args, '--node-id', options.nodeId);
  addFlagValue(args, '--profile-id', options.profileId);
  addFlagValue(args, '--timeout-ms', options.timeoutMs);
  if (options.withPromotionGate) args.push('--with-promotion-gate');
  if (options.allowDirectWebrtcPromotion) args.push('--allow-direct-webrtc-promotion');
  if (options.skipCloudEdge) args.push('--skip-cloud-edge');
  return args;
}

async function runStep(name, runner) {
  try {
    const report = await runner();
    return {
      name,
      ok: Boolean(report && report.ok !== false),
      report,
      error: null
    };
  } catch (error) {
    return {
      name,
      ok: false,
      report: null,
      error: {
        code: normalizeText(error && error.code, 96) || 'step_failed',
        message: normalizeText(error && error.message, 512) || String(error)
      }
    };
  }
}

function createSessionMarker(now = new Date()) {
  const stamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '_')
    .replace('Z', '');
  return `AIH_FABRIC_CLOSURE_AUDIT_${stamp}`;
}

function buildSessionPrompt(marker) {
  return `Do not use tools. Output exactly: ${marker}`;
}

function extractRunId(report = {}) {
  const source = normalizeObject(report);
  const result = normalizeObject(source.result);
  return normalizeText(result.runId || result.run_id || result.sessionId || result.session_id, 160);
}

function getEventTypes(report = {}) {
  const source = normalizeObject(report);
  const summary = normalizeObject(source.summary);
  const eventTypes = normalizeObject(summary.eventTypes);
  if (Object.keys(eventTypes).length > 0) return eventTypes;
  const events = normalizeArray(normalizeObject(source.result).events);
  return events.reduce((acc, event) => {
    const type = normalizeText(event && event.type, 64) || 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
}

function getSessionEvents(report = {}) {
  return normalizeArray(normalizeObject(normalizeObject(report).result).events);
}

function getCanonicalSessionOutputText(report = {}) {
  return getSessionEvents(report)
    .map((event) => {
      if (!event || typeof event !== 'object') return '';
      const type = normalizeText(event.type, 64);
      if (type === 'delta') {
        return [
          event.delta,
          event.text,
          event.content
        ].map((item) => String(item || '')).filter(Boolean).join('\n');
      }
      if (type === 'result' || type === 'done' || type === 'assistant_text') {
        return [
          event.content,
          event.text,
          event.message
        ].map((item) => String(item || '')).filter(Boolean).join('\n');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function markerExists(report, marker) {
  if (!marker) return false;
  return getCanonicalSessionOutputText(report).includes(marker);
}

function isDoneObserved(report = {}) {
  const eventTypes = getEventTypes(report);
  if (Number(eventTypes.done || 0) > 0) return true;
  return getSessionEvents(report).some((event) => normalizeText(event && event.type, 64) === 'done');
}

function collectSessionEventBlockers(report = {}, lastError = null, markerFound = false, doneObserved = false) {
  const blockers = [];
  if (lastError && lastError.code) blockers.push(lastError.code);
  getSessionEvents(report).forEach((event) => {
    if (!event || typeof event !== 'object') return;
    const type = normalizeText(event.type, 64);
    if (type === 'runtime-blocked') {
      const provider = normalizeText(event.provider, 64) || 'provider';
      const reason = normalizeText(event.reason || event.status || event.code, 160) || 'unknown';
      blockers.push(`runtime_blocked:${provider}:${reason}`);
      return;
    }
    if (type === 'error') {
      blockers.push(normalizeText(event.code, 160) || 'session_error');
      return;
    }
    if (type === 'aborted') {
      blockers.push('session_aborted');
    }
  });
  if (!markerFound) blockers.push('session_marker_not_observed');
  if (markerFound && !doneObserved) blockers.push('session_done_not_observed');
  return unique(blockers);
}

function hasTerminalSessionFailure(report = {}) {
  const eventTypes = getEventTypes(report);
  return Number(eventTypes['runtime-blocked'] || 0) > 0
    || Number(eventTypes.error || 0) > 0
    || Number(eventTypes.aborted || 0) > 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollSessionEvents(options, runId, marker, deps = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + Number(options.eventTimeoutMs || DEFAULT_EVENT_TIMEOUT_MS);
  const runner = deps.runFabricSessionControlClient || runFabricSessionControlClient;
  let attempts = 0;
  let lastReport = null;
  let lastError = null;

  do {
    attempts += 1;
    try {
      lastReport = await runner({
        aiHomeDir: options.aiHomeDir,
        endpoint: options.endpoint,
        profileId: options.profileId,
        nodeId: options.nodeId,
        runId,
        action: 'events',
        limit: options.eventLimit,
        timeoutMs: Math.min(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, Number(options.eventTimeoutMs) || DEFAULT_EVENT_TIMEOUT_MS)
      }, deps);
      lastError = null;
      const markerFound = markerExists(lastReport, marker);
      const doneObserved = isDoneObserved(lastReport);
      if (markerFound && doneObserved && !hasTerminalSessionFailure(lastReport)) break;
      if (hasTerminalSessionFailure(lastReport)) break;
      if (markerFound && Date.now() >= deadline) break;
    } catch (error) {
      lastError = {
        code: normalizeText(error && error.code, 96) || 'events_failed',
        message: normalizeText(error && error.message, 512) || String(error)
      };
    }
    if (Date.now() >= deadline) break;
    await sleep(Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  } while (Date.now() <= deadline);

  const eventTypes = getEventTypes(lastReport);
  const markerFound = markerExists(lastReport, marker);
  const doneObserved = lastReport ? isDoneObserved(lastReport) : false;
  const blockers = collectSessionEventBlockers(lastReport, lastError, markerFound, doneObserved);
  return {
    ok: markerFound && doneObserved && !lastError && blockers.length === 0,
    runId,
    attempts,
    durationMs: Date.now() - startedAt,
    markerFound,
    doneObserved,
    cursor: Number(lastReport && lastReport.summary && lastReport.summary.cursor || 0),
    eventCount: Number(lastReport && lastReport.summary && lastReport.summary.eventCount || normalizeArray(normalizeObject(lastReport && lastReport.result).events).length || 0),
    eventTypes,
    report: lastReport,
    error: lastError,
    blockers
  };
}

async function runSessionProof(options = {}, deps = {}) {
  if (options.skipSession) {
    return {
      skipped: true,
      ok: true,
      marker: '',
      promptPresent: false,
      runId: '',
      start: null,
      events: null,
      blockers: []
    };
  }

  const marker = normalizeText(options.sessionMarker, 256) || createSessionMarker(new Date());
  const prompt = String(options.prompt || '').trim() || buildSessionPrompt(marker);
  const startRunner = deps.runFabricSessionStartClient || runFabricSessionStartClient;
  const start = await runStep('sessionStart', () => startRunner({
    aiHomeDir: options.aiHomeDir,
    endpoint: options.endpoint,
    profileId: options.profileId,
    nodeId: options.nodeId,
    provider: options.provider,
    prompt,
    projectId: options.projectId,
    projectPath: options.projectPath,
    accountRef: options.accountRef,
    model: options.model,
    timeoutMs: options.sessionTimeoutMs
  }, deps));

  const runId = extractRunId(start.report);
  if (!start.ok || !start.report || start.report.ok !== true || !runId) {
    const blockers = normalizeArray(start.report && start.report.blockers);
    return {
      skipped: false,
      ok: false,
      marker,
      promptPresent: true,
      runId,
      start: start.report,
      events: null,
      blockers: blockers.length > 0 ? blockers : [start.error ? start.error.code : 'session_start_failed']
    };
  }

  const events = await pollSessionEvents(options, runId, marker, deps);
  return {
    skipped: false,
    ok: events.ok === true,
    marker,
    promptPresent: true,
    runId,
    start: start.report,
    events,
    transportDecision: normalizeObject(start.report && start.report.transportDecision),
    blockers: events.ok ? [] : events.blockers
  };
}

function collectProviderStates(node = {}, selectedProvider = DEFAULT_PROVIDER) {
  const source = normalizeObject(node);
  const runtimes = normalizeArray(source.runtimes);
  const gaps = normalizeArray(source.runtimeGaps);
  const actions = normalizeArray(source.actions);
  const providerNames = new Set(KNOWN_PROVIDERS);
  runtimes.forEach((runtime) => {
    const provider = normalizeText(runtime && runtime.provider, 64).toLowerCase();
    if (provider) providerNames.add(provider);
  });
  gaps.forEach((gap) => {
    const provider = normalizeText(gap && gap.provider, 64).toLowerCase();
    if (provider) providerNames.add(provider);
  });
  actions.forEach((action) => {
    const provider = normalizeText(action && action.provider, 64).toLowerCase();
    if (provider) providerNames.add(provider);
  });

  const selected = normalizeText(selectedProvider, 64).toLowerCase();
  return Array.from(providerNames).sort().map((provider) => {
    const action = actions.find((item) => normalizeText(item && item.provider, 64).toLowerCase() === provider
      && normalizeText(item && item.id, 160).startsWith('start-session:')) || null;
    const gap = gaps.find((item) => normalizeText(item && item.provider, 64).toLowerCase() === provider) || null;
    const runtime = runtimes.find((item) => normalizeText(item && item.provider, 64).toLowerCase() === provider) || null;
    const blockers = normalizeArray(action && action.blockers).length > 0
      ? normalizeArray(action.blockers)
      : (gap ? [normalizeText(gap.blocker || gap.status, 160)] : []);
    return {
      provider,
      selected: provider === selected,
      startEnabled: Boolean(action && action.enabled === true),
      eligible: Boolean(action && action.eligible === true),
      runtimeStatus: normalizeText((action && action.runtimeStatus) || (runtime && runtime.status) || (gap && gap.status), 64),
      runtimeId: normalizeText((action && action.runtimeId) || (runtime && runtime.id) || (gap && gap.runtimeId), 96),
      blockers: blockers.map((item) => normalizeText(item, 160)).filter(Boolean),
      diagnostic: normalizeObject(gap && gap.diagnostic)
    };
  });
}

function findProviderState(providerStates = [], provider = DEFAULT_PROVIDER) {
  const wanted = normalizeText(provider, 64).toLowerCase();
  return providerStates.find((item) => item.provider === wanted) || null;
}

function hasAction(node, actionId) {
  return normalizeArray(node && node.actions).some((action) => normalizeText(action && action.id, 160) === actionId && action.enabled === true);
}

function buildMilestones(nodesReport, transportReport, sessionProof, providerStates, options = {}) {
  const node = normalizeObject(nodesReport && nodesReport.targetNode);
  const capabilities = normalizeObject(node.capabilities);
  const transportSummary = normalizeObject(transportReport && transportReport.summary);
  const selectedProvider = findProviderState(providerStates, options.provider);
  const nodeVisible = Boolean(nodesReport && nodesReport.ok === true && node.id);
  const runtimeModelVisible = normalizeArray(node.actions).length > 0 && Array.isArray(node.runtimeGaps);
  const sessionChecked = !sessionProof.skipped;
  return [
    {
      id: 'M3',
      name: 'role_registry_node_visibility',
      status: nodeVisible && capabilities.node && capabilities.relayNode ? 'pass' : 'blocked',
      evidence: `node=${node.id || ''} relay=${capabilities.relayNode === true} project_host=${capabilities.projectHost === true}`
    },
    {
      id: 'M3.5',
      name: 'unified_node_inventory_model',
      status: nodeVisible && runtimeModelVisible ? 'pass' : 'blocked',
      evidence: `actions=${normalizeArray(node.actions).length} runtime_gaps=${normalizeArray(node.runtimeGaps).length} ssh=${capabilities.sshBootstrap === true}`
    },
    {
      id: 'M4',
      name: 'remote_session_marker',
      status: sessionChecked ? (sessionProof.ok ? 'pass' : 'blocked') : 'unchecked',
      evidence: sessionChecked ? `run=${sessionProof.runId || ''} marker=${sessionProof.events && sessionProof.events.markerFound === true}` : 'session proof skipped'
    },
    {
      id: 'M5',
      name: 'session_events_readback',
      status: sessionChecked ? (sessionProof.events && sessionProof.events.ok ? 'pass' : 'blocked') : 'unchecked',
      evidence: sessionChecked && sessionProof.events
        ? `events=${sessionProof.events.eventCount || 0} done=${sessionProof.events.doneObserved === true} cursor=${sessionProof.events.cursor || 0}`
        : 'session proof skipped'
    },
    {
      id: 'M6',
      name: 'transport_remote_development',
      status: transportSummary.advancedPromotionReady === true
        ? 'pass'
        : (transportSummary.remoteDevelopmentReady === true ? 'partial' : 'blocked'),
      evidence: `default=${transportSummary.defaultTransport || ''} fallback=${transportSummary.fallbackReady === true} advanced=${transportSummary.advancedPromotionReady === true}`
    },
    {
      id: 'runtime',
      name: 'selected_provider_account',
      status: selectedProvider && selectedProvider.startEnabled ? 'pass' : 'blocked',
      evidence: `${options.provider || DEFAULT_PROVIDER}: start=${selectedProvider && selectedProvider.startEnabled === true}${selectedProvider && selectedProvider.blockers.length ? ` blockers=${selectedProvider.blockers.join(',')}` : ''}`
    }
  ];
}

function collectRuntimeBlockers(providerStates = [], selectedProvider = DEFAULT_PROVIDER) {
  return providerStates
    .filter((state) => state && state.startEnabled !== true && state.blockers.length > 0)
    .map((state) => ({
      provider: state.provider,
      selected: state.provider === normalizeText(selectedProvider, 64).toLowerCase(),
      blockers: state.blockers
    }));
}

function collectCapabilities(node = {}, transportReport = {}, providerStates = []) {
  const source = normalizeObject(node);
  const capabilities = normalizeObject(source.capabilities);
  const transportSummary = normalizeObject(transportReport.summary);
  return {
    canReadRegistry: Boolean(source.id),
    canUseAsRelay: capabilities.relayNode === true,
    canHostProjects: capabilities.projectHost === true,
    canHostRuntime: capabilities.runtimeHost === true,
    canUseSsh: capabilities.sshBootstrap === true || hasAction(source, 'configure-ssh'),
    canOpenProject: hasAction(source, 'open-project'),
    startableProviders: providerStates
      .filter((state) => state.startEnabled === true)
      .map((state) => state.provider),
    transportKinds: normalizeArray(capabilities.transportKinds),
    defaultTransport: normalizeText(transportSummary.defaultTransport, 64),
    fallbackReady: transportSummary.fallbackReady === true,
    advancedPromotionReady: transportSummary.advancedPromotionReady === true,
    promotedTransports: normalizeArray(transportSummary.promotedTransports)
  };
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value, 256)).filter(Boolean)));
}

function buildNextActions(summary = {}, runtimeBlockers = [], transportSummary = {}, sessionProof = {}) {
  const actions = [];
  if (!summary.nodeReady) {
    actions.push('Configure a Server with its Management Key, then re-run Fabric closure audit.');
  }
  if (!summary.transportReady) {
    actions.push('Run fabric transport status and fix the reported relay/WebRTC readiness blockers.');
  }
  if (!summary.targetProviderReady) {
    actions.push(`Make provider ${summary.provider || DEFAULT_PROVIDER} schedulable on the target AWS node, or choose a provider that is already enabled.`);
  }
  if (!sessionProof.skipped && sessionProof.ok !== true) {
    actions.push('Re-run the real session marker proof after fixing the session blocker.');
  }
  if (runtimeBlockers.some((item) => item.selected !== true)) {
    actions.push('Codex/Claude/AGY need real AWS-side account login/import before they can start sessions; do not upload local credentials without explicit approval.');
  }
  normalizeArray(transportSummary.nextActions).forEach((action) => actions.push(action));
  normalizeArray(transportSummary.blockers).forEach((blocker) => {
    if (blocker.includes('turn')) actions.push('Provide a controlled TURN relay/UDP path, then re-run transport turn-relay and promotion-gate.');
    if (blocker.includes('webtransport')) actions.push('Provide a real HTTPS/H3 WebTransport endpoint, then re-run transport webtransport.');
    if (blocker.includes('mptcp') || blocker.includes('openmptcprouter')) actions.push('Validate a real OpenMPTCPRouter/MPTCP underlay before promoting multipath.');
  });
  if (actions.length === 0) actions.push('No core blocker remains for the selected provider on this node.');
  return unique(actions);
}

function buildSummary(nodesStep, transportStep, sessionProof, providerStates, options = {}) {
  const nodesReport = nodesStep.report || {};
  const transportReport = transportStep.report || {};
  const node = normalizeObject(nodesReport.targetNode);
  const transportSummary = normalizeObject(transportReport.summary);
  const selectedProvider = findProviderState(providerStates, options.provider);
  const runtimeBlockers = collectRuntimeBlockers(providerStates, options.provider);
  const nodeReady = Boolean(nodesStep.ok && node.id);
  const transportReady = transportSummary.remoteDevelopmentReady === true;
  const targetProviderReady = Boolean(selectedProvider && selectedProvider.startEnabled === true);
  const sessionReady = sessionProof.skipped ? true : sessionProof.ok === true;
  const coreReady = nodeReady && transportReady && targetProviderReady && sessionReady;
  const externalBlockers = unique([
    ...normalizeArray(transportSummary.blockers),
    ...runtimeBlockers.flatMap((item) => item.selected ? [] : item.blockers.map((blocker) => `${item.provider}:${blocker}`))
  ]);
  const status = coreReady
    ? (externalBlockers.length > 0 ? 'usable_with_blockers' : 'complete')
    : 'blocked';
  const summary = {
    status,
    coreReady,
    nodeReady,
    transportReady,
    targetProviderReady,
    sessionReady,
    provider: normalizeText(options.provider, 64).toLowerCase() || DEFAULT_PROVIDER,
    nodeId: normalizeText(options.nodeId, 128),
    endpoint: normalizeText(options.endpoint, 2048),
    selectedTransportKind: normalizeText(sessionProof.transportDecision && sessionProof.transportDecision.selectedTransportKind, 64)
      || normalizeText(transportSummary.defaultTransport, 64),
    fallbackUsed: sessionProof.transportDecision && Object.prototype.hasOwnProperty.call(sessionProof.transportDecision, 'fallbackUsed')
      ? sessionProof.transportDecision.fallbackUsed === true
      : null,
    runtimeBlockers,
    externalBlockers
  };
  summary.nextActions = buildNextActions(summary, runtimeBlockers, transportSummary, sessionProof);
  return summary;
}

function mapExternalPrerequisite(prerequisite = {}) {
  return {
    id: normalizeText(prerequisite.id, 128),
    domain: normalizeText(prerequisite.domain, 96),
    owner: normalizeText(prerequisite.owner, 96),
    title: normalizeText(prerequisite.title, 256),
    requiredEvidence: normalizeText(prerequisite.requiredEvidence, 1024),
    status: normalizeText(prerequisite.status, 96),
    failureIds: normalizeArray(prerequisite.failureIds),
    blockers: normalizeArray(prerequisite.blockers),
    commands: normalizeArray(prerequisite.commands),
    nextActions: normalizeArray(prerequisite.nextActions)
  };
}

function mapFailureForHandoff(failure = {}) {
  return {
    id: normalizeText(failure.id, 128),
    status: normalizeText(failure.status, 96),
    domain: normalizeText(failure.domain, 96),
    owner: normalizeText(failure.owner, 96),
    external: failure.external === true,
    canAutomate: failure.canAutomate === true,
    requiresConfirmation: failure.requiresConfirmation === true,
    blockers: normalizeArray(failure.blockers),
    rootCause: normalizeText(failure.rootCause, 1024),
    nextAction: normalizeText(failure.nextAction, 1024),
    command: normalizeText(failure.command, 2048),
    repeatPrevention: normalizeText(failure.repeatPrevention, 1024)
  };
}

function mapExecutionDecision(decision = {}) {
  return {
    decision: normalizeText(decision.decision, 96),
    state: normalizeText(decision.state, 96),
    canContinueWithoutInput: decision.canContinueWithoutInput === true,
    reason: normalizeText(decision.reason, 1024),
    nextCommand: normalizeText(decision.nextCommand, 2048),
    resumeWhen: normalizeArray(decision.resumeWhen)
  };
}

function buildClosureHandoff(report = {}) {
  const summary = normalizeObject(report.summary);
  const failureLedger = normalizeObject(report.failureLedger);
  const businessClosure = normalizeObject(failureLedger.businessClosure);
  const streamProof = normalizeObject(failureLedger.streamProof);
  const automation = normalizeObject(failureLedger.automation);
  const executionDecision = mapExecutionDecision(failureLedger.executionDecision);
  const prerequisites = normalizeArray(failureLedger.externalPrerequisites).map(mapExternalPrerequisite);
  return {
    schema: 'aih.fabric.closure-handoff.v1',
    workflow: normalizeText(report.workflow, 64) || 'closure_audit',
    generatedAt: normalizeText(report.generatedAt, 64),
    target: {
      endpoint: normalizeText(report.target && report.target.endpoint, 2048),
      nodeId: normalizeText(report.target && report.target.nodeId, 128),
      provider: normalizeText(report.target && report.target.provider, 64)
    },
    conclusion: {
      status: normalizeText(failureLedger.status || summary.status, 96),
      businessClosureProven: businessClosure.usable === true,
      streamProofProven: streamProof.ok === true && streamProof.skipped !== true,
      streamProofSkipped: streamProof.skipped === true,
      automationState: normalizeText(automation.state, 96),
      canContinueWithoutInput: automation.canContinueWithoutInput === true,
      runnableCount: Number(automation.runnableCount || 0),
      operatorInputCount: Number(automation.operatorInputCount || 0),
      executionDecision: executionDecision.decision
    },
    proof: {
      businessClosure,
      session: {
        skipped: streamProof.skipped === true,
        ok: streamProof.ok === true,
        runId: normalizeText(streamProof.runId, 160),
        marker: normalizeText(streamProof.marker, 256),
        markerFound: streamProof.markerFound === true,
        doneObserved: streamProof.doneObserved === true,
        eventCount: Number(streamProof.eventCount || 0),
        eventTypes: normalizeObject(streamProof.eventTypes),
        blockers: normalizeArray(streamProof.blockers)
      },
      transport: {
        selectedTransportKind: normalizeText(businessClosure.selectedTransportKind || summary.selectedTransportKind, 64),
        fallbackUsed: Object.prototype.hasOwnProperty.call(businessClosure, 'fallbackUsed')
          ? businessClosure.fallbackUsed
          : summary.fallbackUsed
      }
    },
    failureLedger: {
      status: normalizeText(failureLedger.status, 96),
      closureState: normalizeText(failureLedger.closureState, 96),
      immediateNextId: normalizeText(failureLedger.immediateNextId, 128),
      summary: normalizeObject(failureLedger.summary),
      automation,
      executionDecision
    },
    executionDecision,
    externalPrerequisites: prerequisites,
    nextRequiredEvidence: unique(prerequisites.map((item) => item.requiredEvidence)),
    failures: normalizeArray(failureLedger.failures).map(mapFailureForHandoff),
    repeatPrevention: normalizeArray(failureLedger.repeatPrevention)
  };
}

async function runFabricClosureAudit(rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: DEFAULT_ENDPOINT,
    profileId: '',
    nodeId: DEFAULT_NODE_ID,
    provider: DEFAULT_PROVIDER,
    failOnIncomplete: false,
    skipSession: false,
    skipCloudEdge: false,
    withPromotionGate: false,
    allowDirectWebrtcPromotion: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    eventTimeoutMs: DEFAULT_EVENT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    eventLimit: DEFAULT_EVENT_LIMIT,
    diagnosticsFile: '',
    handoffFile: '',
    workflow: 'closure_audit',
    ...rawOptions
  };
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  options.provider = normalizeText(options.provider, 64).toLowerCase() || DEFAULT_PROVIDER;
  options.nodeId = normalizeText(options.nodeId, 128) || DEFAULT_NODE_ID;

  const nodesStep = await runStep('nodes', () => (
    (deps.runFabricNodesClient || runFabricNodesClient)({
      aiHomeDir: options.aiHomeDir,
      endpoint: options.endpoint,
      profileId: options.profileId,
      nodeId: options.nodeId,
      timeoutMs: options.timeoutMs
    }, deps)
  ));
  const transportStep = await runStep('transportStatus', () => (
    (deps.runFabricTransportStatusCommand || runFabricTransportStatusCommand)(
      buildTransportStatusArgs(options),
      deps
    )
  ));
  const providerStates = collectProviderStates(nodesStep.report && nodesStep.report.targetNode, options.provider);
  const sessionProof = await runSessionProof(options, deps);
  const milestones = buildMilestones(nodesStep.report, transportStep.report, sessionProof, providerStates, options);
  const capabilities = collectCapabilities(nodesStep.report && nodesStep.report.targetNode, transportStep.report, providerStates);
  const summary = buildSummary(nodesStep, transportStep, sessionProof, providerStates, options);
  const closurePlan = buildClosurePlan({
    summary,
    capabilities,
    providerStates,
    sessionProof: {
      skipped: sessionProof.skipped,
      ok: sessionProof.ok,
      marker: sessionProof.marker,
      runId: sessionProof.runId,
      promptPresent: sessionProof.promptPresent,
      markerFound: sessionProof.events ? sessionProof.events.markerFound : false,
      doneObserved: sessionProof.events ? sessionProof.events.doneObserved : false,
      eventCount: sessionProof.events ? sessionProof.events.eventCount : 0,
      eventTypes: sessionProof.events ? sessionProof.events.eventTypes : {},
      attempts: sessionProof.events ? sessionProof.events.attempts : 0,
      blockers: sessionProof.blockers,
      transportDecision: sessionProof.transportDecision || null
    },
    transportSummary: transportStep.report && transportStep.report.summary,
    options
  });
  const sessionProofSummary = {
    skipped: sessionProof.skipped,
    ok: sessionProof.ok,
    marker: sessionProof.marker,
    runId: sessionProof.runId,
    promptPresent: sessionProof.promptPresent,
    markerFound: sessionProof.events ? sessionProof.events.markerFound : false,
    doneObserved: sessionProof.events ? sessionProof.events.doneObserved : false,
    eventCount: sessionProof.events ? sessionProof.events.eventCount : 0,
    eventTypes: sessionProof.events ? sessionProof.events.eventTypes : {},
    attempts: sessionProof.events ? sessionProof.events.attempts : 0,
    blockers: sessionProof.blockers,
    transportDecision: sessionProof.transportDecision || null
  };
  const failureLedger = buildFailureLedger({
    summary,
    capabilities,
    closurePlan,
    sessionProof: sessionProofSummary
  });
  const incomplete = milestones.some((item) => item.status !== 'pass') || summary.externalBlockers.length > 0;
  const exitOk = options.failOnIncomplete ? !incomplete : summary.coreReady;
  const report = {
    ok: summary.coreReady,
    exitOk,
    json: options.json === true,
    workflow: normalizeText(options.workflow, 64) || 'closure_audit',
    generatedAt: new Date().toISOString(),
    target: {
      endpoint: options.endpoint,
      nodeId: options.nodeId,
      provider: options.provider
    },
    summary,
    capabilities,
    closurePlan,
    failureLedger,
    milestones,
    providerStates,
    sessionProof: sessionProofSummary,
    artifacts: {
      diagnosticsFile: options.diagnosticsFile || '',
      handoffFile: options.handoffFile || ''
    },
    steps: {
      nodes: nodesStep,
      transportStatus: transportStep
    },
    reports: {
      nodes: nodesStep.report,
      transportStatus: transportStep.report,
      sessionStart: sessionProof.start,
      sessionEvents: sessionProof.events && sessionProof.events.report
    }
  };
  if (options.diagnosticsFile) writeDiagnosticsFile(options.diagnosticsFile, report);
  if (options.handoffFile) writeHandoffFile(options.handoffFile, buildClosureHandoff(report));
  return report;
}

async function runFabricClosureAuditCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runFabricClosureAudit(options, deps);
  return {
    ...report,
    json: options.json === true
  };
}

function writeDiagnosticsFile(filePath, report) {
  writeJsonFile(filePath, report);
}

function writeHandoffFile(filePath, handoff) {
  writeJsonFile(filePath, handoff);
}

function writeJsonFile(filePath, payload) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function yesNo(value) {
  if (value === null || value === undefined) return 'unknown';
  return value ? 'yes' : 'no';
}

function formatFabricClosureReport(report = {}, title = 'AIH Fabric closure audit') {
  const summary = normalizeObject(report.summary);
  const capabilities = normalizeObject(report.capabilities);
  const sessionProof = normalizeObject(report.sessionProof);
  const lines = [
    title,
    `  endpoint: ${report.target && report.target.endpoint || ''}`,
    `  node_id: ${report.target && report.target.nodeId || ''}`,
    `  provider: ${report.target && report.target.provider || ''}`,
    `  status: ${summary.status || 'unknown'}`,
    `  core_ready: ${yesNo(summary.coreReady)}`,
    `  selected_transport: ${summary.selectedTransportKind || capabilities.defaultTransport || ''}`,
    `  fallback_used: ${yesNo(summary.fallbackUsed)}`,
    `  startable_providers: ${normalizeArray(capabilities.startableProviders).join(', ') || 'none'}`,
    `  can_use_ssh: ${yesNo(capabilities.canUseSsh)}`,
    `  can_open_project: ${yesNo(capabilities.canOpenProject)}`
  ];

  if (sessionProof.skipped) {
    lines.push('  session_proof: skipped');
  } else {
    lines.push(`  session_proof: ${sessionProof.ok ? 'pass' : 'fail'} run=${sessionProof.runId || ''} marker=${sessionProof.markerFound ? 'yes' : 'no'} done=${sessionProof.doneObserved ? 'yes' : 'no'} events=${sessionProof.eventCount || 0}`);
  }

  lines.push('  milestones:');
  normalizeArray(report.milestones).forEach((milestone) => {
    lines.push(`    - ${milestone.id}: ${milestone.status} (${milestone.evidence || ''})`);
  });

  const runtimeBlockers = normalizeArray(summary.runtimeBlockers);
  if (runtimeBlockers.length > 0) {
    lines.push('  runtime_blockers:');
    runtimeBlockers.forEach((item) => {
      lines.push(`    - ${item.provider}: ${normalizeArray(item.blockers).join(', ')}`);
    });
  }

  const externalBlockers = normalizeArray(summary.externalBlockers);
  if (externalBlockers.length > 0) {
    lines.push('  external_blockers:');
    externalBlockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }

  const nextActions = normalizeArray(summary.nextActions);
  if (nextActions.length > 0) {
    lines.push('  next_actions:');
    nextActions.forEach((action) => lines.push(`    - ${action}`));
  }

  lines.push(...formatClosurePlan(report.closurePlan));
  lines.push(...formatFailureLedger(report.failureLedger));

  lines.push(`  result: ${report.exitOk === false ? 'incomplete' : 'pass'}`);
  return lines.join('\n');
}

function formatFabricClosureAuditReport(report = {}) {
  return formatFabricClosureReport(report, 'AIH Fabric closure audit');
}

function formatFabricClosureVerifyReport(report = {}) {
  return formatFabricClosureReport(report, 'AIH Fabric closure verify');
}

async function runFabricClosureVerifyCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runFabricClosureAudit({
    ...options,
    workflow: 'closure_verify'
  }, deps);
  return {
    ...report,
    json: options.json === true
  };
}

async function runFabricClosureStatusCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runFabricClosureAudit({
    ...options,
    skipSession: true,
    skipCloudEdge: true,
    workflow: 'closure_status'
  }, deps);
  const statusReport = projectClosureStatusReport(report);
  return {
    ...statusReport,
    json: options.json === true
  };
}

module.exports = {
  buildClosureHandoff,
  buildMilestones,
  buildSummary,
  buildTransportStatusArgs,
  collectProviderStates,
  createSessionMarker,
  formatFabricClosureAuditReport,
  formatFabricClosureStatusReport,
  formatFabricClosureVerifyReport,
  parseArgs,
  parseFabricClosureAuditArgs: parseArgs,
  runFabricClosureAudit,
  runFabricClosureAuditCommand,
  runFabricClosureStatusCommand,
  runFabricClosureVerifyCommand
};
