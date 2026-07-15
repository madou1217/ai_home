'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildSessionStartUrl,
  formatReport,
  parseArgs,
  runFabricSessionStartClient
} = require('../lib/cli/services/fabric/session-start-client');
const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  saveControlPlaneProfile
} = require('../lib/server/control-plane-profile-store');

const ACCOUNT_REF = 'acct_11111111111111111111';

function createAiHome(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-session-start-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

function saveProfile(aiHomeDir, overrides = {}) {
  return saveControlPlaneProfile({
    id: 'cp-aws',
    name: 'AWS Current',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    connectionMode: 'direct',
    state: 'ready',
    managementKey: 'management-secret',
    ...overrides
  }, { active: true }, { fs, aiHomeDir }).profile;
}

function createNodesReport(action) {
  return {
    ok: true,
    http: { authorizedStatus: 200 },
    targetNode: {
      id: 'aws-current-node',
      name: 'AWS Current Node',
      capabilities: { runtimeHost: action.enabled === true },
      runtimeGaps: action.enabled ? [] : [{ provider: 'codex', blocker: 'missing_provider_runtime:codex' }],
      projects: [{
        id: 'project-1',
        name: 'aih-fabric-current',
        displayPath: '/home/ubuntu/aih-fabric-current'
      }],
      actions: [action]
    }
  };
}

test('fabric session start parser accepts positional node and start options', () => {
  const options = parseArgs([
    'aws-current-node',
    '--provider',
    'codex',
    '--prompt',
    'hello',
    '--json'
  ], {
    HOME: '/Users/example',
    AIH_HOST_HOME: '/Users/example'
  });

  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.provider, 'codex');
  assert.equal(options.prompt, 'hello');
  assert.equal(options.aiHomeDir, '/Users/example/.ai_home');
  assert.equal(options.json, true);
});

test('fabric session start returns inventory blockers without posting when action is disabled', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);

  const report = await runFabricSessionStartClient({
    aiHomeDir,
    nodeId: 'aws-current-node',
    provider: 'codex',
    timeoutMs: 1000
  }, {
    runFabricNodesClient: async () => createNodesReport({
      id: 'start-session:codex',
      label: 'Start codex',
      enabled: false,
      eligible: false,
      blockers: ['missing_provider_runtime:codex'],
      provider: 'codex',
      runtimeStatus: 'missing'
    }),
    fetchImpl: async () => {
      throw new Error('session start should not be posted');
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.blocked, true);
  assert.deepEqual(report.blockers, ['missing_provider_runtime:codex']);
  assert.equal(report.http.sessionStartStatus, 0);
  assert.equal(JSON.stringify(report).includes('management-secret'), false);
  assert.match(formatReport(report), /missing_provider_runtime:codex/);
});

test('fabric session start posts protected device session start when action is enabled', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);
  const requests = [];

  const report = await runFabricSessionStartClient({
    aiHomeDir,
    nodeId: 'local-mac-remote-node',
    provider: 'codex',
    prompt: 'real prompt',
    accountRef: ACCOUNT_REF,
    model: 'gpt-5.5',
    timeoutMs: 1000
  }, {
    runFabricNodesClient: async () => ({
      ok: true,
      http: { authorizedStatus: 200 },
      targetNode: {
        id: 'local-mac-remote-node',
        name: 'Local Mac Remote Node',
        capabilities: { runtimeHost: true },
        runtimeGaps: [],
        projects: [{
          id: 'local-project',
          name: 'ai_home',
          displayPath: '/Users/model/projects/feature/ai_home'
        }],
        actions: [{
          id: 'start-session:codex',
          label: 'Start codex',
          enabled: true,
          eligible: true,
          blockers: [],
          provider: 'codex',
          runtimeId: 'local-codex',
          runtimeStatus: 'available'
        }]
      }
    }),
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.node_session_start',
          transport: { id: 'local-mac-relay', kind: 'relay', endpoint: 'relay://local-mac-remote-node' },
          transportDecision: {
            transportPurpose: 'stream',
            selectedTransportId: 'local-mac-relay',
            selectedTransportKind: 'relay',
            fallbackUsed: false,
            fallbackFrom: [],
            rejectedTransports: []
          },
          result: {
            accepted: true,
            runId: 'run-1',
            sessionId: 'run-1',
            status: 'running'
          }
        })
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.blocked, false);
  assert.equal(report.result.runId, 'run-1');
  assert.deepEqual(report.transport, { id: 'local-mac-relay', kind: 'relay' });
  assert.equal(report.transportDecision.transportPurpose, 'stream');
  assert.equal(report.transportDecision.selectedTransportKind, 'relay');
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    buildSessionStartUrl('http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527')
  );
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.authorization, 'Bearer management-secret');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    nodeId: 'local-mac-remote-node',
    provider: 'codex',
    accountRef: ACCOUNT_REF,
    prompt: 'real prompt',
    projectPath: '/Users/model/projects/feature/ai_home',
    model: 'gpt-5.5',
    sessionId: ''
  });
  assert.equal(JSON.stringify(report).includes('management-secret'), false);
  assert.equal(JSON.stringify(report).includes('relay://local-mac-remote-node'), false);
  assert.match(formatReport(report), /run-1/);
  assert.match(formatReport(report), /transport: kind=relay id=local-mac-relay/);
});

test('fabric command router routes session start JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'session',
    'start',
    'local-mac-remote-node',
    '--provider',
    'codex',
    '--prompt',
    'hello',
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
    runFabricSessionStartClientCommand: async (args) => {
      assert.deepEqual(args, ['local-mac-remote-node', '--provider', 'codex', '--prompt', 'hello', '--json']);
      return {
        ok: true,
        json: true,
        target: { nodeId: 'local-mac-remote-node', provider: 'codex' },
        result: { runId: 'run-1' },
        blockers: []
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.result.runId, 'run-1');
});
