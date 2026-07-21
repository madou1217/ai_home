const test = require('node:test');
const assert = require('node:assert/strict');

const { createFabricWebrtcSignalingStore } = require('../lib/server/fabric-webrtc-signaling');

test('fabric webrtc signaling store creates short-lived rooms and exchanges messages by seq', () => {
  let now = 1000;
  const store = createFabricWebrtcSignalingStore({
    now: () => now,
    roomTtlMs: 60000,
    maxMessagesPerRoom: 10
  });

  const room = store.createRoom({ name: 'Local WebRTC Lab' });
  assert.match(room.roomId, /^rtc_/);
  assert.equal(room.createdAt, 1000);
  assert.equal(room.expiresAt, 61000);

  const offer = store.appendMessage(room.roomId, {
    peerId: 'peer-a',
    type: 'offer',
    payload: { type: 'offer', sdp: 'v=0' }
  });
  const answer = store.appendMessage(room.roomId, {
    peerId: 'peer-b',
    type: 'answer',
    payload: { type: 'answer', sdp: 'v=0' }
  });

  assert.equal(offer.seq, 1);
  assert.equal(answer.seq, 2);
  assert.deepEqual(
    store.listMessages(room.roomId, { since: 1 }).messages.map((message) => message.type),
    ['answer']
  );
  assert.equal(store.listMessages(room.roomId).room.peerCount, 2);

  now = 62000;
  assert.throws(
    () => store.listMessages(room.roomId),
    /fabric_webrtc_room_not_found/
  );
});

test('fabric webrtc signaling store rejects invalid peers types and oversized payloads', () => {
  const store = createFabricWebrtcSignalingStore();
  const room = store.createRoom();

  assert.throws(
    () => store.appendMessage(room.roomId, { peerId: 'x', type: 'offer', payload: {} }),
    /invalid_fabric_webrtc_signal/
  );
  assert.throws(
    () => store.appendMessage(room.roomId, { peerId: 'peer-a', type: 'unknown', payload: {} }),
    /invalid_fabric_webrtc_signal/
  );
  assert.throws(
    () => store.appendMessage(room.roomId, {
      peerId: 'peer-a',
      type: 'candidate',
      payload: { blob: 'x'.repeat(260 * 1024) }
    }),
    /fabric_webrtc_signal_payload_too_large/
  );
});
