'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  buildHttpsUrlFromEndpoint,
  buildPromotionTransport,
  buildRemotePromotionPublishCommand,
  buildWebSocketUrlFromEndpoint,
  buildSummary,
  classifyMultipath,
  classifyRelayBaseline,
  classifyTurnRelay,
  classifyWebTransport,
  classifyWebrtcDirect,
  formatReport,
  parseArgs,
  publishPromotionToRegistry,
  runPromotionGate
} = require('../scripts/fabric-m6-promotion-gate');

function createFakeSpawn(result = {}, calls = []) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
      if (result.error) child.emit('error', result.error);
      else child.emit('close', result.status === undefined ? 0 : result.status, result.signal || null);
    });
    return child;
  };
}

test('M6 promotion gate parser defaults to AWS current without TURN credentials', () => {
  const options = parseArgs(['--diagnostics-dir', '/tmp/aih-m6-gate', '--json']);

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(options.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.port, 9527);
  assert.equal(options.sampleCount, 5);
  assert.equal(options.rpcSampleCount, 3);
  assert.equal(options.relayCount, 20);
  assert.equal(options.relayPayloadSize, 64);
  assert.equal(options.timeoutMs, 30000);
  assert.equal(options.browserChannel, 'chrome');
  assert.equal(options.allowDirectWebrtcPromotion, false);
  assert.equal(options.directWebrtcMaxP95Ms, 1500);
  assert.equal(options.publishPromotion, false);
  assert.equal(options.promotionTtlMs, 86400000);
  assert.deepEqual(options.turnIceServers, []);
  assert.equal(options.skipTurnUdpProbe, false);
  assert.equal(options.diagnosticsDir, '/tmp/aih-m6-gate');
  assert.equal(options.json, true);
});

test('M6 promotion gate parser supports registry promotion publish options', () => {
  const options = parseArgs([
    '--publish-promotion',
    '--node-id',
    'AWS Current Node',
    '--promotion-ttl-ms',
    '60000',
    '--promotion-evidence-ref',
    'docs/fabric/evidence/current.md'
  ]);

  assert.equal(options.publishPromotion, true);
  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.promotionTtlMs, 60000);
  assert.equal(options.promotionEvidenceRef, 'docs/fabric/evidence/current.md');
});

test('M6 promotion gate parser supports explicit direct WebRTC promotion policy', () => {
  const options = parseArgs([
    '--allow-direct-webrtc-promotion',
    '--direct-webrtc-max-p95-ms',
    '900'
  ]);

  assert.equal(options.allowDirectWebrtcPromotion, true);
  assert.equal(options.directWebrtcMaxP95Ms, 900);
});

test('M6 promotion gate parser can skip default TURN UDP probe', () => {
  const options = parseArgs(['--skip-turn-udp-probe']);

  assert.equal(options.skipTurnUdpProbe, true);
});

test('M6 promotion gate parser requires TURN auth with TURN servers', () => {
  assert.throws(
    () => parseArgs(['--turn-ice-server', 'turn:relay.example.com:3478']),
    /--turn-username and --turn-credential are required/
  );

  const options = parseArgs([
    '--turn-ice-server',
    'turn:relay.example.com:3478',
    '--turn-username',
    'user',
    '--turn-credential',
    'secret',
    '--browser-channel',
    'bundled',
    '--headed'
  ]);

  assert.deepEqual(options.turnIceServers, ['turn:relay.example.com:3478']);
  assert.equal(options.turnUsername, 'user');
  assert.equal(options.turnCredential, 'secret');
  assert.equal(options.browserChannel, '');
  assert.equal(options.headed, true);
});

test('M6 promotion gate builds HTTPS WebTransport probe URL on the default port', () => {
  assert.equal(
    buildHttpsUrlFromEndpoint(
      'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
      '/v0/fabric/webtransport/echo'
    ),
    'https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo'
  );
  assert.equal(
    buildWebSocketUrlFromEndpoint(
      'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
      '/v0/fabric/transport/echo'
    ),
    'ws://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/transport/echo'
  );
});

