'use strict';

const {
  explainBlockers
} = require('./blocker-catalog');
const {
  DEFAULT_ENDPOINT,
  DEFAULT_NODE_ID,
  DEFAULT_TIMEOUT_MS,
  runFabricTransportReadinessClientCommand
} = require('./transport-readiness-client');
const {
  runFabricTransportCloudEdgeCommand
} = require('./transport-cloud-edge');
const {
  runFabricTransportPromotionGateCommand
} = require('./transport-promotion-gate');
const {
  normalizeHttpEndpoint,
  normalizeText,
  parsePositiveInteger,
  readOptionValue,
  resolveLocalPath
} = require('./server-profile-client');

const DEFAULT_SSH_TARGET = 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com';
const DEFAULT_SSH_KEY = '~/.ssh/aws.pem';
const DEFAULT_REMOTE_DIR = '/home/ubuntu/aih-fabric-current';
const DEFAULT_PORT = 9527;
const DEFAULT_UDP_TIMEOUT_MS = 5000;
const DEFAULT_DIRECT_WEBRTC_MAX_P95_MS = 1500;

function parseArgs(argv = []) {
  const options = {
    help: false,
    json: false,
    failOnBlocked: false,
    endpoint: DEFAULT_ENDPOINT,
    profileId: '',
    nodeId: DEFAULT_NODE_ID,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    port: DEFAULT_PORT,
    udpTimeoutMs: DEFAULT_UDP_TIMEOUT_MS,
    skipReadiness: false,
    skipCloudEdge: false,
    withPromotionGate: false,
    allowDirectWebrtcPromotion: false,
    directWebrtcMaxP95Ms: DEFAULT_DIRECT_WEBRTC_MAX_P95_MS,
    skipWebrtc: false,
    skipWebtransport: false,
    skipMultipath: false
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
    if (token === '--fail-on-blocked') {
      options.failOnBlocked = true;
      index += 1;
      continue;
    }
    if (token === '--skip-readiness') {
      options.skipReadiness = true;
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
    if (token === '--direct-webrtc-max-p95-ms' || token.startsWith('--direct-webrtc-max-p95-ms=')) {
      const next = readOptionValue(argv, index, '--direct-webrtc-max-p95-ms');
      options.directWebrtcMaxP95Ms = parsePositiveInteger(next.value, '--direct-webrtc-max-p95-ms', DEFAULT_DIRECT_WEBRTC_MAX_P95_MS, 1, 60000);
      index += next.consumed;
      continue;
    }
    if (token === '--skip-webrtc') {
      options.skipWebrtc = true;
      index += 1;
      continue;
    }
    if (token === '--skip-webtransport') {
      options.skipWebtransport = true;
      index += 1;
      continue;
    }
    if (token === '--skip-multipath') {
      options.skipMultipath = true;
      index += 1;
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
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
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
    if (token === '--port' || token.startsWith('--port=')) {
      const next = readOptionValue(argv, index, '--port');
      options.port = parsePositiveInteger(next.value, '--port', DEFAULT_PORT, 1, 65535);
      index += next.consumed;
      continue;
    }
    if (token === '--udp-timeout-ms' || token.startsWith('--udp-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--udp-timeout-ms');
      options.udpTimeoutMs = parsePositiveInteger(next.value, '--udp-timeout-ms', DEFAULT_UDP_TIMEOUT_MS, 1000, 60000);
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  if (!options.sshTarget) throw new Error('--ssh is required');
  return options;
}

function addFlagValue(args, flag, value) {
  if (value !== undefined && value !== null && String(value).trim()) {
    args.push(flag, String(value));
  }
}

function buildReadinessArgs(options = {}) {
  const args = [];
  addFlagValue(args, '--endpoint', options.endpoint);
  addFlagValue(args, '--node-id', options.nodeId);
  addFlagValue(args, '--timeout-ms', options.timeoutMs);
  addFlagValue(args, '--profile-id', options.profileId);
  return args;
}

function buildCloudEdgeArgs(options = {}) {
  const args = [];
  addFlagValue(args, '--endpoint', options.endpoint);
  addFlagValue(args, '--ssh', options.sshTarget);
  addFlagValue(args, '--ssh-key', options.sshKey);
  addFlagValue(args, '--remote-dir', options.remoteDir);
  addFlagValue(args, '--port', options.port);
  addFlagValue(args, '--udp-timeout-ms', options.udpTimeoutMs);
  return args;
}

function buildPromotionGateArgs(options = {}) {
  const args = [];
  addFlagValue(args, '--endpoint', options.endpoint);
  addFlagValue(args, '--ssh', options.sshTarget);
  addFlagValue(args, '--ssh-key', options.sshKey);
  addFlagValue(args, '--remote-dir', options.remoteDir);
  addFlagValue(args, '--port', options.port);
  if (options.skipWebrtc) args.push('--skip-webrtc');
  if (options.allowDirectWebrtcPromotion) args.push('--allow-direct-webrtc-promotion');
  addFlagValue(args, '--direct-webrtc-max-p95-ms', options.directWebrtcMaxP95Ms);
  if (options.skipWebtransport) args.push('--skip-webtransport');
  if (options.skipMultipath) args.push('--skip-multipath');
  return args;
}

async function runStep(name, skipped, runner) {
  if (skipped) return { name, skipped: true, ok: true, report: null, error: null };
  try {
    const report = await runner();
    return {
      name,
      skipped: false,
      ok: Boolean(report && report.ok !== false),
      report,
      error: null
    };
  } catch (error) {
    return {
      name,
      skipped: false,
      ok: false,
      report: null,
      error: {
        code: normalizeText(error && error.code, 96) || 'step_failed',
        message: normalizeText(error && error.message, 512) || String(error)
      }
    };
  }
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value, 256)).filter(Boolean)));
}

