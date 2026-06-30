'use strict';

const {
  parseArgs: parseActivationArgs,
  runActivation
} = require('../../../../scripts/fabric-runtime-account-activation');
const {
  DEFAULT_TIMEOUT_MS,
  buildProfileSummary,
  createError,
  fetchJson,
  loadControlPlaneProfileStore,
  normalizeHttpEndpoint,
  normalizeOptionalHttpEndpoint,
  parsePositiveInteger,
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath,
  selectReadyProfile
} = require('./server-profile-client');
const {
  runFabricNodesClient
} = require('./nodes-client');

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

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function parseReauthArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: '',
    profileId: '',
    provider: '',
    accountId: '',
    waitMs: 3000,
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
    if (token === '--provider' || token.startsWith('--provider=')) {
      const next = readOptionValue(argv, index, '--provider');
      options.provider = normalizeText(next.value, 64).toLowerCase();
      index += next.consumed;
      continue;
    }
    if (token === '--account-id' || token.startsWith('--account-id=')) {
      const next = readOptionValue(argv, index, '--account-id');
      options.accountId = normalizeText(next.value, 128);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--wait-auth-url-ms' || token.startsWith('--wait-auth-url-ms=') || token === '--wait-ms' || token.startsWith('--wait-ms=')) {
      const flag = token.startsWith('--wait-ms') ? '--wait-ms' : '--wait-auth-url-ms';
      const next = readOptionValue(argv, index, flag);
      options.waitMs = parsePositiveInteger(next.value, flag, 3000, 0, 10000);
      index += next.consumed;
      continue;
    }
    if (!isFlag(token) && !options.provider) {
      options.provider = normalizeText(token, 64).toLowerCase();
      index += 1;
      continue;
    }
    if (!isFlag(token) && !options.accountId) {
      options.accountId = normalizeText(token, 128);
      index += 1;
      continue;
    }
    throw createError('invalid_option', `unknown option: ${token}`);
  }

  options.aiHomeDir = options.aiHomeDir ? resolveLocalPath(options.aiHomeDir) : resolveDefaultAiHomeDir(env);
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  if (!options.provider) throw createError('missing_provider', 'missing --provider');
  if (!options.accountId) throw createError('missing_account_id', 'missing --account-id');
  return options;
}

function parseAuthJobArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: '',
    profileId: '',
    action: '',
    jobId: '',
    callbackUrl: '',
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
    if (token === '--job-id' || token.startsWith('--job-id=')) {
      const next = readOptionValue(argv, index, '--job-id');
      options.jobId = normalizeText(next.value, 160);
      index += next.consumed;
      continue;
    }
    if (
      token === '--callback-url'
      || token.startsWith('--callback-url=')
      || token === '--callback'
      || token.startsWith('--callback=')
      || token === '--code'
      || token.startsWith('--code=')
    ) {
      const flag = token.startsWith('--callback=') || token === '--callback'
        ? '--callback'
        : (token.startsWith('--code=') || token === '--code' ? '--code' : '--callback-url');
      const next = readOptionValue(argv, index, flag);
      options.callbackUrl = normalizeText(next.value, 8192);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (!isFlag(token) && !options.action) {
      options.action = normalizeText(token, 32).toLowerCase();
      index += 1;
      continue;
    }
    throw createError('invalid_option', `unknown option: ${token}`);
  }

  options.aiHomeDir = options.aiHomeDir ? resolveLocalPath(options.aiHomeDir) : resolveDefaultAiHomeDir(env);
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  if (options.action === 'status') options.action = 'get';
  if (!['get', 'cancel', 'callback'].includes(options.action)) {
    throw createError('missing_auth_job_action', 'auth-job action must be get, cancel, or callback');
  }
  if (!options.jobId) throw createError('missing_job_id', 'missing --job-id');
  if (options.action === 'callback' && !options.callbackUrl) {
    throw createError('missing_callback_url', 'missing --callback-url or --code');
  }
  return options;
}

