'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  TRANSPORT_CONFIG_KEY,
  writeTransportConfig
} = require('../lib/cli/services/fabric/transport-config');
const {
  buildCloudUdpPolicyCheck,
  formatFabricClosureResumeCheckReport,
  runFabricClosureResumeCheckCommand
} = require('../lib/cli/services/fabric/closure-resume-check');

function createHandoffFile(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-resume-check-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const file = path.join(tempDir, 'handoff.json');
  fs.writeFileSync(file, `${JSON.stringify({
    schema: 'aih.fabric.closure-handoff.v1',
    target: {
      endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
      nodeId: 'aws-current-node',
      provider: 'opencode'
    },
    executionDecision: {
      decision: 'stop_awaiting_external_input',
      state: 'awaiting_external_input',
      canContinueWithoutInput: false
    },
    externalPrerequisites: [
      {
        id: 'cloud-udp-policy',
        requiredEvidence: 'SG/NACL readback or a controlled TURN/UDP path that proves packets can reach the target node.',
        commands: ['aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json']
      },
      {
        id: 'webtransport-h3-endpoint',
        requiredEvidence: 'Browser WebTransport handshake and stream/RPC smoke against an HTTPS/H3 endpoint.',
        commands: ['aih fabric transport webtransport --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json']
      },
      {
        id: 'multipath-underlay',
        requiredEvidence: 'Dual-ended MPTCP/OpenMPTCPRouter evidence plus transport smoke over the promoted underlay.',
        commands: ['aih fabric transport prerequisites --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --node-id aws-current-node --json']
      },
      {
        id: 'provider-credentials',
        requiredEvidence: 'Reauthenticated or replaced provider accounts on the target node, followed by a provider account audit that clears the auth blockers.'
      }
    ],
    failures: [
      {
        id: 'provider-codex-blocked',
        domain: 'provider_account',
        blockers: ['provider_account_unavailable:codex']
      },
      {
        id: 'provider-claude-blocked',
        domain: 'provider_account',
        blockers: ['provider_account_unavailable:claude']
      }
    ]
  }, null, 2)}\n`, 'utf8');
  return file;
}

function createStoreDeps(initial = null) {
  const store = new Map();
  if (initial) store.set(TRANSPORT_CONFIG_KEY, initial);
  return {
    aiHomeDir: '/tmp/aih-fabric-resume-check',
    env: {},
    readJsonValue: (_fs, _aiHomeDir, key) => store.get(key) || null,
    writeJsonValue: (_fs, _aiHomeDir, key, value) => store.set(key, value),
    runCloudEdgePreflight: async (options) => ({
      ok: true,
      summary: {
        cloudApiCredentialsReady: false,
        remoteAwsApiCredentialsReady: false,
        localAwsApiReadbackReady: false,
        localAwsApiCredentialsReady: false,
        blockers: ['aws_cli_missing', 'aws_iam_role_missing', 'aws_local_cli_missing']
      },
      cloudApi: {
        blockers: ['aws_cli_missing', 'aws_iam_role_missing', 'aws_local_cli_missing'],
        summary: {
          awsApiCredentialsReady: false,
          remoteAwsApiCredentialsReady: false,
          localAwsApiReadbackReady: false,
          localAwsApiCredentialsReady: false
        },
        remote: {
          awsCli: { available: false },
          imds: { iamRoleAvailable: false },
          blockers: ['aws_cli_missing', 'aws_iam_role_missing']
        },
        local: {
          awsCli: { available: false },
          summary: {
            awsApiReadbackReady: false,
            awsApiCredentialsReady: false
          },
          blockers: ['aws_local_cli_missing']
        }
      },
      probeOptions: options
    })
  };
}

function blockedProviderAudit() {
  return {
    ok: true,
    credentialHandoff: {
      providers: [
        {
          provider: 'codex',
          status: 'awaiting_operator_input',
          action: 'update_api_key',
          runtimeBlocked: 1,
          requiredInput: 'Update API key.'
        },
        {
          provider: 'claude',
          status: 'awaiting_operator_input',
          action: 'update_api_key',
          runtimeBlocked: 4,
          requiredInput: 'Update API key.'
        }
      ]
    }
  };
}

