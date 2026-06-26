'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { normalizeId } = require('./remote/node-registry');

const CONTROL_PLANE_DEVICES_FILE = 'control-plane-devices.json';
const CONTROL_PLANE_DEVICE_SECRETS_FILE = 'control-plane-device-secrets.json';
const DEFAULT_DEVICE_INVITE_TTL_MS = 10 * 60 * 1000;
const MAX_DEVICE_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEVICE_SCOPES = Object.freeze([
  'control-plane:read',
  'nodes:read',
  'status:read',
  'accounts:read',
  'usage:read',
  'sessions:read',
  'sessions:write'
]);

function nowMs() {
  return Date.now();
}

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeStringList(value, fallback = []) {
  const input = Array.isArray(value) ? value : fallback;
  return Array.from(new Set(input
    .map((item) => normalizeText(item, 96))
    .filter(Boolean)));
}

function normalizeDeviceState(value) {
  const state = normalizeText(value, 32).toLowerCase();
  return state === 'revoked' ? 'revoked' : 'paired';
}

function randomToken(byteLength = 24) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function hashSecret(value) {
  const text = normalizeText(value, 4096);
  return text ? crypto.createHash('sha256').update(text).digest('hex') : '';
}

function getControlPlaneDevicesPath(aiHomeDir) {
  const root = normalizeText(aiHomeDir, 2048);
  return root ? path.join(root, CONTROL_PLANE_DEVICES_FILE) : '';
}

function getControlPlaneDeviceSecretsPath(aiHomeDir) {
  const root = normalizeText(aiHomeDir, 2048);
  return root ? path.join(root, CONTROL_PLANE_DEVICE_SECRETS_FILE) : '';
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
  if (typeof deps.fs.mkdirSync === 'function') deps.fs.mkdirSync(path.dirname(filePath), { recursive: true });
  deps.fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    if (typeof deps.fs.chmodSync === 'function') deps.fs.chmodSync(filePath, 0o600);
  } catch (_error) {}
}

function normalizeDeviceStore(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: 1,
    devices: Array.isArray(source.devices) ? source.devices : [],
    invites: Array.isArray(source.invites) ? source.invites : []
  };
}

function normalizeSecretStore(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: 1,
    inviteCodeHashes: source.inviteCodeHashes && typeof source.inviteCodeHashes === 'object' ? source.inviteCodeHashes : {},
    deviceTokenHashes: source.deviceTokenHashes && typeof source.deviceTokenHashes === 'object' ? source.deviceTokenHashes : {}
  };
}

function readDeviceStore(deps = {}) {
  return normalizeDeviceStore(readJsonFile(getControlPlaneDevicesPath(deps.aiHomeDir), { version: 1, devices: [], invites: [] }, deps));
}

function writeDeviceStore(store, deps = {}) {
  writeJsonFile(getControlPlaneDevicesPath(deps.aiHomeDir), normalizeDeviceStore(store), deps);
}

function readDeviceSecretStore(deps = {}) {
  return normalizeSecretStore(readJsonFile(
    getControlPlaneDeviceSecretsPath(deps.aiHomeDir),
    { version: 1, inviteCodeHashes: {}, deviceTokenHashes: {} },
    deps
  ));
}

function writeDeviceSecretStore(store, deps = {}) {
  writeJsonFile(getControlPlaneDeviceSecretsPath(deps.aiHomeDir), normalizeSecretStore(store), deps);
}

function resolveInviteTtlMs(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_DEVICE_INVITE_TTL_MS;
  return Math.min(MAX_DEVICE_INVITE_TTL_MS, Math.max(60 * 1000, Math.floor(ttl)));
}

