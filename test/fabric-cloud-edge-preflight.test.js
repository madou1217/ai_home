'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  buildRemoteCloudApiSnapshotCommand,
  buildSummary,
  combineCloudApiSnapshots,
  parseArgs,
  runCloudEdgePreflight,
  runLocalAwsApiReadback,
  runRemoteCloudApiSnapshot
} = require('../scripts/fabric-cloud-edge-preflight');

function createSpawnQueue(responses, calls = []) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const response = responses.shift() || {};
    setImmediate(() => {
      child.stdout.end(response.stdout || '');
      child.stderr.end(response.stderr || '');
      child.emit('close', Object.prototype.hasOwnProperty.call(response, 'status') ? response.status : 0, response.signal || null);
    });
    return child;
  };
}

test('cloud edge preflight parser defaults to AWS current', () => {
  const options = parseArgs(['--json']);

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(options.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(options.port, 9527);
  assert.equal(options.udpProbeTimeoutMs, 5000);
  assert.equal(options.awsRegion, 'ap-northeast-1');
  assert.equal(options.awsApiTimeoutMs, 5000);
  assert.equal(options.json, true);
});

test('cloud edge preflight builds remote AWS API credential snapshot command', () => {
  const command = buildRemoteCloudApiSnapshotCommand({
    remoteDir: '/home/ubuntu/aih-fabric-current'
  });

  assert.match(command, /command -v aws/);
  assert.match(command, /aws --version/);
  assert.match(command, /169\.254\.169\.254\/latest\/api\/token/);
  assert.match(command, /iam\/security-credentials/);
  assert.match(command, /__HTTP_STATUS__/);
  assert.match(command, /roleNamesRaw\.httpStatus===200/);
  assert.match(command, /aws_cli_missing/);
  assert.match(command, /aws_iam_role_missing/);
});

test('cloud edge preflight runs cloud API snapshot locally in target deployment dir', async () => {
  const calls = [];
  const report = await runRemoteCloudApiSnapshot({
    sshTarget: 'ubuntu@example.com',
    sshKey: '/home/ubuntu/.ssh/aws.pem',
    remoteDir: '/home/ubuntu/aih-fabric-current',
    port: 9527
  }, {
    cwd: '/home/ubuntu/aih-fabric-current',
    spawn: createSpawnQueue([
      {
        stdout: JSON.stringify({
          ran: true,
          awsCli: { available: false, path: '', version: 'aws_cli_missing' },
          imds: { tokenAvailable: true, iamRoleAvailable: false, iamRoleNames: [] },
          summary: { awsApiCredentialsReady: false },
          blockers: ['aws_cli_missing', 'aws_iam_role_missing']
        })
      }
    ], calls)
  });

  assert.equal(calls[0].command, 'sh');
  assert.deepEqual(calls[0].args.slice(0, 1), ['-lc']);
  assert.equal(calls[0].args.join(' ').includes('/home/ubuntu/.ssh/aws.pem'), false);
  assert.equal(report.ok, true);
  assert.equal(report.awsCli.available, false);
  assert.deepEqual(report.blockers, ['aws_cli_missing', 'aws_iam_role_missing']);
});

test('cloud edge preflight summary classifies cloud UDP path and AWS API credential blockers', () => {
  const cloudApi = combineCloudApiSnapshots({
    summary: { awsApiCredentialsReady: false },
    blockers: ['aws_cli_missing', 'aws_iam_role_missing']
  }, {
    summary: { awsApiReadbackReady: false, awsApiCredentialsReady: false },
    blockers: ['aws_local_cli_missing']
  });
  const summary = buildSummary({
    udp: {
      ran: true,
      port: 9527,
      candidateReady: false,
      blockers: ['turn_default_udp_9527_unreachable'],
      remote: {
        packetCapture: {
          available: true,
          captured: false
        },
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
    },
    cloudApi
  });

  assert.equal(summary.cloudEdgeReady, false);
  assert.equal(summary.udpReachable, false);
  assert.equal(summary.packetArrivalCaptured, false);
  assert.equal(summary.hostFirewallBlocksUdp, false);
  assert.equal(summary.cloudApiCredentialsReady, false);
  assert.equal(summary.localAwsApiReadbackReady, false);
  assert.equal(summary.blockers.includes('aws_public_udp_path_blocked'), true);
  assert.equal(summary.blockers.includes('aws_cli_missing'), true);
  assert.equal(summary.blockers.includes('aws_local_cli_missing'), true);
  assert.deepEqual(summary.securityGroupIds, ['sg-01e33f3412fabfded']);
  assert.equal(summary.nextActions.some((item) => item.includes('Security Group')), true);
});

test('cloud edge preflight summary separates concurrent UDP probe from cloud path blocker', () => {
  const summary = buildSummary({
    udp: {
      ran: true,
      port: 9527,
      candidateReady: false,
      blockers: ['turn_default_udp_probe_busy'],
      remote: {
        ready: false,
        error: 'bind EADDRINUSE 0.0.0.0:9527',
        packetCapture: {
          skipped: true,
          reason: 'remote_udp_echo_not_ready'
        },
        edge: {
          summary: {
            interface: 'enp39s0',
            securityGroupIds: ['sg-01e33f3412fabfded'],
            hostFirewallBlocksUdp: false
          }
        }
      }
    },
    cloudApi: {
      summary: { awsApiCredentialsReady: true },
      blockers: []
    }
  });

  assert.equal(summary.cloudEdgeReady, false);
  assert.equal(summary.packetArrivalCaptured, null);
  assert.equal(summary.blockers.includes('turn_default_udp_probe_busy'), true);
  assert.equal(summary.blockers.includes('aws_public_udp_path_blocked'), false);
  assert.equal(summary.nextActions.some((item) => item.includes('one default UDP transport diagnostic')), true);
});

test('cloud edge preflight summary does not treat target-local UDP success as public edge proof', () => {
  const summary = buildSummary({
    udp: {
      ran: true,
      port: 9527,
      candidateReady: false,
      blockers: ['turn_default_udp_target_local_only'],
      targetExecution: {
        commandMode: 'local',
        proofScope: 'target_local'
      },
      remote: {
        ready: true,
        packetCapture: {
          available: true,
          captured: false
        },
        edge: {
          summary: {
            interface: 'enp39s0',
            securityGroupIds: ['sg-01e33f3412fabfded'],
            hostFirewallBlocksUdp: false
          }
        }
      },
      local: {
        ok: true,
        remoteAddress: '172.31.47.163'
      }
    },
    cloudApi: {
      summary: { awsApiCredentialsReady: true },
      blockers: []
    }
  });

  assert.equal(summary.cloudEdgeReady, false);
  assert.equal(summary.blockers.includes('turn_default_udp_target_local_only'), true);
  assert.equal(summary.blockers.includes('aws_public_udp_path_blocked'), false);
  assert.equal(summary.nextActions.some((item) => item.includes('target-local UDP success')), true);
});

test('cloud edge preflight combines local AWS readback as a read-only cloud API path', () => {
  const combined = combineCloudApiSnapshots({
    ran: true,
    summary: { awsApiCredentialsReady: false },
    blockers: ['aws_cli_missing', 'aws_iam_role_missing']
  }, {
    ran: true,
    summary: {
      awsApiReadbackReady: true,
      awsApiCredentialsReady: true,
      instanceId: 'i-001b344ddf61dc168',
      subnetId: 'subnet-0f7fce79d31c05449'
    },
    blockers: []
  });

  assert.equal(combined.summary.awsApiCredentialsReady, true);
  assert.equal(combined.summary.remoteAwsApiCredentialsReady, false);
  assert.equal(combined.summary.localAwsApiReadbackReady, true);
  assert.equal(combined.summary.localAwsApiInstanceId, 'i-001b344ddf61dc168');
  assert.deepEqual(combined.blockers, []);
});

test('local AWS API readback reports missing CLI as structured blocker', async () => {
  const calls = [];
  const report = await runLocalAwsApiReadback({
    awsRegion: 'ap-northeast-1',
    awsApiTimeoutMs: 1000
  }, {}, {
    spawn: createSpawnQueue([
      { stdout: '' }
    ], calls)
  });

  assert.equal(calls[0].command, 'sh');
  assert.equal(report.ok, true);
  assert.equal(report.awsCli.available, false);
  assert.equal(report.apiReadback.attempted, false);
  assert.deepEqual(report.blockers, ['aws_local_cli_missing']);
});

test('local AWS API readback uses only read-only EC2 commands and redacts identity', async () => {
  const calls = [];
  const report = await runLocalAwsApiReadback({
    awsRegion: 'ap-northeast-1',
    awsApiTimeoutMs: 1000,
    port: 9527
  }, {
    udp: {
      remote: {
        edge: {
          imds: {
            instanceId: 'i-001b344ddf61dc168',
            subnetId: 'subnet-0f7fce79d31c05449',
            securityGroupIds: ['sg-01e33f3412fabfded']
          },
          summary: {
            securityGroupIds: ['sg-01e33f3412fabfded']
          }
        }
      }
    }
  }, {
    spawn: createSpawnQueue([
      { stdout: '/usr/local/bin/aws\n' },
      { stdout: 'aws-cli/2.15.0 Python/3.11\n' },
      { stdout: JSON.stringify({ Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/ReadOnly/session' }) },
      { stdout: JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: 'i-001b344ddf61dc168', State: { Name: 'running' }, VpcId: 'vpc-123', SubnetId: 'subnet-0f7fce79d31c05449', PrivateIpAddress: '172.31.47.163', PublicIpAddress: '43.207.102.163', SecurityGroups: [{ GroupId: 'sg-01e33f3412fabfded' }] }] }] }) },
      { stdout: JSON.stringify({ SecurityGroups: [{ GroupId: 'sg-01e33f3412fabfded', GroupName: 'aih', VpcId: 'vpc-123', IpPermissions: [{ IpProtocol: 'udp', FromPort: 9527, ToPort: 9527, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }], IpPermissionsEgress: [{ IpProtocol: '-1' }] }] }) },
      { stdout: JSON.stringify({ NetworkAcls: [{ NetworkAclId: 'acl-123', VpcId: 'vpc-123', IsDefault: true, Associations: [{ SubnetId: 'subnet-0f7fce79d31c05449' }], Entries: [{ Egress: false, Protocol: '17', PortRange: { From: 9527, To: 9527 }, RuleAction: 'allow' }, { Egress: true, Protocol: '-1', RuleAction: 'allow' }] }] }) }
    ], calls)
  });

  assert.equal(report.summary.awsApiReadbackReady, true);
  assert.equal(report.identity.accountSuffix, '9012');
  assert.equal(report.identity.Account, undefined);
  assert.equal(report.target.instanceId, 'i-001b344ddf61dc168');
  assert.equal(report.ec2.securityGroups[0].udpDefaultPortIngressRuleCount, 1);
  assert.deepEqual(report.blockers, []);
  assert.equal(calls.some((call) => call.args.includes('authorize-security-group-ingress')), false);
  assert.equal(calls.some((call) => call.args.includes('revoke-security-group-ingress')), false);
  assert.equal(calls.some((call) => call.args.includes('modify-network-acl-entry')), false);
});