function readPassthroughValue(argv, index, flag) {
  const token = normalizeText(argv[index], 256);
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = argv[index + 1];
  if (value === undefined || isFlag(value)) return { value: '', consumed: 1 };
  return { value: String(value), consumed: 2 };
}

function hasFlagValue(argv = [], flag) {
  return argv.some((token) => {
    const text = normalizeText(token, 256);
    return text === flag || text.startsWith(`${flag}=`);
  });
}

function readFlagValue(argv = [], flag) {
  for (let index = 0; index < argv.length; index += 1) {
    const text = normalizeText(argv[index], 256);
    if (text.startsWith(`${flag}=`)) return text.slice(flag.length + 1);
    if (text === flag && argv[index + 1] !== undefined && !isFlag(argv[index + 1])) {
      return String(argv[index + 1]);
    }
  }
  return '';
}

function parseRemoteTargetArgs(argv = [], env = process.env) {
  const options = {
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: '',
    profileId: '',
    activationArgs: []
  };

  for (let index = 0; index < argv.length;) {
    const token = normalizeText(argv[index], 256);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--ai-home-dir' || token.startsWith('--ai-home-dir=')) {
      const next = readPassthroughValue(argv, index, '--ai-home-dir');
      options.aiHomeDir = resolveLocalPath(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readPassthroughValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--profile-id' || token.startsWith('--profile-id=')) {
      const next = readPassthroughValue(argv, index, '--profile-id');
      options.profileId = normalizeText(next.value, 96);
      index += next.consumed;
      continue;
    }
    options.activationArgs.push(String(argv[index]));
    index += 1;
  }

  options.aiHomeDir = options.aiHomeDir ? resolveLocalPath(options.aiHomeDir) : resolveDefaultAiHomeDir(env);
  return options;
}

function endpointPort(endpoint) {
  try {
    const parsed = new URL(normalizeHttpEndpoint(endpoint, '--endpoint'));
    if (parsed.port) return parsed.port;
    return parsed.protocol === 'https:' ? '443' : '80';
  } catch (_error) {
    return '';
  }
}

function selectSshBinding(node = {}) {
  return normalizeArray(node.localSshBindings)
    .find((binding) => normalizeText(binding && (binding.target || binding.host), 512) && normalizeText(binding && binding.remoteRoot, 2048))
    || null;
}

function applyDerivedFlag(args, flag, value) {
  const text = normalizeText(value, 2048);
  if (!text || hasFlagValue(args, flag)) return args;
  return [...args, flag, text];
}

async function resolveRemoteActivationArgs(argv = [], options = {}, deps = {}) {
  if (!options.endpoint && !options.profileId) return argv.slice();
  const nodeId = normalizeText(readFlagValue(argv, '--node-id'), 128);
  const report = await (deps.runFabricNodesClient || runFabricNodesClient)({
    aiHomeDir: options.aiHomeDir,
    endpoint: options.endpoint,
    profileId: options.profileId,
    nodeId
  }, deps);
  if (!report || report.ok !== true) {
    throw createError('provider_accounts_target_unavailable', 'provider accounts target server profile is not readable');
  }
  const node = normalizeObject(report.targetNode);
  const binding = selectSshBinding(node);
  let resolved = argv.slice();
  resolved = applyDerivedFlag(resolved, '--node-id', node.id);
  if (binding) {
    resolved = applyDerivedFlag(resolved, '--ssh', binding.target || `${binding.user ? `${binding.user}@` : ''}${binding.host}`);
    resolved = applyDerivedFlag(resolved, '--remote-dir', binding.remoteRoot);
  }
  resolved = applyDerivedFlag(resolved, '--port', endpointPort(report.target && report.target.endpoint));
  if ((!hasFlagValue(resolved, '--ssh') || !hasFlagValue(resolved, '--remote-dir')) && !binding) {
    throw createError('provider_accounts_ssh_binding_missing', 'target node has no local SSH binding; pass --ssh and --remote-dir explicitly');
  }
  return resolved;
}

