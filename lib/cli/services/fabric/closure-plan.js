'use strict';

const {
  explainBlockers
} = require('./blocker-catalog');

const DEFAULT_PROVIDER = 'opencode';

function normalizeText(value, maxLength = 256) {
  const text = String(value || '').trim();
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

function isProviderAccountBlocker(blocker) {
  return /provider_account_unavailable|missing_provider_account|auth_invalid|not_logged_in|not_signed_in|upstream_401/.test(String(blocker || ''));
}

function getSelectedProviderRuntimeBlockers(sessionProof = {}, selectedProvider = DEFAULT_PROVIDER) {
  const provider = normalizeText(selectedProvider, 64).toLowerCase() || DEFAULT_PROVIDER;
  const prefix = `runtime_blocked:${provider}:`;
  return unique(normalizeArray(sessionProof.blockers)
    .map((blocker) => normalizeText(blocker, 256))
    .filter((blocker) => blocker.toLowerCase().startsWith(prefix))
    .filter(isProviderAccountBlocker));
}

function classifyTransportBlocker(blocker) {
  const value = normalizeText(blocker, 256).toLowerCase();
  if (!value) return '';
  if (value.includes('turn_default_udp_probe_busy')) return 'diagnostic_concurrency';
  if (value.includes('turn_default_udp_target_local_only')) return 'diagnostic_context';
  if (value.includes('webtransport')) return 'webtransport';
  if (value.includes('openmptcprouter') || value.includes('mptcp') || value.includes('multipath') || value.startsWith('omr:')) return 'multipath';
  if (value.includes('turn') || value.includes('udp') || value.includes('security') || value.includes('nacl') || value.includes('aws_public_udp_path')) return 'cloud_edge';
  if (value.includes('aws_cli') || value.includes('aws_iam') || value.includes('iam_role') || value.includes('aws_local')) return 'cloud_api';
  return 'transport';
}

function canonicalizeWebTransportBlockers(blockers = []) {
  const source = unique(blockers);
  const endpointMissing = source.some((blocker) => /webtransport_(endpoint_not_configured|not_promoted|h3_endpoint_missing)/.test(blocker));
  if (!endpointMissing) return source;
  return unique([
    'webtransport:webtransport_h3_endpoint_missing',
    ...source.filter((blocker) => !/webtransport_(endpoint_not_configured|not_promoted|h3_endpoint_missing)/.test(blocker))
  ]);
}

function commandLine(parts = []) {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

function buildAuditCommand(options = {}, extra = []) {
  return commandLine([
    'aih fabric closure audit',
    '--node-id',
    normalizeText(options.nodeId, 128),
    '--provider',
    normalizeText(options.provider, 64) || DEFAULT_PROVIDER,
    '--endpoint',
    normalizeText(options.endpoint, 2048),
    ...extra
  ]);
}

function buildProviderAccountsCommand(action, provider, options = {}, extra = []) {
  const endpoint = normalizeText(options.endpoint, 2048);
  return commandLine([
    `aih fabric provider accounts ${action}`,
    ...(endpoint ? ['--endpoint', endpoint] : []),
    '--providers',
    normalizeText(provider, 64).toLowerCase(),
    ...extra
  ]);
}

function buildTransportCommand(name, options = {}, extra = [], config = {}) {
  const includeNodeId = config.includeNodeId !== false;
  return commandLine([
    `aih fabric transport ${name}`,
    '--endpoint',
    normalizeText(options.endpoint, 2048),
    ...(includeNodeId ? ['--node-id', normalizeText(options.nodeId, 128)] : []),
    ...extra
  ]);
}

function describeProviderDiagnostics(providerState = {}) {
  const evidence = {
    startEnabled: providerState.startEnabled === true,
    runtimeStatus: normalizeText(providerState.runtimeStatus, 64),
    runtimeId: normalizeText(providerState.runtimeId, 96)
  };
  const diagnostic = normalizeObject(providerState.diagnostic);
  const hasDiagnostic = Object.keys(diagnostic).length > 0;
  const accounts = normalizeObject(diagnostic.accounts);
  const hasAccounts = Object.keys(accounts).length > 0;
  const reasons = normalizeArray(accounts.reasons)
    .map((item) => {
      const reason = normalizeText(item && item.reason, 160);
      const count = Number(item && item.count || 0);
      return reason ? `${reason}${count > 0 ? `=${count}` : ''}` : '';
    })
    .filter(Boolean);
  const cli = normalizeObject(diagnostic.cli);
  if (hasDiagnostic && Object.keys(cli).length > 0) {
    evidence.cliAvailable = cli.available === true;
    evidence.cliPath = normalizeText(cli.path, 512);
  }
  if (hasAccounts) {
    evidence.accountTotal = Number(accounts.total || 0);
    evidence.schedulable = Number(accounts.schedulable || 0);
    evidence.unavailable = Number(accounts.unavailable || 0);
    evidence.reasons = reasons;
  }
  return evidence;
}

function buildProviderBlockerCommands(provider, providerState = {}, options = {}) {
  return unique([
    buildProviderAccountsCommand('audit', provider, options, ['--json']),
    buildProviderAccountsCommand('revalidate', provider, options, ['--yes', '--json']),
    buildAuditCommand({ ...options, provider }, ['--skip-session', '--json'])
  ]);
}

function buildProviderRuntimeBlockerCommands(provider, providerState = {}, options = {}) {
  return unique([
    buildProviderAccountsCommand('revalidate', provider, options, ['--yes', '--json']),
    buildProviderAccountsCommand('audit', provider, options, ['--json']),
    ...buildProviderBlockerCommands(provider, providerState, options)
  ]);
}

function createPlanItem(input = {}) {
  const blockers = unique(input.blockers || []);
  return {
    id: normalizeText(input.id, 96),
    domain: normalizeText(input.domain, 64),
    status: normalizeText(input.status, 64),
    title: normalizeText(input.title, 160),
    owner: normalizeText(input.owner, 64) || 'aih',
    canAutomate: input.canAutomate === true,
    requiresConfirmation: input.requiresConfirmation === true,
    blockers,
    blockerDetails: explainBlockers(blockers, input.context || {}),
    reason: normalizeText(input.reason, 512),
    commands: unique(input.commands || []),
    evidence: normalizeObject(input.evidence)
  };
}

function buildNodePlanItem(summary = {}, options = {}) {
  if (summary.nodeReady) {
    return createPlanItem({
      id: 'node-registry-ready',
      domain: 'node',
      status: 'done',
      title: 'Server profile and node registry are readable',
      owner: 'aih',
      reason: 'The selected Server can read the target registry.',
      commands: [buildAuditCommand(options, ['--skip-session', '--json'])],
      evidence: {
        nodeId: normalizeText(summary.nodeId, 128),
        endpoint: normalizeText(summary.endpoint, 2048)
      }
    });
  }
  return createPlanItem({
    id: 'server-profile-required',
    domain: 'node',
    status: 'action_required',
    title: 'Configure a Server before reading Fabric data',
    owner: 'operator',
    canAutomate: true,
    blockers: ['ready_server_profile_missing'],
    context: options,
    reason: 'Node inventory is blocked until the client has an authorized server profile.',
    commands: [
      commandLine(['aih server add <name>', '--url', normalizeText(options.endpoint, 2048), '--management-key', '<key>']),
      buildAuditCommand(options, ['--skip-session', '--json'])
    ],
    evidence: {
      nodeReady: false
    }
  });
}

function buildSelectedProviderPlanItem(summary = {}, providerStates = [], sessionProof = {}, options = {}) {
  const selectedProvider = normalizeText(summary.provider || options.provider, 64).toLowerCase() || DEFAULT_PROVIDER;
  if (!summary.nodeReady) {
    return createPlanItem({
      id: `provider-${selectedProvider}-unchecked`,
      domain: 'provider_account',
      status: 'blocked',
      title: `${selectedProvider} provider state cannot be evaluated before node registry is readable`,
      owner: 'aih',
      canAutomate: true,
      blockers: ['ready_server_profile_missing'],
      context: options,
      reason: 'Provider availability depends on the authorized Server registry read; configure the Server before classifying provider credentials.',
      commands: [
        commandLine(['aih server add <name>', '--url', normalizeText(options.endpoint, 2048), '--management-key', '<key>']),
        buildAuditCommand(options, ['--skip-session', '--json'])
      ],
      evidence: {
        nodeReady: false,
        provider: selectedProvider
      }
    });
  }
  const state = normalizeArray(providerStates).find((item) => normalizeText(item && item.provider, 64).toLowerCase() === selectedProvider) || {};
  const diagnostics = describeProviderDiagnostics(state);
  const runtimeBlockers = getSelectedProviderRuntimeBlockers(sessionProof, selectedProvider);
  if (runtimeBlockers.length > 0) {
    return createPlanItem({
      id: `provider-${selectedProvider}-blocked`,
      domain: 'provider_account',
      status: 'blocked_external',
      title: `${selectedProvider} account failed during real session proof`,
      owner: 'operator',
      requiresConfirmation: true,
      blockers: runtimeBlockers,
      context: { ...options, provider: selectedProvider },
      reason: 'The selected provider looked schedulable, but the real session emitted a runtime account block. Revalidate or repair login state before retrying session proof.',
      commands: buildProviderRuntimeBlockerCommands(selectedProvider, state, options),
      evidence: {
        ...diagnostics,
        runId: normalizeText(sessionProof.runId, 160),
        markerFound: sessionProof.markerFound === true,
        doneObserved: sessionProof.doneObserved === true,
        eventCount: Number(sessionProof.eventCount || 0)
      }
    });
  }
  if (summary.targetProviderReady) {
    return createPlanItem({
      id: `provider-${selectedProvider}-ready`,
      domain: 'provider_account',
      status: 'done',
      title: `${selectedProvider} is schedulable on the target node`,
      owner: 'aih',
      reason: 'The selected provider can start a Fabric session on this node.',
      commands: [buildAuditCommand({ ...options, provider: selectedProvider }, ['--json'])],
      evidence: diagnostics
    });
  }
  const blockers = normalizeArray(state.blockers).length > 0 ? state.blockers : [`provider_account_unavailable:${selectedProvider}`];
  return createPlanItem({
    id: `provider-${selectedProvider}-blocked`,
    domain: 'provider_account',
    status: 'blocked_external',
    title: `${selectedProvider} account is not schedulable on the target node`,
    owner: 'operator',
    requiresConfirmation: true,
    blockers,
    context: { ...options, provider: selectedProvider },
    reason: 'Provider credentials or login state must be fixed on the target node; AIH must not upload local credentials without explicit approval.',
    commands: buildProviderBlockerCommands(selectedProvider, state, options),
    evidence: diagnostics
  });
}

function buildOtherProviderPlanItems(summary = {}, providerStates = [], options = {}) {
  const selectedProvider = normalizeText(summary.provider || options.provider, 64).toLowerCase() || DEFAULT_PROVIDER;
  return normalizeArray(providerStates)
    .filter((state) => {
      const provider = normalizeText(state && state.provider, 64).toLowerCase();
      return provider && provider !== selectedProvider && state.startEnabled !== true && normalizeArray(state.blockers).some(isProviderAccountBlocker);
    })
    .map((state) => {
      const provider = normalizeText(state.provider, 64).toLowerCase();
      return createPlanItem({
        id: `provider-${provider}-blocked`,
        domain: 'provider_account',
        status: 'blocked_external',
        title: `${provider} account is present but not schedulable`,
        owner: 'operator',
        requiresConfirmation: true,
        blockers: state.blockers,
        context: { ...options, provider },
        reason: 'This provider needs real AWS-side account login/import/revalidation before sessions can start.',
        commands: buildProviderBlockerCommands(provider, state, options),
        evidence: describeProviderDiagnostics(state)
      });
    });
}

function groupTransportBlockers(transportSummary = {}, summary = {}) {
  const groups = {
    diagnostic_concurrency: [],
    diagnostic_context: [],
    cloud_edge: [],
    cloud_api: [],
    webtransport: [],
    multipath: [],
    transport: []
  };
  unique([
    ...normalizeArray(transportSummary.blockers),
    ...normalizeArray(summary.externalBlockers)
  ]).forEach((blocker) => {
    if (isProviderAccountBlocker(blocker)) return;
    const group = classifyTransportBlocker(blocker) || 'transport';
    groups[group].push(blocker);
  });
  Object.keys(groups).forEach((key) => {
    groups[key] = unique(groups[key]);
  });
  groups.webtransport = canonicalizeWebTransportBlockers(groups.webtransport);
  return groups;
}

function buildTransportPlanItems(summary = {}, capabilities = {}, transportSummary = {}, options = {}) {
  const items = [];
  if (summary.transportReady) {
    items.push(createPlanItem({
      id: 'transport-default-ready',
      domain: 'transport',
      status: 'done',
      title: 'Default remote development transport is usable',
      owner: 'aih',
      reason: 'The target node has a usable default transport and relay fallback state.',
      commands: [buildTransportCommand('status', options, ['--json'])],
      evidence: {
        defaultTransport: normalizeText(capabilities.defaultTransport || summary.selectedTransportKind, 64),
        fallbackReady: capabilities.fallbackReady === true,
        advancedPromotionReady: capabilities.advancedPromotionReady === true,
        promotedTransports: normalizeArray(capabilities.promotedTransports)
      }
    }));
  } else {
    items.push(createPlanItem({
      id: 'transport-default-blocked',
      domain: 'transport',
      status: 'blocked',
      title: 'Default remote development transport is not usable',
      owner: 'aih',
      blockers: transportSummary.blockers,
      context: options,
      reason: 'Remote development cannot be considered ready until relay or an advanced transport passes.',
      commands: [buildTransportCommand('status', options, ['--json'])]
    }));
  }

  const groups = groupTransportBlockers(transportSummary, summary);
  if (groups.diagnostic_concurrency.length > 0) {
    items.push(createPlanItem({
      id: 'transport-diagnostic-concurrency',
      domain: 'diagnostic_concurrency',
      status: 'diagnostic_retry',
      title: 'Default UDP diagnostic is already running',
      owner: 'aih',
      canAutomate: true,
      blockers: groups.diagnostic_concurrency,
      context: options,
      reason: 'A concurrent default UDP diagnostic is binding the default port; this is diagnostic contention, not AWS UDP path evidence.',
      commands: [
        commandLine(['aih fabric transport cloud-edge', '--endpoint', normalizeText(options.endpoint, 2048), '--json']),
        buildTransportCommand('prerequisites', options, ['--json'])
      ],
      evidence: {
        udpReachable: transportSummary.udpReachable === true,
        packetArrivalCaptured: Object.prototype.hasOwnProperty.call(transportSummary, 'packetArrivalCaptured')
          ? transportSummary.packetArrivalCaptured === true
          : null
      }
    }));
  }
  if (groups.diagnostic_context.length > 0) {
    items.push(createPlanItem({
      id: 'transport-diagnostic-context',
      domain: 'diagnostic_context',
      status: 'diagnostic_retry',
      title: 'Transport diagnostic ran in the wrong execution context',
      owner: 'aih',
      canAutomate: true,
      blockers: groups.diagnostic_context,
      context: options,
      reason: 'The diagnostic result only proves target-local behavior; it is not client-to-cloud transport evidence.',
      commands: [
        commandLine(['aih fabric transport cloud-edge', '--endpoint', normalizeText(options.endpoint, 2048), '--json'])
      ],
      evidence: {
        udpReachable: transportSummary.udpReachable === true,
        packetArrivalCaptured: Object.prototype.hasOwnProperty.call(transportSummary, 'packetArrivalCaptured')
          ? transportSummary.packetArrivalCaptured === true
          : null
      }
    }));
  }
  if (groups.cloud_edge.length > 0) {
    items.push(createPlanItem({
      id: 'transport-cloud-edge-udp',
      domain: 'transport_cloud_edge',
      status: 'blocked_external',
      title: 'TURN/UDP cloud edge is not reachable on the default port',
      owner: 'cloud_operator',
      requiresConfirmation: true,
      blockers: groups.cloud_edge,
      context: options,
      reason: 'The AWS host firewall is not blocking UDP, but packets do not arrive at the instance; Security Group or NACL path still needs external verification.',
      commands: [
        commandLine(['aih fabric transport cloud-edge', '--endpoint', normalizeText(options.endpoint, 2048), '--json']),
        buildTransportCommand('turn-relay', options, ['--json'], { includeNodeId: false }),
        buildTransportCommand('promotion-gate', options, ['--json'])
      ],
      evidence: {
        publicIpv4: normalizeText(transportSummary.publicIpv4, 128),
        securityGroupIds: normalizeArray(transportSummary.securityGroupIds),
        hostFirewallBlocksUdp: transportSummary.hostFirewallBlocksUdp === true,
        udpReachable: transportSummary.udpReachable === true,
        packetArrivalCaptured: transportSummary.packetArrivalCaptured === true
      }
    }));
  }
  if (groups.cloud_api.length > 0) {
    items.push(createPlanItem({
      id: 'transport-cloud-api-readback',
      domain: 'transport_cloud_edge',
      status: 'blocked_external',
      title: 'AWS SG/NACL readback cannot run from the node',
      owner: 'cloud_operator',
      requiresConfirmation: true,
      blockers: groups.cloud_api,
      context: options,
      reason: 'AWS CLI or a read-only IAM role is required before AIH can inspect cloud policy; this remains read-only and does not mutate cloud configuration.',
      commands: [
        commandLine(['aih fabric transport cloud-edge', '--endpoint', normalizeText(options.endpoint, 2048), '--json'])
      ],
      evidence: {
        cloudApiCredentialsReady: transportSummary.cloudApiCredentialsReady === true,
        securityGroupIds: normalizeArray(transportSummary.securityGroupIds)
      }
    }));
  }
  if (groups.webtransport.length > 0) {
    items.push(createPlanItem({
      id: 'transport-webtransport-h3',
      domain: 'transport_webtransport',
      status: 'blocked_external',
      title: 'WebTransport requires a real HTTPS/H3 endpoint',
      owner: 'network_operator',
      requiresConfirmation: true,
      blockers: groups.webtransport,
      context: options,
      reason: 'The default 9527 listener is plain HTTP today; WebTransport cannot be promoted until a real secure H3 endpoint passes the browser probe.',
      commands: [
        buildTransportCommand('webtransport', options, ['--json'], { includeNodeId: false }),
        buildTransportCommand('promotion-gate', options, ['--json'])
      ]
    }));
  }
  if (groups.multipath.length > 0) {
    items.push(createPlanItem({
      id: 'transport-multipath-underlay',
      domain: 'transport_multipath',
      status: 'blocked_external',
      title: 'Multipath needs a real OpenMPTCPRouter/MPTCP underlay',
      owner: 'network_operator',
      requiresConfirmation: true,
      blockers: groups.multipath,
      context: options,
      reason: 'Multipath promotion must wait for real dual-ended underlay evidence; it must not be inferred from a single plain HTTP listener.',
      commands: [
        buildTransportCommand('prerequisites', options, ['--json']),
        buildTransportCommand('promotion-gate', options, ['--json'])
      ]
    }));
  }
  return items;
}

function buildSessionPlanItem(sessionProof = {}, summary = {}, options = {}) {
  if (sessionProof.skipped) {
    return createPlanItem({
      id: 'session-marker-proof-unchecked',
      domain: 'session',
      status: 'unchecked',
      title: 'Real session marker proof was skipped',
      owner: 'aih',
      canAutomate: true,
      reason: 'Run a non-skipped closure audit to prove start/events/done on the selected provider.',
      commands: [
        buildAuditCommand(options, ['--session-marker', 'AIH_FABRIC_REAL_MARKER', '--event-timeout-ms', '60000', '--session-timeout-ms', '120000'])
      ],
      evidence: {
        provider: normalizeText(summary.provider, 64),
        nodeId: normalizeText(summary.nodeId, 128)
      }
    });
  }
  if (sessionProof.ok === true) {
    return createPlanItem({
      id: 'session-marker-proof-ready',
      domain: 'session',
      status: 'done',
      title: 'Real session marker proof passed',
      owner: 'aih',
      reason: 'The selected provider produced the expected marker and terminal event stream.',
      commands: [buildAuditCommand(options, ['--json'])],
      evidence: {
        runId: normalizeText(sessionProof.runId, 160),
        markerFound: sessionProof.markerFound === true,
        doneObserved: sessionProof.doneObserved === true,
        eventCount: Number(sessionProof.eventCount || 0)
      }
    });
  }
  return createPlanItem({
    id: 'session-marker-proof-blocked',
    domain: 'session',
    status: 'blocked',
    title: 'Real session marker proof failed',
    owner: 'aih',
    blockers: sessionProof.blockers,
    context: options,
    reason: 'The selected provider cannot be considered end-to-end ready until the marker appears in events and a done/result event is observed.',
    commands: [buildAuditCommand(options, ['--json'])],
    evidence: {
      runId: normalizeText(sessionProof.runId, 160),
      markerFound: sessionProof.markerFound === true,
      doneObserved: sessionProof.doneObserved === true,
      eventCount: Number(sessionProof.eventCount || 0)
    }
  });
}

function rankPlanItem(item = {}, selectedProvider = DEFAULT_PROVIDER) {
  const id = normalizeText(item.id, 96);
  if (item.status === 'action_required') return 5;
  if (id === `provider-${selectedProvider}-blocked`) return 10;
  if (item.status === 'blocked') return 15;
  if (item.status === 'unchecked') return 30;
  if (item.domain === 'diagnostic_concurrency') return 35;
  if (item.domain === 'diagnostic_context') return 35;
  if (item.domain === 'transport_cloud_edge') return 40;
  if (item.domain === 'transport_webtransport') return 50;
  if (item.domain === 'transport_multipath') return 55;
  if (item.domain === 'provider_account') return 70;
  return 80;
}

function buildNextQueue(items = [], selectedProvider = DEFAULT_PROVIDER) {
  return normalizeArray(items)
    .map((item, index) => ({ item, index }))
    .filter((entry) => entry.item && entry.item.status !== 'done')
    .map((entry) => {
      const item = entry.item;
      return {
        id: item.id,
        status: item.status,
        domain: item.domain,
        title: item.title,
        owner: item.owner,
        priority: rankPlanItem(item, selectedProvider),
        canAutomate: item.canAutomate,
        requiresConfirmation: item.requiresConfirmation,
        blockers: normalizeArray(item.blockers),
        command: normalizeArray(item.commands)[0] || '',
        reason: item.reason,
        blockerDetails: normalizeArray(item.blockerDetails),
        order: entry.index
      };
    })
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.order - right.order;
    })
    .map((item) => {
      const { order, ...publicItem } = item;
      return publicItem;
    });
}

