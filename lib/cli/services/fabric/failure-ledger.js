'use strict';

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
  return Array.from(new Set(values.map((value) => normalizeText(value, 512)).filter(Boolean)));
}

function indexPlanItems(items = []) {
  const byId = new Map();
  normalizeArray(items).forEach((item) => {
    const id = normalizeText(item && item.id, 128);
    if (id && !byId.has(id)) byId.set(id, item);
  });
  return byId;
}

function firstBlockerDetail(queueItem = {}, planItem = {}) {
  return normalizeArray(queueItem.blockerDetails)[0]
    || normalizeArray(planItem.blockerDetails)[0]
    || {};
}

function isExternal(queueItem = {}, planItem = {}) {
  if (queueItem.status === 'blocked_external' || planItem.status === 'blocked_external') return true;
  return normalizeArray(queueItem.blockerDetails).some((detail) => detail && detail.external === true)
    || normalizeArray(planItem.blockerDetails).some((detail) => detail && detail.external === true);
}

function inferRepeatPrevention(entry = {}) {
  const domain = normalizeText(entry.domain, 96);
  const blockers = normalizeArray(entry.blockers).join(' ');
  if (domain === 'provider_account') {
    return 'Do not debug this as a transport failure until the provider is reauthenticated or replaced on the target node.';
  }
  if (domain === 'transport_cloud_edge' || /udp|turn|aws_public_udp_path|aws_cli|iam|nacl/i.test(blockers)) {
    return 'Do not repeat cloud-edge probes expecting a different result until SG/NACL, AWS readback credentials, or TURN configuration changes.';
  }
  if (domain === 'transport_webtransport' || /webtransport/i.test(blockers)) {
    return 'Do not classify this as a browser failure while WebTransport exists but the HTTPS/H3 endpoint is not configured.';
  }
  if (domain === 'transport_multipath' || /mptcp|openmptcprouter|multipath|omr/i.test(blockers)) {
    return 'Do not promote multipath from one-sided kernel capability; require real end-to-end MPTCP/OpenMPTCPRouter evidence.';
  }
  if (domain === 'session') {
    return 'Do not count terminal echo as proof; require canonical marker output plus done/result events.';
  }
  return 'Re-run only after the recorded blocker or command output changes.';
}

function buildFailureEntry(queueItem = {}, planItem = {}) {
  const detail = firstBlockerDetail(queueItem, planItem);
  const command = normalizeText(queueItem.command, 2048)
    || normalizeText(normalizeArray(planItem.commands)[0], 2048)
    || normalizeText(detail.command, 2048);
  const blockers = unique([
    ...normalizeArray(queueItem.blockers),
    ...normalizeArray(planItem.blockers)
  ]);
  const entry = {
    id: normalizeText(queueItem.id || planItem.id, 128),
    status: normalizeText(queueItem.status || planItem.status, 64),
    domain: normalizeText(queueItem.domain || planItem.domain || detail.domain, 96),
    owner: normalizeText(queueItem.owner || planItem.owner || detail.owner, 96),
    external: isExternal(queueItem, planItem),
    canAutomate: queueItem.canAutomate === true || planItem.canAutomate === true,
    requiresConfirmation: queueItem.requiresConfirmation === true || planItem.requiresConfirmation === true,
    blockers,
    rootCause: normalizeText(queueItem.reason || planItem.reason || detail.reason, 1024),
    nextAction: normalizeText(detail.nextAction || queueItem.title || planItem.title, 1024),
    command,
    evidence: normalizeObject(planItem.evidence)
  };
  entry.repeatPrevention = inferRepeatPrevention(entry);
  return entry;
}

function buildBusinessClosure(summary = {}, capabilities = {}) {
  return {
    usable: summary.coreReady === true,
    status: normalizeText(summary.status, 96),
    nodeReady: summary.nodeReady === true,
    transportReady: summary.transportReady === true,
    targetProviderReady: summary.targetProviderReady === true,
    sessionReady: summary.sessionReady === true,
    provider: normalizeText(summary.provider, 64),
    nodeId: normalizeText(summary.nodeId, 128),
    selectedTransportKind: normalizeText(summary.selectedTransportKind || capabilities.defaultTransport, 64),
    fallbackUsed: Object.prototype.hasOwnProperty.call(summary, 'fallbackUsed') ? summary.fallbackUsed : null,
    startableProviders: normalizeArray(capabilities.startableProviders)
  };
}