function collectStepErrors(steps = []) {
  return steps
    .filter((step) => step && step.error)
    .map((step) => `${step.name}:${step.error.code}`);
}

function collectBlockers(readiness, cloudEdge, promotionGate) {
  const gatePromoted = promotionGate
    && promotionGate.report
    && promotionGate.report.summary
    && promotionGate.report.summary.promotionReady === true;
  return unique([
    ...collectStepErrors([readiness, cloudEdge, promotionGate]),
    ...(readiness && readiness.report && Array.isArray(readiness.report.blockers) ? readiness.report.blockers : []),
    ...(!gatePromoted && readiness && readiness.report && readiness.report.summary && Array.isArray(readiness.report.summary.blockers) ? readiness.report.summary.blockers : []),
    ...(!gatePromoted && cloudEdge && cloudEdge.report && cloudEdge.report.summary && Array.isArray(cloudEdge.report.summary.blockers) ? cloudEdge.report.summary.blockers : []),
    ...(promotionGate && promotionGate.report && promotionGate.report.summary && Array.isArray(promotionGate.report.summary.blockers) ? promotionGate.report.summary.blockers : [])
  ]);
}

function collectNextActions(readiness, cloudEdge, promotionGate, summary) {
  const actions = [];
  if (readiness && readiness.error && readiness.error.code === 'ready_server_profile_missing') {
    actions.push('Configure a Server with a Management Key or pass --profile-id for a ready Server profile.');
  }
  if (summary.fallbackReady && !summary.advancedPromotionReady) {
    actions.push('Keep relay as the default data path until an advanced transport passes promotion.');
  }
  const cloudActions = cloudEdge && cloudEdge.report && cloudEdge.report.summary && Array.isArray(cloudEdge.report.summary.nextActions)
    ? cloudEdge.report.summary.nextActions
    : [];
  if (!summary.advancedPromotionReady) actions.push(...cloudActions);
  if (promotionGate && promotionGate.error) {
    actions.push('Re-run with --with-promotion-gate after fixing the reported promotion gate error.');
  }
  return unique(actions);
}

