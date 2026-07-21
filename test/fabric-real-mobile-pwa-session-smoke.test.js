'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMobileBrowserInput,
  createNodeInviteUrl,
  mobileBrowserClientEvaluate,
  parseArgs,
  prepareNodeViaApi,
  resolveServerManagementKey,
  runMobilePwaSessionSmoke
} = require('../scripts/fabric-real-mobile-pwa-session-smoke');

const ACCOUNT_REF = 'acct_11111111111111111111';

test('mobile pwa smoke parseArgs accepts AWS default-port session options', () => {
  const options = parseArgs([
    '--endpoint',
    'http://control.example.com:9527/',
    '--client-endpoint',
    'http://control.example.com:9527',
    '--host-home',
    '/Users/model',
    '--node-id',
    'm4-8-7-mobile-node',
    '--management-key',
    'cli-management-key',
    '--session-provider',
    'codex',
    '--session-account-ref',
    ACCOUNT_REF,
    '--session-model',
    'gpt-5.5',
    '--session-project',
    '/repo/project',
    '--existing-node',
    '--timeout-ms',
    '30000',
    '--session-timeout-ms',
    '60000',
    '--headed'
  ], { AIH_MANAGEMENT_KEY: 'env-management-key' });

  assert.equal(options.endpoint, 'http://control.example.com:9527');
  assert.equal(options.clientEndpoint, 'http://control.example.com:9527');
  assert.equal(options.hostHome, '/Users/model');
  assert.equal(options.nodeId, 'm4-8-7-mobile-node');
  assert.equal(options.managementKey, 'cli-management-key');
  assert.equal(options.managementKeySource, 'cli');
  assert.equal(options.sessionProvider, 'codex');
  assert.equal(options.sessionAccountRef, ACCOUNT_REF);
  assert.equal(options.sessionModel, 'gpt-5.5');
  assert.equal(options.sessionProjectPath, '/repo/project');
  assert.equal(options.existingNode, true);
  assert.equal(options.timeoutMs, 30000);
  assert.equal(options.sessionTimeoutMs, 60000);
  assert.equal(options.headed, true);
});

test('mobile pwa smoke creates only a node join invite with Management Key auth', async () => {
  const requests = [];
  const invite = await createNodeInviteUrl({
    endpoint: 'http://control.example.com:9527',
    nodeId: 'm4-8-7-mobile-node',
    managementKey: 'server-management-key'
  }, {
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        authorization: options.headers.authorization,
        body: JSON.parse(String(options.body || '{}'))
      });
      return new Response(JSON.stringify({
        ok: true,
        joinUrl: 'http://control.example.com:9527/v0/node-rpc/join?code=node-code',
        invite: { id: 'invite-node' }
      }), { status: 200 });
    }
  });

  assert.equal(invite.joinUrl, 'http://control.example.com:9527/v0/node-rpc/join?code=node-code');
  assert.equal(invite.nodeInviteId, 'invite-node');
  assert.deepEqual(Object.keys(invite).sort(), ['joinUrl', 'nodeInviteId']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://control.example.com:9527/v0/webui/nodes/invites');
  assert.equal(requests[0].authorization, 'Bearer server-management-key');
  assert.equal(requests[0].body.nodeId, 'm4-8-7-mobile-node');
  assert.deepEqual(requests[0].body.capabilities, ['status', 'sessions']);
  assert.deepEqual(Object.keys(requests[0].body).sort(), [
    'bootstrapTarget',
    'capabilities',
    'controlEndpoint',
    'name',
    'nodeId',
    'preferredTransports',
    'transportKind'
  ]);
});

test('mobile pwa smoke joins the temporary node without extra client authorization', async () => {
  const requests = [];
  const prepared = await prepareNodeViaApi({
    nodeId: 'm4-8-7-mobile-node',
    nodeManagementKey: 'node-secret',
    joinUrl: 'http://control.example.com:9527/v0/node-rpc/join?code=node-code'
  }, {
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        body: JSON.parse(String(options.body || '{}'))
      });
      return new Response(JSON.stringify({
        ok: true,
        node: { id: 'm4-8-7-mobile-node' }
      }), { status: 200 });
    }
  });

  assert.equal(prepared.nodeManagementKey, 'node-secret');
  assert.deepEqual(Object.keys(prepared).sort(), ['node', 'nodeManagementKey', 'preparation']);
  assert.equal(requests[0].body.node.managementKey, 'node-secret');
  assert.equal(requests[0].body.node.transportKind, 'relay');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/v0\/node-rpc\/join\?code=node-code$/);
});

