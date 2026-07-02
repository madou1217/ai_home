'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  saveControlPlaneProfile
} = require('../../../server/control-plane-profile-store');
const {
  createControlPlaneDeviceInvite
} = require('../../../server/control-plane-device-pairing');
const {
  buildProfileSummary,
  createError,
  fetchJson,
  normalizeHttpEndpoint,
  normalizeText,
  parsePositiveInteger,
  readOptionValue,
  resolveDefaultAiHomeDir,
  resolveLocalPath
} = require('./server-profile-client');

const DEFAULT_LOOPBACK_ENDPOINT = 'http://127.0.0.1:9527';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_INVITE_TTL_MS = 10 * 60 * 1000;

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizePlatform(value) {
  return normalizeText(value, 64) || process.platform || 'node';
}

function defaultDeviceId(env = process.env, platform = process.platform) {
  const host = normalizeText(env.HOSTNAME || env.COMPUTERNAME || os.hostname(), 64)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = host || 'local';
  return `aih-cli-${normalizeText(platform, 32) || 'node'}-${suffix}`.slice(0, 96);
}

function defaultDeviceName(env = process.env) {
  return normalizeText(env.AIH_FABRIC_DEVICE_NAME, 120)
    || normalizeText(os.hostname(), 120)
    || 'AIH CLI';
}

function readPairLinkParam(params) {
  return normalizeText(
    params.get('pair')
      || params.get('pairUrl')
      || params.get('pair_url')
      || params.get('pairUrlOrCode')
      || '',
    4096
  );
}

function readPairEndpointParam(params) {
  return normalizeText(
    params.get('endpoint')
      || params.get('controlEndpoint')
      || params.get('control_endpoint')
      || '',
    2048
  );
}

