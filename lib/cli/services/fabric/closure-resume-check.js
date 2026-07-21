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
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath
} = require('./server-profile-client');
const {
  publicTransportConfig,
  readTransportConfig
} = require('./transport-config');
const {
  runFabricProviderAccountsCommand
} = require('./provider-accounts');
const {
  runCloudEdgePreflight
} = require('../../../../scripts/fabric-cloud-edge-preflight');

const KNOWN_PROVIDERS = ['codex', 'claude', 'agy', 'opencode', 'grok', 'qoder', 'qodercn'];

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value, 512)).filter(Boolean)));
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    skipProviderAudit: false,
    skipCloudApiCheck: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: '',
    profileId: '',
    nodeId: '',
    handoffFile: '',
    timeoutMs: DEFAULT_TIMEOUT_MS
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
    if (token === '--skip-provider-audit') {
      options.skipProviderAudit = true;
      index += 1;
      continue;
    }
    if (token === '--skip-cloud-api-check') {
      options.skipCloudApiCheck = true;
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
    if (token === '--handoff-file' || token.startsWith('--handoff-file=')) {
      const next = readOptionValue(argv, index, '--handoff-file');
      options.handoffFile = path.resolve(String(next.value || ''));
      index += next.consumed;
      continue;
    }
    if (!isFlag(token) && !options.handoffFile) {
      options.handoffFile = path.resolve(token);
      index += 1;
      continue;
    }
    throw createError('invalid_option', `unknown option: ${token}`);
  }

  options.aiHomeDir = options.aiHomeDir ? resolveLocalPath(options.aiHomeDir) : resolveDefaultAiHomeDir(env);
  if (!options.handoffFile) throw createError('missing_handoff_file', 'closure resume-check requires --handoff-file');
  return options;
}