test('closure resume-check does not continue when no external input changed', async (t) => {
  const handoffFile = createHandoffFile(t);
  const calls = [];
  const report = await runFabricClosureResumeCheckCommand([
    '--handoff-file',
    handoffFile,
    '--json'
  ], {
    ...createStoreDeps(),
    runFabricProviderAccountsCommand: async (action, args) => {
      calls.push({ action, args });
      return blockedProviderAudit();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.json, true);
  assert.equal(report.resume.canContinueWithoutInput, false);
  assert.equal(report.resume.state, 'awaiting_external_input');
  assert.equal(report.resume.commands.length, 0);
  const cloudCheck = report.checks.find((item) => item.id === 'cloud-udp-policy');
  assert.equal(cloudCheck.status, 'unchanged');
  assert.equal(cloudCheck.cloudApi.cloudApiCredentialsReady, false);
  assert.equal(report.checks.find((item) => item.id === 'webtransport-h3-endpoint').status, 'unchanged');
  assert.equal(report.checks.find((item) => item.id === 'provider-credentials').changed, false);
  assert.equal(calls[0].action, 'audit');
  assert.equal(calls[0].args.includes('--endpoint'), true);
  assert.equal(JSON.stringify(report).includes('Update API key.'), true);

  const text = formatFabricClosureResumeCheckReport(report);
  assert.match(text, /can_continue: no/);
});

test('closure resume-check marks cloud UDP changed when read-only AWS readback is available', async (t) => {
  const handoffFile = createHandoffFile(t);
  const calls = [];
  const report = await runFabricClosureResumeCheckCommand([
    '--handoff-file',
    handoffFile,
    '--json',
    '--skip-provider-audit'
  ], {
    ...createStoreDeps(),
    runCloudEdgePreflight: async (options) => {
      calls.push(options);
      return {
        ok: true,
        summary: {
          cloudApiCredentialsReady: true,
          remoteAwsApiCredentialsReady: false,
          localAwsApiReadbackReady: true,
          localAwsApiCredentialsReady: true,
          blockers: []
        },
        cloudApi: {
          blockers: [],
          summary: {
            awsApiCredentialsReady: true,
            remoteAwsApiCredentialsReady: false,
            localAwsApiReadbackReady: true,
            localAwsApiCredentialsReady: true
          },
          remote: {
            awsCli: { available: false },
            imds: { iamRoleAvailable: false },
            blockers: ['aws_cli_missing', 'aws_iam_role_missing']
          },
          local: {
            awsCli: { available: true },
            summary: {
              awsApiReadbackReady: true,
              awsApiCredentialsReady: true
            },
            blockers: []
          }
        }
      };
    }
  });

  const cloudCheck = report.checks.find((item) => item.id === 'cloud-udp-policy');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].skipUdpProbe, true);
  assert.equal(cloudCheck.status, 'ready_to_recheck');
  assert.equal(cloudCheck.changed, true);
  assert.equal(cloudCheck.cloudApi.localAwsApiReadbackReady, true);
  assert.equal(report.resume.canContinueWithoutInput, true);
  assert.equal(
    report.resume.commands.includes('aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json'),
    true
  );
});

test('closure resume-check can skip cloud API readback explicitly', async (t) => {
  const handoffFile = createHandoffFile(t);
  const report = await runFabricClosureResumeCheckCommand([
    '--handoff-file',
    handoffFile,
    '--json',
    '--skip-provider-audit',
    '--skip-cloud-api-check'
  ], {
    ...createStoreDeps(),
    runCloudEdgePreflight: async () => {
      throw new Error('should not run');
    }
  });

  const cloudCheck = report.checks.find((item) => item.id === 'cloud-udp-policy');
  assert.equal(cloudCheck.status, 'unchecked');
  assert.equal(cloudCheck.changed, false);
  assert.equal(report.resume.canContinueWithoutInput, false);
});