function buildActivationArgs(action, args = []) {
  const command = normalizeText(action, 64);
  if (command === 'audit') return ['--remote-audit', ...args];
  if (command === 'revalidate') return ['--remote-revalidate', ...args];
  throw new Error(`unknown provider accounts command: ${command}`);
}

function commandLine(parts = []) {
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

function buildProviderAccountsCommand(action, provider, endpoint = '', extra = []) {
  return commandLine([
    `aih fabric provider accounts ${action}`,
    ...(endpoint ? ['--endpoint', endpoint] : []),
    '--providers',
    normalizeText(provider, 64).toLowerCase(),
    ...extra
  ]);
}

function buildProviderAccountReauthCommand(provider, accountId, endpoint = '', extra = []) {
  return commandLine([
    'aih fabric provider accounts reauth',
    '--provider',
    normalizeText(provider, 64).toLowerCase(),
    '--account-id',
    normalizeText(accountId, 128),
    ...(endpoint ? ['--endpoint', endpoint] : []),
    ...extra
  ]);
}

function providerAuthModes(provider = {}) {
  const modes = normalizeArray(provider.authModeCounts)
    .map((item) => normalizeText(item && item.reason, 64).toLowerCase())
    .filter(Boolean);
  if (Number(provider.apiKeyMode || 0) > 0 && !modes.includes('api-key')) {
    modes.push('api-key');
  }
  return modes;
}

function firstSampleAccountId(provider = {}) {
  return normalizeArray(provider.sampleClearableAccountIds)
    .map((item) => normalizeText(item, 128))
    .find(Boolean) || '';
}

function buildCredentialCommands(action, provider, endpoint, accountId) {
  const commands = [
    buildProviderAccountsCommand('audit', provider, endpoint, ['--json']),
    buildProviderAccountsCommand('revalidate', provider, endpoint, ['--yes', '--json'])
  ];
  if (action === 'complete_oauth_reauth' && accountId) {
    commands.unshift(buildProviderAccountReauthCommand(provider, accountId, endpoint, ['--json']));
  }
  return commands.filter(Boolean);
}

function classifyProviderCredentialAction(providerReport = {}) {
  const provider = normalizeText(providerReport.provider, 64).toLowerCase();
  const runtimeBlocked = Number(providerReport.runtimeBlocked || 0);
  const configured = Number(providerReport.configured || 0);
  const profileCount = Number(providerReport.profileCount || 0);
  const authModes = providerAuthModes(providerReport);
  if (runtimeBlocked <= 0 && configured > 0) {
    return {
      action: 'none',
      status: 'ready',
      requiredInput: '',
      reason: `${provider} is already schedulable.`
    };
  }
  if (configured <= 0 && profileCount <= 0) {
    return {
      action: 'configure_provider_account',
      status: 'awaiting_operator_input',
      requiredInput: 'Add or import a real provider account on the target node.',
      reason: `${provider} has no configured provider account on the target node.`
    };
  }
  if (authModes.includes('api-key')) {
    return {
      action: 'update_api_key',
      status: 'awaiting_operator_input',
      requiredInput: 'Update or replace the API key on the target node, then revalidate.',
      reason: `${provider} is an API Key account; remote OAuth reauth is unsupported for this account type.`
    };
  }
  if (authModes.includes('oauth')) {
    return {
      action: 'complete_oauth_reauth',
      status: 'awaiting_external_input',
      requiredInput: 'Complete the provider OAuth flow on the target node, then revalidate.',
      reason: `${provider} is an OAuth account and needs an operator-completed authorization flow.`
    };
  }
  return {
    action: 'repair_provider_credentials',
    status: 'awaiting_operator_input',
    requiredInput: 'Repair or replace the provider credentials on the target node, then revalidate.',
    reason: `${provider} has runtime blockers but no more specific auth mode was reported.`
  };
}

function buildProviderCredentialHandoff(providerReport = {}, endpoint = '') {
  const provider = normalizeText(providerReport.provider, 64).toLowerCase();
  const authModes = providerAuthModes(providerReport);
  const accountId = firstSampleAccountId(providerReport);
  const classification = classifyProviderCredentialAction(providerReport);
  return {
    provider,
    status: classification.status,
    action: classification.action,
    authModes,
    runtimeBlocked: Number(providerReport.runtimeBlocked || 0),
    clearableRuntimeBlocks: Number(providerReport.clearableRuntimeBlocks || 0),
    configured: Number(providerReport.configured || 0),
    profileCount: Number(providerReport.profileCount || 0),
    sampleAccountId: accountId,
    requiredInput: classification.requiredInput,
    reason: classification.reason,
    commands: buildCredentialCommands(classification.action, provider, endpoint, accountId)
  };
}

function buildCredentialHandoff(report = {}, endpoint = '') {
  const remoteAudit = normalizeObject(report.remoteAudit);
  const providers = normalizeArray(remoteAudit.providers).map((item) => buildProviderCredentialHandoff(item, endpoint));
  const blocked = providers.filter((item) => item.status !== 'ready');
  return {
    status: blocked.length > 0 ? 'awaiting_operator_input' : 'ready',
    providers,
    summary: {
      providers: providers.length,
      ready: providers.length - blocked.length,
      awaitingInput: blocked.length
    }
  };
}

function buildProviderAccountReauthUrl(endpoint) {
  return new URL('/v0/node-rpc/device-provider-account-reauth', normalizeHttpEndpoint(endpoint)).toString();
}

function buildProviderAccountAuthJobUrl(endpoint, action, jobId = '') {
  const normalizedAction = normalizeText(action, 32).toLowerCase();
  const pathname = normalizedAction === 'cancel'
    ? '/v0/node-rpc/device-provider-account-auth-job-cancel'
    : (normalizedAction === 'callback'
      ? '/v0/node-rpc/device-provider-account-auth-job-callback'
      : '/v0/node-rpc/device-provider-account-auth-job');
  const url = new URL(pathname, normalizeHttpEndpoint(endpoint));
  if (normalizedAction === 'get' && jobId) url.searchParams.set('jobId', normalizeText(jobId, 160));
  return url.toString();
}

function evaluateProviderAccountReauthResponse(profile, options, response) {
  const body = normalizeObject(response && response.body);
  const result = normalizeObject(body.result);
  const ok = response.status === 200 && response.ok === true && body.ok === true && result.ok === true;
  const blockers = ok ? [] : [normalizeText(body.error, 160) || `http_${Number(response.status || 0)}`];
  return {
    ok,
    mode: 'remote-reauth',
    generatedAt: new Date().toISOString(),
    profile: buildProfileSummary(profile),
    target: {
      endpoint: profile.endpoint,
      provider: normalizeText(options.provider, 64).toLowerCase(),
      accountId: normalizeText(options.accountId, 128),
      reauthUrl: buildProviderAccountReauthUrl(profile.endpoint)
    },
    http: {
      reauthStatus: Number(response.status || 0)
    },
    rpc: normalizeText(body.rpc, 128),
    result,
    blockers
  };
}

async function runFabricProviderAccountReauth(rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: '',
    profileId: '',
    provider: '',
    accountId: '',
    waitMs: 3000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...rawOptions
  };
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  if (!options.provider) throw createError('missing_provider', 'missing --provider');
  if (!options.accountId) throw createError('missing_account_id', 'missing --account-id');

  const store = loadControlPlaneProfileStore(options, deps);
  const profile = selectReadyProfile(store, options);
  const response = await fetchJson(buildProviderAccountReauthUrl(profile.endpoint), {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_provider_account_reauth_timeout',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${profile.deviceToken}`
    },
    body: JSON.stringify({
      provider: normalizeText(options.provider, 64).toLowerCase(),
      accountId: normalizeText(options.accountId, 128),
      waitMs: Number(options.waitMs || 0)
    })
  }, deps);
  return evaluateProviderAccountReauthResponse(profile, options, response);
}