function buildStreamProof(sessionProof = {}) {
  return {
    skipped: sessionProof.skipped === true,
    ok: sessionProof.ok === true,
    runId: normalizeText(sessionProof.runId, 160),
    marker: normalizeText(sessionProof.marker, 256),
    markerFound: sessionProof.markerFound === true,
    doneObserved: sessionProof.doneObserved === true,
    eventCount: Number(sessionProof.eventCount || 0),
    eventTypes: normalizeObject(sessionProof.eventTypes),
    blockers: normalizeArray(sessionProof.blockers)
  };
}

function buildRepeatPreventionRules(failures = [], businessClosure = {}, streamProof = {}) {
  const rules = [];
  if (businessClosure.usable && streamProof.ok && streamProof.skipped !== true) {
    rules.push('Business closure for the selected provider is already proven; do not re-run it unless node, provider, or transport state changes.');
  }
  failures.forEach((failure) => rules.push(failure.repeatPrevention));
  if (failures.some((failure) => /udp|turn|cloud_edge/i.test(`${failure.domain} ${failure.blockers.join(' ')}`))) {
    rules.push('Run only one default UDP transport diagnostic at a time; concurrent probes can create artificial probe-busy failures.');
  }
  return unique(rules);
}

function buildFailureSummary(failures = []) {
  const countsByDomain = {};
  let external = 0;
  let actionableByAih = 0;
  failures.forEach((failure) => {
    const domain = failure.domain || 'unknown';
    countsByDomain[domain] = (countsByDomain[domain] || 0) + 1;
    if (failure.external) external += 1;
    if (failure.canAutomate && !failure.external) actionableByAih += 1;
  });
  return {
    total: failures.length,
    external,
    actionableByAih,
    countsByDomain,
    allExternal: failures.length > 0 && failures.every((failure) => failure.external === true)
  };
}

function prerequisiteTemplateFor(failure = {}) {
  const domain = normalizeText(failure.domain, 96);
  if (domain === 'provider_account') {
    return {
      id: 'provider-credentials',
      domain,
      owner: 'operator',
      title: 'Provider accounts on the target node must be schedulable',
      requiredEvidence: 'Reauthenticated or replaced provider accounts on the target node, followed by a provider account audit that clears the auth blockers.'
    };
  }
  if (domain === 'transport_cloud_edge') {
    return {
      id: 'cloud-udp-policy',
      domain,
      owner: 'cloud_operator',
      title: 'Cloud UDP path or AWS policy readback must be proven',
      requiredEvidence: 'SG/NACL readback or a controlled TURN/UDP path that proves packets can reach the target node.'
    };
  }
  if (domain === 'transport_webtransport') {
    return {
      id: 'webtransport-h3-endpoint',
      domain,
      owner: 'network_operator',
      title: 'WebTransport requires a real HTTPS/H3 endpoint',
      requiredEvidence: 'Browser WebTransport handshake and stream/RPC smoke against an HTTPS/H3 endpoint.'
    };
  }
  if (domain === 'transport_multipath') {
    return {
      id: 'multipath-underlay',
      domain,
      owner: 'network_operator',
      title: 'Multipath requires an end-to-end MPTCP/OpenMPTCPRouter underlay',
      requiredEvidence: 'Dual-ended MPTCP/OpenMPTCPRouter evidence plus transport smoke over the promoted underlay.'
    };
  }
  return null;
}

function buildExternalPrerequisites(failures = []) {
  const grouped = new Map();
  normalizeArray(failures)
    .filter((failure) => failure && failure.external === true)
    .forEach((failure) => {
      const template = prerequisiteTemplateFor(failure);
      if (!template) return;
      const current = grouped.get(template.id) || {
        id: template.id,
        domain: template.domain,
        owner: template.owner,
        title: template.title,
        requiredEvidence: template.requiredEvidence,
        failureIds: [],
        blockers: [],
        commands: [],
        nextActions: []
      };
      current.failureIds.push(failure.id);
      current.blockers.push(...normalizeArray(failure.blockers));
      if (failure.command) current.commands.push(failure.command);
      if (failure.nextAction) current.nextActions.push(failure.nextAction);
      grouped.set(template.id, current);
    });
  return Array.from(grouped.values()).map((item) => ({
    ...item,
    failureIds: unique(item.failureIds),
    blockers: unique(item.blockers),
    commands: unique(item.commands),
    nextActions: unique(item.nextActions),
    status: 'awaiting_external_input'
  }));
}