test('M6 promotion gate keeps WebRTC candidate separate from default promotion', () => {
  const turnGate = classifyTurnRelay(null, false);
  const webRtcGate = classifyWebrtcDirect({
    ok: true,
    mode: 'webrtc-datachannel-smoke',
    rtt: { count: 5, p95: 120 },
    rpc: {
      ok: true,
      adapter: 'datachannel-json-rpc-echo',
      sampleCount: 3,
      responses: 3,
      requestsHandled: 3,
      rtt: { count: 3, p95: 20 }
    },
    offerer: {
      localCandidateKinds: { host: 2, srflx: 1 },
      remoteCandidateKinds: { host: 1, srflx: 1 },
      selectedCandidatePair: {
        localCandidateType: 'srflx',
        remoteCandidateType: 'srflx'
      }
    },
    answerer: {
      localCandidateKinds: { host: 1, srflx: 1 },
      remoteCandidateKinds: { host: 2, srflx: 1 }
    }
  }, {}, turnGate);

  assert.equal(webRtcGate.candidateReady, true);
  assert.equal(webRtcGate.promotionReady, false);
  assert.equal(webRtcGate.blockers.includes('turn_relay_gate_not_ready'), true);
  assert.equal(webRtcGate.blockers.includes('remote_rpc_webrtc_adapter_not_ready'), false);
  assert.equal(webRtcGate.rpc.ok, true);
});

test('M6 promotion gate can explicitly promote verified direct WebRTC', () => {
  const turnGate = classifyTurnRelay(null, false);
  const webRtcGate = classifyWebrtcDirect({
    ok: true,
    mode: 'webrtc-datachannel-smoke',
    rtt: { count: 5, p95: 120 },
    rpc: {
      ok: true,
      adapter: 'datachannel-json-rpc-echo',
      sampleCount: 3,
      responses: 3,
      requestsHandled: 3,
      rtt: { count: 3, p95: 20 }
    },
    offerer: {
      selectedCandidatePair: {
        localCandidateType: 'srflx',
        remoteCandidateType: 'srflx'
      }
    },
    answerer: {}
  }, {
    allowDirectWebrtcPromotion: true,
    directWebrtcMaxP95Ms: 500,
    sampleCount: 5
  }, turnGate);

  assert.equal(webRtcGate.candidateReady, true);
  assert.equal(webRtcGate.promotionReady, true);
  assert.equal(webRtcGate.promotionMode, 'direct');
  assert.equal(webRtcGate.directPromotion.directPairVerified, true);
  assert.deepEqual(webRtcGate.blockers, []);
});

test('M6 promotion gate accepts direct WebRTC evidence when selected pair stats are missing', () => {
  const webRtcGate = classifyWebrtcDirect({
    ok: true,
    mode: 'webrtc-datachannel-smoke',
    rtt: { count: 5, p95: 120 },
    rpc: { ok: true, responses: 3, requestsHandled: 3 },
    offerer: {
      localCandidateKinds: { host: 2, srflx: 1 },
      remoteCandidateKinds: { host: 2, srflx: 1 }
    },
    answerer: {
      localCandidateKinds: { host: 2, srflx: 1 },
      remoteCandidateKinds: { host: 2, srflx: 1 }
    }
  }, {
    allowDirectWebrtcPromotion: true,
    directWebrtcMaxP95Ms: 500,
    sampleCount: 5
  }, classifyTurnRelay(null, false));

  assert.equal(webRtcGate.promotionReady, true);
  assert.equal(webRtcGate.directPromotion.directPairVerified, false);
  assert.equal(webRtcGate.directPromotion.directCandidateKindsVerified, true);
  assert.equal(webRtcGate.directPromotion.directCandidateVerified, true);
  assert.deepEqual(webRtcGate.blockers, []);
});

test('M6 promotion gate rejects direct WebRTC evidence when relay candidates appear', () => {
  const webRtcGate = classifyWebrtcDirect({
    ok: true,
    mode: 'webrtc-datachannel-smoke',
    rtt: { count: 5, p95: 120 },
    rpc: { ok: true, responses: 3, requestsHandled: 3 },
    offerer: {
      localCandidateKinds: { host: 1, relay: 1 },
      remoteCandidateKinds: { srflx: 1 }
    },
    answerer: {
      localCandidateKinds: { srflx: 1 },
      remoteCandidateKinds: { host: 1 }
    }
  }, {
    allowDirectWebrtcPromotion: true,
    directWebrtcMaxP95Ms: 500,
    sampleCount: 5
  }, classifyTurnRelay(null, false));

  assert.equal(webRtcGate.promotionReady, false);
  assert.equal(webRtcGate.blockers.includes('webrtc_direct_pair_not_verified'), true);
});

