'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const { DEFAULT_NODE_CAPABILITIES, normalizeId } = require('./node-registry');
const {
  SUPPORTED_TRANSPORT_KINDS,
  getTransportKindCatalog,
  getTransportKindMetadata,
  normalizeTransportKind,
  normalizeTransportRouteRole,
  normalizeTransportTrustLevel
} = require('./transport-registry');
const { buildRemoteTransportStrategies } = require('./transport-strategies');
const { resolveRepoSubdir } = require('./repo-paths');

const DEFAULT_REMOTE_TRANSPORT_KIND = 'relay';

const TRANSPORT_PROVIDER_BY_KIND = Object.freeze(buildTransportFieldMap('provider'));
const TRANSPORT_ROUTE_ROLE_BY_KIND = Object.freeze(buildTransportFieldMap('defaultRouteRole'));
const TRANSPORT_TRUST_LEVEL_BY_KIND = Object.freeze(buildTransportFieldMap('defaultTrustLevel'));

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function buildTransportFieldMap(field) {
  return SUPPORTED_TRANSPORT_KINDS.reduce((map, kind) => {
    const metadata = getTransportKindMetadata(kind) || {};
    map[kind] = normalizeText(metadata[field], 64);
    return map;
  }, {});
}

function slugifyNodeName(value) {
  return normalizeText(value, 96)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 8);
}

function normalizeMachineId(value) {
  const text = normalizeText(value, 256);
  const compact = text.replace(/[^a-zA-Z0-9]/g, '');
  if (compact.length < 8 || /^0+$/.test(compact)) return '';
  return text;
}

function resolveHostname(deps = {}) {
  if (typeof deps.hostname === 'function') {
    const value = normalizeText(deps.hostname(), 120);
    if (value) return value;
  }
  return normalizeText(os.hostname(), 120) || 'ai-home-node';
}

function resolvePlatform(deps = {}) {
  const processObj = deps.processObj || process;
  return normalizeText(deps.platform || (processObj && processObj.platform) || process.platform, 32) || 'unknown';
}

function resolveArch(deps = {}) {
  const processObj = deps.processObj || process;
  return normalizeText(deps.arch || (processObj && processObj.arch) || process.arch, 32) || 'unknown';
}

function readFirstMachineIdFile(paths, deps = {}) {
  const fs = deps.fs;
  if (!fs || typeof fs.readFileSync !== 'function') return '';
  for (const filePath of paths) {
    try {
      const value = normalizeMachineId(fs.readFileSync(filePath, 'utf8'));
      if (value) return value;
    } catch (_error) {}
  }
  return '';
}

function runMachineIdCommand(command, args, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  if (typeof spawn !== 'function') return '';
  try {
    const result = spawn(command, args, { encoding: 'utf8' });
    if (result && result.status === 0) return normalizeText(result.stdout, 4096);
  } catch (_error) {}
  return '';
}

function runTextCommand(command, args, options = {}, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  if (typeof spawn !== 'function') return '';
  try {
    const result = spawn(command, args, {
      encoding: 'utf8',
      ...options
    });
    if (result && result.status === 0) return normalizeText(result.stdout, 4096);
  } catch (_error) {}
  return '';
}

function normalizeCloneRepoUrl(value) {
  const text = normalizeText(value, 512);
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;

  const scpLikeMatch = text.match(/^git@([^:/\s]+):(.+)$/);
  if (scpLikeMatch) {
    const host = normalizeText(scpLikeMatch[1], 256);
    const repoPath = normalizeText(scpLikeMatch[2], 512).replace(/^\/+/, '');
    if (host && repoPath && !repoPath.startsWith('~')) return `https://${host}/${repoPath}`;
  }

  try {
    const parsed = new URL(text);
    if (parsed.protocol === 'ssh:' && parsed.username === 'git' && parsed.hostname && (!parsed.port || parsed.port === '22')) {
      const repoPath = normalizeText(parsed.pathname, 512).replace(/^\/+/, '');
      if (repoPath && !repoPath.startsWith('~')) return `https://${parsed.hostname}/${repoPath}`;
    }
  } catch (_error) {}

  return text;
}

