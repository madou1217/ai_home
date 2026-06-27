'use strict';

const crypto = require('node:crypto');

const DEFAULT_ROOM_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ROOMS = 200;
const DEFAULT_MAX_MESSAGES_PER_ROOM = 500;
const MAX_SIGNAL_PAYLOAD_BYTES = 256 * 1024;
const VALID_SIGNAL_TYPES = new Set(['offer', 'answer', 'candidate', 'ready', 'meta']);

function nowMs(options = {}) {
  return typeof options.now === 'function' ? Number(options.now()) : Date.now();
}

function normalizeText(value, maxLength = 160) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizePositiveInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function createRoomId() {
  return `rtc_${crypto.randomBytes(12).toString('base64url')}`;
}

function normalizeRoomId(value) {
  const text = normalizeText(value, 96);
  return /^rtc_[a-zA-Z0-9_-]{16,}$/.test(text) ? text : '';
}

function normalizePeerId(value) {
  const text = normalizeText(value, 96);
  return /^[a-zA-Z0-9._:-]{3,96}$/.test(text) ? text : '';
}

function normalizeSignalType(value) {
  const type = normalizeText(value, 32).toLowerCase();
  return VALID_SIGNAL_TYPES.has(type) ? type : '';
}

function measureJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value == null ? null : value), 'utf8');
  } catch (_error) {
    return MAX_SIGNAL_PAYLOAD_BYTES + 1;
  }
}

function toPublicRoom(room) {
  return {
    roomId: room.roomId,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
    messageCount: room.messages.length,
    peerCount: room.peers.size
  };
}

function createFabricWebrtcSignalingStore(options = {}) {
  const rooms = new Map();
  const roomTtlMs = normalizePositiveInteger(options.roomTtlMs, DEFAULT_ROOM_TTL_MS, 30 * 1000, 24 * 60 * 60 * 1000);
  const maxRooms = normalizePositiveInteger(options.maxRooms, DEFAULT_MAX_ROOMS, 1, 10000);
  const maxMessagesPerRoom = normalizePositiveInteger(options.maxMessagesPerRoom, DEFAULT_MAX_MESSAGES_PER_ROOM, 10, 10000);

  function purgeExpired(referenceTime = nowMs(options)) {
    for (const [roomId, room] of rooms.entries()) {
      if (room.expiresAt <= referenceTime) rooms.delete(roomId);
    }
    while (rooms.size > maxRooms) {
      const oldest = Array.from(rooms.values()).sort((left, right) => left.createdAt - right.createdAt)[0];
      if (!oldest) break;
      rooms.delete(oldest.roomId);
    }
  }

  function getActiveRoom(roomId, referenceTime = nowMs(options)) {
    purgeExpired(referenceTime);
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!normalizedRoomId) return null;
    const room = rooms.get(normalizedRoomId);
    if (!room || room.expiresAt <= referenceTime) {
      rooms.delete(normalizedRoomId);
      return null;
    }
    return room;
  }

  function createRoom(input = {}) {
    const createdAt = nowMs(options);
    purgeExpired(createdAt);
    const room = {
      roomId: createRoomId(),
      name: normalizeText(input.name, 120),
      createdAt,
      expiresAt: createdAt + roomTtlMs,
      nextSeq: 1,
      peers: new Set(),
      messages: []
    };
    rooms.set(room.roomId, room);
    purgeExpired(createdAt);
    return toPublicRoom(room);
  }

  function appendMessage(roomId, input = {}) {
    const room = getActiveRoom(roomId);
    if (!room) {
      const error = new Error('fabric_webrtc_room_not_found');
      error.code = 'fabric_webrtc_room_not_found';
      throw error;
    }
    const peerId = normalizePeerId(input.peerId);
    const type = normalizeSignalType(input.type);
    if (!peerId || !type) {
      const error = new Error('invalid_fabric_webrtc_signal');
      error.code = 'invalid_fabric_webrtc_signal';
      throw error;
    }
    const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
    if (measureJsonBytes(payload) > MAX_SIGNAL_PAYLOAD_BYTES) {
      const error = new Error('fabric_webrtc_signal_payload_too_large');
      error.code = 'fabric_webrtc_signal_payload_too_large';
      throw error;
    }
    room.peers.add(peerId);
    const message = {
      seq: room.nextSeq++,
      peerId,
      type,
      payload,
      createdAt: nowMs(options)
    };
    room.messages.push(message);
    if (room.messages.length > maxMessagesPerRoom) {
      room.messages.splice(0, room.messages.length - maxMessagesPerRoom);
    }
    return message;
  }

  function listMessages(roomId, input = {}) {
    const room = getActiveRoom(roomId);
    if (!room) {
      const error = new Error('fabric_webrtc_room_not_found');
      error.code = 'fabric_webrtc_room_not_found';
      throw error;
    }
    const since = normalizePositiveInteger(input.since, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = normalizePositiveInteger(input.limit, 100, 1, 500);
    const messages = room.messages.filter((message) => message.seq > since).slice(0, limit);
    return {
      room: toPublicRoom(room),
      messages,
      nextSeq: messages.length > 0 ? messages[messages.length - 1].seq : since
    };
  }

  return {
    createRoom,
    appendMessage,
    listMessages,
    purgeExpired
  };
}

module.exports = {
  createFabricWebrtcSignalingStore
};