function readHandoffFile(filePath, deps = {}) {
  const fsImpl = deps.fs || fs;
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw createError('handoff_file_unreadable', `cannot read handoff file: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw createError('handoff_file_invalid_json', `handoff file is not valid JSON: ${error.message}`);
  }
}

function extractProviders(handoff = {}) {
  const providers = [];
  normalizeArray(handoff.failures).forEach((failure) => {
    if (normalizeText(failure && failure.domain, 96) !== 'provider_account') return;
    const id = normalizeText(failure.id, 128).toLowerCase();
    const blockerText = normalizeArray(failure.blockers).join(' ').toLowerCase();
    KNOWN_PROVIDERS.forEach((provider) => {
      if (id.includes(provider) || blockerText.includes(provider)) providers.push(provider);
    });
  });
  return unique(providers);
}

function envPresent(env = {}, names = []) {
  return names.some((name) => normalizeText(env[name], 4096));
}

function getTransportInputState(config = {}, env = {}) {
  const publicConfig = publicTransportConfig(config);
  return {
    turnConfigured: publicConfig.turn.configured === true
      || envPresent(env, ['AIH_TURN_ICE_SERVERS', 'AIH_TURN_ICE_SERVER']),
    webtransportConfigured: publicConfig.webtransport.configured === true
      || envPresent(env, ['AIH_WEBTRANSPORT_URL', 'AIH_M6_WEBTRANSPORT_URL']),
    config: publicConfig,
    env: {
      turnIceServersPresent: envPresent(env, ['AIH_TURN_ICE_SERVERS', 'AIH_TURN_ICE_SERVER']),
      turnUsernamePresent: envPresent(env, ['AIH_TURN_USERNAME']),
      turnCredentialPresent: envPresent(env, ['AIH_TURN_CREDENTIAL']),
      webtransportUrlPresent: envPresent(env, ['AIH_WEBTRANSPORT_URL', 'AIH_M6_WEBTRANSPORT_URL']),
      webtransportPageUrlPresent: envPresent(env, ['AIH_WEBTRANSPORT_PAGE_URL', 'AIH_M6_WEBTRANSPORT_PAGE_URL'])
    }
  };
}

function buildStaticPrerequisiteCheck(prerequisite = {}, transportState = {}) {
  const id = normalizeText(prerequisite.id, 128);
  if (id === 'webtransport-h3-endpoint') {
    const changed = transportState.webtransportConfigured === true;
    return {
      id,
      status: changed ? 'ready_to_recheck' : 'unchanged',
      changed,
      reason: changed
        ? 'A WebTransport endpoint is configured; run the browser WebTransport gate.'
        : 'No stored or environment WebTransport URL is present.',
      commands: changed ? normalizeArray(prerequisite.commands) : [],
      requiredEvidence: normalizeText(prerequisite.requiredEvidence, 1024)
    };
  }
  if (id === 'multipath-underlay') {
    return {
      id,
      status: 'unchanged',
      changed: false,
      reason: 'No OpenMPTCPRouter/MPTCP underlay evidence source is configured in AIH.',
      commands: [],
      requiredEvidence: normalizeText(prerequisite.requiredEvidence, 1024)
    };
  }
  return null;
}

function summarizeCloudApiReadback(report = {}) {
  const summary = normalizeObject(report.summary);
  const cloudApi = normalizeObject(report.cloudApi);
  const cloudSummary = normalizeObject(cloudApi.summary);
  const remote = normalizeObject(cloudApi.remote);
  const local = normalizeObject(cloudApi.local);
  return {
    ok: report.ok === true,
    cloudApiCredentialsReady: summary.cloudApiCredentialsReady === true || cloudSummary.awsApiCredentialsReady === true,
    remoteAwsApiCredentialsReady: summary.remoteAwsApiCredentialsReady === true || cloudSummary.remoteAwsApiCredentialsReady === true,
    localAwsApiReadbackReady: summary.localAwsApiReadbackReady === true || cloudSummary.localAwsApiReadbackReady === true,
    localAwsApiCredentialsReady: summary.localAwsApiCredentialsReady === true || cloudSummary.localAwsApiCredentialsReady === true,
    blockers: unique([
      ...normalizeArray(summary.blockers),
      ...normalizeArray(cloudApi.blockers)
    ]),
    remote: {
      awsCliAvailable: remote.awsCli && remote.awsCli.available === true,
      iamRoleAvailable: remote.imds && remote.imds.iamRoleAvailable === true,
      blockers: unique(normalizeArray(remote.blockers))
    },
    local: {
      awsCliAvailable: local.awsCli && local.awsCli.available === true,
      apiReadbackReady: local.summary && local.summary.awsApiReadbackReady === true,
      credentialsReady: local.summary && local.summary.awsApiCredentialsReady === true,
      blockers: unique(normalizeArray(local.blockers))
    }
  };
}

async function buildCloudUdpPolicyCheck(prerequisite = {}, target = {}, transportState = {}, options = {}, deps = {}) {
  const id = normalizeText(prerequisite.id, 128);
  if (id !== 'cloud-udp-policy') return null;
  const baseCommands = normalizeArray(prerequisite.commands);
  if (transportState.turnConfigured === true) {
    return {
      id,
      status: 'ready_to_recheck',
      changed: true,
      reason: 'A TURN/UDP candidate is configured; run the transport prerequisite gate.',
      commands: baseCommands,
      requiredEvidence: normalizeText(prerequisite.requiredEvidence, 1024),
      cloudApi: null
    };
  }
  if (options.skipCloudApiCheck) {
    return {
      id,
      status: 'unchecked',
      changed: false,
      reason: 'Cloud API readback check was skipped; AWS SG/NACL readback state was not re-read.',
      commands: [],
      requiredEvidence: normalizeText(prerequisite.requiredEvidence, 1024),
      cloudApi: null
    };
  }
  const runner = deps.runCloudEdgePreflight || runCloudEdgePreflight;
  let report;
  try {
    report = await runner({
      endpoint: normalizeText(target.endpoint, 2048),
      skipUdpProbe: true,
      port: 9527
    }, deps);
  } catch (error) {
    return {
      id,
      status: 'cloud_api_unavailable',
      changed: false,
      reason: `Read-only cloud API check could not run: ${normalizeText(error && error.message, 1024) || 'unknown error'}`,
      commands: [],
      requiredEvidence: normalizeText(prerequisite.requiredEvidence, 1024),
      cloudApi: {
        ok: false,
        error: {
          code: normalizeText(error && error.code, 128),
          message: normalizeText(error && error.message, 1024)
        }
      }
    };
  }
  const cloudApi = summarizeCloudApiReadback(report);
  const changed = cloudApi.cloudApiCredentialsReady === true || cloudApi.localAwsApiReadbackReady === true;
  return {
    id,
    status: changed ? 'ready_to_recheck' : 'unchanged',
    changed,
    reason: changed
      ? 'Read-only AWS API readback is now available; run cloud-edge to inspect SG/NACL and UDP arrival together.'
      : 'No stored TURN/UDP candidate is present and read-only AWS API readback is still unavailable.',
    commands: changed ? baseCommands : [],
    requiredEvidence: normalizeText(prerequisite.requiredEvidence, 1024),
    cloudApi
  };
}

async function buildPrerequisiteChecks(prerequisites = [], target = {}, transportState = {}, options = {}, deps = {}) {
  const checks = [];
  for (const prerequisite of normalizeArray(prerequisites)) {
    const id = normalizeText(prerequisite && prerequisite.id, 128);
    if (id === 'cloud-udp-policy') {
      const cloudCheck = await buildCloudUdpPolicyCheck(prerequisite, target, transportState, options, deps);
      if (cloudCheck) checks.push(cloudCheck);
      continue;
    }
    const check = buildStaticPrerequisiteCheck(prerequisite, transportState);
    if (check) checks.push(check);
  }
  return checks;
}

function providerAuditArgs(endpoint, profileId, providers = []) {
  return [
    ...(endpoint ? ['--endpoint', endpoint] : []),
    ...(profileId ? ['--profile-id', profileId] : []),
    '--providers',
    providers.join(','),
    '--json'
  ];
}

function summarizeProviderAudit(report = {}, providers = []) {
  const handoff = normalizeObject(report.credentialHandoff);
  const items = normalizeArray(handoff.providers)
    .filter((item) => providers.length === 0 || providers.includes(normalizeText(item && item.provider, 64).toLowerCase()))
    .map((item) => ({
      provider: normalizeText(item.provider, 64).toLowerCase(),
      status: normalizeText(item.status, 96),
      action: normalizeText(item.action, 96),
      runtimeBlocked: Number(item.runtimeBlocked || 0),
      requiredInput: normalizeText(item.requiredInput, 512)
    }));
  const ready = items.filter((item) => item.status === 'ready');
  return {
    ok: report.ok === true,
    providers: items,
    readyCount: ready.length,
    blockedCount: items.length - ready.length,
    allReady: items.length > 0 && ready.length === items.length
  };
}

async function buildProviderCheck(options = {}, handoff = {}, target = {}, deps = {}) {
  const providers = extractProviders(handoff);
  if (providers.length === 0) return null;
  if (options.skipProviderAudit) {
    return {
      id: 'provider-credentials',
      status: 'unchecked',
      changed: false,
      reason: 'Provider audit was skipped; credential state was not re-read.',
      providers,
      commands: [],
      audit: null
    };
  }
  const endpoint = normalizeText(options.endpoint || handoff.target && handoff.target.endpoint, 2048);
  const runner = deps.runFabricProviderAccountsCommand || runFabricProviderAccountsCommand;
  let report;
  try {
    report = await runner('audit', providerAuditArgs(endpoint, options.profileId, providers), deps);
  } catch (error) {
    return {
      id: 'provider-credentials',
      status: 'audit_unavailable',
      changed: false,
      reason: `Read-only provider audit could not run: ${normalizeText(error && error.message, 1024) || 'unknown error'}`,
      providers,
      commands: [],
      audit: {
        ok: false,
        error: {
          code: normalizeText(error && error.code, 128),
          message: normalizeText(error && error.message, 1024)
        }
      }
    };
  }
  const audit = summarizeProviderAudit(report, providers);
  const changed = audit.allReady === true;
  return {
    id: 'provider-credentials',
    status: changed ? 'ready_to_recheck' : 'unchanged',
    changed,
    reason: changed
      ? 'All providers from the handoff are ready in the latest read-only provider audit.'
      : 'Latest read-only provider audit still reports blocked provider credentials.',
    providers,
    commands: changed ? [
      [
        'aih fabric closure verify',
        '--endpoint',
        normalizeText(target.endpoint, 2048),
        '--node-id',
        normalizeText(target.nodeId, 128),
        '--provider',
        normalizeText(target.provider, 64),
        '--json'
      ].filter(Boolean).join(' ')
    ] : [],
    audit
  };
}

function buildResumeSummary(checks = []) {
  const changed = checks.filter((item) => item && item.changed === true);
  const commands = unique(changed.flatMap((item) => normalizeArray(item.commands)));
  return {
    canContinueWithoutInput: changed.length > 0,
    changedEvidenceCount: changed.length,
    state: changed.length > 0 ? 'ready_to_recheck' : 'awaiting_external_input',
    reason: changed.length > 0
      ? 'At least one external prerequisite has new input; run the listed recheck command.'
      : 'No external prerequisite input has changed since the handoff; do not repeat closure proof yet.',
    commands
  };
}

async function runFabricClosureResumeCheck(rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: '',
    profileId: '',
    nodeId: '',
    handoffFile: '',
    json: false,
    skipProviderAudit: false,
    skipCloudApiCheck: false,
    ...rawOptions
  };
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  const handoff = readHandoffFile(options.handoffFile, deps);
  const target = {
    endpoint: normalizeText(options.endpoint || handoff.target && handoff.target.endpoint, 2048) || DEFAULT_ENDPOINT,
    nodeId: normalizeText(options.nodeId || handoff.target && handoff.target.nodeId, 128) || DEFAULT_NODE_ID,
    provider: normalizeText(handoff.target && handoff.target.provider, 64) || 'opencode'
  };
  const transportConfig = readTransportConfig({ aiHomeDir: options.aiHomeDir }, deps);
  const transportState = getTransportInputState(transportConfig, deps.env || process.env);
  const prerequisiteChecks = await buildPrerequisiteChecks(
    handoff.externalPrerequisites,
    target,
    transportState,
    options,
    deps
  );
  const providerCheck = await buildProviderCheck({
    ...options,
    endpoint: target.endpoint
  }, handoff, target, deps);
  const checks = providerCheck ? [...prerequisiteChecks, providerCheck] : prerequisiteChecks;
  const resume = buildResumeSummary(checks);
  return {
    ok: true,
    exitOk: true,
    json: options.json === true,
    schema: 'aih.fabric.closure-resume-check.v1',
    generatedAt: new Date().toISOString(),
    handoffFile: options.handoffFile,
    target,
    previousDecision: normalizeObject(handoff.executionDecision),
    transportInputs: transportState,
    checks,
    resume
  };
}

async function runFabricClosureResumeCheckCommand(args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runFabricClosureResumeCheck(options, deps);
  return {
    ...report,
    json: options.json === true
  };
}

function formatFabricClosureResumeCheckReport(report = {}) {
  const resume = normalizeObject(report.resume);
  const lines = [
    'AIH Fabric closure resume check',
    `  handoff_file: ${normalizeText(report.handoffFile, 2048)}`,
    `  endpoint: ${normalizeText(report.target && report.target.endpoint, 2048)}`,
    `  node_id: ${normalizeText(report.target && report.target.nodeId, 128)}`,
    `  state: ${normalizeText(resume.state, 96)}`,
    `  can_continue: ${resume.canContinueWithoutInput ? 'yes' : 'no'}`,
    `  reason: ${normalizeText(resume.reason, 1024)}`
  ];
  const commands = normalizeArray(resume.commands);
  if (commands.length > 0) {
    lines.push('  commands:');
    commands.forEach((command) => lines.push(`    - ${command}`));
  }
  lines.push('  checks:');
  normalizeArray(report.checks).forEach((check) => {
    lines.push(`    - ${check.id}: ${check.status} changed=${check.changed ? 'yes' : 'no'}`);
    if (check.reason) lines.push(`      reason: ${check.reason}`);
  });
  return lines.join('\n');
}

module.exports = {
  buildResumeSummary,
  buildCloudUdpPolicyCheck,
  buildPrerequisiteChecks,
  formatFabricClosureResumeCheckReport,
  getTransportInputState,
  parseArgs,
  runFabricClosureResumeCheck,
  runFabricClosureResumeCheckCommand
};