function evaluateProviderAccountAuthJobResponse(profile, options, response) {
  const body = normalizeObject(response && response.body);
  const result = normalizeObject(body.result);
  const ok = response.status >= 200 && response.status < 300 && response.ok === true && body.ok === true;
  const blockers = ok ? [] : [normalizeText(body.error, 160) || `http_${Number(response.status || 0)}`];
  return {
    ok,
    mode: 'remote-auth-job',
    action: normalizeText(options.action, 32),
    generatedAt: new Date().toISOString(),
    profile: buildProfileSummary(profile),
    target: {
      endpoint: profile.endpoint,
      jobId: normalizeText(options.jobId, 160),
      url: buildProviderAccountAuthJobUrl(profile.endpoint, options.action, options.jobId)
    },
    http: {
      status: Number(response.status || 0)
    },
    rpc: normalizeText(body.rpc, 128),
    result,
    blockers
  };
}

async function runFabricProviderAccountAuthJob(rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: '',
    profileId: '',
    action: '',
    jobId: '',
    callbackUrl: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...rawOptions
  };
  options.endpoint = normalizeOptionalHttpEndpoint(options.endpoint, '--endpoint');
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  if (options.action === 'status') options.action = 'get';
  if (!['get', 'cancel', 'callback'].includes(options.action)) {
    throw createError('missing_auth_job_action', 'auth-job action must be get, cancel, or callback');
  }
  if (!options.jobId) throw createError('missing_job_id', 'missing --job-id');
  if (options.action === 'callback' && !options.callbackUrl) {
    throw createError('missing_callback_url', 'missing --callback-url or --code');
  }

  const store = loadControlPlaneProfileStore(options, deps);
  const profile = selectReadyProfile(store, options);
  const method = options.action === 'get' ? 'GET' : 'POST';
  const body = options.action === 'get'
    ? undefined
    : JSON.stringify({
      jobId: normalizeText(options.jobId, 160),
      callbackUrl: normalizeText(options.callbackUrl, 8192)
    });
  const response = await fetchJson(buildProviderAccountAuthJobUrl(profile.endpoint, options.action, options.jobId), {
    method,
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_provider_account_auth_job_timeout',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${profile.deviceToken}`
    },
    body
  }, deps);
  return evaluateProviderAccountAuthJobResponse(profile, options, response);
}