test('cloud UDP policy check records cloud API readback failures instead of crashing', async () => {
  const error = new Error('ssh timeout');
  error.code = 'ssh_timeout';
  const check = await buildCloudUdpPolicyCheck({
    id: 'cloud-udp-policy',
    requiredEvidence: 'read SG/NACL',
    commands: ['aih fabric transport cloud-edge --json']
  }, {
    endpoint: 'http://aws.example:9527'
  }, {
    turnConfigured: false
  }, {}, {
    runCloudEdgePreflight: async () => {
      throw error;
    }
  });

  assert.equal(check.status, 'cloud_api_unavailable');
  assert.equal(check.changed, false);
  assert.equal(check.cloudApi.error.code, 'ssh_timeout');
});

test('closure resume-check continues only when stored external config changes', async (t) => {
  const handoffFile = createHandoffFile(t);
  const deps = createStoreDeps();
  writeTransportConfig({
    webtransport: {
      url: 'https://wt.example.com/fabric',
      pageUrl: 'https://wt.example.com/probe'
    }
  }, {}, deps);

  const report = await runFabricClosureResumeCheckCommand([
    '--handoff-file',
    handoffFile,
    '--json',
    '--skip-provider-audit'
  ], deps);

  assert.equal(report.resume.canContinueWithoutInput, true);
  assert.equal(report.resume.changedEvidenceCount, 1);
  assert.equal(report.checks.find((item) => item.id === 'webtransport-h3-endpoint').status, 'ready_to_recheck');
  assert.equal(report.checks.find((item) => item.id === 'provider-credentials').status, 'unchecked');
  assert.equal(
    report.resume.commands.includes('aih fabric transport webtransport --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json'),
    true
  );
  assert.equal(JSON.stringify(report).includes('wt.example.com'), true);
});

test('closure resume-check marks provider credentials changed when latest audit is ready', async (t) => {
  const handoffFile = createHandoffFile(t);
  const report = await runFabricClosureResumeCheckCommand([
    '--handoff-file',
    handoffFile,
    '--json'
  ], {
    ...createStoreDeps(),
    runFabricProviderAccountsCommand: async () => ({
      ok: true,
      credentialHandoff: {
        providers: [
          { provider: 'codex', status: 'ready', action: 'none', runtimeBlocked: 0 },
          { provider: 'claude', status: 'ready', action: 'none', runtimeBlocked: 0 }
        ]
      }
    })
  });

  const providerCheck = report.checks.find((item) => item.id === 'provider-credentials');
  assert.equal(providerCheck.status, 'ready_to_recheck');
  assert.equal(providerCheck.changed, true);
  assert.equal(report.resume.canContinueWithoutInput, true);
  assert.equal(
    report.resume.commands[0],
    'aih fabric closure verify --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --node-id aws-current-node --provider opencode --json'
  );
});

test('closure resume-check records provider audit failures instead of crashing', async (t) => {
  const handoffFile = createHandoffFile(t);
  const error = new Error('no server profile with a Management Key is ready');
  error.code = 'server_profile_not_ready';

  const report = await runFabricClosureResumeCheckCommand([
    '--handoff-file',
    handoffFile,
    '--json'
  ], {
    ...createStoreDeps(),
    runFabricProviderAccountsCommand: async () => {
      throw error;
    }
  });

  const providerCheck = report.checks.find((item) => item.id === 'provider-credentials');
  assert.equal(report.ok, true);
  assert.equal(providerCheck.status, 'audit_unavailable');
  assert.equal(providerCheck.changed, false);
  assert.equal(providerCheck.audit.ok, false);
  assert.equal(providerCheck.audit.error.code, 'server_profile_not_ready');
  assert.equal(report.resume.canContinueWithoutInput, false);
  assert.match(formatFabricClosureResumeCheckReport(report), /audit_unavailable/);
});

test('fabric command router routes closure resume-check JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'closure',
    'resume-check',
    '--handoff-file',
    '/tmp/handoff.json',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricClosureResumeCheckCommand: async (args) => {
      assert.deepEqual(args, ['--handoff-file', '/tmp/handoff.json', '--json']);
      return {
        ok: true,
        json: true,
        exitOk: true,
        schema: 'aih.fabric.closure-resume-check.v1',
        resume: { canContinueWithoutInput: false }
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.schema, 'aih.fabric.closure-resume-check.v1');
});
