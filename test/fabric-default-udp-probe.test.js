'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  buildRemoteUdpEdgeSnapshotCommand,
  buildRemoteUdpPacketCaptureCommand,
  classifyDefaultPortUdpProbe,
  defaultUdpProbeBlockers,
  defaultUdpProbeFailureBlocker,
  getTargetCommandExecutionContext,
  isUdpProbeBusy,
  runRemoteUdpEdgeSnapshot,
  shouldRunTargetCommandLocally
} = require('../scripts/fabric-default-udp-probe');

function createSpawnChild(onStart) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => onStart(child));
  return child;
}

test('default UDP probe builds a remote packet capture command on the default port', () => {
  const command = buildRemoteUdpPacketCaptureCommand({
    remoteDir: '/home/ubuntu/aih-fabric-current',
    port: 9527,
    udpPacketCaptureInterface: 'enp39s0'
  }, 6500);

  assert.match(command, /tcpdump/);
  assert.match(command, /capture-ready/);
  assert.match(command, /capture-result/);
  assert.match(command, /enp39s0/);
  assert.match(command, /9527/);
});

test('default UDP probe builds a remote edge snapshot command for AWS diagnostics', () => {
  const command = buildRemoteUdpEdgeSnapshotCommand({
    remoteDir: '/home/ubuntu/aih-fabric-current',
    port: 9527
  });

  assert.match(command, /ip route get 1\.1\.1\.1/);
  assert.match(command, /ufw status/);
  assert.match(command, /iptables -S INPUT/);
  assert.match(command, /169\.254\.169\.254\/latest\/meta-data/);
  assert.match(command, /security-group-ids/);
  assert.match(command, /hostFirewallBlocksUdp/);
  assert.match(command, /9527/);
});

test('default UDP probe parses remote edge snapshot output', async () => {
  const calls = [];
  const report = await runRemoteUdpEdgeSnapshot({
    sshTarget: 'ubuntu@example.com',
    sshKey: '/tmp/aws.pem',
    remoteDir: '/home/ubuntu/aih-fabric-current',
    port: 9527
  }, {
    cwd: '/tmp/local-client',
    spawn: (command, args) => {
      calls.push({ command, args });
      return createSpawnChild((child) => {
        child.stdout.end(JSON.stringify({
          ran: true,
          route: '1.1.1.1 via 172.31.32.1 dev enp39s0 src 172.31.47.163 uid 1000',
          interface: 'enp39s0',
          sourceAddress: '172.31.47.163',
          firewall: {
            ufwInactive: true,
            inputPolicyAccept: true,
            hostFirewallBlocksUdp: false
          },
          imds: {
            tokenAvailable: true,
            publicIpv4: '43.207.102.163',
            securityGroupIds: ['sg-01e33f3412fabfded']
          },
          summary: {
            interface: 'enp39s0',
            privateAddress: '172.31.47.163',
            publicIpv4: '43.207.102.163',
            securityGroupIds: ['sg-01e33f3412fabfded'],
            hostFirewallBlocksUdp: false
          }
        }));
        child.stderr.end('');
        child.emit('close', 0, null);
      });
    }
  });

  assert.equal(calls[0].command, 'ssh');
  assert.equal(calls[0].args.includes('ubuntu@example.com'), true);
  assert.equal(report.ok, true);
  assert.equal(report.ran, true);
  assert.equal(report.interface, 'enp39s0');
  assert.equal(report.firewall.ufwInactive, true);
  assert.equal(report.firewall.hostFirewallBlocksUdp, false);
  assert.equal(report.summary.publicIpv4, '43.207.102.163');
  assert.deepEqual(report.summary.securityGroupIds, ['sg-01e33f3412fabfded']);
});

test('default UDP probe runs target commands locally when already inside remote dir', async () => {
  const calls = [];
  const report = await runRemoteUdpEdgeSnapshot({
    sshTarget: 'ubuntu@example.com',
    sshKey: '/home/ubuntu/.ssh/aws.pem',
    remoteDir: '/home/ubuntu/aih-fabric-current',
    port: 9527
  }, {
    cwd: '/home/ubuntu/aih-fabric-current',
    spawn: (command, args) => {
      calls.push({ command, args });
      return createSpawnChild((child) => {
        child.stdout.end(JSON.stringify({
          ran: true,
          interface: 'enp39s0',
          firewall: { hostFirewallBlocksUdp: false },
          imds: { securityGroupIds: ['sg-01e33f3412fabfded'] },
          summary: {
            interface: 'enp39s0',
            securityGroupIds: ['sg-01e33f3412fabfded'],
            hostFirewallBlocksUdp: false
          }
        }));
        child.stderr.end('');
        child.emit('close', 0, null);
      });
    }
  });

  assert.equal(shouldRunTargetCommandLocally({
    remoteDir: '/home/ubuntu/aih-fabric-current'
  }, {
    cwd: '/home/ubuntu/aih-fabric-current'
  }), true);
  assert.equal(getTargetCommandExecutionContext({
    remoteDir: '/home/ubuntu/aih-fabric-current'
  }, {
    cwd: '/home/ubuntu/aih-fabric-current'
  }).proofScope, 'target_local');
  assert.equal(calls[0].command, 'sh');
  assert.deepEqual(calls[0].args.slice(0, 1), ['-lc']);
  assert.equal(calls[0].args.join(' ').includes('/home/ubuntu/.ssh/aws.pem'), false);
  assert.equal(report.ok, true);
  assert.equal(report.summary.interface, 'enp39s0');
});