function normalizeControlEndpoint(value) {
  const endpoint = normalizeText(value, 2048).replace(/\/+$/, '');
  if (!endpoint) return '';
  try {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function sanitizeDeviceInvite(input = {}, previous = null) {
  const source = input && typeof input === 'object' ? input : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const createdAt = Number(prior.createdAt || source.createdAt || nowMs()) || nowMs();
  const id = normalizeId(source.id || prior.id || `device-invite-${randomToken(8).toLowerCase()}`);
  if (!id) {
    const error = new Error('invalid_device_invite_id');
    error.code = 'invalid_device_invite_id';
    throw error;
  }
  return {
    id,
    name: normalizeText(source.name || prior.name, 120),
    controlEndpoint: normalizeControlEndpoint(source.controlEndpoint || prior.controlEndpoint),
    scopes: normalizeStringList(source.scopes, prior.scopes || DEFAULT_DEVICE_SCOPES),
    createdAt,
    expiresAt: Number(source.expiresAt || prior.expiresAt || (createdAt + resolveInviteTtlMs(source.expiresInMs))) || 0,
    consumedAt: Number(source.consumedAt || prior.consumedAt || 0) || 0,
    deviceId: normalizeId(source.deviceId || prior.deviceId)
  };
}

function sanitizeDevice(input = {}, previous = null) {
  const source = input && typeof input === 'object' ? input : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const id = normalizeId(source.id || prior.id || `device-${randomToken(8).toLowerCase()}`);
  if (!id) {
    const error = new Error('invalid_device_id');
    error.code = 'invalid_device_id';
    throw error;
  }
  const createdAt = Number(prior.createdAt || source.createdAt || nowMs()) || nowMs();
  return {
    id,
    name: normalizeText(source.name || prior.name || id, 120),
    platform: normalizeText(source.platform || prior.platform, 64),
    publicKeyFingerprint: normalizeText(source.publicKeyFingerprint || prior.publicKeyFingerprint, 160),
    scopes: normalizeStringList(source.scopes, prior.scopes || DEFAULT_DEVICE_SCOPES),
    state: normalizeDeviceState(source.state || prior.state || 'paired'),
    pairedAt: Number(source.pairedAt || prior.pairedAt || nowMs()) || 0,
    revokedAt: Number(source.revokedAt || prior.revokedAt || 0) || 0,
    lastSeenAt: Number(source.lastSeenAt || prior.lastSeenAt || 0) || 0,
    createdAt,
    updatedAt: Number(source.updatedAt || nowMs()) || nowMs()
  };
}

function buildDevicePairUrl(invite, code) {
  const endpoint = normalizeControlEndpoint(invite && invite.controlEndpoint);
  if (!endpoint) return '';
  const url = new URL('/v0/node-rpc/device-pair', endpoint);
  url.searchParams.set('code', code);
  return url.toString();
}

function buildDeviceWebPairUrl(invite, code) {
  const endpoint = normalizeControlEndpoint(invite && invite.controlEndpoint);
  if (!endpoint) return '';
  const pairUrl = buildDevicePairUrl(invite, code);
  const parsed = new URL(endpoint);
  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${basePath}/ui/settings`;
  parsed.search = '';
  parsed.hash = '';
  parsed.searchParams.set('pair', pairUrl);
  return parsed.toString();
}

function createControlPlaneDeviceInvite(input = {}, deps = {}) {
  const code = randomToken(24);
  const invite = sanitizeDeviceInvite({
    ...input,
    createdAt: nowMs()
  });
  const store = readDeviceStore(deps);
  store.invites = store.invites
    .filter((entry) => normalizeId(entry && entry.id) !== invite.id)
    .concat(invite)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  writeDeviceStore(store, deps);

  const secretStore = readDeviceSecretStore(deps);
  secretStore.inviteCodeHashes[invite.id] = hashSecret(code);
  writeDeviceSecretStore(secretStore, deps);

  return {
    invite,
    code,
    pairUrl: buildDevicePairUrl(invite, code),
    webPairUrl: buildDeviceWebPairUrl(invite, code)
  };
}

function listControlPlaneDeviceInvites(deps = {}) {
  return readDeviceStore(deps).invites.map((invite) => sanitizeDeviceInvite(invite, invite));
}

function listControlPlaneDevices(deps = {}) {
  return readDeviceStore(deps).devices.map((device) => sanitizeDevice(device, device));
}

function findInviteByCode(code, deps = {}) {
  const codeHash = hashSecret(code);
  if (!codeHash) return null;
  const store = readDeviceStore(deps);
  const secretStore = readDeviceSecretStore(deps);
  const invite = store.invites.find((entry) => {
    const id = normalizeId(entry && entry.id);
    return id && normalizeText(secretStore.inviteCodeHashes[id], 128) === codeHash;
  });
  return invite ? sanitizeDeviceInvite(invite, invite) : null;
}

function assertInviteUsable(invite) {
  if (!invite) {
    const error = new Error('device_invite_not_found');
    error.code = 'device_invite_not_found';
    throw error;
  }
  if (invite.consumedAt) {
    const error = new Error('device_invite_already_consumed');
    error.code = 'device_invite_already_consumed';
    throw error;
  }
  if (invite.expiresAt && invite.expiresAt <= nowMs()) {
    const error = new Error('device_invite_expired');
    error.code = 'device_invite_expired';
    throw error;
  }
}

function publicKeyFingerprint(publicKey) {
  const digest = hashSecret(publicKey);
  return digest ? `sha256:${digest}` : '';
}

function consumeControlPlaneDeviceInvite(input = {}, deps = {}) {
  const invite = findInviteByCode(input.code, deps);
  assertInviteUsable(invite);
  const payload = input.device && typeof input.device === 'object' ? input.device : input;
  const token = randomToken(32);
  const device = sanitizeDevice({
    id: payload.id,
    name: payload.name || invite.name,
    platform: payload.platform,
    publicKeyFingerprint: publicKeyFingerprint(payload.publicKey || payload.devicePublicKey),
    scopes: invite.scopes,
    state: 'paired',
    pairedAt: nowMs(),
    createdAt: nowMs(),
    updatedAt: nowMs()
  });

  const store = readDeviceStore(deps);
  store.devices = store.devices
    .filter((entry) => normalizeId(entry && entry.id) !== device.id)
    .concat(device)
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  store.invites = store.invites.map((entry) => {
    if (normalizeId(entry && entry.id) !== invite.id) return entry;
    return sanitizeDeviceInvite({
      ...entry,
      consumedAt: nowMs(),
      deviceId: device.id
    }, entry);
  });
  writeDeviceStore(store, deps);

  const secretStore = readDeviceSecretStore(deps);
  secretStore.deviceTokenHashes[device.id] = hashSecret(token);
  writeDeviceSecretStore(secretStore, deps);

  return {
    device,
    token
  };
}

function findControlPlaneDeviceByToken(token, deps = {}) {
  const tokenHash = hashSecret(token);
  if (!tokenHash) return null;
  const secretStore = readDeviceSecretStore(deps);
  const deviceId = Object.keys(secretStore.deviceTokenHashes).find((id) => {
    return normalizeText(secretStore.deviceTokenHashes[id], 128) === tokenHash;
  });
  if (!deviceId) return null;
  const device = listControlPlaneDevices(deps).find((entry) => entry.id === normalizeId(deviceId));
  return device && device.state !== 'revoked' ? device : null;
}

function authorizeControlPlaneDeviceToken(token, requiredScope, deps = {}) {
  const device = findControlPlaneDeviceByToken(token, deps);
  if (!device) {
    return {
      ok: false,
      statusCode: 401,
      error: 'unauthorized_control_plane_device'
    };
  }
  const scope = normalizeText(requiredScope, 96);
  if (scope && !device.scopes.includes(scope)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'forbidden_control_plane_device_scope',
      device
    };
  }
  return {
    ok: true,
    device
  };
}

function revokeControlPlaneDevice(deviceId, deps = {}) {
  const id = normalizeId(deviceId);
  if (!id) {
    const error = new Error('invalid_device_id');
    error.code = 'invalid_device_id';
    throw error;
  }
  const store = readDeviceStore(deps);
  let revoked = null;
  store.devices = store.devices.map((entry) => {
    if (normalizeId(entry && entry.id) !== id) return entry;
    revoked = sanitizeDevice({
      ...entry,
      state: 'revoked',
      revokedAt: nowMs(),
      updatedAt: nowMs()
    }, entry);
    return revoked;
  });
  if (!revoked) {
    const error = new Error('device_not_found');
    error.code = 'device_not_found';
    throw error;
  }
  writeDeviceStore(store, deps);
  const secretStore = readDeviceSecretStore(deps);
  delete secretStore.deviceTokenHashes[id];
  writeDeviceSecretStore(secretStore, deps);
  return revoked;
}

module.exports = {
  CONTROL_PLANE_DEVICES_FILE,
  CONTROL_PLANE_DEVICE_SECRETS_FILE,
  DEFAULT_DEVICE_SCOPES,
  getControlPlaneDevicesPath,
  getControlPlaneDeviceSecretsPath,
  createControlPlaneDeviceInvite,
  consumeControlPlaneDeviceInvite,
  authorizeControlPlaneDeviceToken,
  findControlPlaneDeviceByToken,
  listControlPlaneDevices,
  listControlPlaneDeviceInvites,
  revokeControlPlaneDevice,
  hashSecret
};
