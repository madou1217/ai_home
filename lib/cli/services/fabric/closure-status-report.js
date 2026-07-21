'use strict';

const {
  formatClosurePlan
} = require('./closure-plan');
const {
  buildFailureLedger,
  formatFailureLedger
} = require('./failure-ledger');

const DEFAULT_PROVIDER = 'opencode';
const STATUS_SKIPPED_SESSION_PROOF_ID = 'session-marker-proof-unchecked';

function normalizeText(value, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value, 256)).filter(Boolean)));
}

function yesNo(value) {
  if (value === null || value === undefined) return 'unknown';
  return value ? 'yes' : 'no';
}

function isStatusSkippedSessionProof(item = {}) {
  return normalizeText(item && item.id, 128) === STATUS_SKIPPED_SESSION_PROOF_ID;
}

function countClosurePlanItems(items = []) {
  const counts = {
    done: 0,
    blocked: 0,
    blockedExternal: 0,
    unchecked: 0,
    actionRequired: 0
  };
  normalizeArray(items).forEach((item) => {
    if (item.status === 'done') counts.done += 1;
    if (item.status === 'blocked') counts.blocked += 1;
    if (item.status === 'blocked_external') counts.blockedExternal += 1;
    if (item.status === 'unchecked') counts.unchecked += 1;
    if (item.status === 'action_required') counts.actionRequired += 1;
  });
  return counts;
}

function deriveClosurePlanState(counts = {}) {
  if (counts.blocked > 0 || counts.actionRequired > 0) return 'blocked';
  if (counts.unchecked > 0) return 'needs_real_session_proof';
  if (counts.blockedExternal > 0) return 'usable_with_external_blockers';
  return 'complete';
}

function selectImmediateNext(nextQueue = []) {
  const item = normalizeArray(nextQueue)[0];
  if (!item) {
    return {
      id: 'none',
      status: 'done',
      title: 'No closure action remains for this target',
      owner: 'aih',
      canAutomate: false,
      requiresConfirmation: false,
      command: ''
    };
  }
  return {
    id: normalizeText(item.id, 128),
    status: normalizeText(item.status, 64),
    title: normalizeText(item.title, 256),
    owner: normalizeText(item.owner, 96),
    priority: Number(item.priority || 0),
    canAutomate: item.canAutomate === true,
    requiresConfirmation: item.requiresConfirmation === true,
    command: normalizeText(item.command, 2048)
  };
}

function projectClosurePlanForStatus(closurePlan = {}) {
  const items = normalizeArray(closurePlan.items).filter((item) => !isStatusSkippedSessionProof(item));
  const nextQueue = normalizeArray(closurePlan.nextQueue).filter((item) => !isStatusSkippedSessionProof(item));
  const counts = countClosurePlanItems(items);
  return {
    ...closurePlan,
    state: deriveClosurePlanState(counts),
    immediateNext: selectImmediateNext(nextQueue),
    nextQueue,
    counts,
    items
  };
}

function buildStatusAvailableNow(summary = {}, capabilities = {}) {
  const items = [];
  if (capabilities.canReadRegistry === true) items.push('node_registry');
  if (capabilities.canUseAsRelay === true) items.push('relay_node');
  if (capabilities.canHostProjects === true) items.push('project_host');
  if (capabilities.canUseSsh === true) items.push('ssh_bootstrap');
  if (capabilities.canOpenProject === true) items.push('open_project');
  if (summary.transportReady === true) {
    const transport = normalizeText(summary.selectedTransportKind || capabilities.defaultTransport, 64);
    items.push(transport ? `transport:${transport}` : 'transport');
  }
  if (summary.targetProviderReady === true) {
    items.push(`start-session:${normalizeText(summary.provider, 64) || DEFAULT_PROVIDER}`);
  }
  return unique(items);
}

