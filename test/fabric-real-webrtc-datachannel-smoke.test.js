'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPeerReport,
  buildReport,
  buildRoomReport,
  buildRtcIceServers,
  candidateKind,
  createBrowserLaunchOptions,
  normalizeIceServerList,
  normalizeIceTransportPolicy,
  parseArgs,
  sanitizeIceServerUrls,
  summarizeCandidateKinds,
  summarizeRtt
} = require('../scripts/fabric-real-webrtc-datachannel-smoke');

test('webrtc datachannel smoke parser defaults to AWS current and public STUN', () => {
  const options = parseArgs([
    '--sample-count',
    '7',
    '--timeout-ms',
    '45000',
    '--headed',
    '--diagnostics-file',
    '/tmp/aih-webrtc.json'
  ]);

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.pageUrl, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/fabric/webrtc-diagnostics');
  assert.deepEqual(options.iceServerUrls, ['stun:stun.l.google.com:19302']);
  assert.equal(options.iceTransportPolicy, 'all');
  assert.deepEqual(buildRtcIceServers(options.iceServerUrls), [
    { urls: 'stun:stun.l.google.com:19302' }
  ]);
  assert.equal(options.sampleCount, 7);
  assert.equal(options.rpcSampleCount, 3);
  assert.equal(options.timeoutMs, 45000);
  assert.equal(options.headed, true);
  assert.equal(options.browserChannel, 'chrome');
  assert.equal(options.diagnosticsFile, '/tmp/aih-webrtc.json');
  assert.equal(options.createRoomOnly, false);
  assert.equal(options.roomId, '');
  assert.equal(options.peerRole, '');
});

test('webrtc datachannel smoke parser supports explicit ICE servers and no-default gate', () => {
  const options = parseArgs([
    '--endpoint',
    'http://127.0.0.1:9527/',
    '--page-url',
    'http://127.0.0.1:9527/ui/fabric/webrtc-diagnostics',
    '--no-default-stun',
    '--ice-server',
    'stun:example.com:3478,turn:relay.example.com:3478',
    '--ice-username',
    'turn-user',
    '--ice-credential',
    'turn-secret',
    '--ice-transport-policy',
    'relay',
    '--rpc-sample-count',
    '4',
    '--browser-channel',
    'msedge'
  ]);

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.equal(options.browserChannel, 'msedge');
  assert.equal(options.iceUsername, 'turn-user');
  assert.equal(options.iceCredential, 'turn-secret');
  assert.equal(options.iceTransportPolicy, 'relay');
  assert.equal(options.rpcSampleCount, 4);
  assert.deepEqual(options.iceServerUrls, [
    'stun:example.com:3478',
    'turn:relay.example.com:3478'
  ]);
  assert.deepEqual(buildRtcIceServers(options.iceServerUrls, {
    username: options.iceUsername,
    credential: options.iceCredential
  }), [
    { urls: 'stun:example.com:3478' },
    { urls: 'turn:relay.example.com:3478', username: 'turn-user', credential: 'turn-secret' }
  ]);
});

test('webrtc datachannel smoke parser supports room-only and single-peer modes', () => {
  const roomOnly = parseArgs(['--create-room-only']);
  assert.equal(roomOnly.createRoomOnly, true);

  const peer = parseArgs([
    '--room-id',
    'rtc_room-1',
    '--peer-role',
    'answerer',
    '--peer-id',
    'aws-answerer-1',
    '--browser-channel',
    'bundled'
  ]);

  assert.equal(peer.roomId, 'rtc_room-1');
  assert.equal(peer.peerRole, 'answerer');
  assert.equal(peer.peerId, 'aws-answerer-1');
  assert.equal(peer.browserChannel, '');
  assert.deepEqual(createBrowserLaunchOptions(peer), { headless: true });

  assert.throws(() => parseArgs(['--peer-role', 'offerer']), /--room-id is required/);
  assert.throws(() => parseArgs(['--room-id', 'bad room', '--peer-role', 'offerer']), /--room-id must contain/);
  assert.throws(() => parseArgs(['--create-room-only', '--peer-role', 'answerer', '--room-id', 'rtc_1']), /cannot be combined/);
});

test('webrtc datachannel smoke parser rejects empty ICE set when default STUN is disabled', () => {
  assert.throws(() => parseArgs(['--no-default-stun']), /at least one --ice-server/);
  assert.throws(() => normalizeIceServerList(['http://bad.example.com']), /--ice-server must start/);
  assert.equal(normalizeIceTransportPolicy('relay'), 'relay');
  assert.throws(() => normalizeIceTransportPolicy('direct'), /must be all or relay/);
  assert.throws(() => parseArgs(['--ice-username', 'user']), /must be provided together/);
});