test('M6 promotion gate rejects direct WebRTC promotion without enough measured RTT samples', () => {
  const webRtcGate = classifyWebrtcDirect({
    ok: true,
    mode: 'webrtc-datachannel-smoke',
    rtt: { count: 2, p95: 120 },
    rpc: { ok: true, responses: 3, requestsHandled: 3 },
    offerer: {
      selectedCandidatePair: {
        localCandidateType: 'srflx',
        remoteCandidateType: 'srflx'
      }
    }
  }, {
    allowDirectWebrtcPromotion: true,
    directWebrtcMaxP95Ms: 500,
    sampleCount: 5
  }, classifyTurnRelay(null, false));

  assert.equal(webRtcGate.promotionReady, false);
  assert.equal(webRtcGate.blockers.includes('webrtc_direct_rtt_samples_missing'), true);
});

test('M6 promotion gate blocks WebRTC when DataChannel RPC adapter echo is missing', () => {
  const turnGate = classifyTurnRelay({
    ok: true,
    offerer: {
      localCandidateKinds: { relay: 1 },
      selectedCandidatePair: { localCandidateType: 'relay', remoteCandidateType: 'relay' }
    }
  }, true);
  const webRtcGate = classifyWebrtcDirect({
    ok: true,
    mode: 'webrtc-datachannel-smoke',
    rtt: { count: 5, p95: 120 },
    rpc: { ok: false, sampleCount: 3, responses: 0, requestsHandled: 0 },
    offerer: {},
    answerer: {}
  }, {}, turnGate);

  assert.equal(webRtcGate.candidateReady, true);
  assert.equal(webRtcGate.promotionReady, false);
  assert.deepEqual(webRtcGate.blockers, ['remote_rpc_webrtc_adapter_not_ready']);
});

test('M6 promotion gate accepts TURN relay only when relay candidates are present', () => {
  const failed = classifyTurnRelay({
    ok: true,
    offerer: { localCandidateKinds: { host: 1 }, remoteCandidateKinds: { srflx: 1 } },
    answerer: { localCandidateKinds: { host: 1 }, remoteCandidateKinds: { srflx: 1 } }
  }, true);

  assert.equal(failed.candidateReady, false);
  assert.equal(failed.blockers.includes('turn_relay_candidate_missing'), true);

  const passed = classifyTurnRelay({
    ok: true,
    offerer: {
      localCandidateKinds: { relay: 1 },
      selectedCandidatePair: { localCandidateType: 'relay', remoteCandidateType: 'relay' }
    }
  }, true);

  assert.equal(passed.candidateReady, true);
  assert.equal(passed.promotionReady, true);
  assert.deepEqual(passed.blockers, []);
});

test('M6 promotion gate classifies WebTransport and multipath blockers', () => {
  const webTransport = classifyWebTransport({
    ok: false,
    webTransportUrl: 'https://control.example.com:9527/v0/fabric/webtransport/echo',
    probe: {
      ok: false,
      isSecureContext: true,
      webTransportType: 'function',
      failureReason: 'webtransport_connect_failed'
    }
  });

  assert.equal(webTransport.promotionReady, false);
  assert.deepEqual(webTransport.blockers, ['webtransport_connect_failed', 'webtransport_h3_endpoint_missing']);

  const multipath = classifyMultipath({
    summary: {
      defaultPortReachable: true,
      promotionReady: false,
      verdict: 'diagnostic_pass_promotion_blocked',
      blockers: ['local_mptcp_unavailable']
    }
  });

  assert.equal(multipath.candidateReady, true);
  assert.equal(multipath.promotionReady, false);
  assert.deepEqual(multipath.blockers, ['local_mptcp_unavailable']);
});

