'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  buildActivationArgs,
  buildCredentialHandoff,
  buildProviderAccountAuthJobUrl,
  buildProviderAccountReauthUrl,
  formatFabricProviderAccountsReport,
  parseAuthJobArgs,
  parseRemoteTargetArgs,
  parseReauthArgs,
  resolveRemoteActivationArgs,
  runFabricProviderAccountsCommand
} = require('../lib/cli/services/fabric/provider-accounts');

const AGY_ACCOUNT_REF = 'acct_11111111111111111111';
const CODEX_ACCOUNT_REF = 'acct_42424242424242424242';

test('provider accounts command maps audit and revalidate to activation modes', () => {
  assert.deepEqual(buildActivationArgs('audit', ['--providers', 'codex']), [
    '--remote-audit',
    '--providers',
    'codex'
  ]);
  assert.deepEqual(buildActivationArgs('revalidate', ['--yes', '--providers', 'opencode']), [
    '--remote-revalidate',
    '--yes',
    '--providers',
    'opencode'
  ]);
  assert.throws(
    () => buildActivationArgs('apply', []),
    /unknown provider accounts command/
  );
});

test('provider accounts credential handoff distinguishes API key and OAuth blockers', () => {
  const handoff = buildCredentialHandoff({
    remoteAudit: {
      providers: [
        {
          provider: 'codex',
          accountCount: 1,
          configured: 1,
          apiKeyMode: 1,
          runtimeBlocked: 1,
          clearableRuntimeBlocks: 1,
          authModeCounts: [{ reason: 'api-key', count: 1 }],
          sampleClearableAccountRefs: ['acct_22222222222222222222']
        },
        {
          provider: 'agy',
          accountCount: 7,
          configured: 7,
          apiKeyMode: 0,
          runtimeBlocked: 7,
          clearableRuntimeBlocks: 7,
          authModeCounts: [{ reason: 'oauth', count: 7 }],
          sampleClearableAccountRefs: [AGY_ACCOUNT_REF]
        },
        {
          provider: 'opencode',
          accountCount: 1,
          configured: 1,
          apiKeyMode: 0,
          runtimeBlocked: 0,
          clearableRuntimeBlocks: 0,
          authModeCounts: [{ reason: 'opencode-auth', count: 1 }]
        }
      ]
    }
  }, 'https://control.example.com:9527');

  const codex = handoff.providers.find((item) => item.provider === 'codex');
  const agy = handoff.providers.find((item) => item.provider === 'agy');
  const opencode = handoff.providers.find((item) => item.provider === 'opencode');

  assert.equal(handoff.status, 'awaiting_operator_input');
  assert.equal(handoff.summary.ready, 1);
  assert.equal(handoff.summary.awaitingInput, 2);
  assert.equal(codex.action, 'update_api_key');
  assert.equal(codex.requiredInput.includes('API key'), true);
  assert.equal(codex.commands.some((command) => command.includes('provider accounts reauth')), false);
  assert.equal(agy.action, 'complete_oauth_reauth');
  assert.equal(agy.commands[0], `aih fabric provider accounts reauth --provider agy --account-ref ${AGY_ACCOUNT_REF} --endpoint https://control.example.com:9527 --json`);
  assert.equal(opencode.status, 'ready');
});

