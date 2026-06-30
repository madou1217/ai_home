'use strict';

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_NODE_ID = 'aws-current-node';

function normalizeText(value, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function commandLine(parts = []) {
  return parts.map((part) => normalizeText(part, 2048)).filter(Boolean).join(' ');
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value, 512)).filter(Boolean)));
}

function normalizeBlockerCode(blocker) {
  const raw = normalizeText(blocker, 256);
  if (!raw) return '';
  const parts = raw.split(':').map((part) => normalizeText(part, 128)).filter(Boolean);
  if (parts.length === 1) return raw;
  const knownProviders = ['codex', 'claude', 'agy', 'opencode'];
  const offset = knownProviders.includes(parts[0].toLowerCase()) ? 1 : 0;
  const head = parts[offset] || parts[0];
  if (head === 'provider_account_unavailable' || head === 'missing_provider_account') return head;
  if (head === 'auth_invalid') return parts[offset + 1] || head;
  return parts[parts.length - 1];
}

function inferProvider(blocker, context = {}) {
  const explicit = normalizeText(context.provider, 64).toLowerCase();
  const raw = normalizeText(blocker, 256).toLowerCase();
  const known = ['codex', 'claude', 'agy', 'opencode'];
  const prefix = raw.split(':')[0];
  if (known.includes(prefix)) return prefix;
  const suffix = raw.split(':').pop();
  if (known.includes(suffix)) return suffix;
  return explicit;
}

function buildCommand(name, context = {}, extra = []) {
  const endpoint = normalizeText(context.endpoint, 2048) || DEFAULT_ENDPOINT;
  const nodeId = normalizeText(context.nodeId, 128) || DEFAULT_NODE_ID;
  if (name === 'cloud-edge') {
    return commandLine(['aih fabric transport cloud-edge', '--endpoint', endpoint, '--json']);
  }
  if (name === 'transport-status') {
    return commandLine(['aih fabric transport status', '--endpoint', endpoint, '--node-id', nodeId, '--json']);
  }
  if (name === 'webtransport') {
    return commandLine(['aih fabric transport webtransport', '--endpoint', endpoint, '--json']);
  }
  if (name === 'promotion-gate') {
    return commandLine(['aih fabric transport promotion-gate', '--endpoint', endpoint, '--json']);
  }
  if (name === 'prerequisites') {
    return commandLine(['aih fabric transport prerequisites', '--endpoint', endpoint, '--json']);
  }
  if (name === 'profile-pair') {
    return commandLine(['aih fabric profile pair <pair-url|code>', '--endpoint', endpoint, '--json']);
  }
  if (name === 'closure-audit') {
    return commandLine(['aih fabric closure audit', '--endpoint', endpoint, '--node-id', nodeId, ...extra]);
  }
  return '';
}

function describeProviderBlocker(blocker, context = {}) {
  const provider = inferProvider(blocker, context);
  const endpoint = normalizeText(context.endpoint, 2048);
  return {
    domain: 'provider_account',
    owner: 'operator',
    impact: 'additional_provider',
    priority: 70,
    canAutomate: false,
    requiresConfirmation: true,
    external: true,
    reason: 'Provider login state must be fixed on the target node; AIH must not copy local credentials without explicit approval.',
    nextAction: `Audit and revalidate ${provider || 'the provider'} on the target node, then start remote reauth when an interactive login is required.`,
    command: commandLine([
      'aih fabric provider accounts audit',
      ...(endpoint ? ['--endpoint', endpoint] : []),
      '--providers',
      provider || '<provider>',
      '--json'
    ])
  };
}