test('M6 promotion gate requires real relay echo before using relay fallback', () => {
  const passed = classifyRelayBaseline({
    ok: true,
    target: 'ws://control.example.com:9527/v0/fabric/transport/echo',
    count: 20,
    successes: 20,
    payloadSize: 64,
    rttMs: { count: 20, p95: 8 },
    failures: []
  });

  assert.equal(passed.candidateReady, true);
  assert.equal(passed.promotionReady, true);
  assert.equal(passed.rtt.p95, 8);
  assert.deepEqual(passed.blockers, []);

  const failed = classifyRelayBaseline({
    ok: false,
    count: 20,
    successes: 18,
    rttMs: { count: 18 },
    failures: [{ id: 19, error: 'timeout' }]
  });

  assert.equal(failed.promotionReady, false);
  assert.equal(failed.blockers.includes('relay_echo_failed'), true);
  assert.equal(failed.blockers.includes('relay_echo_incomplete'), true);
  assert.equal(failed.blockers.includes('relay_rtt_samples_missing'), true);
});

test('M6 promotion gate summary falls back to relay when every advanced gate blocks', () => {
  const summary = buildSummary({
    relay: { candidateReady: true, promotionReady: true, blockers: [] },
    webrtc: { candidateReady: true, promotionReady: false, blockers: ['turn_relay_gate_not_ready'] },
    turn: {
      ran: false,
      candidateReady: false,
      promotionReady: false,
      blockers: ['turn_ice_server_not_configured', 'turn_default_udp_9527_unreachable']
    },
    webtransport: { candidateReady: false, promotionReady: false, blockers: ['webtransport_connect_failed'] },
    multipath: { candidateReady: true, promotionReady: false, blockers: ['local_mptcp_unavailable'] }
  });

  assert.equal(summary.promotionReady, false);
  assert.equal(summary.defaultTransport, 'relay');
  assert.equal(summary.defaultTransportScope, 'fallback_transport');
  assert.equal(summary.fallbackRequired, true);
  assert.equal(summary.fallbackTransport, 'relay');
  assert.equal(summary.fallbackReady, true);
  assert.deepEqual(summary.candidateTransports, ['relay', 'webrtc', 'multipath']);
  assert.deepEqual(summary.blockedTransports, ['webrtc', 'turn', 'webtransport', 'multipath']);
  assert.deepEqual(summary.promotionPolicy, {
    webrtc: 'turn_relay_required',
    directWebrtcMaxP95Ms: 1500
  });
  assert.equal(summary.blockers.includes('webrtc:turn_relay_gate_not_ready'), true);
  assert.equal(summary.blockers.includes('turn:turn_ice_server_not_configured'), true);
  assert.equal(summary.blockers.includes('turn:turn_default_udp_9527_unreachable'), true);
});

test('M6 promotion gate summary does not assume relay fallback when relay probe blocks', () => {
  const summary = buildSummary({
    relay: { candidateReady: false, promotionReady: false, blockers: ['relay_echo_failed'] },
    webrtc: { candidateReady: true, promotionReady: false, blockers: ['turn_relay_gate_not_ready'] }
  });

  assert.equal(summary.promotionReady, false);
  assert.equal(summary.defaultTransport, 'none');
  assert.equal(summary.defaultTransportScope, 'none');
  assert.equal(summary.fallbackTransport, 'none');
  assert.equal(summary.fallbackReady, false);
  assert.equal(summary.blockers.includes('relay:relay_echo_failed'), true);
});

test('M6 promotion gate summary clears top-level blockers once an advanced transport promotes', () => {
  const summary = buildSummary({
    relay: { candidateReady: true, promotionReady: true, blockers: [] },
    webrtc: { candidateReady: true, promotionReady: true, blockers: [] },
    turn: {
      candidateReady: false,
      promotionReady: false,
      blockers: ['turn_ice_server_not_configured']
    }
  }, {
    allowDirectWebrtcPromotion: true,
    directWebrtcMaxP95Ms: 500
  });

  assert.equal(summary.promotionReady, true);
  assert.deepEqual(summary.promotedTransports, ['webrtc']);
  assert.equal(summary.defaultTransport, 'webrtc');
  assert.equal(summary.defaultTransportScope, 'promoted_transport');
  assert.equal(summary.fallbackTransport, 'relay');
  assert.deepEqual(summary.candidateTransports, ['relay', 'webrtc']);
  assert.deepEqual(summary.blockedTransports, ['turn']);
  assert.deepEqual(summary.promotionPolicy, {
    webrtc: 'direct_allowed',
    directWebrtcMaxP95Ms: 500
  });
  assert.deepEqual(summary.blockers, []);
  assert.deepEqual(summary.nonPromotedGateBlockers, ['turn:turn_ice_server_not_configured']);
});

