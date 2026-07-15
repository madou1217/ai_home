'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildDefaultWebTransportUrl,
  buildDiagnosticConcurrencySummary,
  buildDiagnosticContextSummary,
  buildSummary,
  buildTurnConfig,
  classifyAwsPreflight,
  classifyDefaultPortUdpProbe,
  classifyTurnPrerequisite,
  classifyWebTransportPrerequisite,
  formatReport,
  parseArgs,
  runPrerequisiteAudit
} = require('../scripts/fabric-m6-prerequisite-audit');

test('M6 prerequisite audit parser defaults to AWS current without transport credentials', () => {
  const options = parseArgs(['--json'], {});

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(options.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.port, 9527);
  assert.deepEqual(options.turnIceServers, []);
  assert.equal(options.webTransportUrl, 'https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo');
  assert.equal(options.webTransportPageUrl, 'https://example.com');
  assert.equal(options.skipTurnUdpProbe, false);
  assert.equal(options.json, true);
});

test('M6 prerequisite audit parser can skip default TURN UDP probe', () => {
  const options = parseArgs(['--skip-turn-udp-probe'], {});

  assert.equal(options.skipTurnUdpProbe, true);
});

test('M6 prerequisite audit parser reads optional environment defaults', () => {
  const options = parseArgs([], {
    AIH_TURN_ICE_SERVERS: 'turn:relay.example.com:3478, turns:relay.example.com:5349',
    AIH_TURN_USERNAME: 'relay-user',
    AIH_TURN_CREDENTIAL: 'relay-secret',
    AIH_M6_WEBTRANSPORT_URL: 'https://transport.example.com/wt',
    AIH_M6_WEBTRANSPORT_PAGE_URL: 'https://transport.example.com/'
  });

  assert.deepEqual(options.turnIceServers, ['turn:relay.example.com:3478', 'turns:relay.example.com:5349']);
  assert.equal(options.turnUsername, 'relay-user');
  assert.equal(options.turnCredential, 'relay-secret');
  assert.equal(options.webTransportUrl, 'https://transport.example.com/wt');
  assert.equal(options.webTransportPageUrl, 'https://transport.example.com');
});

test('M6 prerequisite audit keeps TURN configuration strict and redacted', () => {
  const absent = classifyTurnPrerequisite(buildTurnConfig({ turnIceServers: [] }));
  assert.equal(absent.ran, false);
  assert.deepEqual(absent.blockers, ['turn_ice_server_not_configured']);

  const stunOnly = classifyTurnPrerequisite(buildTurnConfig({
    turnIceServers: ['stun:stun.example.com:19302']
  }));
  assert.equal(stunOnly.blockers.includes('turn_ice_server_not_turn_url'), true);

  const missingCredential = classifyTurnPrerequisite(buildTurnConfig({
    turnIceServers: ['turn:relay.example.com:3478'],
    turnUsername: 'user'
  }));
  assert.equal(missingCredential.blockers.includes('turn_credential_missing'), true);
  assert.equal(missingCredential.configuration.username, '<set>');
  assert.equal(missingCredential.configuration.credential, '');
});

test('M6 prerequisite audit reports default UDP blocker when self-hosted TURN is not configured', () => {
  const udp = classifyDefaultPortUdpProbe({
    ran: true,
    host: 'ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com',
    port: 9527,
    candidateReady: false,
    blockers: ['turn_default_udp_9527_unreachable'],
    local: { ok: false, error: 'udp_echo_timeout' },
    remote: { ready: true }
  });
  const gate = classifyTurnPrerequisite(buildTurnConfig({ turnIceServers: [] }), null, null, false, udp);

  assert.equal(gate.defaultPortUdp.candidateReady, false);
  assert.equal(gate.blockers.includes('turn_ice_server_not_configured'), true);
  assert.equal(gate.blockers.includes('turn_default_udp_9527_unreachable'), true);
});

test('M6 prerequisite audit marks concurrent default UDP probe as diagnostic concurrency', () => {
  const summary = buildSummary({
    aws: { promotionReady: true, blockers: [] },
    turn: {
      candidateReady: false,
      promotionReady: false,
      blockers: ['turn_ice_server_not_configured', 'turn_default_udp_probe_busy']
    },
    webtransport: { promotionReady: false, blockers: [] },
    multipath: { promotionReady: false, blockers: [] }
  });

  assert.equal(summary.promotionReady, false);
  assert.equal(summary.blockers.includes('turn:turn_default_udp_probe_busy'), true);
  assert.equal(summary.diagnosticConcurrency.blocked, true);
  assert.deepEqual(summary.diagnosticConcurrency.blockers, ['turn:turn_default_udp_probe_busy']);
  assert.match(summary.diagnosticConcurrency.nextAction, /one default UDP transport diagnostic/);

  const direct = buildDiagnosticConcurrencySummary({
    turn: { blockers: ['turn_default_udp_probe_busy'] }
  });
  assert.equal(direct.blocked, true);
});

test('M6 prerequisite audit marks target-local UDP proof as diagnostic context', () => {
  const summary = buildSummary({
    aws: { promotionReady: true, blockers: [] },
    turn: {
      candidateReady: false,
      promotionReady: false,
      blockers: ['turn_default_udp_target_local_only']
    },
    webtransport: { promotionReady: false, blockers: [] },
    multipath: { promotionReady: false, blockers: [] }
  });

  assert.equal(summary.promotionReady, false);
  assert.equal(summary.blockers.includes('turn:turn_default_udp_target_local_only'), true);
  assert.equal(summary.diagnosticContext.blocked, true);
  assert.deepEqual(summary.diagnosticContext.blockers, ['turn:turn_default_udp_target_local_only']);
  assert.match(summary.diagnosticContext.nextAction, /client side/);

  const direct = buildDiagnosticContextSummary({
    turn: { blockers: ['turn_default_udp_target_local_only'] }
  });
  assert.equal(direct.blocked, true);
});