function buildSummary(steps = {}, context = {}) {
  const readiness = steps.readiness;
  const cloudEdge = steps.cloudEdge;
  const promotionGate = steps.promotionGate;
  const readinessSummary = readiness && readiness.report && readiness.report.summary || {};
  const readinessNode = readiness && readiness.report && readiness.report.node || {};
  const cloudSummary = cloudEdge && cloudEdge.report && cloudEdge.report.summary || {};
  const gateSummary = promotionGate && promotionGate.report && promotionGate.report.summary || {};
  const fallbackReady = readinessSummary.fallbackReady === true || gateSummary.fallbackReady === true;
  const advancedPromotionReady = readinessSummary.promotionReady === true || gateSummary.promotionReady === true;
  const remoteDevelopmentReady = Boolean(readiness && readiness.ok && fallbackReady);
  const blockers = collectBlockers(readiness, cloudEdge, promotionGate);
  const blockerDetails = explainBlockers(blockers, {
    endpoint: context.endpoint || DEFAULT_ENDPOINT,
    nodeId: context.nodeId || DEFAULT_NODE_ID
  });
  const defaultTransport = gateSummary.promotionReady === true
    ? gateSummary.defaultTransport
    : (readinessSummary.defaultTransport || gateSummary.defaultTransport);
  const summary = {
    status: advancedPromotionReady ? 'complete' : (remoteDevelopmentReady ? 'usable_partial' : 'blocked'),
    remoteDevelopmentReady,
    defaultTransport: normalizeText(defaultTransport, 64),
    fallbackReady,
    relayMeasurementPass: readinessNode.relayMeasurementPass === true,
    advancedPromotionReady,
    promotedTransports: Array.isArray(readinessSummary.promotedTransports) && readinessSummary.promotedTransports.length > 0
      ? readinessSummary.promotedTransports
      : (Array.isArray(gateSummary.promotedTransports) ? gateSummary.promotedTransports : []),
    cloudEdgeReady: cloudSummary.cloudEdgeReady === true,
    udpReachable: cloudSummary.udpReachable === true,
    packetArrivalCaptured: cloudSummary.packetArrivalCaptured === true,
    hostFirewallBlocksUdp: cloudSummary.hostFirewallBlocksUdp === true,
    cloudApiCredentialsReady: cloudSummary.cloudApiCredentialsReady === true,
    remoteAwsApiCredentialsReady: cloudSummary.remoteAwsApiCredentialsReady === true,
    localAwsApiReadbackReady: cloudSummary.localAwsApiReadbackReady === true,
    localAwsApiCredentialsReady: cloudSummary.localAwsApiCredentialsReady === true,
    localAwsApiInstanceId: normalizeText(cloudSummary.localAwsApiInstanceId, 64),
    localAwsApiSubnetId: normalizeText(cloudSummary.localAwsApiSubnetId, 128),
    publicIpv4: normalizeText(cloudSummary.publicIpv4, 128),
    securityGroupIds: Array.isArray(cloudSummary.securityGroupIds) ? cloudSummary.securityGroupIds : [],
    blockers,
    blockerDetails,
    stepOk: {
      readiness: !readiness || readiness.ok === true,
      cloudEdge: !cloudEdge || cloudEdge.ok === true,
      promotionGate: !promotionGate || promotionGate.ok === true
    }
  };
  summary.nextActions = unique([
    ...collectNextActions(readiness, cloudEdge, promotionGate, summary),
    ...blockerDetails.map((detail) => detail.nextAction)
  ]);
  return summary;
}

