'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildPromptParts,
  parseArgs,
  runSessionRecoverySmoke,
  writeDiagnosticsFile
} = require('../scripts/fabric-real-session-recovery-smoke');

const ACCOUNT_REF = 'acct_11111111111111111111';

function createJsonResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload)
  };
}

function createRelayHandle(label) {
  let resolveExit;
  const handle = {
    label,
    child: {
      pid: 12345,
      kill: () => {
        handle.exited = true;
        handle.exitCode = 0;
        resolveExit(handle);
      }
    },
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: '',
    exited: false,
    exitPromise: null
  };
  handle.exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  return handle;
}

test('session recovery parser defaults to AWS broker and local default port', () => {
  const options = parseArgs([
    '--token-file',
    '/tmp/broker-token',
    '--server-id',
    'Local Mac Recovery',
    '--node-id',
    'M5-Recovery-Node',
    '--interrupt',
    'broker'
  ], {});

  assert.equal(options.brokerEndpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.localUrl, 'http://127.0.0.1:9527');
  assert.equal(options.serverId, 'local-mac-recovery');
  assert.equal(options.nodeId, 'm5-recovery-node');
  assert.equal(options.interrupt, 'broker');
});

test('buildPromptParts keeps expected marker out of the prompt text', () => {
  const prompt = buildPromptParts('AIH_M5_RECOVERY_START_OK');

  assert.equal(prompt.marker, 'AIH_M5_RECOVERY_START_OK_20260628');
  assert.equal(prompt.prompt.includes(prompt.marker), false);
  assert.match(prompt.prompt, /AIH M5 RECOVERY START OK 20260628/);
});