test('provider accounts command delegates to runtime activation without transferring credentials', async () => {
  const calls = [];
  const report = await runFabricProviderAccountsCommand('audit', ['--providers', 'codex', '--json'], {
    parseRuntimeAccountActivationArgs: (args) => {
      calls.push({ type: 'parse', args });
      return {
        json: args.includes('--json'),
        providers: ['codex'],
        remoteAudit: true
      };
    },
    runRuntimeAccountActivation: async (options) => {
      calls.push({ type: 'run', options });
      return {
        ok: true,
        mode: 'remote-audit',
        target: {
          nodeId: 'aws-current-node',
          ssh: 'ubuntu@example.com',
          remoteDir: '/home/ubuntu/aih-fabric-current',
          providers: ['codex']
        },
        localArchive: null,
        remote: null,
        remoteAudit: {
          ok: true,
          readOnly: true,
          summary: {
            dbPresent: true,
            accountCount: 1,
            stateRows: 1,
            runtimeBlocked: 1,
            clearableRuntimeBlocks: 1
          },
          providers: [{
            provider: 'codex',
            accountCount: 1,
            configured: 1,
            apiKeyMode: 1,
            stateRows: 1,
            runtimeBlocked: 1,
            clearableRuntimeBlocks: 1,
            authModeCounts: [{ reason: 'api-key', count: 1 }],
            runtimeReasonCounts: [{ reason: 'auth_invalid:upstream_401', count: 1 }]
          }]
        }
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.json, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.localArchive, null);
  assert.equal(report.remote, null);
  assert.equal(report.credentialHandoff.providers[0].action, 'update_api_key');
  assert.deepEqual(calls[0], {
    type: 'parse',
    args: ['--remote-audit', '--providers', 'codex', '--json']
  });
  assert.equal(calls[1].options.remoteAudit, true);
  assert.match(formatFabricProviderAccountsReport(report), /AIH Fabric provider accounts/);
  assert.match(formatFabricProviderAccountsReport(report), /auth_invalid:upstream_401=1/);
  assert.match(formatFabricProviderAccountsReport(report), /credential_handoff: awaiting_operator_input/);
  assert.match(formatFabricProviderAccountsReport(report), /codex: update_api_key/);
});

test('provider accounts command resolves endpoint profile to ssh activation target', async () => {
  const calls = [];
  const report = await runFabricProviderAccountsCommand('audit', [
    '--endpoint',
    'https://control.example.com:9527',
    '--providers',
    'codex',
    '--json'
  ], {
    env: { HOME: '/tmp/home' },
    runFabricNodesClient: async (options) => {
      calls.push({ type: 'nodes', options });
      return {
        ok: true,
        target: { endpoint: 'https://control.example.com:9527' },
        targetNode: {
          id: 'server-node-1',
          localSshBindings: [{
            target: 'ubuntu@control.example.com',
            remoteRoot: '/srv/aih-current'
          }]
        }
      };
    },
    parseRuntimeAccountActivationArgs: (args) => {
      calls.push({ type: 'parse', args });
      return { json: args.includes('--json'), remoteAudit: true };
    },
    runRuntimeAccountActivation: async () => ({
      ok: true,
      mode: 'remote-audit',
      target: {
        nodeId: 'server-node-1',
        ssh: 'ubuntu@control.example.com',
        remoteDir: '/srv/aih-current',
        providers: ['codex']
      }
    })
  });

  assert.equal(report.ok, true);
  assert.deepEqual(calls[0], {
    type: 'nodes',
    options: {
      aiHomeDir: '/tmp/home/.ai_home',
      endpoint: 'https://control.example.com:9527',
      profileId: '',
      nodeId: ''
    }
  });
  assert.deepEqual(calls[1], {
    type: 'parse',
    args: [
      '--remote-audit',
      '--providers',
      'codex',
      '--json',
      '--node-id',
      'server-node-1',
      '--ssh',
      'ubuntu@control.example.com',
      '--remote-dir',
      '/srv/aih-current',
      '--port',
      '9527'
    ]
  });
});

test('provider accounts endpoint resolution requires ssh binding or explicit ssh target', async () => {
  await assert.rejects(
    () => resolveRemoteActivationArgs(['--providers', 'codex'], {
      aiHomeDir: '/tmp/home/.ai_home',
      endpoint: 'https://control.example.com',
      profileId: ''
    }, {
      runFabricNodesClient: async () => ({
        ok: true,
        target: { endpoint: 'https://control.example.com' },
        targetNode: { id: 'server-node-1', localSshBindings: [] }
      })
    }),
    /target node has no local SSH binding/
  );

  const resolved = await resolveRemoteActivationArgs([
    '--providers',
    'codex',
    '--ssh',
    'ubuntu@manual.example.com',
    '--remote-dir',
    '/opt/aih'
  ], {
    aiHomeDir: '/tmp/home/.ai_home',
    endpoint: 'https://control.example.com',
    profileId: ''
  }, {
    runFabricNodesClient: async () => ({
      ok: true,
      target: { endpoint: 'https://control.example.com' },
      targetNode: { id: 'server-node-1', localSshBindings: [] }
    })
  });

  assert.deepEqual(resolved, [
    '--providers',
    'codex',
    '--ssh',
    'ubuntu@manual.example.com',
    '--remote-dir',
    '/opt/aih',
    '--node-id',
    'server-node-1',
    '--port',
    '443'
  ]);
});

test('provider accounts remote target parser strips profile flags from activation args', () => {
  const parsed = parseRemoteTargetArgs([
    '--endpoint',
    'https://control.example.com',
    '--profile-id',
    'cp-1',
    '--providers',
    'codex',
    '--json'
  ], { HOME: '/tmp/home' });

  assert.equal(parsed.endpoint, 'https://control.example.com');
  assert.equal(parsed.profileId, 'cp-1');
  assert.equal(parsed.aiHomeDir, '/tmp/home/.ai_home');
  assert.deepEqual(parsed.activationArgs, ['--providers', 'codex', '--json']);
});

test('provider accounts reauth uses Server Management Key without printing it', async () => {
  const requests = [];
  const report = await runFabricProviderAccountsCommand('reauth', [
    '--provider',
    'codex',
    '--account-ref',
    CODEX_ACCOUNT_REF,
    '--json'
  ], {
    env: { HOME: '/tmp/home' },
    listControlPlaneProfiles: () => ({
      activeProfileId: 'profile-1',
      profiles: [{
        id: 'profile-1',
        name: 'AWS Current',
        endpoint: 'https://control.example.com',
        state: 'ready',
        connectionMode: 'remote',
        managementKey: 'management-secret'
      }]
    }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.provider_account_reauth',
          result: {
            ok: true,
            provider: 'codex',
            targetAccountRef: CODEX_ACCOUNT_REF,
            authMode: 'oauth-browser',
            status: 'pending',
            jobId: 'job-42',
            authorizationUrl: 'https://login.example.com/oauth'
          }
        })
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.mode, 'remote-reauth');
  assert.equal(report.json, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.result.jobId, 'job-42');
  assert.equal(requests[0].url, buildProviderAccountReauthUrl('https://control.example.com'));
  assert.equal(requests[0].options.headers.authorization, 'Bearer management-secret');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    provider: 'codex',
    accountRef: CODEX_ACCOUNT_REF,
    waitMs: 3000
  });
  const text = formatFabricProviderAccountsReport(report);
  assert.match(text, /remote-reauth/);
  assert.match(text, /job-42/);
  assert.match(text, new RegExp(`target_account_ref: ${CODEX_ACCOUNT_REF}`));
  assert.match(text, /authorization_url: https:\/\/login\.example\.com\/oauth/);
  assert.doesNotMatch(JSON.stringify(report), /management-secret/);
  assert.doesNotMatch(text, /management-secret/);
});

test('provider accounts reauth parser accepts positional provider and accountRef', () => {
  const options = parseReauthArgs(['codex', CODEX_ACCOUNT_REF, '--endpoint', 'https://control.example.com']);
  assert.equal(options.provider, 'codex');
  assert.equal(options.accountRef, CODEX_ACCOUNT_REF);
  assert.equal(options.endpoint, 'https://control.example.com');
  assert.equal(options.waitMs, 3000);
});

test('provider accounts auth-job parser accepts status alias and callback code', () => {
  const status = parseAuthJobArgs(['status', '--job-id', 'job-42', '--endpoint', 'https://control.example.com']);
  assert.equal(status.action, 'get');
  assert.equal(status.jobId, 'job-42');
  assert.equal(status.endpoint, 'https://control.example.com');

  const callback = parseAuthJobArgs(['callback', '--job-id', 'job-42', '--code', '4/0AgyAuthorizationCode']);
  assert.equal(callback.action, 'callback');
  assert.equal(callback.jobId, 'job-42');
  assert.equal(callback.callbackUrl, '4/0AgyAuthorizationCode');
});

test('provider accounts auth-job uses Server Management Key without printing it', async () => {
  const requests = [];
  const report = await runFabricProviderAccountsCommand('auth-job', [
    'cancel',
    '--job-id',
    'job-42',
    '--json'
  ], {
    env: { HOME: '/tmp/home' },
    listControlPlaneProfiles: () => ({
      activeProfileId: 'profile-1',
      profiles: [{
        id: 'profile-1',
        name: 'AWS Current',
        endpoint: 'https://control.example.com',
        state: 'ready',
        connectionMode: 'remote',
        managementKey: 'management-secret'
      }]
    }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        status: 200,
        ok: true,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.provider_account_auth_job',
          result: {
            action: 'cancel',
            job: {
              id: 'job-42',
              provider: 'agy',
              accountRef: AGY_ACCOUNT_REF,
              status: 'cancelled',
              authProgressState: 'cancelled'
            }
          }
        })
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.mode, 'remote-auth-job');
  assert.equal(report.action, 'cancel');
  assert.equal(report.result.job.id, 'job-42');
  assert.equal(requests[0].url, buildProviderAccountAuthJobUrl('https://control.example.com', 'cancel', 'job-42'));
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.authorization, 'Bearer management-secret');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    jobId: 'job-42',
    callbackUrl: ''
  });
  const text = formatFabricProviderAccountsReport(report);
  assert.match(text, /remote-auth-job/);
  assert.match(text, /action: cancel/);
  assert.match(text, /job: job-42/);
  assert.doesNotMatch(JSON.stringify(report), /management-secret/);
  assert.doesNotMatch(text, /management-secret/);
});