function hasPlaceholderCommand(command) {
  const text = normalizeText(command, 2048);
  return !text || /<[^>]+>/.test(text);
}

function canRunAutomatically(failure = {}) {
  const blockers = normalizeArray(failure.blockers).join(' ');
  return failure.canAutomate === true
    && failure.external !== true
    && failure.requiresConfirmation !== true
    && !/ready_server_profile_missing/.test(blockers)
    && !hasPlaceholderCommand(failure.command);
}

function buildAutomationSummary(failures = [], businessClosure = {}, streamProof = {}) {
  const profileMissing = failures.some((failure) => /ready_server_profile_missing/.test(normalizeArray(failure.blockers).join(' ')));
  const runnable = profileMissing ? [] : failures.filter(canRunAutomatically);
  const externalOrConfirmation = failures.filter((failure) => failure.external === true || failure.requiresConfirmation === true);
  const placeholderOnly = failures.filter((failure) => failure.canAutomate === true && hasPlaceholderCommand(failure.command));
  let state = 'clear';
  if (runnable.length > 0) {
    state = 'can_continue';
  } else if (failures.length === 0) {
    state = 'clear';
  } else if (businessClosure.usable === true && streamProof.ok === true && failures.every((failure) => failure.external === true)) {
    state = 'awaiting_external_input';
  } else if (placeholderOnly.length > 0 || externalOrConfirmation.length > 0) {
    state = 'awaiting_operator_input';
  } else {
    state = 'blocked_needs_triage';
  }
  return {
    state,
    canContinueWithoutInput: runnable.length > 0,
    nextAutomatable: runnable[0] ? {
      id: runnable[0].id,
      command: runnable[0].command,
      reason: runnable[0].rootCause
    } : null,
    runnableCount: runnable.length,
    operatorInputCount: failures.length - runnable.length,
    externalOrConfirmationCount: externalOrConfirmation.length,
    placeholderCommandCount: placeholderOnly.length,
    blockedByProfileMissing: profileMissing
  };
}

function buildExecutionDecision(failures = [], businessClosure = {}, streamProof = {}, automation = {}, externalPrerequisites = []) {
  const next = normalizeObject(automation.nextAutomatable);
  const state = normalizeText(automation.state, 96);
  if (automation.canContinueWithoutInput === true) {
    return {
      decision: 'continue_automatable',
      state,
      canContinueWithoutInput: true,
      reason: 'A non-external action can still run without operator input.',
      nextCommand: normalizeText(next.command, 2048),
      resumeWhen: []
    };
  }
  if (failures.length === 0) {
    return {
      decision: 'complete',
      state,
      canContinueWithoutInput: false,
      reason: 'No closure failure remains for this target.',
      nextCommand: '',
      resumeWhen: []
    };
  }
  if (automation.blockedByProfileMissing === true) {
    return {
      decision: 'stop_configure_server',
      state,
      canContinueWithoutInput: false,
      reason: 'The client must configure a ready Server before AIH can read the registry or continue automation.',
      nextCommand: '',
      resumeWhen: ['A ready Server profile is available and Fabric can read the target registry.']
    };
  }
  if (businessClosure.usable === true && streamProof.ok === true && streamProof.skipped !== true && state === 'awaiting_external_input') {
    return {
      decision: 'stop_awaiting_external_input',
      state,
      canContinueWithoutInput: false,
      reason: 'Business closure and stream proof already passed; every remaining failure is external or requires confirmation.',
      nextCommand: '',
      resumeWhen: unique(normalizeArray(externalPrerequisites).map((item) => item && item.requiredEvidence))
    };
  }
  if (state === 'awaiting_operator_input' || Number(automation.placeholderCommandCount || 0) > 0) {
    return {
      decision: 'stop_operator_input_required',
      state,
      canContinueWithoutInput: false,
      reason: 'The next action needs operator input or a concrete command value before automation can continue.',
      nextCommand: '',
      resumeWhen: ['The operator supplies the required value, confirmation, or credential input.']
    };
  }
  if (Number(automation.externalOrConfirmationCount || 0) > 0) {
    return {
      decision: 'stop_confirmation_required',
      state,
      canContinueWithoutInput: false,
      reason: 'The remaining actions require external confirmation before AIH should run them again.',
      nextCommand: '',
      resumeWhen: unique(normalizeArray(externalPrerequisites).map((item) => item && item.requiredEvidence))
    };
  }
  return {
    decision: 'blocked_needs_triage',
    state,
    canContinueWithoutInput: false,
    reason: 'No safe automatable action is available, and the blocker does not yet map to a known external prerequisite.',
    nextCommand: '',
    resumeWhen: ['A stable blocker category is added or the diagnostic output changes.']
  };
}