test('M6 prerequisite audit accepts TURN only when relay candidates are proven', () => {
  const config = buildTurnConfig({
    turnIceServers: ['turn:relay.example.com:3478'],
    turnUsername: 'user',
    turnCredential: 'secret'
  });
  const gate = classifyTurnPrerequisite(config, {
    ok: true,
    offerer: {
      localCandidateKinds: { relay: 1 },
      remoteCandidateKinds: { relay: 1 },
      selectedCandidatePair: {
        localCandidateType: 'relay',
        remoteCandidateType: 'relay'
      }
    },
    answerer: {
      localCandidateKinds: { relay: 1 },
      remoteCandidateKinds: { relay: 1 }
    }
  });

  assert.equal(gate.candidateReady, true);
  assert.equal(gate.promotionReady, true);
  assert.deepEqual(gate.blockers, []);
  assert.deepEqual(gate.configuration.turnServers, ['turn:relay.example.com:3478']);
  assert.equal(gate.configuration.credential, '<redacted>');
});

test('M6 prerequisite audit classifies AWS and WebTransport blockers', () => {
  const aws = classifyAwsPreflight({
    ok: false,
    remainingGate: ['registry_readback_failed', 'unexpected_residue_processes'],
    registry: { ok: false, http: 401 }
  });
  assert.equal(aws.promotionReady, false);
  assert.equal(aws.blockers.includes('aws_preflight_failed'), true);
  assert.equal(aws.blockers.includes('registry_readback_failed'), true);

  const webtransport = classifyWebTransportPrerequisite({
    ok: false,
    webTransportUrl: 'http://transport.example.com/wt',
    probe: {
      ok: false,
      isSecureContext: true,
      webTransportType: 'function',
      failureReason: 'webtransport_connect_failed'
    }
  }, null, {
    webTransportUrl: 'http://transport.example.com/wt',
    webTransportPageUrl: 'https://example.com'
  });

  assert.equal(webtransport.promotionReady, false);
  assert.equal(webtransport.blockers.includes('webtransport_connect_failed'), true);
  assert.equal(webtransport.blockers.includes('webtransport_h3_endpoint_missing'), true);
  assert.equal(webtransport.blockers.includes('webtransport_url_not_https'), true);
});

test('M6 prerequisite audit summary requires AWS base readiness before promotion', () => {
  const summary = buildSummary({
    aws: { promotionReady: false, blockers: ['aws_preflight_failed'] },
    turn: { promotionReady: true, blockers: [] },
    webtransport: { promotionReady: false, blockers: ['webtransport_connect_failed'] },
    multipath: { promotionReady: false, blockers: ['local_mptcp_unavailable'] }
  });

  assert.equal(summary.baseReady, false);
  assert.equal(summary.promotionReady, false);
  assert.deepEqual(summary.readyTransports, []);
  assert.equal(summary.blockers.includes('aws:aws_preflight_failed'), true);
});

test('runPrerequisiteAudit composes injected probe reports without network access', async () => {
  const report = await runPrerequisiteAudit({
    endpoint: 'http://control.example.com:9527',
    sshTarget: 'ubuntu@example.com',
    sshKey: '/tmp/key',
    remoteDir: '/home/ubuntu/aih-fabric-current',
    nodeId: 'aws-current-node',
    port: 9527,
    turnIceServers: ['turn:relay.example.com:3478'],
    turnUsername: 'user',
    turnCredential: 'secret',
    timeoutMs: 1000,
    skipMultipath: false
  }, {
    runPreflight: async () => ({
      ok: true,
      target: { nodeId: 'aws-current-node', port: 9527 },
      remainingGate: [],
      registry: {
        ok: true,
        http: 200,
        targetNode: { present: true, runtimeHost: false, runtimeGaps: ['codex:missing_provider_runtime'] }
      },
      residue: []
    }),
    runDefaultPortUdpProbe: async () => ({
      ran: true,
      host: 'control.example.com',
      port: 9527,
      candidateReady: false,
      blockers: ['turn_default_udp_9527_unreachable'],
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
    }),
    runWebrtcDatachannelSmoke: async (options) => {
      assert.equal(options.iceTransportPolicy, 'relay');
      assert.deepEqual(options.iceServerUrls, ['turn:relay.example.com:3478']);
      return {
        ok: true,
        offerer: {
          localCandidateKinds: { relay: 1 },
          selectedCandidatePair: {
            localCandidateType: 'relay',
            remoteCandidateType: 'relay'
          }
        },
        answerer: {
          localCandidateKinds: { relay: 1 },
          remoteCandidateKinds: { relay: 1 }
        }
      };
    },
    runWebTransportSmoke: async () => ({
      ok: false,
      webTransportUrl: buildDefaultWebTransportUrl('http://control.example.com:9527'),
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

  assert.equal(report.gates.aws.promotionReady, true);
  assert.equal(report.gates.turn.promotionReady, true);
  assert.equal(report.gates.turn.defaultPortUdp.remote.edge.summary.publicIpv4, '43.207.102.163');
  assert.equal(report.gates.webtransport.blockers[0], 'webtransport_connect_failed');
  assert.equal(report.gates.multipath.blockers[0], 'default_listener_is_plain_http_not_multipath_transport');
  assert.deepEqual(report.summary.readyTransports, ['webrtc-turn-relay']);
  assert.equal(report.summary.promotionReady, true);
  assert.match(formatReport(report), /ready_transports: webrtc-turn-relay/);
});