test('default UDP probe does not promote target-local success as cloud edge proof', () => {
  const blockers = defaultUdpProbeBlockers(
    { ready: true, port: 9527 },
    { ok: true, remoteAddress: '172.31.47.163' },
    { proofScope: 'target_local' },
    9527
  );

  assert.deepEqual(blockers, ['turn_default_udp_target_local_only']);

  const gate = classifyDefaultPortUdpProbe({
    ran: true,
    host: 'ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com',
    port: 9527,
    timeoutMs: 5000,
    targetExecution: {
      commandMode: 'local',
      proofScope: 'target_local'
    },
    candidateReady: false,
    remote: { ready: true },
    local: { ok: true, remoteAddress: '172.31.47.163' },
    blockers
  });

  assert.equal(gate.targetExecution.proofScope, 'target_local');
  assert.equal(gate.candidateReady, false);
  assert.equal(gate.blockers.includes('turn_default_udp_target_local_only'), true);
});

test('default UDP probe classification preserves packet capture evidence', () => {
  const gate = classifyDefaultPortUdpProbe({
    ran: true,
    host: 'control.example.com',
    port: 9527,
    timeoutMs: 5000,
    candidateReady: false,
    remote: {
      ready: true,
      packetCapture: {
        ran: true,
        ready: true,
        available: true,
        captured: false,
        interface: 'enp39s0',
        status: 124
      }
    },
    local: {
      ok: false,
      error: 'udp_echo_timeout'
    },
    blockers: ['turn_default_udp_9527_unreachable']
  });

  assert.equal(gate.remote.packetCapture.available, true);
  assert.equal(gate.remote.packetCapture.captured, false);
  assert.equal(gate.blockers.includes('turn_default_udp_9527_unreachable'), true);
});

test('default UDP probe classification preserves edge snapshot evidence', () => {
  const gate = classifyDefaultPortUdpProbe({
    ran: true,
    host: 'control.example.com',
    port: 9527,
    timeoutMs: 5000,
    candidateReady: false,
    remote: {
      ready: true,
      edge: {
        ran: true,
        ok: true,
        summary: {
          interface: 'enp39s0',
          privateAddress: '172.31.47.163',
          publicIpv4: '43.207.102.163',
          securityGroupIds: ['sg-01e33f3412fabfded'],
          hostFirewallBlocksUdp: false
        }
      }
    },
    local: {
      ok: false,
      error: 'udp_echo_timeout'
    },
    blockers: ['turn_default_udp_9527_unreachable']
  });

  assert.equal(gate.remote.edge.summary.interface, 'enp39s0');
  assert.equal(gate.remote.edge.summary.publicIpv4, '43.207.102.163');
  assert.equal(gate.remote.edge.summary.hostFirewallBlocksUdp, false);
});

test('default UDP probe classifies concurrent diagnostic bind as busy', () => {
  assert.equal(isUdpProbeBusy('bind EADDRINUSE 0.0.0.0:9527'), true);
  assert.equal(
    defaultUdpProbeFailureBlocker({ ready: false, error: 'bind EADDRINUSE 0.0.0.0:9527' }, 9527),
    'turn_default_udp_probe_busy'
  );

  const gate = classifyDefaultPortUdpProbe({
    ran: true,
    host: 'control.example.com',
    port: 9527,
    candidateReady: false,
    remote: {
      ready: false,
      error: 'bind EADDRINUSE 0.0.0.0:9527',
      packetCapture: { skipped: true, reason: 'remote_udp_echo_not_ready' }
    },
    local: {
      ok: false,
      error: 'bind EADDRINUSE 0.0.0.0:9527'
    },
    blockers: ['turn_default_udp_probe_busy']
  });

  assert.equal(gate.blockers.includes('turn_default_udp_probe_busy'), true);
  assert.equal(gate.blockers.includes('turn_default_udp_probe_failed'), false);
});