test('runSessionRecoverySmoke resumes the same session after broker interruption', async () => {
  const localUrl = 'http://127.0.0.1:9527';
  const brokerEndpoint = 'http://broker.example.test:9527';
  const proxyBase = `${brokerEndpoint}/v0/fabric/broker/servers/m5-test/proxy`;
  let brokerOnline = false;
  let connectCount = 0;
  let messageSent = false;
  const fetches = [];

  const result = await runSessionRecoverySmoke({
    brokerEndpoint,
    localUrl,
    hostHome: os.tmpdir(),
    serverId: 'm5-test',
    nodeId: 'm5-test-node',
    token: 'secret-token',
    managementKey: 'management-secret',
    sessionProvider: 'codex',
    sessionAccountRef: ACCOUNT_REF,
    sessionModel: 'gpt-5.5',
    sessionProjectPath: '/work/ai_home',
    interrupt: 'broker',
    timeoutMs: 1000,
    sessionTimeoutMs: 1000
  }, {
    connectFabricBroker: async (options) => {
      assert.equal(options.brokerUrl, brokerEndpoint);
      assert.equal(options.localUrl, localUrl);
      brokerOnline = true;
      connectCount += 1;
      return {
        sessionId: `broker-session-${connectCount}`,
        close: () => {
          brokerOnline = false;
        },
        closed: Promise.resolve({ ok: true, reason: 'closed' })
      };
    },
    resolveExistingNodeManagementKey: () => ({
      key: 'node-management-key',
      source: 'test',
      passCliArg: true
    }),
    prepareExistingEndpointStores: () => ({
      managementKey: 'management-secret',
      node: { id: 'm5-test-node' }
    }),
    spawnAihProcess: createRelayHandle,
    fetchImpl: async (url, options = {}) => {
      fetches.push({ url, method: options.method || 'GET' });
      if (url === `${localUrl}/readyz`) {
        return createJsonResponse(200, { ok: true, ready: true });
      }
      if (url === `${proxyBase}/readyz`) {
        if (!brokerOnline) {
          return createJsonResponse(503, {
            ok: false,
            error: 'fabric_broker_server_offline',
            brokerStatus: {
              online: false,
              lastDisconnected: {
                disconnectReason: 'broker_server_link_closed'
              }
            }
          });
        }
        return createJsonResponse(200, { ok: true, ready: true });
      }
      assert.equal(brokerOnline, true, `unexpected proxied request while broker offline: ${url}`);
      assert.equal(options.headers.authorization, 'Bearer management-secret');
      const parsed = new URL(url);
      const route = parsed.pathname.replace('/v0/fabric/broker/servers/m5-test/proxy', '');
      if (route === '/v0/node-rpc/device-nodes') {
        return createJsonResponse(200, {
          ok: true,
          result: {
            nodes: [{
              id: 'm5-test-node',
              connection: {
                status: 'online',
                transportKind: 'relay',
                transportId: 'm5-test-node-relay'
              }
            }]
          }
        });
      }
      if (route === '/v0/node-rpc/device-node-session-start') {
        return createJsonResponse(200, {
          ok: true,
          result: { runId: 'run-m5-recovery-1' }
        });
      }
      if (route === '/v0/node-rpc/device-node-session-run-events') {
        const cursor = Number(parsed.searchParams.get('cursor')) || 0;
        if (!messageSent && cursor < 10) {
          return createJsonResponse(200, {
            ok: true,
            result: {
              cursor: 10,
              events: [{
                cursor: 10,
                type: 'terminal-output',
                text: 'AIH_M5_RECOVERY_START_OK_20260628'
              }]
            }
          });
        }
        if (messageSent && cursor < 20) {
          return createJsonResponse(200, {
            ok: true,
            result: {
              cursor: 20,
              events: [{
                cursor: 20,
                type: 'terminal-output',
                text: 'AIH_M5_RECOVERY_MESSAGE_OK_20260628'
              }]
            }
          });
        }
        return createJsonResponse(200, {
          ok: true,
          result: { cursor, events: [] }
        });
      }
      if (route === '/v0/node-rpc/device-node-session-ack') {
        return createJsonResponse(200, {
          ok: true,
          result: { accepted: true, cursor: 10 }
        });
      }
      if (route === '/v0/node-rpc/device-node-session-attach') {
        return createJsonResponse(200, {
          ok: true,
          result: { sessionId: 'run-m5-recovery-1', cursor: 10, snapshot: { events: [] } }
        });
      }
      if (route === '/v0/node-rpc/device-node-session-command') {
        const body = JSON.parse(options.body || '{}');
        if (body.type === 'message') messageSent = true;
        return createJsonResponse(200, {
          ok: true,
          result: { accepted: true, type: body.type, cursor: messageSent ? 20 : 10 }
        });
      }
      throw new Error(`unexpected route: ${route}`);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(connectCount, 2);
  assert.equal(result.broker.firstSessionId, 'broker-session-1');
  assert.equal(result.broker.interruption.secondSessionId, 'broker-session-2');
  assert.equal(result.broker.interruption.offline.error, 'fabric_broker_server_offline');
  assert.equal(result.session.beforeInterruptCursor, 10);
  assert.equal(result.session.finalCursor, 20);
  assert.equal(result.session.duplicateEventsAfterRecovery, 0);
  assert.equal(result.session.cursorAdvanced, true);
  assert.deepEqual(result.authentication, { method: 'management_key', configured: true });
  assert.equal(JSON.stringify(result).includes('management-secret'), false);
  assert.equal(fetches.some((entry) => entry.url.endsWith('/device-node-session-attach') && entry.method === 'POST'), true);
});

test('runSessionRecoverySmoke observes relay offline before relay recovery', async () => {
  const localUrl = 'http://127.0.0.1:9527';
  const brokerEndpoint = 'http://broker.example.test:9527';
  const proxyBase = `${brokerEndpoint}/v0/fabric/broker/servers/m5-relay/proxy`;
  let relayOnline = false;
  let messageSent = false;
  let relaySpawnCount = 0;

  const result = await runSessionRecoverySmoke({
    brokerEndpoint,
    localUrl,
    hostHome: os.tmpdir(),
    serverId: 'm5-relay',
    nodeId: 'm5-relay-node',
    token: 'secret-token',
    managementKey: 'management-secret',
    sessionProjectPath: '/work/ai_home',
    interrupt: 'relay',
    timeoutMs: 1000,
    sessionTimeoutMs: 1000
  }, {
    connectFabricBroker: async () => ({
      sessionId: 'broker-session-relay',
      close: () => {},
      closed: Promise.resolve({ ok: true })
    }),
    resolveExistingNodeManagementKey: () => ({
      key: 'node-management-key',
      source: 'test',
      passCliArg: true
    }),
    prepareExistingEndpointStores: () => ({
      managementKey: 'management-secret',
      node: { id: 'm5-relay-node' }
    }),
    spawnAihProcess: (label) => {
      relaySpawnCount += 1;
      relayOnline = true;
      const handle = createRelayHandle(label);
      const originalKill = handle.child.kill;
      handle.child.kill = () => {
        relayOnline = false;
        originalKill();
      };
      return handle;
    },
    fetchImpl: async (url, options = {}) => {
      if (url === `${localUrl}/readyz` || url === `${proxyBase}/readyz`) {
        return createJsonResponse(200, { ok: true, ready: true });
      }
      const parsed = new URL(url);
      const route = parsed.pathname.replace('/v0/fabric/broker/servers/m5-relay/proxy', '');
      assert.equal(options.headers.authorization, 'Bearer management-secret');
      if (route === '/v0/node-rpc/device-nodes') {
        return createJsonResponse(200, {
          ok: true,
          result: {
            nodes: [{
              id: 'm5-relay-node',
              connection: relayOnline
                ? { status: 'online', transportKind: 'relay', transportId: 'm5-relay-node-relay' }
                : { status: 'offline', transportKind: 'relay', transportId: 'm5-relay-node-relay' }
            }]
          }
        });
      }
      if (route === '/v0/node-rpc/device-node-session-start') {
        return createJsonResponse(200, { ok: true, result: { runId: 'run-m5-relay-1' } });
      }
      if (route === '/v0/node-rpc/device-node-session-run-events') {
        const cursor = Number(parsed.searchParams.get('cursor')) || 0;
        if (!messageSent && cursor < 10) {
          return createJsonResponse(200, {
            ok: true,
            result: {
              cursor: 10,
              events: [{ cursor: 10, type: 'terminal-output', text: 'AIH_M5_RECOVERY_START_OK_20260628' }]
            }
          });
        }
        if (messageSent && cursor < 20) {
          return createJsonResponse(200, {
            ok: true,
            result: {
              cursor: 20,
              events: [{ cursor: 20, type: 'terminal-output', text: 'AIH_M5_RECOVERY_MESSAGE_OK_20260628' }]
            }
          });
        }
        return createJsonResponse(200, { ok: true, result: { cursor, events: [] } });
      }
      if (route === '/v0/node-rpc/device-node-session-attach' && !relayOnline) {
        return createJsonResponse(502, { ok: false, error: 'remote_node_session_attach_failed' });
      }
      if (route === '/v0/node-rpc/device-node-session-attach') {
        return createJsonResponse(200, {
          ok: true,
          result: { sessionId: 'run-m5-relay-1', cursor: 10, snapshot: { events: [] } }
        });
      }
      if (route === '/v0/node-rpc/device-node-session-ack') {
        return createJsonResponse(200, { ok: true, result: { accepted: true, cursor: 10 } });
      }
      if (route === '/v0/node-rpc/device-node-session-command') {
        const body = JSON.parse(options.body || '{}');
        if (body.type === 'message') messageSent = true;
        return createJsonResponse(200, {
          ok: true,
          result: { accepted: true, type: body.type, cursor: messageSent ? 20 : 10 }
        });
      }
      throw new Error(`unexpected route: ${route}`);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(relaySpawnCount, 2);
  assert.equal(result.broker.interruption.kind, 'relay');
  assert.equal(result.broker.interruption.offline.nodeStatus, 'offline');
  assert.equal(result.broker.interruption.offlineAttach.status, 502);
  assert.equal(result.session.messageMarkerFound, true);
  assert.equal(result.session.duplicateEventsAfterRecovery, 0);
  assert.deepEqual(result.authentication, { method: 'management_key', configured: true });
  assert.equal(JSON.stringify(result).includes('management-secret'), false);
});

test('writeDiagnosticsFile creates a sanitized JSON export target', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-m5-recovery-diag-'));
  const file = path.join(tempRoot, 'diagnostics', 'report.json');

  assert.equal(writeDiagnosticsFile(file, { ok: true }), file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