async function runFabricProviderAccountsCommand(action, args = [], deps = {}) {
  if (normalizeText(action, 64) === 'reauth') {
    const options = parseReauthArgs(Array.isArray(args) ? args : [], deps.env || process.env);
    const report = await runFabricProviderAccountReauth(options, deps);
    return {
      ...report,
      json: options.json === true,
      exitOk: report && report.ok === true
    };
  }
  if (normalizeText(action, 64) === 'auth-job') {
    const options = parseAuthJobArgs(Array.isArray(args) ? args : [], deps.env || process.env);
    const report = await runFabricProviderAccountAuthJob(options, deps);
    return {
      ...report,
      json: options.json === true,
      exitOk: report && report.ok === true
    };
  }
  const targetOptions = parseRemoteTargetArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const activationArgs = await resolveRemoteActivationArgs(targetOptions.activationArgs, targetOptions, deps);
  const commandArgs = buildActivationArgs(action, activationArgs);
  const parseArgs = deps.parseRuntimeAccountActivationArgs || parseActivationArgs;
  const runner = deps.runRuntimeAccountActivation || runActivation;
  const options = parseArgs(commandArgs);
  const report = await runner(options, deps);
  return {
    ...report,
    credentialHandoff: buildCredentialHandoff(report, targetOptions.endpoint),
    json: options.json === true,
    exitOk: report && report.ok !== false
  };
}

function formatProviderReasons(reasons = []) {
  return normalizeArray(reasons)
    .map((item) => {
      const reason = normalizeText(item && item.reason, 160);
      const count = Number(item && item.count || 0);
      return reason ? `${reason}${count > 0 ? `=${count}` : ''}` : '';
    })
    .filter(Boolean)
    .join(',');
}