function buildStatusBlockedProviders(providerStates = []) {
  return normalizeArray(providerStates)
    .filter((state) => state && state.startEnabled !== true && normalizeArray(state.blockers).length > 0)
    .map((state) => ({
      provider: normalizeText(state.provider, 64),
      blockers: normalizeArray(state.blockers)
    }));
}

function buildStatusView(report = {}) {
  const summary = normalizeObject(report.summary);
  const capabilities = normalizeObject(report.capabilities);
  const failureLedger = normalizeObject(report.failureLedger);
  return {
    mode: 'status_only',
    sessionProof: 'not_run_by_status',
    availableNow: buildStatusAvailableNow(summary, capabilities),
    blockedProviders: buildStatusBlockedProviders(report.providerStates),
    externalBlockers: normalizeArray(summary.externalBlockers),
    externalPrerequisites: normalizeArray(failureLedger.externalPrerequisites).map((item) => ({
      id: normalizeText(item && item.id, 128),
      owner: normalizeText(item && item.owner, 96),
      title: normalizeText(item && item.title, 256),
      requiredEvidence: normalizeText(item && item.requiredEvidence, 1024)
    })),
    canContinueWithoutInput: normalizeObject(failureLedger.executionDecision).canContinueWithoutInput === true,
    decision: normalizeText(normalizeObject(failureLedger.executionDecision).decision, 96)
  };
}

function projectClosureStatusReport(report = {}) {
  const closurePlan = projectClosurePlanForStatus(report.closurePlan);
  const sessionProof = {
    ...normalizeObject(report.sessionProof),
    skipped: true
  };
  const failureLedger = buildFailureLedger({
    summary: report.summary,
    capabilities: report.capabilities,
    closurePlan,
    sessionProof
  });
  const projected = {
    ...report,
    closurePlan,
    failureLedger,
    sessionProof
  };
  return {
    ...projected,
    statusView: buildStatusView(projected)
  };
}

function formatFabricClosureStatusReport(report = {}) {
  const summary = normalizeObject(report.summary);
  const capabilities = normalizeObject(report.capabilities);
  const statusView = normalizeObject(report.statusView);
  const lines = [
    'AIH Fabric closure status',
    `  endpoint: ${report.target && report.target.endpoint || ''}`,
    `  node_id: ${report.target && report.target.nodeId || ''}`,
    `  provider: ${report.target && report.target.provider || ''}`,
    `  status: ${summary.status || 'unknown'}`,
    `  mode: ${statusView.mode || 'status_only'}`,
    `  core_ready: ${yesNo(summary.coreReady)}`,
    `  selected_transport: ${summary.selectedTransportKind || capabilities.defaultTransport || ''}`,
    `  fallback_ready: ${yesNo(capabilities.fallbackReady)}`,
    `  startable_providers: ${normalizeArray(capabilities.startableProviders).join(', ') || 'none'}`,
    `  session_proof: ${statusView.sessionProof || 'not_run_by_status'}`
  ];

  const availableNow = normalizeArray(statusView.availableNow);
  if (availableNow.length > 0) {
    lines.push('  available_now:');
    availableNow.forEach((item) => lines.push(`    - ${item}`));
  }

  const blockedProviders = normalizeArray(statusView.blockedProviders);
  if (blockedProviders.length > 0) {
    lines.push('  blocked_providers:');
    blockedProviders.forEach((item) => {
      lines.push(`    - ${item.provider}: ${normalizeArray(item.blockers).join(', ')}`);
    });
  }

  const externalBlockers = normalizeArray(statusView.externalBlockers);
  if (externalBlockers.length > 0) {
    lines.push('  external_blockers:');
    externalBlockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }

  lines.push(...formatClosurePlan(report.closurePlan));
  lines.push(...formatFailureLedger(report.failureLedger));
  lines.push(`  result: ${report.exitOk === false ? 'incomplete' : 'pass'}`);
  return lines.join('\n');
}

module.exports = {
  formatFabricClosureStatusReport,
  projectClosureStatusReport
};