async function runFabricTransportStatusCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : []);
  const readiness = await runStep('readiness', options.skipReadiness, () => (
    (deps.runFabricTransportReadinessClientCommand || runFabricTransportReadinessClientCommand)(
      buildReadinessArgs(options),
      deps
    )
  ));
  const cloudEdge = await runStep('cloudEdge', options.skipCloudEdge, () => (
    (deps.runFabricTransportCloudEdgeCommand || runFabricTransportCloudEdgeCommand)(
      buildCloudEdgeArgs(options),
      deps
    )
  ));
  const promotionGate = await runStep('promotionGate', !options.withPromotionGate, () => (
    (deps.runFabricTransportPromotionGateCommand || runFabricTransportPromotionGateCommand)(
      buildPromotionGateArgs(options),
      deps
    )
  ));
  const steps = { readiness, cloudEdge, promotionGate };
  const summary = buildSummary(steps, options);
  const ok = [readiness, cloudEdge, promotionGate].every((step) => step && step.ok === true);
  return {
    ok,
    json: options.json === true,
    exitOk: options.failOnBlocked ? summary.advancedPromotionReady : ok,
    generatedAt: new Date().toISOString(),
    target: {
      endpoint: options.endpoint,
      nodeId: options.nodeId,
      ssh: options.sshTarget,
      remoteDir: options.remoteDir,
      port: options.port
    },
    summary,
    steps,
    reports: {
      readiness: readiness.report,
      cloudEdge: cloudEdge.report,
      promotionGate: promotionGate.report
    }
  };
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function formatFabricTransportStatusReport(report = {}) {
  const summary = report.summary || {};
  const lines = [
    'AIH Fabric transport status',
    `  endpoint: ${report.target && report.target.endpoint || ''}`,
    `  node_id: ${report.target && report.target.nodeId || ''}`,
    `  ssh: ${report.target && report.target.ssh || ''}`,
    `  status: ${summary.status || 'unknown'}`,
    `  remote_development_ready: ${yesNo(summary.remoteDevelopmentReady)}`,
    `  default_transport: ${summary.defaultTransport || ''}`,
    `  fallback_ready: ${yesNo(summary.fallbackReady)}`,
    `  relay_measurement_pass: ${yesNo(summary.relayMeasurementPass)}`,
    `  advanced_promotion_ready: ${yesNo(summary.advancedPromotionReady)}`,
    `  cloud_edge_ready: ${yesNo(summary.cloudEdgeReady)}`,
    `  udp_reachable: ${yesNo(summary.udpReachable)}`,
    `  packet_arrival_captured: ${yesNo(summary.packetArrivalCaptured)}`,
    `  cloud_api_credentials_ready: ${yesNo(summary.cloudApiCredentialsReady)}`,
    `  remote_aws_api_credentials_ready: ${yesNo(summary.remoteAwsApiCredentialsReady)}`,
    `  local_aws_api_readback_ready: ${yesNo(summary.localAwsApiReadbackReady)}`
  ];
  if (summary.publicIpv4) lines.push(`  public_ipv4: ${summary.publicIpv4}`);
  if (summary.localAwsApiInstanceId) lines.push(`  local_aws_api_instance_id: ${summary.localAwsApiInstanceId}`);
  if (summary.localAwsApiSubnetId) lines.push(`  local_aws_api_subnet_id: ${summary.localAwsApiSubnetId}`);
  if (Array.isArray(summary.securityGroupIds) && summary.securityGroupIds.length > 0) {
    lines.push(`  security_group_ids: ${summary.securityGroupIds.join(', ')}`);
  }
  if (Array.isArray(summary.blockers) && summary.blockers.length > 0) {
    lines.push('  blockers:');
    summary.blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }
  if (Array.isArray(summary.blockerDetails) && summary.blockerDetails.length > 0) {
    lines.push('  blocker_details:');
    summary.blockerDetails.forEach((detail) => {
      lines.push(`    - ${detail.blocker}: owner=${detail.owner} impact=${detail.impact}`);
      lines.push(`      next: ${detail.nextAction}`);
      if (detail.command) lines.push(`      command: ${detail.command}`);
    });
  }
  if (Array.isArray(summary.nextActions) && summary.nextActions.length > 0) {
    lines.push('  next_actions:');
    summary.nextActions.forEach((action) => lines.push(`    - ${action}`));
  }
  lines.push(`  result: ${report.exitOk === false ? 'blocked' : (report.ok ? 'pass' : 'diagnostic_failed')}`);
  return lines.join('\n');
}

module.exports = {
  buildCloudEdgeArgs,
  buildPromotionGateArgs,
  buildReadinessArgs,
  buildSummary,
  formatFabricTransportStatusReport,
  parseArgs,
  runFabricTransportStatusCommand
};