function chooseImmediateNext(nextQueue = []) {
  const item = normalizeArray(nextQueue)[0];
  if (item) {
    return {
      id: item.id,
      status: item.status,
      title: item.title,
      owner: item.owner,
      priority: item.priority,
      canAutomate: item.canAutomate,
      requiresConfirmation: item.requiresConfirmation,
      command: item.command
    };
  }
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

function buildClosurePlan(input = {}) {
  const summary = normalizeObject(input.summary);
  const capabilities = normalizeObject(input.capabilities);
  const providerStates = normalizeArray(input.providerStates);
  const sessionProof = normalizeObject(input.sessionProof);
  const transportSummary = normalizeObject(input.transportSummary);
  const options = {
    endpoint: normalizeText(summary.endpoint || input.endpoint || input.options && input.options.endpoint, 2048),
    nodeId: normalizeText(summary.nodeId || input.nodeId || input.options && input.options.nodeId, 128),
    provider: normalizeText(summary.provider || input.provider || input.options && input.options.provider, 64).toLowerCase() || DEFAULT_PROVIDER
  };
  const items = [
    buildNodePlanItem(summary, options),
    buildSelectedProviderPlanItem(summary, providerStates, sessionProof, options),
    ...buildOtherProviderPlanItems(summary, providerStates, options),
    ...buildTransportPlanItems(summary, capabilities, transportSummary, options),
    buildSessionPlanItem(sessionProof, summary, options)
  ];
  const blocked = items.filter((item) => item.status === 'blocked').length;
  const external = items.filter((item) => item.status === 'blocked_external').length;
  const unchecked = items.filter((item) => item.status === 'unchecked').length;
  const actionRequired = items.filter((item) => item.status === 'action_required').length;
  const done = items.filter((item) => item.status === 'done').length;
  const state = blocked > 0 || actionRequired > 0
    ? 'blocked'
    : (unchecked > 0 ? 'needs_real_session_proof' : (external > 0 ? 'usable_with_external_blockers' : 'complete'));
  const nextQueue = buildNextQueue(items, options.provider);
  return {
    state,
    immediateNext: chooseImmediateNext(nextQueue),
    nextQueue,
    counts: {
      done,
      blocked,
      blockedExternal: external,
      unchecked,
      actionRequired
    },
    items
  };
}

function formatClosurePlan(plan = {}) {
  const items = normalizeArray(plan.items);
  if (items.length === 0) return [];
  const lines = [
    '  closure_plan:',
    `    state: ${normalizeText(plan.state, 64) || 'unknown'}`
  ];
  const next = normalizeObject(plan.immediateNext);
  if (next.id) {
    lines.push(`    immediate_next: ${next.status || 'unknown'} ${next.id}${next.command ? ` -> ${next.command}` : ''}`);
  }
  const nextQueue = normalizeArray(plan.nextQueue);
  if (nextQueue.length > 0) {
    lines.push('    next_queue:');
    nextQueue.slice(0, 5).forEach((item) => {
      lines.push(`      - ${item.id}: ${item.status} owner=${item.owner}${item.command ? ` -> ${item.command}` : ''}`);
    });
  }
  items.forEach((item) => {
    lines.push(`    - ${item.id}: ${item.status} [${item.domain}] ${item.title}`);
    if (normalizeArray(item.blockers).length > 0) {
      lines.push(`      blockers: ${item.blockers.join(', ')}`);
    }
    if (normalizeArray(item.blockerDetails).length > 0) {
      const first = item.blockerDetails[0];
      lines.push(`      next: ${first.owner} -> ${first.nextAction}`);
    }
  });
  return lines;
}

module.exports = {
  buildClosurePlan,
  buildNextQueue,
  classifyTransportBlocker,
  formatClosurePlan
};