function describeBlocker(blocker, context = {}) {
  const raw = normalizeText(blocker, 256);
  const code = normalizeBlockerCode(raw).toLowerCase();
  let details;

  if (!raw) {
    details = {
      domain: 'unknown',
      owner: 'aih',
      impact: 'unknown',
      priority: 90,
      canAutomate: false,
      requiresConfirmation: false,
      external: false,
      reason: 'No blocker code was reported.',
      nextAction: 'Re-run the diagnostic command with --json and inspect the full report.',
      command: buildCommand('closure-audit', context, ['--json'])
    };
  } else if (/provider_account_unavailable|missing_provider_account|auth_invalid|not_logged_in|not_signed_in|upstream_401/.test(code) || raw.includes('provider_account_unavailable')) {
    details = describeProviderBlocker(raw, context);
  } else if (code === 'ready_server_profile_missing') {
    details = {
      domain: 'server_profile',
      owner: 'operator',
      impact: 'core_blocker',
      priority: 10,
      canAutomate: true,
      requiresConfirmation: false,
      external: false,
      reason: 'The client cannot read Fabric registry until a ready server profile is paired.',
      nextAction: 'Pair this client with the target server, then re-run closure audit.',
      command: buildCommand('profile-pair', context)
    };
  } else if (code.includes('remote_transport_unavailable') || code.includes('relay_echo_failed') || code.includes('relay_echo_incomplete')) {
    details = {
      domain: 'transport',
      owner: 'aih',
      impact: 'core_blocker',
      priority: 20,
      canAutomate: true,
      requiresConfirmation: false,
      external: false,
      reason: 'The default data path is not proving usable remote RPC/session traffic.',
      nextAction: 'Run transport status and repair relay/WebRTC readiness before claiming node usability.',
      command: buildCommand('transport-status', context)
    };
  } else if (code === 'turn_default_udp_probe_busy') {
    details = {
      domain: 'diagnostic_concurrency',
      owner: 'aih',
      impact: 'diagnostic_retry',
      priority: 35,
      canAutomate: true,
      requiresConfirmation: false,
      external: false,
      reason: 'Another Fabric transport diagnostic is already binding the default UDP probe port.',
      nextAction: 'Run only one default UDP transport diagnostic at a time, then re-run cloud-edge or promotion-gate.',
      command: buildCommand('cloud-edge', context)
    };
  } else if (code === 'turn_default_udp_target_local_only') {
    details = {
      domain: 'diagnostic_context',
      owner: 'aih',
      impact: 'diagnostic_retry',
      priority: 36,
      canAutomate: true,
      requiresConfirmation: false,
      external: false,
      reason: 'The UDP probe ran on the target node itself, so it cannot prove client-to-cloud UDP reachability.',
      nextAction: 'Run the cloud-edge diagnostic from the client side, or pass an explicit remote SSH target that represents the node.',
      command: buildCommand('cloud-edge', context)
    };
  } else if (code.includes('turn_default_udp') || code.includes('aws_public_udp_path') || code.includes('host_firewall_blocks_udp')) {
    details = {
      domain: 'cloud_edge',
      owner: 'cloud_operator',
      impact: 'advanced_transport',
      priority: 40,
      canAutomate: false,
      requiresConfirmation: true,
      external: true,
      reason: 'UDP packets for the default port are not reaching the AWS instance, or the host firewall is dropping them.',
      nextAction: 'Verify Security Group and subnet NACL UDP rules, then re-run cloud-edge and promotion-gate.',
      command: buildCommand('cloud-edge', context)
    };
  } else if (code.includes('aws_cli') || code.includes('aws_iam') || code.includes('iam_role') || code.includes('aws_cloud_api_probe') || code.includes('aws_local')) {
    details = {
      domain: 'cloud_api',
      owner: 'cloud_operator',
      impact: 'diagnostic_blocker',
      priority: 45,
      canAutomate: false,
      requiresConfirmation: true,
      external: true,
      reason: 'AIH cannot read AWS SG/NACL state without AWS CLI plus read-only permissions on either the node or the operator machine.',
      nextAction: 'Attach read-only EC2 permissions to the node or configure local AWS CLI read-only credentials; this diagnostic remains read-only.',
      command: buildCommand('cloud-edge', context)
    };
  } else if (code.includes('webtransport')) {
    details = {
      domain: 'webtransport',
      owner: 'network_operator',
      impact: 'advanced_transport',
      priority: 50,
      canAutomate: false,
      requiresConfirmation: true,
      external: true,
      reason: 'WebTransport requires a real secure HTTP/3 endpoint; the default AIH listener is not enough.',
      nextAction: 'Configure a real HTTPS/H3 WebTransport endpoint, then run the browser WebTransport probe.',
      command: buildCommand('webtransport', context)
    };
  } else if (code.includes('openmptcprouter') || code.includes('mptcp') || code.includes('multipath') || code.includes('default_listener_is_plain_http')) {
    details = {
      domain: 'multipath',
      owner: 'network_operator',
      impact: 'advanced_transport',
      priority: 55,
      canAutomate: false,
      requiresConfirmation: true,
      external: true,
      reason: 'Multipath cannot be inferred from a plain listener; it needs a real OpenMPTCPRouter/MPTCP underlay.',
      nextAction: 'Validate both ends of the multipath underlay, then re-run prerequisites and promotion-gate.',
      command: buildCommand('prerequisites', context)
    };
  } else if (code.includes('webrtc_not_promoted') || code.includes('turn_relay_gate_not_ready') || code.includes('turn_ice_server')) {
    details = {
      domain: 'transport_promotion',
      owner: 'network_operator',
      impact: 'advanced_transport',
      priority: 60,
      canAutomate: false,
      requiresConfirmation: true,
      external: true,
      reason: 'The advanced transport candidate exists but still lacks the required promotion proof.',
      nextAction: 'Run promotion-gate with the real transport prerequisites and only publish promotion after it passes.',
      command: buildCommand('promotion-gate', context)
    };
  } else {
    details = {
      domain: 'unknown',
      owner: 'aih',
      impact: 'needs_triage',
      priority: 80,
      canAutomate: true,
      requiresConfirmation: false,
      external: false,
      reason: 'This blocker is not yet mapped to a Fabric remediation category.',
      nextAction: 'Re-run closure audit with --json and add a blocker catalog rule if the code is stable.',
      command: buildCommand('closure-audit', context, ['--json'])
    };
  }

  return {
    blocker: raw,
    code,
    ...details
  };
}

function explainBlockers(blockers = [], context = {}) {
  return unique(normalizeArray(blockers))
    .map((blocker) => describeBlocker(blocker, context))
    .sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.blocker.localeCompare(right.blocker);
    });
}

module.exports = {
  describeBlocker,
  explainBlockers,
  normalizeBlockerCode
};
