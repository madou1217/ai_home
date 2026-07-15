'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_PROVIDERS,
  buildLocalExportArgs,
  buildRemoteCleanupCommand,
  buildRemoteEnvCommand,
  buildRemoteImportCommand,
  buildRemoteManagementReloadCommand,
  buildRemoteRuntimeAuditCommand,
  buildRemoteRuntimeBlockClearCommand,
  buildRemoteRegistryPublishCommand,
  buildRemoteReadyzCommand,
  parseAihExportSummary,
  parseAihImportSummary,
  parseArgs,
  parseProviders,
  runActivation,
  summarizeFabricNode
} = require('../scripts/fabric-runtime-account-activation');

function accountRef(value) {
  return `acct_${String(value).padStart(20, '0')}`;
}

test('parseArgs defaults to AWS current node and local-only mode', () => {
  const parsed = parseArgs([]);

  assert.equal(parsed.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(parsed.remoteDir, '/home/ubuntu/aih-fabric-current');
  assert.equal(parsed.nodeId, 'aws-current-node');
  assert.equal(parsed.port, 9527);
  assert.deepEqual(parsed.providers, DEFAULT_PROVIDERS);
  assert.equal(parsed.remoteDryRun, false);
  assert.equal(parsed.apply, false);
});

test('parseArgs requires explicit yes before credentials cross machines', () => {
  assert.throws(
    () => parseArgs(['--remote-dry-run']),
    /--yes is required/
  );
  assert.throws(
    () => parseArgs(['--apply']),
    /--yes is required/
  );
  assert.throws(
    () => parseArgs(['--remote-revalidate']),
    /--yes is required before clearing remote runtime blockers/
  );
});

test('parseArgs allows remote audit without credential-transfer confirmation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-audit-'));
  try {
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(key, 'key');

    const parsed = parseArgs([
      '--remote-audit',
      '--ssh-key',
      key
    ]);

    assert.equal(parsed.remoteAudit, true);
    assert.equal(parsed.remoteDryRun, false);
    assert.equal(parsed.apply, false);
    assert.equal(parsed.yes, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseArgs allows remote revalidation with explicit runtime-state confirmation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-revalidate-'));
  try {
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(key, 'key');

    const parsed = parseArgs([
      '--remote-revalidate',
      '--yes',
      '--ssh-key',
      key
    ]);

    assert.equal(parsed.remoteRevalidate, true);
    assert.equal(parsed.remoteAudit, false);
    assert.equal(parsed.remoteDryRun, false);
    assert.equal(parsed.apply, false);
    assert.equal(parsed.yes, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runActivation remote audit does not create or transfer an account archive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-audit-run-'));
  try {
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(key, 'key');
    const options = parseArgs(['--remote-audit', '--ssh-key', key]);
    const commands = [];

    const report = await runActivation(options, {
      runRemote: async (_options, command) => {
        commands.push(command);
        if (String(command).includes('/readyz')) {
          return { status: 0, stdout: '{"ok":true,"ready":true}', stderr: '' };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            mode: 'remote-runtime-audit',
            readOnly: true,
            target: { deployedGitHead: 'abc123' },
            providers: [],
            summary: {
              dbPresent: true,
              stateRows: 1,
              accountCount: 1,
              runtimeBlocked: 1,
              clearableRuntimeBlocks: 1
            }
          }),
          stderr: ''
        };
      },
      copyToRemote: async () => {
        throw new Error('copy must not run during remote audit');
      }
    });

    assert.equal(report.mode, 'remote-audit');
    assert.equal(report.localArchive, null);
    assert.equal(report.remote, null);
    assert.equal(report.remoteAudit.readOnly, true);
    assert.deepEqual(report.readyz, { ok: true, ready: true });
    assert.equal(commands.length, 2);
    assert.match(commands[0], /app-state\.db/);
    assert.match(commands[1], /\/readyz/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runActivation remote revalidation clears runtime blockers and runs real session guards without transferring archives', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-revalidate-run-'));
  try {
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(key, 'key');
    const options = parseArgs(['--remote-revalidate', '--yes', '--ssh-key', key, '--providers', 'codex,opencode']);
    const remoteCommands = [];
    const localCommands = [];

    const auditPayload = (runtimeBlocked) => JSON.stringify({
      ok: true,
      mode: 'remote-runtime-audit',
      readOnly: true,
      target: { deployedGitHead: 'abc123' },
      providers: [{
        provider: 'codex',
        runtimeBlocked,
        runtimeReasonCounts: runtimeBlocked > 0 ? [{ reason: 'auth_invalid:upstream_401', count: runtimeBlocked }] : []
      }],
      summary: {
        dbPresent: true,
        stateRows: 2,
        accountCount: 2,
        runtimeBlocked,
        clearableRuntimeBlocks: runtimeBlocked
      }
    });

    const report = await runActivation(options, {
      sleep: async () => {},
      runRemote: async (_options, command) => {
        remoteCommands.push(command);
        if (String(command).includes('/readyz')) {
          return { status: 0, stdout: '{"ok":true,"ready":true}', stderr: '' };
        }
        if (String(command).includes('clearRuntimeBlock')) {
          return { status: 0, stdout: '{"ok":true,"cleared":2,"skipped":0}', stderr: '' };
        }
        if (String(command).includes('/v0/management/reload')) {
          return { status: 0, stdout: '{"ok":true,"reloaded":4}', stderr: '' };
        }
        if (String(command).includes('registry')) {
          return { status: 0, stdout: '{"ok":true,"runtimes":4,"providers":["codex","opencode"]}', stderr: '' };
        }
        const auditCount = remoteCommands.filter((entry) => String(entry).includes('app-state.db')).length;
        return { status: 0, stdout: auditPayload(auditCount === 1 ? 2 : (auditCount === 2 ? 0 : 2)), stderr: '' };
      },
      waitForRuntimeRegistry: async () => ({
        ok: true,
        attempts: 1,
        node: {
          found: true,
          runtimeHost: true,
          runtimeProviders: ['codex', 'opencode'],
          runtimeGaps: []
        }
      }),
      runLocalCli: async (args) => {
        localCommands.push(args);
        if (args.includes('nodes')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              targetNode: {
                id: 'aws-current-node',
                capabilities: { runtimeHost: true, runtimeProviders: ['codex', 'opencode'] }
              }
            }),
            stderr: ''
          };
        }
        return {
          status: 1,
          stdout: JSON.stringify({
            ok: false,
            blocked: true,
            http: { registryAuthorizedStatus: 200, sessionStartStatus: 0 },
            blockers: [`provider_account_unavailable:${args[args.indexOf('--provider') + 1]}`]
          }),
          stderr: ''
        };
      },
      copyToRemote: async () => {
        throw new Error('copy must not run during remote revalidation');
      }
    });

    assert.equal(report.mode, 'remote-revalidate');
    assert.equal(report.localArchive, null);
    assert.equal(report.remote, null);
    assert.equal(report.runtimeBlockClear.cleared, 2);
    assert.equal(report.postClearAudit.summary.runtimeBlocked, 0);
    assert.equal(report.postSessionAudit.summary.runtimeBlocked, 2);
    assert.equal(report.sessionStarts.length, 2);
    assert.deepEqual(report.sessionStarts.map((item) => item.provider), ['codex', 'opencode']);
    assert.equal(report.conclusion.status, 'credentials_still_invalid');
    assert.equal(localCommands.filter((args) => args.includes('start')).length, 2);
    assert.equal(remoteCommands.some((command) => String(command).includes('/tmp/aih-runtime-accounts')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runActivation remote revalidation classifies marker success and event runtime blockers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-revalidate-events-'));
  try {
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(key, 'key');
    const options = parseArgs(['--remote-revalidate', '--yes', '--ssh-key', key, '--providers', 'agy,opencode']);
    const remoteCommands = [];
    const markersByRunId = new Map();

    const auditPayload = (runtimeBlocked) => JSON.stringify({
      ok: true,
      mode: 'remote-runtime-audit',
      readOnly: true,
      target: { deployedGitHead: 'abc123' },
      providers: [
        {
          provider: 'agy',
          runtimeBlocked,
          runtimeReasonCounts: runtimeBlocked > 0 ? [{ reason: 'auth_invalid:agy_not_signed_in', count: runtimeBlocked }] : []
        },
        {
          provider: 'opencode',
          runtimeBlocked: 0,
          runtimeReasonCounts: []
        }
      ],
      summary: {
        dbPresent: true,
        stateRows: 2,
        accountCount: 2,
        runtimeBlocked,
        clearableRuntimeBlocks: runtimeBlocked
      }
    });

    const report = await runActivation(options, {
      sleep: async () => {},
      runRemote: async (_options, command) => {
        remoteCommands.push(command);
        if (String(command).includes('/readyz')) {
          return { status: 0, stdout: '{"ok":true,"ready":true}', stderr: '' };
        }
        if (String(command).includes('clearRuntimeBlock')) {
          return { status: 0, stdout: '{"ok":true,"cleared":1,"skipped":0}', stderr: '' };
        }
        if (String(command).includes('/v0/management/reload')) {
          return { status: 0, stdout: '{"ok":true,"reloaded":2}', stderr: '' };
        }
        if (String(command).includes('registry')) {
          return { status: 0, stdout: '{"ok":true,"runtimes":2,"providers":["agy","opencode"]}', stderr: '' };
        }
        const auditCount = remoteCommands.filter((entry) => String(entry).includes('app-state.db')).length;
        return { status: 0, stdout: auditPayload(auditCount === 2 ? 0 : 1), stderr: '' };
      },
      waitForRuntimeRegistry: async () => ({
        ok: true,
        attempts: 1,
        node: {
          found: true,
          runtimeHost: true,
          runtimeProviders: ['agy', 'opencode'],
          runtimeGaps: []
        }
      }),
      runLocalCli: async (args) => {
        if (args.includes('start')) {
          const provider = args[args.indexOf('--provider') + 1];
          const prompt = args[args.indexOf('--prompt') + 1];
          const marker = prompt.match(/Reply with (.+) only\./)[1];
          const runId = `${provider}-run`;
          markersByRunId.set(runId, marker);
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              blocked: false,
              http: { registryAuthorizedStatus: 200, sessionStartStatus: 200 },
              transportDecision: { selectedTransportKind: 'webrtc', fallbackUsed: false },
              result: { accepted: true, provider, accountRef: accountRef(1), runId }
            }),
            stderr: ''
          };
        }

        const runId = args[args.indexOf('--run-id') + 1];
        if (runId === 'agy-run') {
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              result: {
                status: 'completed',
                cursor: 2,
                events: [
                  { seq: 1, type: 'ready', runId },
                  { seq: 2, type: 'terminal-output', text: `Reply with ${markersByRunId.get(runId)} only.`, runId },
                  {
                    seq: 3,
                    type: 'runtime-blocked',
                    provider: 'agy',
                    accountRef: accountRef(1),
                    status: 'auth_invalid',
                    reason: 'agy_not_signed_in',
                    runId
                  }
                ]
              },
              summary: { completed: true, cursor: 3, eventCount: 3, eventTypes: { ready: 1, 'terminal-output': 1, 'runtime-blocked': 1 } }
            }),
            stderr: ''
          };
        }

        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              status: 'completed',
              cursor: 3,
              events: [
                { seq: 1, type: 'ready', runId },
                { seq: 2, type: 'result', content: markersByRunId.get(runId), runId },
                { seq: 3, type: 'done', content: markersByRunId.get(runId), runId }
              ]
            },
            summary: { completed: true, cursor: 3, eventCount: 3, eventTypes: { ready: 1, result: 1, done: 1 } }
          }),
          stderr: ''
        };
      },
      copyToRemote: async () => {
        throw new Error('copy must not run during remote revalidation');
      }
    });

    assert.equal(report.conclusion.status, 'provider_session_validated');
    assert.deepEqual(report.conclusion.providersStarted, ['agy', 'opencode']);
    assert.deepEqual(report.conclusion.providersValidated, ['opencode']);
    assert.deepEqual(report.conclusion.providersBlocked, ['agy']);
    assert.equal(report.sessionStarts[0].blocked, true);
    assert.equal(report.sessionStarts[0].events.runtimeBlocked, true);
    assert.equal(report.sessionStarts[0].markerFound, false);
    assert.equal(report.sessionStarts[1].markerFound, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runActivation remote revalidation retries transient remote transport unavailability', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-revalidate-retry-'));
  try {
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(key, 'key');
    const options = parseArgs(['--remote-revalidate', '--yes', '--ssh-key', key, '--providers', 'opencode']);
    const remoteCommands = [];
    let startAttempts = 0;
    let marker = '';
    let slept = false;

    const auditPayload = () => JSON.stringify({
      ok: true,
      mode: 'remote-runtime-audit',
      readOnly: true,
      target: { deployedGitHead: 'abc123' },
      providers: [{ provider: 'opencode', runtimeBlocked: 0, runtimeReasonCounts: [] }],
      summary: {
        dbPresent: true,
        stateRows: 1,
        accountCount: 1,
        runtimeBlocked: 0,
        clearableRuntimeBlocks: 0
      }
    });

    const report = await runActivation(options, {
      sleep: async () => {
        slept = true;
      },
      runRemote: async (_options, command) => {
        remoteCommands.push(command);
        if (String(command).includes('/readyz')) {
          return { status: 0, stdout: '{"ok":true,"ready":true}', stderr: '' };
        }
        if (String(command).includes('clearRuntimeBlock')) {
          return { status: 0, stdout: '{"ok":true,"cleared":0,"skipped":1}', stderr: '' };
        }
        if (String(command).includes('/v0/management/reload')) {
          return { status: 0, stdout: '{"ok":true,"reloaded":1}', stderr: '' };
        }
        if (String(command).includes('registry')) {
          return { status: 0, stdout: '{"ok":true,"runtimes":1,"providers":["opencode"]}', stderr: '' };
        }
        return { status: 0, stdout: auditPayload(), stderr: '' };
      },
      waitForRuntimeRegistry: async () => ({
        ok: true,
        attempts: 1,
        node: {
          found: true,
          runtimeHost: true,
          runtimeProviders: ['opencode'],
          runtimeGaps: []
        }
      }),
      runLocalCli: async (args) => {
        if (args.includes('start')) {
          startAttempts += 1;
          marker = args[args.indexOf('--prompt') + 1].match(/Reply with (.+) only\./)[1];
          if (startAttempts === 1) {
            return {
              status: 1,
              stdout: JSON.stringify({
                ok: false,
                blockers: ['remote_transport_unavailable'],
                http: { registryAuthorizedStatus: 200, sessionStartStatus: 503 }
              }),
              stderr: ''
            };
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              http: { registryAuthorizedStatus: 200, sessionStartStatus: 200 },
              result: { provider: 'opencode', accountRef: accountRef(1), runId: 'opencode-run' }
            }),
            stderr: ''
          };
        }

        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              status: 'completed',
              cursor: 2,
              events: [
                { seq: 1, type: 'ready', runId: 'opencode-run' },
                { seq: 2, type: 'done', content: marker, runId: 'opencode-run' }
              ]
            },
            summary: { completed: true, cursor: 2, eventCount: 2, eventTypes: { ready: 1, done: 1 } }
          }),
          stderr: ''
        };
      },
      copyToRemote: async () => {
        throw new Error('copy must not run during remote revalidation');
      }
    });

    assert.equal(slept, true);
    assert.equal(report.conclusion.status, 'provider_session_validated');
    assert.deepEqual(report.conclusion.providersTransportUnavailable, []);
    assert.equal(report.sessionStarts[0].startAttempts, 2);
    assert.deepEqual(report.sessionStarts[0].startHistory.map((item) => item.sessionStartStatus), [503, 200]);
    assert.equal(report.sessionStarts[0].markerFound, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runActivation remote revalidation continues through blocked provider accounts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-revalidate-pool-'));
  try {
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(key, 'key');
    const options = parseArgs(['--remote-revalidate', '--yes', '--ssh-key', key, '--providers', 'claude']);
    const markersByRunId = new Map();
    let startCount = 0;

    const auditPayload = () => JSON.stringify({
      ok: true,
      mode: 'remote-runtime-audit',
      readOnly: true,
      target: { deployedGitHead: 'abc123' },
      providers: [{
        provider: 'claude',
        accountCount: 2,
        runtimeBlocked: 0,
        runtimeReasonCounts: []
      }],
      summary: {
        dbPresent: true,
        stateRows: 2,
        accountCount: 2,
        runtimeBlocked: 0,
        clearableRuntimeBlocks: 0
      }
    });

    const report = await runActivation(options, {
      sleep: async () => {},
      runRemote: async (_options, command) => {
        if (String(command).includes('/readyz')) {
          return { status: 0, stdout: '{"ok":true,"ready":true}', stderr: '' };
        }
        if (String(command).includes('clearRuntimeBlock')) {
          return { status: 0, stdout: '{"ok":true,"cleared":0,"skipped":2}', stderr: '' };
        }
        if (String(command).includes('/v0/management/reload')) {
          return { status: 0, stdout: '{"ok":true,"reloaded":2}', stderr: '' };
        }
        if (String(command).includes('registry')) {
          return { status: 0, stdout: '{"ok":true,"runtimes":1,"providers":["claude"]}', stderr: '' };
        }
        return { status: 0, stdout: auditPayload(), stderr: '' };
      },
      waitForRuntimeRegistry: async () => ({
        ok: true,
        attempts: 1,
        node: {
          found: true,
          runtimeHost: true,
          runtimeProviders: ['claude'],
          runtimeGaps: []
        }
      }),
      runLocalCli: async (args) => {
        if (args.includes('start')) {
          startCount += 1;
          const marker = args[args.indexOf('--prompt') + 1].match(/Reply with (.+) only\./)[1];
          const runId = `claude-run-${startCount}`;
          markersByRunId.set(runId, marker);
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              http: { registryAuthorizedStatus: 200, sessionStartStatus: 200 },
              result: { provider: 'claude', accountRef: accountRef(startCount), runId }
            }),
            stderr: ''
          };
        }

        const runId = args[args.indexOf('--run-id') + 1];
        if (runId === 'claude-run-1') {
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              result: {
                status: 'completed',
                cursor: 2,
                events: [
                  { seq: 1, type: 'ready', runId },
                  {
                    seq: 2,
                    type: 'runtime-blocked',
                    provider: 'claude',
                    accountRef: accountRef(1),
                    status: 'auth_invalid',
                    reason: 'claude_not_logged_in',
                    runId
                  }
                ]
              },
              summary: { completed: true, cursor: 2, eventCount: 2, eventTypes: { ready: 1, 'runtime-blocked': 1 } }
            }),
            stderr: ''
          };
        }

        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              status: 'completed',
              cursor: 2,
              events: [
                { seq: 1, type: 'ready', runId },
                { seq: 2, type: 'done', content: markersByRunId.get(runId), runId }
              ]
            },
            summary: { completed: true, cursor: 2, eventCount: 2, eventTypes: { ready: 1, done: 1 } }
          }),
          stderr: ''
        };
      },
      copyToRemote: async () => {
        throw new Error('copy must not run during remote revalidation');
      }
    });

    assert.equal(startCount, 2);
    assert.equal(report.conclusion.status, 'provider_session_validated');
    assert.deepEqual(report.conclusion.providersValidated, ['claude']);
    assert.equal(report.sessionStarts[0].accountRef, accountRef(2));
    assert.equal(report.sessionStarts[0].providerAttemptCount, 2);
    assert.equal(report.sessionStarts[0].providerAttemptLimit, 2);
    assert.deepEqual(report.sessionStarts[0].providerAttemptHistory.map((item) => item.accountRef), [accountRef(1), accountRef(2)]);
    assert.equal(report.sessionStarts[0].providerRuntimeBlocks.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runActivation remote revalidation keeps provider blocked when pool ends with missing account', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-revalidate-missing-tail-'));
  try {
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(key, 'key');
    const options = parseArgs(['--remote-revalidate', '--yes', '--ssh-key', key, '--providers', 'claude']);
    let startCount = 0;

    const auditPayload = () => JSON.stringify({
      ok: true,
      mode: 'remote-runtime-audit',
      readOnly: true,
      target: { deployedGitHead: 'abc123' },
      providers: [{
        provider: 'claude',
        accountCount: 2,
        runtimeBlocked: 0,
        runtimeReasonCounts: []
      }],
      summary: {
        dbPresent: true,
        stateRows: 2,
        accountCount: 2,
        runtimeBlocked: 0,
        clearableRuntimeBlocks: 0
      }
    });

    const report = await runActivation(options, {
      sleep: async () => {},
      runRemote: async (_options, command) => {
        if (String(command).includes('/readyz')) {
          return { status: 0, stdout: '{"ok":true,"ready":true}', stderr: '' };
        }
        if (String(command).includes('clearRuntimeBlock')) {
          return { status: 0, stdout: '{"ok":true,"cleared":0,"skipped":2}', stderr: '' };
        }
        if (String(command).includes('/v0/management/reload')) {
          return { status: 0, stdout: '{"ok":true,"reloaded":2}', stderr: '' };
        }
        if (String(command).includes('registry')) {
          return { status: 0, stdout: '{"ok":true,"runtimes":1,"providers":["claude"]}', stderr: '' };
        }
        return { status: 0, stdout: auditPayload(), stderr: '' };
      },
      waitForRuntimeRegistry: async () => ({
        ok: true,
        attempts: 1,
        node: {
          found: true,
          runtimeHost: true,
          runtimeProviders: ['claude'],
          runtimeGaps: []
        }
      }),
      runLocalCli: async (args) => {
        if (args.includes('start')) {
          startCount += 1;
          if (startCount === 2) {
            return {
              status: 1,
              stdout: JSON.stringify({
                ok: false,
                error: 'missing_account_id',
                blockers: ['missing_account_id'],
                http: { registryAuthorizedStatus: 200, sessionStartStatus: 500 }
              }),
              stderr: ''
            };
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              ok: true,
              http: { registryAuthorizedStatus: 200, sessionStartStatus: 200 },
              result: { provider: 'claude', accountRef: accountRef(1), runId: 'claude-run-1' }
            }),
            stderr: ''
          };
        }

        return {
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              status: 'completed',
              cursor: 2,
              events: [
                { seq: 1, type: 'ready', runId: 'claude-run-1' },
                {
                  seq: 2,
                  type: 'runtime-blocked',
                  provider: 'claude',
                  accountRef: accountRef(1),
                  status: 'auth_invalid',
                  reason: 'claude_not_logged_in',
                  runId: 'claude-run-1'
                }
              ]
            },
            summary: { completed: true, cursor: 2, eventCount: 2, eventTypes: { ready: 1, 'runtime-blocked': 1 } }
          }),
          stderr: ''
        };
      },
      copyToRemote: async () => {
        throw new Error('copy must not run during remote revalidation');
      }
    });

    assert.equal(startCount, 2);
    assert.equal(report.conclusion.status, 'credentials_still_invalid');
    assert.deepEqual(report.conclusion.providersBlocked, ['claude']);
    assert.equal(report.sessionStarts[0].providerAttemptCount, 2);
    assert.equal(report.sessionStarts[0].providerRuntimeBlocks.length, 1);
    assert.deepEqual(report.sessionStarts[0].providerAttemptHistory.map((item) => item.accountRef), [accountRef(1), '']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseArgs accepts existing accounts zip and provider subset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-account-activation-'));
  try {
    const zip = path.join(root, 'accounts.zip');
    const key = path.join(root, 'aws.pem');
    fs.writeFileSync(zip, 'zip');
    fs.writeFileSync(key, 'key');

    const parsed = parseArgs([
      '--accounts',
      zip,
      '--ssh-key',
      key,
      '--providers',
      'codex,claude',
      '--remote-dry-run',
      '--yes'
    ]);

    assert.equal(parsed.accountsZip, zip);
    assert.equal(parsed.sshKey, key);
    assert.deepEqual(parsed.providers, ['codex', 'claude']);
    assert.equal(parsed.remoteDryRun, true);
    assert.equal(parsed.apply, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseProviders rejects unsupported providers', () => {
  assert.deepEqual(parseProviders('codex,claude,codex'), ['codex', 'claude']);
  assert.throws(
    () => parseProviders('codex,unknown'),
    /unsupported provider: unknown/
  );
});

test('buildLocalExportArgs uses standard provider selectors', () => {
  const args = buildLocalExportArgs({ providers: ['codex', 'agy'] }, '/tmp/accounts.zip');

  assert.deepEqual(args, [
    'bin/ai-home.js',
    'export',
    '/tmp/accounts.zip',
    'codex',
    'agy'
  ]);
});

test('remote commands scope runtime state to AWS current dir and default port', () => {
  const options = {
    remoteDir: '/home/ubuntu/aih-fabric-current',
    nodeId: 'aws-current-node',
    port: 9527
  };

  const env = buildRemoteEnvCommand(options);
  assert.match(env, /cd '\/home\/ubuntu\/aih-fabric-current'/);
  assert.match(env, /export AIH_HOST_HOME='\/home\/ubuntu\/aih-fabric-current\/\.aih-host-home'/);
  assert.match(env, /node-v22\.16\.0-linux-x64\/bin/);
  assert.match(env, /node_modules\/\.bin/);

  const dryRunImport = buildRemoteImportCommand(options, '/tmp/accounts.zip', { dryRun: true });
  assert.match(dryRunImport, /node bin\/ai-home\.js import '\/tmp\/accounts\.zip' --dry-run/);

  const applyImport = buildRemoteImportCommand(options, '/tmp/accounts.zip', { dryRun: false });
  assert.match(applyImport, /node bin\/ai-home\.js import '\/tmp\/accounts\.zip'$/);

  assert.match(buildRemoteReadyzCommand(options), /http:\/\/127\.0\.0\.1:9527\/readyz/);
  const reload = buildRemoteManagementReloadCommand(options);
  assert.match(reload, /server-config-store/);
  assert.doesNotMatch(reload, /server-config\.json/);
  assert.match(reload, /http:\/\/127\.0\.0\.1:9527\/v0\/management\/reload/);
  assert.match(reload, /authorization:.*Bearer .*key/);
  assert.doesNotMatch(reload, /--management-key/);

  const audit = buildRemoteRuntimeAuditCommand({ ...options, providers: ['codex', 'claude'] });
  assert.match(audit, /readOnly:true/);
  assert.match(audit, /app-state\.db/);
  assert.match(audit, /DEPLOYED_GIT_HEAD/);
  assert.match(audit, /codex/);
  assert.match(audit, /claude/);
  assert.doesNotMatch(audit, /OPENAI_API_KEY/);
  assert.doesNotMatch(audit, /ANTHROPIC_AUTH_TOKEN/);
  assert.doesNotMatch(audit, /refresh_token/);

  const clearBlocks = buildRemoteRuntimeBlockClearCommand({ ...options, providers: ['codex', 'agy'] });
  assert.match(clearBlocks, /account\/state-index/);
  assert.match(clearBlocks, /account\/state-service/);
  assert.match(clearBlocks, /manual_admin_clear/);
  assert.match(clearBlocks, /clearRuntimeBlock\(accountRef,provider,/);
  assert.match(clearBlocks, /codex/);
  assert.match(clearBlocks, /agy/);
  assert.doesNotMatch(clearBlocks, /OPENAI_API_KEY/);
  assert.doesNotMatch(clearBlocks, /ANTHROPIC_AUTH_TOKEN/);

  const publish = buildRemoteRegistryPublishCommand(options);
  assert.match(publish, /registry-agent-management-key-store/);
  assert.match(publish, /readRegistryAgentManagementKey/);
  assert.doesNotMatch(publish, /\.token/);
  assert.doesNotMatch(publish, /run\/fabric\/tokens/);
  assert.match(publish, /server-config-store/);
  assert.doesNotMatch(publish, /server-config\.json/);
  assert.match(publish, /registry/);
  assert.match(publish, /publish/);
  assert.match(publish, /--from-server/);
  assert.doesNotMatch(publish, /AIH_FABRIC_TOKEN/);
  assert.match(publish, /AIH_MANAGEMENT_KEY:storedManagementKey\|\|managementKey/);
  assert.doesNotMatch(publish, /--token/);
  assert.doesNotMatch(publish, /--management-key/);
  assert.equal(buildRemoteCleanupCommand('/tmp/accounts.zip'), "rm -f '/tmp/accounts.zip'");
});

test('parseAihExportSummary and parseAihImportSummary avoid credential material', () => {
  const exportSummary = parseAihExportSummary('\u001b[90m[aih]\u001b[0m providers=agy, claude, codex accounts=12 files=12 skipped=1');
  assert.deepEqual(exportSummary, {
    providers: ['agy', 'claude', 'codex'],
    accounts: 12,
    files: 12,
    skipped: 1
  });

  const importSummary = parseAihImportSummary([
    '\u001b[36m[aih]\u001b[0m import summary',
    '  - zip: source=/tmp/accounts.zip imported=3 duplicates=2 invalid=1 failed=0',
    '  - json: source=/tmp/extra.json imported=1 duplicates=0 invalid=0 failed=0'
  ].join('\n'));

  assert.deepEqual(importSummary, {
    sources: 2,
    imported: 4,
    duplicates: 2,
    invalid: 1,
    failed: 0
  });
});

test('summarizeFabricNode reports runtime providers and gaps', () => {
  const summary = summarizeFabricNode({
    targetNode: {
      id: 'aws-current-node',
      capabilities: {
        runtimeHost: true,
        runtimeProviders: ['codex', 'claude']
      },
      runtimeGaps: [{
        provider: 'agy',
        blocker: 'missing_provider_account:agy'
      }]
    }
  }, 'aws-current-node');

  assert.equal(summary.found, true);
  assert.equal(summary.runtimeHost, true);
  assert.deepEqual(summary.runtimeProviders, ['codex', 'claude']);
  assert.deepEqual(summary.runtimeGaps, [{
    provider: 'agy',
    blocker: 'missing_provider_account:agy'
  }]);
});