function readDarwinMachineId(deps = {}) {
  const output = runMachineIdCommand('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], deps);
  const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
  return normalizeMachineId(match && match[1]);
}

function readWin32MachineId(deps = {}) {
  const output = runMachineIdCommand('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], deps);
  const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
  return normalizeMachineId(match && match[1]);
}

function resolveMachineId(deps = {}) {
  if (typeof deps.machineId === 'function') {
    const value = normalizeMachineId(deps.machineId());
    if (value) return value;
  } else {
    const value = normalizeMachineId(deps.machineId);
    if (value) return value;
  }

  const platform = resolvePlatform(deps);
  if (platform === 'linux') return readFirstMachineIdFile(['/etc/machine-id', '/var/lib/dbus/machine-id'], deps);
  if (platform === 'darwin') return readDarwinMachineId(deps);
  if (platform === 'win32') return readWin32MachineId(deps);
  return '';
}

function buildNodeIdentitySeed(hostname, deps = {}) {
  const machineId = resolveMachineId(deps);
  if (machineId) {
    return [
      shortHash(machineId),
      resolvePlatform(deps),
      resolveArch(deps)
    ].join('|');
  }
  return [
    hostname.toLowerCase(),
    resolvePlatform(deps),
    resolveArch(deps),
    normalizeText(deps.aiHomeDir, 512)
  ].join('|');
}

function buildRemoteNodeIdentity(input = {}, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const hostname = normalizeText(source.name || source.hostname || resolveHostname(deps), 120) || 'AI Home Node';
  const explicitId = normalizeId(source.nodeId || source.id);
  if (explicitId) {
    return {
      nodeId: explicitId,
      name: hostname
    };
  }

  const seed = buildNodeIdentitySeed(hostname, deps);
  const suffix = shortHash(seed);
  const base = slugifyNodeName(hostname) || 'node';
  const nodeId = normalizeId(`${base.slice(0, 54)}-${suffix}`) || `node-${suffix}`;
  return {
    nodeId,
    name: hostname
  };
}

function resolveRepoUrl(deps = {}) {
  if (typeof deps.gitRemoteUrl === 'function') {
    const value = normalizeText(deps.gitRemoteUrl(), 512);
    if (value) return normalizeCloneRepoUrl(value);
  } else {
    const value = normalizeText(deps.gitRemoteUrl, 512);
    if (value) return normalizeCloneRepoUrl(value);
  }

  return normalizeCloneRepoUrl(runTextCommand('git', ['config', '--get', 'remote.origin.url'], {
    cwd: normalizeText(deps.cwd, 512) || process.cwd()
  }, deps));
}

function resolveTransportProvider(kind) {
  const transportKind = normalizeTransportKind(kind || DEFAULT_REMOTE_TRANSPORT_KIND) || DEFAULT_REMOTE_TRANSPORT_KIND;
  const metadata = getTransportKindMetadata(transportKind) || {};
  return normalizeText(metadata.provider, 64) || transportKind;
}

function resolveTransportRouteRole(kind, value) {
  const normalized = normalizeTransportRouteRole(value);
  if (value) return normalized;
  const metadata = getTransportKindMetadata(kind) || {};
  return normalizeTransportRouteRole(metadata.defaultRouteRole || 'data-plane');
}

function resolveTransportTrustLevel(kind, value) {
  const normalized = normalizeTransportTrustLevel(value);
  if (value) return normalized;
  const metadata = getTransportKindMetadata(kind) || {};
  return normalizeTransportTrustLevel(metadata.defaultTrustLevel || normalized);
}

function buildRemoteTransportDefaults() {
  return SUPPORTED_TRANSPORT_KINDS.reduce((defaults, kind) => {
    defaults[kind] = {
      provider: resolveTransportProvider(kind),
      routeRole: resolveTransportRouteRole(kind),
      trustLevel: resolveTransportTrustLevel(kind)
    };
    return defaults;
  }, {});
}

function buildRemoteNodeDefaults(input = {}, deps = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const identity = buildRemoteNodeIdentity(source, deps);
  const transportKind = normalizeTransportKind(source.transportKind || source.kind || DEFAULT_REMOTE_TRANSPORT_KIND)
    || DEFAULT_REMOTE_TRANSPORT_KIND;
  return {
    ...identity,
    transportKind,
    provider: normalizeText(source.provider || resolveTransportProvider(transportKind), 64),
    routeRole: resolveTransportRouteRole(transportKind, source.routeRole),
    trustLevel: resolveTransportTrustLevel(transportKind, source.trustLevel),
    transportDefaults: buildRemoteTransportDefaults(),
    transportCatalog: getTransportKindCatalog(),
    transportStrategies: buildRemoteTransportStrategies(),
    preferredTransports: [transportKind],
    capabilities: DEFAULT_NODE_CAPABILITIES.slice(),
    repoUrl: normalizeText(source.repoUrl || resolveRepoUrl(deps), 512),
    repoSubdir: normalizeText(source.repoSubdir || resolveRepoSubdir(deps), 512),
    repoDir: normalizeText(source.repoDir, 512)
  };
}

module.exports = {
  DEFAULT_REMOTE_TRANSPORT_KIND,
  TRANSPORT_PROVIDER_BY_KIND,
  TRANSPORT_ROUTE_ROLE_BY_KIND,
  TRANSPORT_TRUST_LEVEL_BY_KIND,
  buildRemoteTransportDefaults,
  buildRemoteNodeDefaults,
  buildRemoteNodeIdentity,
  normalizeCloneRepoUrl,
  resolveMachineId,
  resolveRepoUrl,
  resolveTransportProvider,
  resolveTransportRouteRole,
  resolveTransportTrustLevel
};
