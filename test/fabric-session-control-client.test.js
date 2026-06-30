'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildSessionCommandUrl,
  buildSessionControlPayload,
  buildSessionRunEventsUrl,
  formatReport,
  parseArgs,
  runFabricSessionControlClient
} = require('../lib/cli/services/fabric/session-control-client');
const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  saveControlPlaneProfile
} = require('../lib/server/control-plane-profile-store');

function createAiHome(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-session-control-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return aiHomeDir;
}

function saveProfile(aiHomeDir, overrides = {}) {
  return saveControlPlaneProfile({
    id: 'cp-aws',
    name: 'AWS Current',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    connectionMode: 'direct',
    state: 'paired',
    authState: 'paired',
    deviceToken: 'device-token',
    ...overrides
  }, { active: true }, { fs, aiHomeDir }).profile;
}

test('fabric session control parser accepts node run and message options', () => {
  const options = parseArgs('message', [
    'local-mac-remote-node',
    '--run-id',
    'run-1',
    '--text',
    'hello',
    '--json'
  ], {
    HOME: '/Users/example',
    AIH_HOST_HOME: '/Users/example'
  });

  assert.equal(options.action, 'message');
  assert.equal(options.nodeId, 'local-mac-remote-node');
  assert.equal(options.runId, 'run-1');
  assert.equal(options.text, 'hello');
  assert.equal(options.aiHomeDir, '/Users/example/.ai_home');
  assert.equal(options.json, true);
});

test('fabric session events uses protected GET and summarizes terminal output', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);
  const requests = [];

  const report = await runFabricSessionControlClient({
    aiHomeDir,
    action: 'events',
    nodeId: 'local-mac-remote-node',
    runId: 'run-1',
    cursor: 7,
    limit: 100,
    timeoutMs: 1000
  }, {
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.node_session_run_events',
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
            runId: 'run-1',
            cursor: 9,
            events: [
              { cursor: 8, type: 'ready' },
              { cursor: 9, type: 'terminal-output', text: 'AIH_SESSION_EVENT_OK' }
            ]
          }
        })
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.cursor, 9);
  assert.equal(report.summary.eventCount, 2);
  assert.equal(report.summary.eventTypes.ready, 1);
  assert.match(report.summary.terminalTail, /AIH_SESSION_EVENT_OK/);
  assert.deepEqual(report.transport, { id: 'local-mac-relay', kind: 'relay' });
  assert.equal(report.transportDecision.selectedTransportKind, 'relay');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.headers.authorization, 'Bearer device-token');
  assert.equal(requests[0].init.body, undefined);
  assert.equal(
    requests[0].url,
    buildSessionRunEventsUrl('http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527', {
      nodeId: 'local-mac-remote-node',
      runId: 'run-1',
      cursor: 7,
      limit: 100
    })
  );
  assert.equal(JSON.stringify(report).includes('device-token'), false);
  assert.equal(JSON.stringify(report).includes('relay://local-mac-remote-node'), false);
  assert.match(formatReport(report), /terminal-output=1/);
  assert.match(formatReport(report), /transport: kind=relay id=local-mac-relay/);
});

test('fabric session message posts protected command payload', async (t) => {
  const aiHomeDir = createAiHome(t);
  saveProfile(aiHomeDir);
  const requests = [];

  const report = await runFabricSessionControlClient({
    aiHomeDir,
    action: 'message',
    nodeId: 'local-mac-remote-node',
    runId: 'run-1',
    text: 'hello',
    timeoutMs: 1000
  }, {
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          rpc: 'control_plane.device.node_session_command',
          result: {
            accepted: true,
            type: 'message',
            sessionId: 'run-1',
            runId: 'run-1'
          }
        })
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    buildSessionCommandUrl('http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527')
  );
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.authorization, 'Bearer device-token');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    nodeId: 'local-mac-remote-node',
    sessionId: 'run-1',
    type: 'message',
    text: 'hello',
    idempotencyKey: buildSessionControlPayload({
      action: 'message',
      nodeId: 'local-mac-remote-node',
      runId: 'run-1',
      text: 'hello'
    }).idempotencyKey
  });
  assert.equal(JSON.stringify(report).includes('device-token'), false);
});

test('fabric session slash and stop build expected command payloads', () => {
  assert.deepEqual(buildSessionControlPayload({
    action: 'slash',
    nodeId: 'local-mac-remote-node',
    runId: 'run-1',
    slashCommand: '/status'
  }), {
    nodeId: 'local-mac-remote-node',
    sessionId: 'run-1',
    type: 'slash',
    command: '/status',
    idempotencyKey: buildSessionControlPayload({
      action: 'slash',
      nodeId: 'local-mac-remote-node',
      runId: 'run-1',
      slashCommand: '/status'
    }).idempotencyKey
  });

  assert.deepEqual(buildSessionControlPayload({
    action: 'stop',
    nodeId: 'local-mac-remote-node',
    runId: 'run-1'
  }), {
    nodeId: 'local-mac-remote-node',
    sessionId: 'run-1',
    type: 'stop',
    scope: 'run',
    idempotencyKey: buildSessionControlPayload({
      action: 'stop',
      nodeId: 'local-mac-remote-node',
      runId: 'run-1',
      scope: 'run'
    }).idempotencyKey
  });
});

test('fabric command router routes session control JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'session',
    'stop',
    'local-mac-remote-node',
    '--run-id',
    'run-1',
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
    runFabricSessionControlClientCommand: async (command, args) => {
      assert.equal(command, 'stop');
      assert.deepEqual(args, ['local-mac-remote-node', '--run-id', 'run-1', '--json']);
      return {
        ok: true,
        json: true,
        target: { nodeId: 'local-mac-remote-node', runId: 'run-1', action: 'stop' },
        result: { accepted: true, type: 'stop' },
        blockers: []
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.result.type, 'stop');
});
