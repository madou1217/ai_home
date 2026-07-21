'use strict';

const crypto = require('node:crypto');
const { normalizeFabricServerId } = require('./fabric-server-id');

const SENSITIVE_DESCRIPTOR_KEY = /(authorization|credential|management.?key|password|secret|token)/i;
const PUBLIC_ROUTE_KEYS = new Set([
  'endpoint',
  'id',
  'kind',
  'path',
  'priority',
  'transport',
  'via'
]);

function defaultSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function sanitizePublicValue(value, depth = 0) {
  if (depth > 5 || value === null) return value === null ? null : undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2048);
  if (Array.isArray(value)) {
    return value.slice(0, 64)
      .map((item) => sanitizePublicValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  Object.entries(value).slice(0, 64).forEach(([key, item]) => {
    if (SENSITIVE_DESCRIPTOR_KEY.test(key)) return;
    const sanitized = sanitizePublicValue(item, depth + 1);
    if (sanitized !== undefined) out[String(key).slice(0, 128)] = sanitized;
  });
  return out;
}

function sanitizeRouteEndpoint(value) {
  const raw = String(value || '').trim().slice(0, 2048);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_error) {
    return raw.split(/[?#]/, 1)[0];
  }
}

function sanitizeBrokerRoute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = {};
  Object.entries(value).forEach(([key, item]) => {
    if (!PUBLIC_ROUTE_KEYS.has(key) || SENSITIVE_DESCRIPTOR_KEY.test(key)) return;
    const sanitized = key === 'endpoint'
      ? sanitizeRouteEndpoint(item)
      : sanitizePublicValue(item, 1);
    if (sanitized !== undefined && sanitized !== '') route[key] = sanitized;
  });
  return Object.keys(route).length > 0 ? route : null;
}

function normalizeBrokerServerDescriptor(serverId, input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const capabilities = sanitizePublicValue(source.capabilities, 0);
  return {
    stableServerId: serverId,
    name: String(source.name || serverId).trim().slice(0, 128) || serverId,
    capabilities: capabilities && typeof capabilities === 'object' ? capabilities : {},
    routes: (Array.isArray(source.routes) ? source.routes : [])
      .slice(0, 16)
      .map(sanitizeBrokerRoute)
      .filter(Boolean)
  };
}

function serializeBrokerSession(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    serverId: session.serverId,
    remoteAddress: session.remoteAddress,
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt
  };
}

function normalizeDisconnectReason(value, fallback = 'broker_session_removed') {
  return String(value || fallback).trim().slice(0, 128) || fallback;
}

function serializeBrokerDisconnection(session, input = {}) {
  const serialized = serializeBrokerSession(session);
  if (!serialized) return null;
  return {
    ...serialized,
    disconnectedAt: input.disconnectedAt,
    disconnectReason: normalizeDisconnectReason(input.reason),
    closeCode: Number(input.closeCode) || 0,
    closeReason: String(input.closeReason || '').trim().slice(0, 256)
  };
}

function isBrokerSessionOnline(session) {
  if (!session) return false;
  if (!session.socket || session.socket.readyState === undefined) return true;
  return session.socket.readyState === 1;
}