function formatAuditProviderLine(item = {}) {
  const reasons = formatProviderReasons(item.runtimeReasonCounts);
  return [
    `    - ${normalizeText(item.provider, 64)}`,
    `profiles=${Number(item.profileCount || 0)}`,
    `state_rows=${Number(item.stateRows || 0)}`,
    `blocked=${Number(item.runtimeBlocked || 0)}`,
    `clearable=${Number(item.clearableRuntimeBlocks || 0)}`,
    reasons ? `reasons=${reasons}` : ''
  ].filter(Boolean).join(' ');
}

function formatSessionGuardLine(item = {}) {
  const events = normalizeObject(item.events);
  return [
    `    - ${normalizeText(item.provider, 64)}`,
    `ok=${item.ok === true}`,
    `blocked=${item.blocked === true}`,
    `marker=${item.markerFound === true}`,
    `run=${normalizeText(item.runId, 160) || '-'}`,
    `transport=${normalizeText(item.transportKind, 64) || '-'}`,
    `fallback=${item.fallbackUsed === true}`,
    `events=${Number(events.eventCount || 0)}`,
    normalizeArray(item.blockers).length > 0 ? `blockers=${item.blockers.join(',')}` : ''
  ].filter(Boolean).join(' ');
}

function formatFabricProviderAccountsReport(report = {}) {
  const target = normalizeObject(report.target);
  const remoteAudit = normalizeObject(report.remoteAudit);
  const summary = normalizeObject(remoteAudit.summary);
  const conclusion = normalizeObject(report.conclusion);
  const lines = [
    'AIH Fabric provider accounts',
    `  mode: ${normalizeText(report.mode, 64) || 'unknown'}`,
    `  node_id: ${normalizeText(target.nodeId, 128)}`,
    `  ssh: ${normalizeText(target.ssh, 512)}`,
    `  remote_dir: ${normalizeText(target.remoteDir, 1024)}`,
    `  providers: ${normalizeArray(target.providers).join(', ') || 'none'}`,
    `  ok: ${report.ok === true}`,
    `  exit_ok: ${report.exitOk !== false}`
  ];

  if (remoteAudit && Object.keys(remoteAudit).length > 0) {
    lines.push(`  remote_audit: db=${summary.dbPresent === true} profiles=${Number(summary.profileCount || 0)} state_rows=${Number(summary.stateRows || 0)} blocked=${Number(summary.runtimeBlocked || 0)} clearable=${Number(summary.clearableRuntimeBlocks || 0)}`);
    normalizeArray(remoteAudit.providers).forEach((item) => lines.push(formatAuditProviderLine(item)));
  }
  const credentialHandoff = normalizeObject(report.credentialHandoff);
  if (normalizeArray(credentialHandoff.providers).length > 0) {
    const handoffSummary = normalizeObject(credentialHandoff.summary);
    lines.push(`  credential_handoff: ${normalizeText(credentialHandoff.status, 96)} ready=${Number(handoffSummary.ready || 0)} awaiting_input=${Number(handoffSummary.awaitingInput || 0)}`);
    credentialHandoff.providers.forEach((item) => {
      lines.push(`    - ${item.provider}: ${item.action} status=${item.status}`);
      if (item.requiredInput) lines.push(`      required: ${item.requiredInput}`);
    });
  }

  if (report.runtimeBlockClear) {
    lines.push(`  runtime_block_clear: ok=${report.runtimeBlockClear.ok === true} cleared=${Number(report.runtimeBlockClear.cleared || 0)} skipped=${Number(report.runtimeBlockClear.skipped || 0)}`);
  }
  if (report.managementReload) {
    lines.push(`  management_reload: ok=${report.managementReload.ok === true} reloaded=${Number(report.managementReload.reloaded || 0)}`);
  }
  if (report.registryPublish) {
    lines.push(`  registry_publish: ok=${report.registryPublish.ok === true} runtimes=${Number(report.registryPublish.runtimes || 0)} providers=${normalizeArray(report.registryPublish.providers).join(',')}`);
  }
  if (normalizeArray(report.sessionStarts).length > 0) {
    lines.push('  session_guards:');
    report.sessionStarts.forEach((item) => lines.push(formatSessionGuardLine(item)));
  }
  if (conclusion.status) {
    lines.push(`  conclusion: ${conclusion.status}`);
    lines.push(`  providers_validated: ${normalizeArray(conclusion.providersValidated).join(', ') || 'none'}`);
    lines.push(`  providers_blocked: ${normalizeArray(conclusion.providersBlocked).join(', ') || 'none'}`);
  }
  if (report.mode === 'remote-audit') {
    lines.push('  next: run provider accounts revalidate --yes to clear runtime blockers and prove real session guards; credential import still requires separate explicit confirmation.');
  }
  if (report.mode === 'remote-reauth') {
    const result = normalizeObject(report.result);
    lines.push(`  http: reauth=${Number(report.http && report.http.reauthStatus || 0)}`);
    lines.push(`  job: ${normalizeText(result.jobId, 160) || '-'}`);
    lines.push(`  target_account_id: ${normalizeText(result.targetAccountId, 128) || normalizeText(target.accountId, 128)}`);
    if (normalizeText(result.transientAccountId, 128)) {
      lines.push(`  transient_account_id: ${normalizeText(result.transientAccountId, 128)}`);
    }
    lines.push(`  auth_mode: ${normalizeText(result.authMode, 64) || '-'}`);
    lines.push(`  status: ${normalizeText(result.status, 64) || '-'}`);
    if (normalizeText(result.authorizationUrl, 4096)) {
      lines.push(`  authorization_url: ${normalizeText(result.authorizationUrl, 4096)}`);
    }
    if (normalizeText(result.callbackListeningUrl, 4096)) {
      lines.push(`  callback_listening_url: ${normalizeText(result.callbackListeningUrl, 4096)}`);
    }
    if (normalizeText(result.authProgressState, 160)) {
      lines.push(`  progress: ${normalizeText(result.authProgressState, 160)}`);
    }
    if (normalizeArray(report.blockers).length > 0) {
      lines.push('  blockers:');
      report.blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
    }
    lines.push('  next: finish the provider OAuth flow, then run provider accounts revalidate --yes for that provider.');
  }
  if (report.mode === 'remote-auth-job') {
    const result = normalizeObject(report.result);
    const job = normalizeObject(result.job);
    lines.push(`  action: ${normalizeText(report.action, 32)}`);
    lines.push(`  http: status=${Number(report.http && report.http.status || 0)}`);
    lines.push(`  job: ${normalizeText(job.id, 160) || normalizeText(target.jobId, 160) || '-'}`);
    lines.push(`  provider: ${normalizeText(job.provider, 64) || '-'}`);
    lines.push(`  account_id: ${normalizeText(job.accountId, 128) || '-'}`);
    lines.push(`  status: ${normalizeText(job.status, 64) || '-'}`);
    lines.push(`  progress: ${normalizeText(job.authProgressState, 160) || '-'}`);
    if (normalizeText(job.authorizationUrl, 4096)) {
      lines.push(`  authorization_url: ${normalizeText(job.authorizationUrl, 4096)}`);
    }
    if (normalizeText(job.verificationUriComplete, 4096)) {
      lines.push(`  verification_uri_complete: ${normalizeText(job.verificationUriComplete, 4096)}`);
    }
    if (normalizeArray(report.blockers).length > 0) {
      lines.push('  blockers:');
      report.blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
    }
  }
  return lines.join('\n');
}

module.exports = {
  buildActivationArgs,
  buildCredentialHandoff,
  buildProviderCredentialHandoff,
  buildProviderAccountAuthJobUrl,
  buildProviderAccountReauthUrl,
  evaluateProviderAccountAuthJobResponse,
  evaluateProviderAccountReauthResponse,
  formatFabricProviderAccountsReport,
  parseAuthJobArgs,
  parseRemoteTargetArgs,
  parseReauthArgs,
  resolveRemoteActivationArgs,
  runFabricProviderAccountAuthJob,
  runFabricProviderAccountReauth,
  runFabricProviderAccountsCommand
};