test('mobile pwa smoke resolves Management Key without exposing obsolete client credentials', () => {
  assert.deepEqual(
    resolveServerManagementKey({ managementKey: 'cli-secret', managementKeySource: 'cli' }, {
      key: 'configured-secret',
      source: 'server-config'
    }),
    { key: 'cli-secret', source: 'cli' }
  );
  assert.deepEqual(
    resolveServerManagementKey({}, { key: 'configured-secret', source: 'server-config' }),
    { key: 'configured-secret', source: 'server-config' }
  );
  assert.throws(
    () => resolveServerManagementKey({}, { key: 'generated-secret', source: 'generated' }),
    /missing Management Key/
  );

  const browserInput = buildMobileBrowserInput({
    clientEndpoint: 'http://server.example.com:9527',
    nodeId: 'existing-node',
    sessionProvider: 'codex',
    sessionAccountRef: '',
    sessionModel: 'gpt-5.5',
    sessionProjectPath: '/repo',
    sessionTimeoutMs: 5000
  }, 'server-management-key');
  assert.equal(browserInput.managementKey, 'server-management-key');
  assert.deepEqual(Object.keys(browserInput).sort(), ['endpoint', 'managementKey', 'nodeId', 'session']);
});

test('mobile pwa existing-node smoke uses Management Key directly without creating invites', async () => {
  const requests = [];
  const report = await runMobilePwaSessionSmoke({
    endpoint: 'http://server.example.com:9527',
    clientEndpoint: 'http://server.example.com:9527',
    hostHome: '/tmp/aih-mobile-host',
    nodeId: 'existing-node',
    managementKey: 'server-management-secret',
    managementKeySource: 'env',
    existingNode: true,
    timeoutMs: 3000,
    sessionTimeoutMs: 3000
  }, {
    resolveExistingHostHome: () => '/tmp/aih-mobile-host',
    resolveExistingNodeManagementKey: () => ({
      key: 'unused-generated-node-key',
      source: 'generated',
      passCliArg: true
    }),
    fetchImpl: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    runMobileBrowserClient: async (input) => {
      assert.equal(input.browserInput.managementKey, 'server-management-secret');
      return {
        ok: true,
        viewport: { width: 390, height: 844 },
        diagnostic: 'authorization=server-management-secret'
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.mode, 'mobile-pwa-existing-node');
  assert.equal(report.managementKeySource, 'env');
  assert.deepEqual(report.preparation, { mode: 'existing-node' });
  assert.deepEqual(report.auth, { method: 'management-key', configured: true });
  assert.deepEqual(requests, ['http://server.example.com:9527/readyz']);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /server-management-secret|unused-generated-node-key/);
  assert.match(report.mobile.diagnostic, /\[REDACTED\]/);
});

test('mobile pwa temporary-node smoke keeps only the node join invite', async () => {
  const requests = [];
  const report = await runMobilePwaSessionSmoke({
    endpoint: 'http://server.example.com:9527',
    clientEndpoint: 'http://server.example.com:9527',
    hostHome: '/tmp/aih-mobile-host',
    nodeId: 'temporary-node',
    managementKey: 'server-management-secret',
    managementKeySource: 'cli',
    timeoutMs: 3000,
    sessionTimeoutMs: 3000
  }, {
    resolveExistingHostHome: () => '/tmp/aih-mobile-host',
    resolveExistingNodeManagementKey: () => ({
      key: 'temporary-node-secret',
      source: 'generated',
      passCliArg: true
    }),
    fetchImpl: async (url, options = {}) => {
      const href = String(url);
      requests.push({
        href,
        authorization: options.headers && options.headers.authorization || ''
      });
      if (href.endsWith('/readyz')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (href.endsWith('/v0/webui/nodes/invites')) {
        return new Response(JSON.stringify({
          ok: true,
          joinUrl: 'http://server.example.com:9527/v0/node-rpc/join?code=node-code',
          invite: { id: 'node-invite' }
        }), { status: 200 });
      }
      if (href.includes('/v0/node-rpc/join?code=node-code')) {
        return new Response(JSON.stringify({
          ok: true,
          node: { id: 'temporary-node' }
        }), { status: 200 });
      }
      throw new Error(`unexpected request: ${href}`);
    },
    spawnAihProcess: (label) => ({
      label,
      child: { pid: 12345 },
      stdout: '',
      stderr: 'relay rejected temporary-node-secret',
      exitCode: 0,
      signal: '',
      exited: true
    }),
    waitForNodeOnline: async (endpoint, managementKey, nodeId) => {
      assert.equal(endpoint, 'http://server.example.com:9527');
      assert.equal(managementKey, 'server-management-secret');
      assert.equal(nodeId, 'temporary-node');
      return {
        node: {
          connection: {
            status: 'online',
            transportKind: 'relay',
            transportId: 'relay-temporary-node'
          }
        }
      };
    },
    runMobileBrowserClient: async (input) => {
      assert.equal(input.browserInput.managementKey, 'server-management-secret');
      return { ok: true };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.managementKeySource, 'cli');
  assert.equal(report.nodeManagementKeySource, 'generated');
  assert.equal(report.preparation.nodeInviteId, 'node-invite');
  assert.deepEqual(Object.keys(report.preparation).sort(), ['joinStatus', 'mode', 'nodeInviteId']);
  assert.equal(requests.filter((entry) => entry.href.includes('/nodes/invites')).length, 1);
  assert.deepEqual(requests.map((entry) => new URL(entry.href).pathname), [
    '/readyz',
    '/v0/webui/nodes/invites',
    '/v0/node-rpc/join'
  ]);
  assert.equal(requests.find((entry) => entry.href.endsWith('/nodes/invites')).authorization, 'Bearer server-management-secret');
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /server-management-secret|temporary-node-secret/);
  assert.match(report.children[0].stderrTail, /\[REDACTED\]/);
});

test('mobile browser client flow resumes by cursor and sends canonical commands', async (t) => {
  const previousFetch = global.fetch;
  const requests = [];
  t.after(() => {
    global.fetch = previousFetch;
  });

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(String(options.body)) : null;
    requests.push({ pathname: parsed.pathname, search: parsed.search, method: options.method || 'GET', body });

    if (parsed.pathname.endsWith('/device-node-session-start')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_start',
        result: { runId: 'run-mobile-1' }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-run-events')) {
      const cursor = Number(parsed.searchParams.get('cursor')) || 0;
      if (cursor === 0) {
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_run_events',
          result: {
            cursor: 5,
            status: 'running',
            events: [{ cursor: 5, type: 'terminal-output', text: 'AIH_MOBILE_PWA_START_OK_20260628' }]
          }
        }), { status: 200 });
      }
      if (cursor === 5) {
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_run_events',
          result: {
            cursor: 8,
            status: 'running',
            events: [{ cursor: 8, type: 'terminal-output', text: 'AIH_MOBILE_PWA_MESSAGE_OK_20260628' }]
          }
        }), { status: 200 });
      }
      if (cursor === 8) {
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_run_events',
          result: {
            cursor: 9,
            status: 'running',
            events: [{ cursor: 9, type: 'approval_request', approvalId: 'codex-plan-active' }]
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_run_events',
        result: {
          cursor: 10,
          status: 'completed',
          completed: true,
          events: [{ cursor: 10, type: 'aborted' }]
        }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-attach')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_attach',
        result: { runId: 'run-mobile-1', cursor: body.cursor }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-command')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_command',
        result: {
          accepted: true,
          type: body.type,
          command: body.command,
          decision: body.decision,
          scope: body.scope,
          sessionId: body.sessionId,
          idempotencyKey: body.idempotencyKey
        }
      }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const input = buildMobileBrowserInput({
    clientEndpoint: 'http://control.example.com:9527',
    nodeId: 'm4-8-7-mobile-node',
    sessionProvider: 'codex',
    sessionAccountRef: ACCOUNT_REF,
    sessionModel: 'gpt-5.5',
    sessionProjectPath: '/repo/project',
    sessionTimeoutMs: 5000
  }, 'server-management-key');
  const result = await mobileBrowserClientEvaluate(input);

  assert.equal(result.ok, true);
  assert.equal(result.attachStatus, 200);
  assert.equal(result.attach.rpc, 'control_plane.device.node_session_attach');
  assert.equal(result.reconnect.resumedFromCursor, 5);
  assert.equal(result.reconnect.duplicateEvents, 0);
  assert.equal(result.commands.message.type, 'message');
  assert.equal(result.commands.slash.command, '/status');
  assert.equal(result.commands.approval.type, 'approval_response');
  assert.equal(result.commands.approval.decision, 'approve');
  assert.equal(result.commands.approval.approvalId, 'codex-plan-active');
  assert.equal(result.commands.stop.type, 'stop');
  assert.equal(result.final.completed, true);
  assert.equal(requests.some((request) => request.pathname.endsWith('/device-node-session-run-input')), false);
  assert.equal(requests.filter((request) => request.pathname.endsWith('/device-node-session-command')).length, 4);
});