test('webrtc datachannel smoke summarizes RTT and candidate kinds', () => {
  assert.deepEqual(summarizeRtt([4.4, 2, 10, 5]), {
    count: 4,
    avg: 5.35,
    p50: 4.4,
    p95: 10,
    min: 2,
    max: 10
  });
  assert.equal(candidateKind('candidate:1 1 udp 1 host.local 123 typ host generation 0'), 'host');
  assert.equal(candidateKind('candidate:1 1 udp 1 1.2.3.4 123 typ srflx generation 0'), 'srflx');
  assert.equal(candidateKind('candidate:1 1 udp 1 relay.example 123 typ relay generation 0'), 'relay');
  assert.deepEqual(summarizeCandidateKinds([
    'candidate:1 1 udp 1 host.local 123 typ host generation 0',
    'candidate:2 1 udp 1 1.2.3.4 123 typ srflx generation 0',
    ''
  ]), { host: 1, srflx: 1 });
});

test('webrtc datachannel smoke redacts TURN URL credentials in reports', () => {
  assert.deepEqual(sanitizeIceServerUrls([
    'stun:stun.l.google.com:19302',
    'turn://user:secret@relay.example.com:3478'
  ]), [
    'stun:stun.l.google.com:19302',
    'turn://<redacted>@relay.example.com:3478'
  ]);
});

test('webrtc datachannel smoke report requires both peers open and enough RTT samples', () => {
  const options = {
    endpoint: 'http://control.example.com:9527',
    pageUrl: 'http://control.example.com:9527/ui/fabric/webrtc-diagnostics',
    iceServerUrls: ['stun:example.com:3478'],
    iceTransportPolicy: 'all',
    sampleCount: 3,
    rpcSampleCount: 2,
    timeoutMs: 30000
  };
  const report = buildReport(options, {
    room: { roomId: 'rtc_1' },
    browser: { engine: 'chromium' },
    offerer: {
      ok: true,
      channelOpened: true,
      rttSamples: [1, 2, 3],
      rpcResponses: 2,
      rpcRttSamples: [3, 4]
    },
    answerer: {
      ok: true,
      channelOpened: true,
      rpcRequestsHandled: 2
    },
    roomMessages: [
      { seq: 1, type: 'offer', peerId: 'peer-offer-1234' },
      { seq: 2, type: 'answer', peerId: 'peer-answer-1234' }
    ],
    console: { errors: 0, warnings: 0, pageErrors: [] }
  });

  assert.equal(report.ok, true);
  assert.equal(report.iceTransportPolicy, 'all');
  assert.equal(report.rtt.count, 3);
  assert.equal(report.rpc.ok, true);
  assert.equal(report.rpc.rtt.count, 2);
  assert.deepEqual(report.signaling.messages.map((item) => item.type), ['offer', 'answer']);
  assert.deepEqual(report.signaling.messages.map((item) => item.peerId), ['peer-<redacted>', 'peer-<redacted>']);

  const failed = buildReport(options, {
    room: { roomId: 'rtc_2' },
    offerer: { ok: true, channelOpened: true, rttSamples: [1] },
    answerer: { ok: true, channelOpened: true }
  });
  assert.equal(failed.ok, false);
});

test('webrtc datachannel single-peer and room reports expose reusable cross-machine evidence', () => {
  const options = {
    endpoint: 'http://control.example.com:9527',
    pageUrl: 'http://control.example.com:9527/ui/fabric/webrtc-diagnostics',
    iceServerUrls: ['stun:example.com:3478'],
    iceUsername: 'turn-user',
    iceCredential: 'turn-secret',
    iceTransportPolicy: 'relay',
    sampleCount: 2,
    rpcSampleCount: 2,
    timeoutMs: 30000,
    roomId: 'rtc_1',
    peerRole: 'offerer',
    peerId: 'peer-offer-1'
  };
  const roomReport = buildRoomReport(options, { roomId: 'rtc_1' });
  assert.equal(roomReport.ok, true);
  assert.equal(roomReport.mode, 'webrtc-signaling-room-create');

  const peerReport = buildPeerReport(options, {
    peer: {
      ok: true,
      role: 'offerer',
      peerId: 'peer-offer-1',
      channelOpened: true,
      rttSamples: [4, 6],
      rpcResponses: 2,
      rpcRttSamples: [5, 7]
    },
    roomMessages: [
      { seq: 1, type: 'offer', peerId: 'peer-offer-1' },
      { seq: 2, type: 'answer', peerId: 'aws-answerer-1' }
    ]
  });

  assert.equal(peerReport.ok, true);
  assert.equal(peerReport.mode, 'webrtc-datachannel-peer-smoke');
  assert.deepEqual(peerReport.iceServerAuth, { username: '<set>', credential: '<redacted>' });
  assert.equal(peerReport.iceTransportPolicy, 'relay');
  assert.equal(peerReport.rtt.count, 2);
  assert.equal(peerReport.rpc.ok, true);
  assert.equal(peerReport.rpc.responses, 2);
  assert.deepEqual(peerReport.signaling.messages.map((item) => item.peerId), [
    'peer-<redacted>',
    'aws-answerer-1'
  ]);

  const incomplete = buildPeerReport(options, {
    peer: {
      ok: true,
      role: 'offerer',
      peerId: 'peer-offer-1',
      channelOpened: true,
      rttSamples: [4]
    }
  });
  assert.equal(incomplete.ok, false);
});
