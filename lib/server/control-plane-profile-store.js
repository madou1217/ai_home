'use strict';

const path = require('node:path');

const CONTROL_PLANE_PROFILES_FILE = 'control-plane-profiles.json';
const PROFILE_STATES = new Set(['draft', 'discovered', 'pairing', 'paired', 'degraded', 'revoked', 'recovery']);
const AUTH_STATES = new Set(['unpaired', 'paired', 'unknown']);
const CONNECTION_MODES = new Set(['direct', 'broker-proxy']);

function nowMs() {
  return Date.now();
}

function normalizeText(value, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeStringArray(value, maxLength = 96) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)));
}

function normalizeEndpoint(value) {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function stableProfileId(endpoint) {
  let hash = 2166136261;
  for (const char of endpoint) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `cp-${(hash >>> 0).toString(36)}`;
}

function getControlPlaneProfilesPath(aiHomeDir) {
  const root = normalizeText(aiHomeDir, 2048);
  return root ? path.join(root, CONTROL_PLANE_PROFILES_FILE) : '';
}

function readJsonFile(filePath, fallback, deps = {}) {
  try {
    if (!filePath || !deps.fs || !deps.fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(deps.fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeJsonFile(filePath, payload, deps = {}) {
  if (!filePath || !deps.fs) return;
  if (typeof deps.fs.mkdirSync === 'function') {
    deps.fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  deps.fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    if (typeof deps.fs.chmodSync === 'function') deps.fs.chmodSync(filePath, 0o600);
  } catch (_error) {}
}

function normalizeConnectionMode(value) {
  const mode = normalizeText(value, 32).toLowerCase();
  return CONNECTION_MODES.has(mode) ? mode : 'direct';
}

function normalizeState(value, fallback = 'discovered') {
  const state = normalizeText(value, 32).toLowerCase();
  return PROFILE_STATES.has(state) ? state : fallback;
}

function normalizeAuthState(value, fallback = 'unpaired') {
  const state = normalizeText(value, 32).toLowerCase();
  return AUTH_STATES.has(state) ? state : fallback;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeBroker(value) {
  const source = normalizeObject(value);
  const brokerEndpoint = normalizeEndpoint(source.brokerEndpoint);
  const serverId = normalizeText(source.serverId, 128);
  const proxyEndpoint = normalizeEndpoint(source.proxyEndpoint);
  if (!brokerEndpoint || !serverId || !proxyEndpoint) return null;
  return { brokerEndpoint, serverId, proxyEndpoint };
}

function normalizeDescriptor(value) {
  const source = normalizeObject(value);
  if (!source.service) return null;
  return source;
}

function normalizeTransport(value) {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 96);
  const nodeId = normalizeText(source.nodeId, 96);
  const kind = normalizeText(source.kind, 64);
  if (!id || !nodeId || !kind) return null;
  return {
    id,
    nodeId,
    kind,
    status: normalizeText(source.status, 32),
    score: normalizeNumber(source.score),
    latencyMs: normalizeNumber(source.latencyMs),
    lastError: normalizeText(source.lastError, 512),
    disabled: Boolean(source.disabled),
    managedBy: normalizeText(source.managedBy, 64),
    provider: normalizeText(source.provider, 64),
    routeRole: normalizeText(source.routeRole, 64) || 'data-plane',
    trustLevel: normalizeText(source.trustLevel, 64) || 'managed',
    createdAt: normalizeNumber(source.createdAt),
    updatedAt: normalizeNumber(source.updatedAt)
  };
}

function normalizeConnection(value) {
  const source = normalizeObject(value);
  return {
    status: normalizeText(source.status, 32) || 'unknown',
    transportKind: normalizeText(source.transportKind, 64),
    transportId: normalizeText(source.transportId, 96),
    sessionId: normalizeText(source.sessionId, 160),
    remoteAddress: normalizeText(source.remoteAddress, 256),
    connectedAt: normalizeNumber(source.connectedAt),
    lastSeenAt: normalizeNumber(source.lastSeenAt)
  };
}

function normalizeNode(value) {
  const source = normalizeObject(value);
  const id = normalizeText(source.id, 96);
  if (!id) return null;
  const transports = (Array.isArray(source.transports) ? source.transports : [])
    .map(normalizeTransport)
    .filter(Boolean);
  return {
    id,
    name: normalizeText(source.name, 120) || id,
    role: normalizeText(source.role, 64) || 'node',
    endpointPolicy: normalizeText(source.endpointPolicy, 64),
    preferredTransports: normalizeStringArray(source.preferredTransports, 64),
    capabilities: normalizeStringArray(source.capabilities, 96),
    fingerprint: normalizeText(source.fingerprint, 160),
    tags: normalizeStringArray(source.tags, 64),
    disabled: Boolean(source.disabled),
    lastSeenAt: normalizeNumber(source.lastSeenAt),
    connection: normalizeConnection(source.connection),
    createdAt: normalizeNumber(source.createdAt),
    updatedAt: normalizeNumber(source.updatedAt),
    transports
  };
}

function normalizeProfile(value, previous = null) {
  const source = normalizeObject(value);
  const prior = previous && typeof previous === 'object' ? previous : {};
  const endpoint = normalizeEndpoint(source.endpoint || prior.endpoint);
  if (!endpoint) return null;
  const createdAt = normalizeNumber(prior.createdAt || source.createdAt) || nowMs();
  const updatedAt = normalizeNumber(source.updatedAt) || nowMs();
  const nodes = (Array.isArray(source.nodes) ? source.nodes : [])
    .map(normalizeNode)
    .filter(Boolean);
  const state = normalizeState(source.state, prior.state || 'discovered');
  const authState = normalizeAuthState(source.authState, prior.authState || (state === 'paired' ? 'paired' : 'unpaired'));
  return {
    id: normalizeText(source.id || prior.id, 96) || stableProfileId(endpoint),
    name: normalizeText(source.name || prior.name, 120) || endpoint,
    endpoint,
    connectionMode: normalizeConnectionMode(source.connectionMode || prior.connectionMode),
    broker: normalizeBroker(source.broker || prior.broker),
    state,
    authState,
    deviceToken: normalizeText(source.deviceToken || prior.deviceToken, 4096),
    nodes,
    nodeCount: Math.max(nodes.length, normalizeNumber(source.nodeCount || prior.nodeCount)),
    accountCount: normalizeNumber(source.accountCount || prior.accountCount),
    activeAccountCount: normalizeNumber(source.activeAccountCount || prior.activeAccountCount),
    schedulableAccountCount: normalizeNumber(source.schedulableAccountCount || prior.schedulableAccountCount),
    sessionCount: normalizeNumber(source.sessionCount || prior.sessionCount),
    lastDeviceSyncAt: normalizeNumber(source.lastDeviceSyncAt || prior.lastDeviceSyncAt),
    lastStatusSyncAt: normalizeNumber(source.lastStatusSyncAt || prior.lastStatusSyncAt),
    lastAccountsSyncAt: normalizeNumber(source.lastAccountsSyncAt || prior.lastAccountsSyncAt),
    lastSessionsSyncAt: normalizeNumber(source.lastSessionsSyncAt || prior.lastSessionsSyncAt),
    descriptor: normalizeDescriptor(source.descriptor || prior.descriptor),
    lastCheckedAt: normalizeNumber(source.lastCheckedAt || prior.lastCheckedAt),
    lastError: normalizeText(source.lastError, 512),
    createdAt,
    updatedAt
  };
}

function normalizeStore(input) {
  const source = normalizeObject(input);
  const profiles = (Array.isArray(source.profiles) ? source.profiles : [])
    .reduce((items, profile) => {
      const normalized = normalizeProfile(profile);
      if (!normalized) return items;
      const existingIndex = items.findIndex((item) => item.id === normalized.id || item.endpoint === normalized.endpoint);
      if (existingIndex >= 0) items.splice(existingIndex, 1);
      items.push(normalized);
      return items;
    }, [])
    .sort((left, right) => right.updatedAt - left.updatedAt || left.name.localeCompare(right.name));
  const activeProfileId = normalizeText(source.activeProfileId, 96);
  return {
    version: 1,
    activeProfileId: profiles.some((profile) => profile.id === activeProfileId) ? activeProfileId : '',
    profiles
  };
}

function readControlPlaneProfileStore(deps = {}) {
  return normalizeStore(readJsonFile(
    getControlPlaneProfilesPath(deps.aiHomeDir),
    { version: 1, activeProfileId: '', profiles: [] },
    deps
  ));
}

function writeControlPlaneProfileStore(store, deps = {}) {
  writeJsonFile(getControlPlaneProfilesPath(deps.aiHomeDir), normalizeStore(store), deps);
}

function listControlPlaneProfiles(deps = {}) {
  return readControlPlaneProfileStore(deps);
}

function saveControlPlaneProfile(profile, options = {}, deps = {}) {
  const store = readControlPlaneProfileStore(deps);
  const previous = store.profiles.find((item) => item.id === normalizeText(profile && profile.id, 96)
    || item.endpoint === normalizeEndpoint(profile && profile.endpoint)) || null;
  const normalized = normalizeProfile(profile, previous);
  if (!normalized) {
    const error = new Error('invalid_control_plane_profile');
    error.code = 'invalid_control_plane_profile';
    throw error;
  }
  const nextProfiles = store.profiles
    .filter((item) => item.id !== normalized.id && item.endpoint !== normalized.endpoint);
  nextProfiles.unshift(normalized);
  const activeProfileId = options.active === true
    ? normalized.id
    : normalizeText(options.activeProfileId || store.activeProfileId, 96);
  const nextStore = normalizeStore({
    version: 1,
    activeProfileId,
    profiles: nextProfiles
  });
  writeControlPlaneProfileStore(nextStore, deps);
  return {
    store: nextStore,
    profile: nextStore.profiles.find((item) => item.id === normalized.id) || normalized
  };
}

function setActiveControlPlaneProfile(profileId, deps = {}) {
  const store = readControlPlaneProfileStore(deps);
  const id = normalizeText(profileId, 96);
  const activeProfileId = store.profiles.some((profile) => profile.id === id) ? id : '';
  const nextStore = normalizeStore({
    version: 1,
    activeProfileId,
    profiles: store.profiles
  });
  writeControlPlaneProfileStore(nextStore, deps);
  return nextStore;
}

function removeControlPlaneProfile(profileId, deps = {}) {
  const id = normalizeText(profileId, 96);
  const store = readControlPlaneProfileStore(deps);
  const nextProfiles = store.profiles.filter((profile) => profile.id !== id);
  const nextStore = normalizeStore({
    version: 1,
    activeProfileId: store.activeProfileId === id ? '' : store.activeProfileId,
    profiles: nextProfiles
  });
  writeControlPlaneProfileStore(nextStore, deps);
  return nextStore;
}

module.exports = {
  CONTROL_PLANE_PROFILES_FILE,
  getControlPlaneProfilesPath,
  listControlPlaneProfiles,
  saveControlPlaneProfile,
  setActiveControlPlaneProfile,
  removeControlPlaneProfile,
  normalizeProfile
};