test('mobile browser current-node flow fails when slash remains unsupported', async (t) => {
  const previousFetch = global.fetch;
  const requests = [];
  t.after(() => {
    global.fetch = previousFetch;
  });

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(String(options.body)) : null;
    requests.push({ pathname: parsed.pathname, search: parsed.search, method: options.method || 'GET', body });

    if (parsed.pathname.endsWith('/device-node-session-start')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_start',
        result: { runId: 'run-current-mobile-1' }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-run-events')) {
      const cursor = Number(parsed.searchParams.get('cursor')) || 0;
      if (cursor === 0) {
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_run_events',
          result: {
            cursor: 4,
            status: 'completed',
            completed: true,
            events: [
              { cursor: 1, type: 'ready' },
              { cursor: 2, type: 'delta', delta: 'AIH_MOBILE_PWA_START_OK_20260628' },
              { cursor: 3, type: 'result', content: 'AIH_MOBILE_PWA_START_OK_20260628' },
              { cursor: 4, type: 'done', content: 'AIH_MOBILE_PWA_START_OK_20260628' }
            ]
          }
        }), { status: 200 });
      }
      if (cursor === 4) {
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_run_events',
          result: {
            cursor: 6,
            status: 'completed',
            completed: true,
            events: [
              { cursor: 5, type: 'delta', delta: 'AIH_MOBILE_PWA_MESSAGE_OK_20260628' },
              { cursor: 6, type: 'done', content: 'AIH_MOBILE_PWA_MESSAGE_OK_20260628' }
            ]
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_run_events',
        result: {
          cursor: 7,
          status: 'completed',
          completed: true,
          events: [{ cursor: 7, type: 'aborted' }]
        }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-attach')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_attach',
        result: { runId: 'run-current-mobile-1', cursor: body.cursor }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-command')) {
      if (body.type === 'slash') {
        return new Response(JSON.stringify({
          ok: false,
          error: 'headless_session_slash_unsupported'
        }), { status: 400 });
      }
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_command',
        result: {
          accepted: true,
          type: body.type,
          sessionId: body.sessionId,
          scope: body.scope
        }
      }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const input = buildMobileBrowserInput({
    clientEndpoint: 'http://control.example.com:9527',
    nodeId: 'aws-current-node',
    sessionProvider: 'opencode',
    sessionAccountRef: ACCOUNT_REF,
    sessionModel: '',
    sessionProjectPath: '/home/ubuntu/aih-fabric-current',
    sessionTimeoutMs: 5000
  }, 'server-management-key');
  const result = await mobileBrowserClientEvaluate(input);

  assert.equal(result.ok, false);
  assert.equal(result.failureStage, 'slash_command');
  assert.equal(result.failureReason, 'headless_session_slash_unsupported');
  assert.equal(result.markers.start, true);
  assert.equal(result.markers.message, true);
  assert.equal(result.commands.message.status, 200);
  assert.equal(result.commands.slash.status, 400);
  assert.equal(result.commands.slash.unsupported, true);
  assert.equal(result.commands.slash.error, 'headless_session_slash_unsupported');
  assert.equal(result.commands.stop.status, 200);
  assert.equal(result.final.eventCounts.delta, 2);
  assert.equal(requests.filter((request) => request.pathname.endsWith('/device-node-session-command')).length, 3);
});