function parseControlPlanePairInput(pairUrlOrCode, fallbackEndpoint = '') {
  const raw = normalizeText(pairUrlOrCode, 4096);
  const fallback = fallbackEndpoint ? normalizeHttpEndpoint(fallbackEndpoint, '--endpoint') : '';
  if (!raw) return { endpoint: fallback, code: '' };
  try {
    const parsed = new URL(raw);
    const explicitEndpoint = readPairEndpointParam(parsed.searchParams);
    const nestedPairUrlOrCode = readPairLinkParam(parsed.searchParams);
    if (nestedPairUrlOrCode && nestedPairUrlOrCode !== raw) {
      return parseControlPlanePairInput(nestedPairUrlOrCode, explicitEndpoint || fallback);
    }
    const code = normalizeText(parsed.searchParams.get('code'), 4096);
    const markers = ['/v0/fabric/device-pair', '/v0/node-rpc/device-pair'];
    const markerIndex = markers
      .map((marker) => parsed.pathname.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? -1;
    const basePath = markerIndex > 0 ? parsed.pathname.slice(0, markerIndex) : '';
    const endpoint = explicitEndpoint || normalizeHttpEndpoint(`${parsed.protocol}//${parsed.host}${basePath}`, '--endpoint');
    return { endpoint, code };
  } catch (_error) {
    return { endpoint: fallback, code: raw };
  }
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    aiHomeDir: normalizeText(env.AIH_HOME || env.AI_HOME, 2048),
    endpoint: '',
    pairUrlOrCode: '',
    code: '',
    deviceId: '',
    deviceName: '',
    platform: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    inviteTtlMs: DEFAULT_INVITE_TTL_MS,
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
    if (token === '--pair-url' || token === '--pair' || token.startsWith('--pair-url=') || token.startsWith('--pair=')) {
      const flag = token.startsWith('--pair-url') ? '--pair-url' : '--pair';
      const next = readOptionValue(argv, index, flag);
      options.pairUrlOrCode = normalizeText(next.value, 4096);
      index += next.consumed;
      continue;
    }
    if (token === '--code' || token.startsWith('--code=')) {
      const next = readOptionValue(argv, index, '--code');
      options.code = normalizeText(next.value, 4096);
      index += next.consumed;
      continue;
    }
    if (token === '--device-id' || token.startsWith('--device-id=')) {
      const next = readOptionValue(argv, index, '--device-id');
      options.deviceId = normalizeText(next.value, 96);
      index += next.consumed;
      continue;
    }
    if (token === '--device-name' || token.startsWith('--device-name=')) {
      const next = readOptionValue(argv, index, '--device-name');
      options.deviceName = normalizeText(next.value, 120);
      index += next.consumed;
      continue;
    }
    if (token === '--platform' || token.startsWith('--platform=')) {
      const next = readOptionValue(argv, index, '--platform');
      options.platform = normalizePlatform(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--invite-ttl-ms' || token.startsWith('--invite-ttl-ms=')) {
      const next = readOptionValue(argv, index, '--invite-ttl-ms');
      options.inviteTtlMs = parsePositiveInteger(next.value, '--invite-ttl-ms', DEFAULT_INVITE_TTL_MS, 60000, 24 * 60 * 60 * 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    if (!isFlag(token) && !options.pairUrlOrCode) {
      options.pairUrlOrCode = normalizeText(token, 4096);
      index += 1;
      continue;
    }
    throw createError('invalid_option', `unknown option: ${token}`);
  }

  options.aiHomeDir = options.aiHomeDir ? resolveLocalPath(options.aiHomeDir) : resolveDefaultAiHomeDir(env);
  options.endpoint = options.endpoint ? normalizeHttpEndpoint(options.endpoint, '--endpoint') : '';
  options.deviceId = options.deviceId || defaultDeviceId(env, process.platform);
  options.deviceName = options.deviceName || defaultDeviceName(env);
  options.platform = normalizePlatform(options.platform);
  return options;
}

function buildUrl(endpoint, pathname) {
  return new URL(pathname, normalizeHttpEndpoint(endpoint, '--endpoint')).toString();
}

async function postJson(url, payload, options = {}, deps = {}) {
  return fetchJson(url, {
    method: 'POST',
    timeoutMs: options.timeoutMs,
    timeoutCode: options.timeoutCode,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload || {})
  }, deps);
}

async function fetchFabricDescriptor(endpoint, options = {}, deps = {}) {
  const response = await fetchJson(buildUrl(endpoint, '/v0/fabric/descriptor'), {
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_profile_descriptor_timeout',
    headers: { accept: 'application/json' }
  }, deps);
  const result = normalizeObject(response.body && response.body.result);
  if (response.status !== 200 || response.ok !== true || response.body && response.body.ok === false || !result.service) {
    throw createError('invalid_fabric_descriptor', 'Fabric descriptor request did not return an AIH Fabric descriptor');
  }
  return result;
}

function createDeviceInviteLocally(endpoint, options = {}, deps = {}) {
  // WebUI 鉴权门(R2)后 invites HTTP 接口需要已配对凭据；CLI 在 server 本机运行，
  // 直接写本地设备存储生成邀请（与 server 同一份 ~/.ai_home 存储）。
  const result = createControlPlaneDeviceInvite({
    name: options.deviceName,
    controlEndpoint: endpoint,
    expiresInMs: options.inviteTtlMs || DEFAULT_INVITE_TTL_MS
  }, {
    fs: deps.fs || fs,
    aiHomeDir: options.aiHomeDir
  });
  return {
    ok: true,
    invite: result.invite,
    code: result.code,
    pairUrl: result.pairUrl,
    webPairUrl: result.webPairUrl
  };
}

async function createDeviceInvite(endpoint, options = {}, deps = {}) {
  if (options.aiHomeDir) {
    try {
      return createDeviceInviteLocally(endpoint, options, deps);
    } catch (_error) {
      // 本地存储不可写（如异机执行）→ 退回 HTTP。
    }
  }
  const response = await postJson(buildUrl(endpoint, '/v0/webui/control-plane/devices/invites'), {
    name: options.deviceName,
    controlEndpoint: endpoint,
    expiresInMs: options.inviteTtlMs
  }, {
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_profile_invite_timeout'
  }, deps);
  if (response.status !== 200 || response.ok !== true || response.body && response.body.ok === false) {
    throw createError(
      'fabric_profile_invite_failed',
      'Fabric profile invite creation failed',
      `status=${response.status}`
    );
  }
  const body = normalizeObject(response.body);
  const pairUrl = normalizeText(body.pairUrl, 4096);
  const code = normalizeText(body.code, 4096);
  if (!pairUrl && !code) {
    throw createError('invalid_fabric_profile_invite', 'Fabric profile invite did not include a pair URL or code');
  }
  return body;
}

function normalizeDevicePairResult(response) {
  const result = normalizeObject(response.body && response.body.result);
  const device = normalizeObject(result.device);
  const token = normalizeText(result.token, 4096);
  if (response.status !== 200 || response.ok !== true || response.body && response.body.ok === false || !token) {
    throw createError(
      'fabric_profile_pair_failed',
      'Fabric device pairing failed',
      `status=${response.status}`
    );
  }
  return {
    device,
    token
  };
}

async function pairDevice(endpoint, code, options = {}, deps = {}) {
  const response = await postJson(buildUrl(endpoint, '/v0/fabric/device-pair'), {
    code,
    device: {
      id: options.deviceId,
      name: options.deviceName,
      platform: options.platform
    }
  }, {
    timeoutMs: options.timeoutMs,
    timeoutCode: 'fabric_profile_pair_timeout'
  }, deps);
  return normalizeDevicePairResult(response);
}

function descriptorName(descriptor, endpoint) {
  const server = normalizeObject(descriptor.server);
  return normalizeText(server.name, 120)
    || normalizeText(server.endpoint, 120)
    || normalizeText(endpoint, 120);
}

function savePairedProfile(endpoint, pairResult, descriptor, options = {}, deps = {}) {
  const saver = deps.saveControlPlaneProfile || saveControlPlaneProfile;
  const saved = saver({
    name: descriptorName(descriptor, endpoint),
    endpoint,
    connectionMode: 'direct',
    descriptor,
    state: pairResult.device && pairResult.device.state === 'revoked' ? 'revoked' : 'paired',
    authState: pairResult.device && pairResult.device.state === 'revoked' ? 'unpaired' : 'paired',
    deviceToken: pairResult.token,
    lastError: ''
  }, { active: true }, {
    fs: deps.fs || fs,
    aiHomeDir: options.aiHomeDir
  });
  return saved.profile;
}

function buildReport(action, endpoint, invite, pairResult, descriptor, profile, options = {}) {
  return {
    ok: true,
    action,
    generatedAt: new Date().toISOString(),
    aiHomeDir: options.aiHomeDir,
    endpoint,
    invite: invite ? {
      id: normalizeText(invite.invite && invite.invite.id, 96),
      warnings: Array.isArray(invite.warnings) ? invite.warnings.map((item) => normalizeText(item, 512)).filter(Boolean) : []
    } : null,
    device: {
      id: normalizeText(pairResult.device && pairResult.device.id, 96),
      name: normalizeText(pairResult.device && pairResult.device.name, 120),
      platform: normalizeText(pairResult.device && pairResult.device.platform, 64),
      state: normalizeText(pairResult.device && pairResult.device.state, 64)
    },
    descriptor: {
      service: normalizeText(descriptor.service, 64),
      protocolVersion: Number(descriptor.protocolVersion || 0),
      serverId: normalizeText(descriptor.server && descriptor.server.id, 160),
      serverEndpoint: normalizeText(descriptor.server && descriptor.server.endpoint, 2048)
    },
    profile: buildProfileSummary(profile),
    deviceTokenPresent: Boolean(profile && profile.deviceToken)
  };
}

async function runFabricProfilePairing(action, rawOptions = {}, deps = {}) {
  const options = {
    aiHomeDir: resolveDefaultAiHomeDir(deps.env || process.env),
    endpoint: '',
    pairUrlOrCode: '',
    code: '',
    deviceId: defaultDeviceId(deps.env || process.env, process.platform),
    deviceName: defaultDeviceName(deps.env || process.env),
    platform: process.platform,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    inviteTtlMs: DEFAULT_INVITE_TTL_MS,
    diagnosticsFile: '',
    ...rawOptions
  };
  options.aiHomeDir = resolveLocalPath(options.aiHomeDir);
  const normalizedAction = normalizeText(action, 32);
  if (normalizedAction !== 'pair' && normalizedAction !== 'pair-self' && normalizedAction !== 'invite') {
    throw createError('unknown_fabric_profile_action', `unknown profile action: ${normalizedAction}`);
  }

  if (normalizedAction === 'invite') {
    // 浏览器 bootstrap（R2 授权门）：生成配对邀请并打印浏览器链接，不做本地配对。
    const inviteEndpoint = normalizeHttpEndpoint(options.endpoint || DEFAULT_LOOPBACK_ENDPOINT, '--endpoint');
    const created = await createDeviceInvite(inviteEndpoint, options, deps);
    return {
      ok: true,
      action: 'invite',
      endpoint: inviteEndpoint,
      invite: created.invite || null,
      code: normalizeText(created.code, 4096),
      pairUrl: normalizeText(created.pairUrl, 4096),
      webPairUrl: normalizeText(created.webPairUrl, 4096)
    };
  }

  let invite = null;
  let pairInput = options.pairUrlOrCode || options.code;
  let endpoint = options.endpoint;
  if (normalizedAction === 'pair-self') {
    endpoint = normalizeHttpEndpoint(endpoint || DEFAULT_LOOPBACK_ENDPOINT, '--endpoint');
    invite = await createDeviceInvite(endpoint, options, deps);
    pairInput = normalizeText(invite.pairUrl, 4096) || normalizeText(invite.code, 4096);
  }

  const parsed = parseControlPlanePairInput(pairInput, endpoint);
  endpoint = normalizeHttpEndpoint(endpoint || parsed.endpoint, '--endpoint');
  const code = normalizeText(options.code || parsed.code, 4096);
  if (!endpoint) throw createError('invalid_control_plane_endpoint', 'missing Fabric endpoint');
  if (!code) throw createError('missing_control_plane_pair_code', 'missing Fabric pair code');

  const pairResult = await pairDevice(endpoint, code, options, deps);
  const descriptor = await fetchFabricDescriptor(endpoint, options, deps);
  const profile = savePairedProfile(endpoint, pairResult, descriptor, options, deps);
  const report = buildReport(normalizedAction, endpoint, invite, pairResult, descriptor, profile, options);
  if (options.diagnosticsFile) writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

async function runFabricProfilePairingCommand(action, args = [], deps = {}) {
  const options = parseArgs(Array.isArray(args) ? args : [], deps.env || process.env);
  const report = await runFabricProfilePairing(action, options, deps);
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

function formatFabricProfilePairingReport(report = {}) {
  if (report.action === 'invite') {
    return [
      'AIH Fabric browser pairing invite',
      `  endpoint: ${report.endpoint || ''}`,
      `  browser url: ${report.webPairUrl || report.pairUrl || ''}`,
      `  pair url: ${report.pairUrl || ''}`,
      '  在要授权的浏览器里打开 browser url 完成配对；邀请一次有效、默认 10 分钟过期。',
      `  result: ${report.ok ? 'pass' : 'fail'}`
    ].join('\n');
  }
  const lines = [
    'AIH Fabric profile pairing',
    `  action: ${report.action || ''}`,
    `  endpoint: ${report.endpoint || ''}`,
    `  profile: ${report.profile && report.profile.name || ''} (${report.profile && report.profile.id || ''})`,
    `  auth_state: ${report.profile && report.profile.authState || ''}`,
    `  device: ${report.device && report.device.name || ''} (${report.device && report.device.id || ''})`,
    `  device_token: ${report.deviceTokenPresent ? 'present' : 'missing'}`
  ];
  const warnings = report.invite && Array.isArray(report.invite.warnings) ? report.invite.warnings : [];
  if (warnings.length > 0) {
    lines.push('  warnings:');
    warnings.forEach((warning) => lines.push(`    - ${warning}`));
  }
  lines.push(`  result: ${report.ok ? 'pass' : 'fail'}`);
  return lines.join('\n');
}

module.exports = {
  DEFAULT_LOOPBACK_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  buildReport,
  createDeviceInvite,
  fetchFabricDescriptor,
  formatFabricProfilePairingReport,
  parseArgs,
  parseControlPlanePairInput,
  runFabricProfilePairing,
  runFabricProfilePairingCommand
};
