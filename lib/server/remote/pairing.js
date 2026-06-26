'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { normalizeId, DEFAULT_NODE_CAPABILITIES, DEFAULT_TRANSPORT_PREFERENCE } = require('./node-registry');
const {
  normalizeEndpoint,
  normalizeTransportKind
} = require('./transport-registry');
const {
  DEFAULT_REMOTE_TRANSPORT_KIND,
  resolveTransportProvider,
  resolveTransportRouteRole,
  resolveTransportTrustLevel
} = require('./node-defaults');

const REMOTE_INVITES_FILE = 'remote-node-invites.json';
const DEFAULT_INVITE_TTL_MS = 15 * 60 * 1000;
const MAX_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function getRemoteInvitesPath(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  return root ? path.join(root, REMOTE_INVITES_FILE) : '';
}

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeStringList(value, fallback = []) {
  const input = Array.isArray(value) ? value : fallback;
  return Array.from(new Set(input
    .map((item) => normalizeText(item, 64))
    .filter(Boolean)));
}

function randomToken(byteLength = 18) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function hashInviteCode(code) {
  const value = normalizeText(code, 256);
  return value ? crypto.createHash('sha256').update(value).digest('hex') : '';
}

function readInviteStore(deps = {}) {
  const filePath = getRemoteInvitesPath(deps.aiHomeDir);
  try {
    if (!filePath || !deps.fs || !deps.fs.existsSync(filePath)) return { version: 1, invites: [] };
    const parsed = JSON.parse(deps.fs.readFileSync(filePath, 'utf8'));
    return {
      version: 1,
      invites: Array.isArray(parsed && parsed.invites) ? parsed.invites : []
    };
  } catch (_error) {
    return { version: 1, invites: [] };
  }
}

function writeInviteStore(store, deps = {}) {
  const filePath = getRemoteInvitesPath(deps.aiHomeDir);
  if (!filePath || !deps.fs) return;
  const payload = {
    version: 1,
    invites: Array.isArray(store && store.invites) ? store.invites : []
  };
  if (typeof deps.fs.mkdirSync === 'function') {
    deps.fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  deps.fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  try {
    if (typeof deps.fs.chmodSync === 'function') deps.fs.chmodSync(filePath, 0o600);
  } catch (_error) {}
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

function resolveInviteTtlMs(value) {
  const ttl = Number(value);
  if (!Number.isFinite(ttl) || ttl <= 0) return DEFAULT_INVITE_TTL_MS;
  return Math.min(MAX_INVITE_TTL_MS, Math.max(60 * 1000, Math.floor(ttl)));
}

function sanitizeInvite(input = {}, previous = null) {
  const source = input && typeof input === 'object' ? input : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const createdAt = Number(prior.createdAt || source.createdAt || nowMs()) || nowMs();
  const id = normalizeId(source.id || prior.id || `invite-${randomToken(8).toLowerCase()}`);
  if (!id) {
    const error = new Error('invalid_invite_id');
    error.code = 'invalid_invite_id';
    throw error;
  }
  const expiresAt = Number(source.expiresAt || prior.expiresAt || (createdAt + resolveInviteTtlMs(source.expiresInMs))) || 0;
  const transportKind = normalizeTransportKind(source.transportKind || prior.transportKind || DEFAULT_REMOTE_TRANSPORT_KIND)
    || DEFAULT_REMOTE_TRANSPORT_KIND;
  return {
    id,
    codeHash: normalizeText(source.codeHash || prior.codeHash, 128),
    nodeId: normalizeId(source.nodeId || prior.nodeId),
    name: normalizeText(source.name || prior.name, 120),
    role: normalizeText(source.role || prior.role || 'worker', 64),
    controlEndpoint: normalizeControlEndpoint(source.controlEndpoint || prior.controlEndpoint),
    endpointHint: normalizeEndpoint(source.endpointHint || prior.endpointHint),
    transportKind,
    provider: normalizeText(source.provider || prior.provider || resolveTransportProvider(transportKind), 64),
    routeRole: resolveTransportRouteRole(transportKind, source.routeRole || prior.routeRole),
    trustLevel: resolveTransportTrustLevel(transportKind, source.trustLevel || prior.trustLevel),
    setupHint: normalizeText(source.setupHint || prior.setupHint, 512),
    preferredTransports: normalizeStringList(
      source.preferredTransports,
      prior.preferredTransports || DEFAULT_TRANSPORT_PREFERENCE
    ),
    capabilities: normalizeStringList(
      source.capabilities,
      prior.capabilities || DEFAULT_NODE_CAPABILITIES
    ),
    tags: normalizeStringList(source.tags, prior.tags || []),
    createdAt,
    expiresAt,
    consumedAt: Number(source.consumedAt || prior.consumedAt || 0) || 0
  };
}

function serializeInvite(invite) {
  const item = sanitizeInvite(invite, invite);
  const { codeHash, ...safeInvite } = item;
  return safeInvite;
}

function buildJoinUrl(invite, code) {
  const endpoint = normalizeControlEndpoint(invite && invite.controlEndpoint);
  if (!endpoint) return '';
  const url = new URL('/v0/node-rpc/join', endpoint);
  url.searchParams.set('code', code);
  return url.toString();
}

function createRemoteNodeInvite(input = {}, deps = {}) {
  const code = randomToken(24);
  const invite = sanitizeInvite({
    ...input,
    codeHash: hashInviteCode(code),
    createdAt: nowMs()
  });
  const store = readInviteStore(deps);
  store.invites = store.invites
    .filter((entry) => normalizeId(entry && entry.id) !== invite.id)
    .concat(invite)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  writeInviteStore(store, deps);
  const safeInvite = serializeInvite(invite);
  return {
    invite: safeInvite,
    code,
    joinUrl: buildJoinUrl(invite, code)
  };
}

function listRemoteNodeInvites(deps = {}) {
  return readInviteStore(deps).invites.map(serializeInvite);
}

function findInviteByCode(code, deps = {}) {
  const codeHash = hashInviteCode(code);
  if (!codeHash) return null;
  const invite = readInviteStore(deps).invites.find((entry) => {
    return normalizeText(entry && entry.codeHash, 128) === codeHash;
  });
  return invite ? sanitizeInvite(invite, invite) : null;
}

function assertInviteUsable(invite) {
  if (!invite) {
    const error = new Error('invite_not_found');
    error.code = 'invite_not_found';
    throw error;
  }
  if (invite.consumedAt) {
    const error = new Error('invite_already_consumed');
    error.code = 'invite_already_consumed';
    throw error;
  }
  if (invite.expiresAt && invite.expiresAt <= nowMs()) {
    const error = new Error('invite_expired');
    error.code = 'invite_expired';
    throw error;
  }
}

function markInviteConsumed(inviteId, deps = {}) {
  const id = normalizeId(inviteId);
  const store = readInviteStore(deps);
  let updated = null;
  store.invites = store.invites.map((entry) => {
    if (normalizeId(entry && entry.id) !== id) return entry;
    updated = sanitizeInvite({ ...entry, consumedAt: nowMs() }, entry);
    return updated;
  });
  writeInviteStore(store, deps);
  return updated ? serializeInvite(updated) : null;
}

module.exports = {
  REMOTE_INVITES_FILE,
  DEFAULT_INVITE_TTL_MS,
  MAX_INVITE_TTL_MS,
  getRemoteInvitesPath,
  hashInviteCode,
  sanitizeInvite,
  serializeInvite,
  createRemoteNodeInvite,
  listRemoteNodeInvites,
  findInviteByCode,
  assertInviteUsable,
  markInviteConsumed
};