test('fabric command router routes provider accounts JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'provider',
    'accounts',
    'audit',
    '--providers',
    'codex',
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
    runFabricProviderAccountsCommand: async (action, args) => {
      assert.equal(action, 'audit');
      assert.deepEqual(args, ['--providers', 'codex', '--json']);
      return {
        ok: true,
        json: true,
        exitOk: true,
        mode: 'remote-audit'
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.mode, 'remote-audit');
});

test('fabric command router routes provider accounts reauth JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'provider',
    'accounts',
    'reauth',
    '--provider',
    'codex',
    '--account-ref',
    CODEX_ACCOUNT_REF,
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
    runFabricProviderAccountsCommand: async (action, args) => {
      assert.equal(action, 'reauth');
      assert.deepEqual(args, ['--provider', 'codex', '--account-ref', CODEX_ACCOUNT_REF, '--json']);
      return {
        ok: true,
        json: true,
        exitOk: true,
        mode: 'remote-reauth',
        result: { jobId: 'job-42' }
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.mode, 'remote-reauth');
  assert.equal(payload.result.jobId, 'job-42');
});

test('fabric command router routes provider accounts auth-job JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'provider',
    'accounts',
    'auth-job',
    'get',
    '--job-id',
    'job-42',
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
    runFabricProviderAccountsCommand: async (action, args) => {
      assert.equal(action, 'auth-job');
      assert.deepEqual(args, ['get', '--job-id', 'job-42', '--json']);
      return {
        ok: true,
        json: true,
        exitOk: true,
        mode: 'remote-auth-job',
        action: 'get',
        result: { job: { id: 'job-42' } }
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.mode, 'remote-auth-job');
  assert.equal(payload.result.job.id, 'job-42');
});