test('M6 promotion gate builds expiring WebRTC promotion metadata from real gate metrics', () => {
  const promotion = buildPromotionTransport({
    generatedAt: '2026-06-29T00:00:00.000Z',
    gates: {
      webrtc: {
        promotionReady: true,
        promotionMode: 'direct',
        rtt: { p95: 120.04 },
        rpc: { rtt: { p95: 20.06 } }
      }
    },
    summary: {
      promotionReady: true,
      promotedTransports: ['webrtc']
    }
  }, {
    promotionTtlMs: 60000,
    promotionEvidenceRef: 'docs/fabric/evidence/current.md'
  }, {
    now: () => 1000
  });

  assert.equal(promotion.kind, 'webrtc');
  assert.equal(promotion.health, 'online');
  assert.deepEqual(promotion.promotion, {
    remoteRequestReady: true,
    mode: 'direct',
    evidenceRef: 'docs/fabric/evidence/current.md',
    rttP95Ms: 120,
    rpcP95Ms: 20.1,
    promotedAt: 1000,
    expiresAt: 61000
  });
});

test('M6 promotion gate remote publish command resolves the node token from app-state.db', () => {
  const command = buildRemotePromotionPublishCommand({
    remoteDir: '/home/ubuntu/aih-fabric-current',
    nodeId: 'aws-current-node',
    port: 9527
  }, 'webrtc=online,remote-request-ready=true');

  assert.match(command, /fabric' 'registry' 'agent'/);
  assert.doesNotMatch(command, /'--token-file'/);
  assert.doesNotMatch(command, /\.token/);
  assert.doesNotMatch(command, /'--token'/);
  assert.match(command, /AIH_HOST_HOME=/);
});

test('M6 promotion gate publishes passing WebRTC promotion over SSH', async () => {
  const calls = [];
  const publish = await publishPromotionToRegistry({
    generatedAt: '2026-06-29T00:00:00.000Z',
    gates: {
      webrtc: {
        promotionReady: true,
        promotionMode: 'direct',
        rtt: { p95: 120 },
        rpc: { rtt: { p95: 20 } }
      }
    },
    summary: {
      promotionReady: true,
      promotedTransports: ['webrtc']
    }
  }, {
    sshTarget: 'ubuntu@example.com',
    sshKey: '/tmp/key.pem',
    remoteDir: '/home/ubuntu/aih-fabric-current',
    nodeId: 'aws-current-node',
    port: 9527,
    promotionTtlMs: 60000,
    promotionEvidenceRef: 'docs/fabric/evidence/current.md'
  }, {
    now: () => 1000,
    spawn: createFakeSpawn({
      stdout: `${JSON.stringify({
        ok: true,
        attempts: 1,
        failures: 0,
        lastResult: {
          result: {
            registry: {
              counts: { nodes: 2, transports: 3 }
            }
          }
        }
      })}\n`
    }, calls)
  });

  assert.equal(publish.ok, true);
  assert.equal(publish.transport, 'webrtc');
  assert.equal(publish.promotion.expiresAt, 61000);
  assert.deepEqual(publish.result.counts, { nodes: 2, transports: 3 });
  assert.equal(calls[0].command, 'ssh');
  assert.equal(calls[0].args.includes('ubuntu@example.com'), true);
  assert.match(calls[0].args[calls[0].args.length - 1], /webrtc=online,remote-request-ready=true/);
});

test('runPromotionGate composes injected probe reports without shelling out', async () => {
  const report = await runPromotionGate({
    endpoint: 'http://control.example.com:9527',
    sshTarget: 'ubuntu@example.com',
    sshKey: '/tmp/key',
    sampleCount: 2,
    rpcSampleCount: 2,
    relayCount: 3,
    relayPayloadSize: 16,
    timeoutMs: 1000,
    skipTurn: true
  }, {
    runFabricTransportEcho: async (args) => {
      assert.deepEqual(args.slice(0, 7), [
        'ws://control.example.com:9527/v0/fabric/transport/echo',
        '--count',
        '3',
        '--payload-size',
        '16',
        '--timeout-ms',
        '1000'
      ]);
      return {
        ok: true,
        target: args[0],
        count: 3,
        successes: 3,
        payloadSize: 16,
        rttMs: { count: 3, p95: 5 },
        failures: []
      };
    },
    runWebrtcDatachannelSmoke: async () => ({
      ok: true,
      mode: 'webrtc-datachannel-smoke',
      rtt: { count: 2, p95: 10 },
      rpc: {
        ok: true,
        adapter: 'datachannel-json-rpc-echo',
        sampleCount: 2,
        responses: 2,
        requestsHandled: 2,
        rtt: { count: 2, p95: 4 }
      },
      offerer: { localCandidateKinds: { host: 1 }, remoteCandidateKinds: { srflx: 1 } },
      answerer: { localCandidateKinds: { host: 1 }, remoteCandidateKinds: { srflx: 1 } }
    }),
    runWebTransportSmoke: async () => ({
      ok: false,
      webTransportUrl: 'https://control.example.com:9527/v0/fabric/webtransport/echo',
      probe: {
        ok: false,
        isSecureContext: true,
        webTransportType: 'function',
        failureReason: 'webtransport_connect_failed'
      }
    }),
    runMultipathDiagnosis: async () => ({
      summary: {
        defaultPortReachable: true,
        promotionReady: false,
        verdict: 'diagnostic_pass_promotion_blocked',
        blockers: ['default_listener_is_plain_http_not_multipath_transport']
      }
    })
  });

  assert.equal(report.target.endpoint, 'http://control.example.com:9527');
  assert.equal(report.gates.relay.promotionReady, true);
  assert.equal(report.gates.webrtc.candidateReady, true);
  assert.equal(report.gates.webrtc.rpc.ok, true);
  assert.equal(report.gates.turn.skipped, true);
  assert.equal(report.gates.webtransport.blockers[0], 'webtransport_connect_failed');
  assert.equal(report.summary.promotionReady, false);
  assert.equal(report.summary.fallbackReady, true);
  assert.match(formatReport(report), /default_transport: relay/);
});

test('runPromotionGate includes default UDP blocker when TURN is not configured', async () => {
  const report = await runPromotionGate({
    endpoint: 'http://control.example.com:9527',
    sshTarget: 'ubuntu@example.com',
    sshKey: '/tmp/key',
    remoteDir: '/home/ubuntu/aih-fabric-current',
    port: 9527,
    sampleCount: 2,
    rpcSampleCount: 2,
    relayCount: 3,
    relayPayloadSize: 16,
    timeoutMs: 1000,
    skipWebrtc: true,
    skipWebTransport: true,
    skipMultipath: true
  }, {
    runFabricTransportEcho: async () => ({
      ok: true,
      target: 'ws://control.example.com:9527/v0/fabric/transport/echo',
      count: 3,
      successes: 3,
      payloadSize: 16,
      rttMs: { count: 3, p95: 5 },
      failures: []
    }),
    runDefaultPortUdpProbe: async (options) => {
      assert.equal(options.endpoint, 'http://control.example.com:9527');
      assert.equal(options.remoteDir, '/home/ubuntu/aih-fabric-current');
      assert.equal(options.port, 9527);
      return {
        ran: true,
        host: 'control.example.com',
        port: 9527,
        candidateReady: false,
        blockers: ['turn_default_udp_9527_unreachable'],
        local: { ok: false, error: 'udp_echo_timeout' },
        remote: {
          ready: true,
          edge: {
            summary: {
              interface: 'enp39s0',
              privateAddress: '172.31.47.163',
              publicIpv4: '43.207.102.163',
              securityGroupIds: ['sg-01e33f3412fabfded'],
              hostFirewallBlocksUdp: false
            }
          }
        }
      };
    }
  });

  assert.equal(report.target.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(report.target.port, 9527);
  assert.equal(report.gates.turn.defaultPortUdp.candidateReady, false);
  assert.equal(report.gates.turn.defaultPortUdp.remote.edge.summary.interface, 'enp39s0');
  assert.equal(report.gates.turn.blockers.includes('turn_default_udp_9527_unreachable'), true);
  assert.equal(report.summary.blockers.includes('turn:turn_default_udp_9527_unreachable'), true);
});