test('mobile browser current-node flow follows resumed message run id', async (t) => {
  const previousFetch = global.fetch;
  const requests = [];
  let childEventReadCount = 0;
  t.after(() => {
    global.fetch = previousFetch;
  });

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(String(options.body)) : null;
    requests.push({ pathname: parsed.pathname, search: parsed.search, method: options.method || 'GET', body });

    if (parsed.pathname.endsWith('/device-node-session-start')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_start',
        result: { runId: 'run-current-mobile-parent' }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-run-events')) {
      const runId = parsed.searchParams.get('runId');
      if (runId === 'run-current-mobile-parent') {
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_run_events',
          result: {
            cursor: 5,
            status: 'completed',
            completed: true,
            events: [
              { cursor: 1, type: 'ready' },
              { cursor: 2, type: 'session-created', sessionId: 'ses-current-mobile' },
              { cursor: 3, type: 'delta', delta: 'AIH_MOBILE_PWA_START_OK_20260628' },
              { cursor: 4, type: 'result', content: 'AIH_MOBILE_PWA_START_OK_20260628' },
              { cursor: 5, type: 'done', content: 'AIH_MOBILE_PWA_START_OK_20260628' }
            ]
          }
        }), { status: 200 });
      }
      if (runId === 'run-current-mobile-child') {
        childEventReadCount += 1;
        if (childEventReadCount === 1) {
          return new Response(JSON.stringify({
            ok: true,
            rpc: 'control_plane.device.node_session_run_events',
            result: {
              cursor: 3,
              status: 'running',
              completed: false,
              events: [
                { cursor: 2, type: 'delta', delta: 'AIH_MOBILE_PWA_MESSAGE_OK_20260628' },
                { cursor: 3, type: 'result', content: 'AIH_MOBILE_PWA_MESSAGE_OK_20260628' }
              ]
            }
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_run_events',
          result: {
            cursor: 4,
            status: 'completed',
            completed: true,
            events: [
              { cursor: 2, type: 'delta', delta: 'AIH_MOBILE_PWA_MESSAGE_OK_20260628' },
              { cursor: 3, type: 'result', content: 'AIH_MOBILE_PWA_MESSAGE_OK_20260628' },
              { cursor: 4, type: 'done', content: 'AIH_MOBILE_PWA_MESSAGE_OK_20260628' }
            ]
          }
        }), { status: 200 });
      }
      throw new Error(`unexpected run id: ${runId}`);
    }
    if (parsed.pathname.endsWith('/device-node-session-attach')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_attach',
        result: { runId: 'run-current-mobile-parent', cursor: body.cursor }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-command')) {
      if (body.type === 'message') {
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_command',
          result: {
            accepted: true,
            type: 'message',
            sessionId: body.sessionId,
            runId: 'run-current-mobile-child',
            sessionRef: 'ses-current-mobile',
            cursor: 1,
            resumed: true,
            resumedFromRunId: 'run-current-mobile-parent',
            provider: 'opencode',
            status: 'running'
          }
        }), { status: 200 });
      }
      if (body.type === 'slash') {
        assert.equal(body.sessionId, 'run-current-mobile-child');
        return new Response(JSON.stringify({
          ok: true,
          rpc: 'control_plane.device.node_session_command',
          result: {
            accepted: true,
            type: 'slash',
            command: '/status',
            sessionId: body.sessionId,
            runId: 'run-current-mobile-slash',
            sessionRef: 'ses-current-mobile',
            cursor: 1,
            resumed: true,
            resumedFromRunId: 'run-current-mobile-child',
            provider: 'opencode',
            status: 'running'
          }
        }), { status: 200 });
      }
      assert.equal(body.sessionId, 'run-current-mobile-child');
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_command',
        result: {
          accepted: true,
          type: body.type,
          sessionId: body.sessionId,
          scope: body.scope
        }
      }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const input = buildMobileBrowserInput({
    clientEndpoint: 'http://control.example.com:9527',
    nodeId: 'aws-current-node',
    sessionProvider: 'opencode',
    sessionAccountRef: ACCOUNT_REF,
    sessionModel: '',
    sessionProjectPath: '/home/ubuntu/aih-fabric-current',
    sessionTimeoutMs: 5000
  }, 'server-management-key');
  const result = await mobileBrowserClientEvaluate(input);

  assert.equal(result.ok, true);
  assert.equal(result.messageRun.resumed, true);
  assert.equal(result.messageRun.fromRunId, 'run-current-mobile-parent');
  assert.equal(result.messageRun.runId, 'run-current-mobile-child');
  assert.equal(result.commands.message.resumed, true);
  assert.equal(result.commands.message.runId, 'run-current-mobile-child');
  assert.equal(result.commands.slash.status, 200);
  assert.equal(result.commands.slash.command, '/status');
  assert.equal(result.commands.slash.unsupported, false);
  assert.equal(result.messageCompletion.completed, true);
  assert.equal(result.reconnect.resumedRunId, 'run-current-mobile-child');
  assert.equal(result.markers.message, true);

  const childEventReads = requests.filter((request) => {
    if (!request.pathname.endsWith('/device-node-session-run-events')) return false;
    return new URLSearchParams(request.search).get('runId') === 'run-current-mobile-child';
  });
  assert.equal(childEventReads.length >= 2, true);
  assert.deepEqual(
    requests
      .filter((request) => request.pathname.endsWith('/device-node-session-command'))
      .map((request) => [request.body.type, request.body.sessionId]),
    [
      ['message', 'run-current-mobile-parent'],
      ['slash', 'run-current-mobile-child'],
      ['stop', 'run-current-mobile-child']
    ]
  );
});

