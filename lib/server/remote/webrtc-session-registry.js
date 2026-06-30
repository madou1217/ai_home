'use strict';

const crypto = require('node:crypto');
const { normalizeId } = require('./node-registry');

function defaultSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function closeQuietly(target) {
  if (!target || typeof target.close !== 'function') return;
  try {
    target.close();
  } catch (_error) {}
}

function serializeSession(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    nodeId: session.nodeId,
    transportId: session.transportId,
    remoteAddress: session.remoteAddress,
    connectedAt: session.connectedAt,
    lastSeenAt: session.lastSeenAt,
    channelState: String(session.channel && session.channel.readyState || '')
  };
}

function isWebrtcChannelOpen(channel) {
  return Boolean(channel && String(channel.readyState || '').toLowerCase() === 'open');
}

function createWebrtcSessionRegistry(options = {}) {
  const sessionsById = new Map();
  const sessionsByNode = new Map();
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now;
  const createSessionId = typeof options.createSessionId === 'function'
    ? options.createSessionId
    : defaultSessionId;

  function removeWebrtcSession(sessionId, removeOptions = {}) {
    const id = String(sessionId || '').trim();
    const session = sessionsById.get(id);
    if (!session) return null;
    sessionsById.delete(id);
    if (sessionsByNode.get(session.nodeId) === session) {
      sessionsByNode.delete(session.nodeId);
    }
    if (removeOptions.closeChannel) closeQuietly(session.channel);
    if (removeOptions.closePeerConnection) closeQuietly(session.peerConnection);
    return serializeSession(session);
  }

  function registerWebrtcSession(input = {}) {
    const nodeId = normalizeId(input.nodeId);
    if (!nodeId) {
      const error = new Error('invalid_webrtc_node_id');
      error.code = 'invalid_webrtc_node_id';
      throw error;
    }
    const sessionId = String(input.sessionId || createSessionId()).trim();
    if (!sessionId) {
      const error = new Error('invalid_webrtc_session_id');
      error.code = 'invalid_webrtc_session_id';
      throw error;
    }
    const previous = sessionsByNode.get(nodeId);
    if (previous) {
      removeWebrtcSession(previous.sessionId, {
        closeChannel: true,
        closePeerConnection: true
      });
    }

    const now = nowMs();
    const session = {
      sessionId,
      nodeId,
      transportId: String(input.transportId || `${nodeId}-webrtc`).trim(),
      peerConnection: input.peerConnection || null,
      channel: input.channel || null,
      remoteAddress: String(input.remoteAddress || '').trim(),
      connectedAt: now,
      lastSeenAt: now
    };
    sessionsById.set(session.sessionId, session);
    sessionsByNode.set(nodeId, session);
    return session;
  }

  function touchWebrtcSession(sessionId) {
    const session = sessionsById.get(String(sessionId || '').trim());
    if (!session) return null;
    session.lastSeenAt = nowMs();
    return serializeSession(session);
  }

  function getWebrtcSession(nodeId) {
    return sessionsByNode.get(normalizeId(nodeId)) || null;
  }

  function hasOpenWebrtcSession(nodeId) {
    const session = getWebrtcSession(nodeId);
    return Boolean(session && isWebrtcChannelOpen(session.channel));
  }

  function listWebrtcSessions() {
    return Array.from(sessionsById.values()).map(serializeSession);
  }

  function closeAll() {
    Array.from(sessionsById.keys()).forEach((sessionId) => {
      removeWebrtcSession(sessionId, {
        closeChannel: true,
        closePeerConnection: true
      });
    });
  }

  return {
    registerWebrtcSession,
    touchWebrtcSession,
    getWebrtcSession,
    hasOpenWebrtcSession,
    listWebrtcSessions,
    removeWebrtcSession,
    closeAll
  };
}

module.exports = {
  createWebrtcSessionRegistry,
  isWebrtcChannelOpen,
  serializeSession
};