test('runCloudEdgePreflight composes injected real-probe reports', async () => {
  const report = await runCloudEdgePreflight({
    endpoint: 'http://control.example.com:9527',
    sshTarget: 'ubuntu@example.com',
    sshKey: '/tmp/key',
    remoteDir: '/home/ubuntu/aih-fabric-current',
    port: 9527
  }, {
    runDefaultPortUdpProbe: async () => ({
      ran: true,
      host: 'control.example.com',
      port: 9527,
      candidateReady: false,
      blockers: ['turn_default_udp_9527_unreachable'],
      remote: {
        ready: true,
        packetCapture: {
          available: true,
          captured: false
        },
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
    runRemoteCloudApiSnapshot: async () => ({
      ok: true,
      ran: true,
      awsCli: { available: false },
      imds: { tokenAvailable: true, iamRoleAvailable: false, iamRoleNames: [] },
      summary: { awsApiCredentialsReady: false },
      blockers: ['aws_cli_missing', 'aws_iam_role_missing']
    }),
    runLocalAwsApiReadback: async () => ({
      ok: true,
      ran: true,
      summary: {
        awsApiReadbackReady: false,
        awsApiCredentialsReady: false
      },
      blockers: ['aws_local_cli_missing']
    })
  });

  assert.equal(report.ok, true);
  assert.equal(report.target.endpoint, 'http://control.example.com:9527');
  assert.equal(report.summary.publicIpv4, '43.207.102.163');
  assert.equal(report.summary.blockers.includes('aws_public_udp_path_blocked'), true);
  assert.equal(report.summary.blockers.includes('aws_iam_role_missing'), true);
  assert.equal(report.summary.blockers.includes('aws_local_cli_missing'), true);
});