test('mobile browser current-node flow stops and reports stage when start marker is missing', async (t) => {
  const previousFetch = global.fetch;
  const requests = [];
  t.after(() => {
    global.fetch = previousFetch;
  });

  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(String(options.body)) : null;
    requests.push({ pathname: parsed.pathname, search: parsed.search, method: options.method || 'GET', body });

    if (parsed.pathname.endsWith('/device-node-session-start')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_start',
        result: { runId: 'run-current-mobile-no-marker' }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-run-events')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_run_events',
        result: {
          cursor: 2,
          status: 'completed',
          completed: true,
          events: [
            { cursor: 1, type: 'ready' },
            { cursor: 2, type: 'done', content: 'NO_EXPECTED_MARKER' }
          ]
        }
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/device-node-session-command')) {
      return new Response(JSON.stringify({
        ok: true,
        rpc: 'control_plane.device.node_session_command',
        result: {
          accepted: true,
          type: body.type,
          scope: body.scope,
          sessionId: body.sessionId
        }
      }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const input = buildMobileBrowserInput({
    clientEndpoint: 'http://control.example.com:9527',
    nodeId: 'aws-current-node',
    sessionProvider: 'opencode',
    sessionAccountRef: ACCOUNT_REF,
    sessionModel: '',
    sessionProjectPath: '/home/ubuntu/aih-fabric-current',
    sessionTimeoutMs: 1000
  }, 'server-management-key');
  const result = await mobileBrowserClientEvaluate(input);

  assert.equal(result.ok, false);
  assert.equal(result.failureStage, 'start_marker');
  assert.equal(result.failureReason, 'start_marker_not_found');
  assert.equal(result.runIdPresent, true);
  assert.equal(result.commands.stop.status, 200);
  assert.equal(result.commands.stop.type, 'stop');
  assert.equal(result.requestLog.some((entry) => entry.path.includes('device-node-session-run-events')), true);

  const commandBodies = requests
    .filter((request) => request.pathname.endsWith('/device-node-session-command'))
    .map((request) => request.body);
  assert.deepEqual(commandBodies.map((body) => body.type), ['stop']);
});