function createFabricBrokerSessionRegistry(options = {}) {
  const sessionsById = new Map();
  const sessionsByServer = new Map();
  const lastDisconnectedByServer = new Map();
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now;
  const createSessionId = typeof options.createSessionId === 'function'
    ? options.createSessionId
    : defaultSessionId;

  function removeBrokerSession(sessionId, removeOptions = {}) {
    const id = String(sessionId || '').trim();
    const session = sessionsById.get(id);
    if (!session) return null;
    sessionsById.delete(id);
    if (sessionsByServer.get(session.serverId) === session) {
      sessionsByServer.delete(session.serverId);
    }
    const disconnected = serializeBrokerDisconnection(session, {
      disconnectedAt: nowMs(),
      reason: removeOptions.reason,
      closeCode: removeOptions.closeCode,
      closeReason: removeOptions.closeReason
    });
    if (disconnected) lastDisconnectedByServer.set(session.serverId, disconnected);
    if (removeOptions.closeSocket && session.socket && typeof session.socket.close === 'function') {
      try {
        session.socket.close(4000, 'broker_session_replaced');
      } catch (_error) {}
    }
    return serializeBrokerSession(session);
  }

  function registerBrokerSession(input = {}) {
    const serverId = normalizeFabricServerId(input.serverId);
    if (!serverId) {
      const error = new Error('invalid_broker_server_id');
      error.code = 'invalid_broker_server_id';
      throw error;
    }
    const sessionId = String(input.sessionId || createSessionId()).trim();
    if (!sessionId) {
      const error = new Error('invalid_broker_session_id');
      error.code = 'invalid_broker_session_id';
      throw error;
    }
    const previous = sessionsByServer.get(serverId);
    if (previous) {
      removeBrokerSession(previous.sessionId, {
        closeSocket: true,
        reason: 'broker_session_replaced',
        closeCode: 4000,
        closeReason: 'broker_session_replaced'
      });
    }

    const now = nowMs();
    const session = {
      sessionId,
      serverId,
      socket: input.socket || null,
      remoteAddress: String(input.remoteAddress || '').trim(),
      connectedAt: now,
      lastSeenAt: now,
      descriptor: normalizeBrokerServerDescriptor(serverId, input.descriptor)
    };
    sessionsById.set(session.sessionId, session);
    sessionsByServer.set(serverId, session);
    lastDisconnectedByServer.delete(serverId);
    return session;
  }

  function touchBrokerSession(sessionId) {
    const session = sessionsById.get(String(sessionId || '').trim());
    if (!session) return null;
    session.lastSeenAt = nowMs();
    return serializeBrokerSession(session);
  }

  function updateBrokerSessionDescriptor(sessionId, descriptor = {}) {
    const session = sessionsById.get(String(sessionId || '').trim());
    if (!session) return null;
    session.descriptor = normalizeBrokerServerDescriptor(session.serverId, descriptor);
    session.lastSeenAt = nowMs();
    return {
      ...session.descriptor,
      online: isBrokerSessionOnline(session),
      connectedAt: session.connectedAt,
      lastSeenAt: session.lastSeenAt
    };
  }

  function getBrokerSession(serverId) {
    return sessionsByServer.get(normalizeFabricServerId(serverId)) || null;
  }

  function getBrokerServerStatus(serverId) {
    const id = normalizeFabricServerId(serverId);
    const session = sessionsByServer.get(id) || null;
    return {
      serverId: id,
      online: isBrokerSessionOnline(session),
      session: serializeBrokerSession(session),
      lastDisconnected: lastDisconnectedByServer.get(id) || null
    };
  }

  function listBrokerSessions() {
    return Array.from(sessionsById.values()).map(serializeBrokerSession);
  }

  function listBrokerServers() {
    return Array.from(sessionsByServer.values())
      .filter(isBrokerSessionOnline)
      .map((session) => ({
        ...normalizeBrokerServerDescriptor(session.serverId, session.descriptor),
        online: true,
        connectedAt: session.connectedAt,
        lastSeenAt: session.lastSeenAt
      }));
  }

  function closeAll() {
    Array.from(sessionsById.keys()).forEach((sessionId) => {
      removeBrokerSession(sessionId, { closeSocket: true });
    });
  }

  return {
    registerBrokerSession,
    touchBrokerSession,
    getBrokerSession,
    getBrokerServerStatus,
    listBrokerServers,
    listBrokerSessions,
    removeBrokerSession,
    updateBrokerSessionDescriptor,
    closeAll
  };
}

module.exports = {
  createFabricBrokerSessionRegistry,
  normalizeBrokerServerDescriptor,
  normalizeFabricServerId,
  serializeBrokerDisconnection,
  serializeBrokerSession
};