function buildFailureLedger(input = {}) {
  const summary = normalizeObject(input.summary);
  const capabilities = normalizeObject(input.capabilities);
  const closurePlan = normalizeObject(input.closurePlan);
  const sessionProof = normalizeObject(input.sessionProof);
  const planItems = indexPlanItems(closurePlan.items);
  const failures = normalizeArray(closurePlan.nextQueue)
    .map((queueItem) => buildFailureEntry(queueItem, planItems.get(normalizeText(queueItem && queueItem.id, 128)) || {}))
    .filter((entry) => entry.id);
  const businessClosure = buildBusinessClosure(summary, capabilities);
  const streamProof = buildStreamProof(sessionProof);
  const failureSummary = buildFailureSummary(failures);
  const automation = buildAutomationSummary(failures, businessClosure, streamProof);
  const externalPrerequisites = buildExternalPrerequisites(failures);
  const executionDecision = buildExecutionDecision(failures, businessClosure, streamProof, automation, externalPrerequisites);
  return {
    status: failures.length === 0 ? 'clear' : (businessClosure.usable ? 'usable_with_recorded_failures' : 'blocked_with_recorded_failures'),
    closureState: normalizeText(closurePlan.state, 96),
    immediateNextId: normalizeText(normalizeObject(closurePlan.immediateNext).id, 128),
    businessClosure,
    streamProof,
    summary: failureSummary,
    automation,
    executionDecision,
    externalPrerequisites,
    failures,
    repeatPrevention: buildRepeatPreventionRules(failures, businessClosure, streamProof)
  };
}

function formatFailureLedger(ledger = {}) {
  const failures = normalizeArray(ledger.failures);
  const lines = [
    '  failure_ledger:',
    `    status: ${normalizeText(ledger.status, 96) || 'unknown'}`,
    `    closure_state: ${normalizeText(ledger.closureState, 96) || 'unknown'}`,
    `    immediate_next: ${normalizeText(ledger.immediateNextId, 128) || 'none'}`
  ];
  const automation = normalizeObject(ledger.automation);
  if (automation.state) {
    lines.push(`    automation: ${automation.state} can_continue=${automation.canContinueWithoutInput ? 'yes' : 'no'}`);
    const next = normalizeObject(automation.nextAutomatable);
    if (next.id) {
      lines.push(`      next_automatable: ${next.id}${next.command ? ` -> ${next.command}` : ''}`);
    }
  }
  const decision = normalizeObject(ledger.executionDecision);
  if (decision.decision) {
    lines.push(`    decision: ${decision.decision} can_continue=${decision.canContinueWithoutInput ? 'yes' : 'no'}`);
    if (decision.reason) lines.push(`      reason: ${decision.reason}`);
    const resumeWhen = normalizeArray(decision.resumeWhen);
    if (resumeWhen.length > 0) {
      lines.push('      resume_when:');
      resumeWhen.slice(0, 5).forEach((item) => lines.push(`        - ${item}`));
    }
  }
  const prerequisites = normalizeArray(ledger.externalPrerequisites);
  if (prerequisites.length > 0) {
    lines.push('    external_prerequisites:');
    prerequisites.forEach((item) => {
      lines.push(`      - ${item.id}: ${item.title}`);
      if (item.requiredEvidence) lines.push(`        required: ${item.requiredEvidence}`);
    });
  }
  if (failures.length > 0) {
    lines.push('    failures:');
    failures.slice(0, 8).forEach((failure) => {
      lines.push(`      - ${failure.id}: ${failure.domain} owner=${failure.owner} external=${failure.external ? 'yes' : 'no'}`);
      if (failure.rootCause) lines.push(`        cause: ${failure.rootCause}`);
      if (failure.nextAction) lines.push(`        next: ${failure.nextAction}`);
    });
  }
  const repeatPrevention = normalizeArray(ledger.repeatPrevention);
  if (repeatPrevention.length > 0) {
    lines.push('    repeat_prevention:');
    repeatPrevention.slice(0, 8).forEach((rule) => lines.push(`      - ${rule}`));
  }
  return lines;
}

module.exports = {
  buildFailureLedger,
  formatFailureLedger
};
