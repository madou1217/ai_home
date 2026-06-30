'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildMobileBrowserInput,
  createAwsInviteUrls,
  mobileBrowserClientEvaluate,
  parseArgs,
  prepareNodeAndDeviceViaApi
} = require('../scripts/fabric-real-mobile-pwa-session-smoke');

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
    '--session-provider',
    'codex',
    '--session-account',
    '1',
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
  ]);

  assert.equal(options.endpoint, 'http://control.example.com:9527');
  assert.equal(options.clientEndpoint, 'http://control.example.com:9527');
  assert.equal(options.hostHome, '/Users/model');
  assert.equal(options.nodeId, 'm4-8-7-mobile-node');
  assert.equal(options.sessionProvider, 'codex');
  assert.equal(options.sessionAccountId, '1');
  assert.equal(options.sessionModel, 'gpt-5.5');
  assert.equal(options.sessionProjectPath, '/repo/project');
  assert.equal(options.existingNode, true);
  assert.equal(options.timeoutMs, 30000);
  assert.equal(options.sessionTimeoutMs, 60000);
  assert.equal(options.headed, true);
});

test('mobile pwa smoke creates node and device invites through real API shapes', async () => {
  const requests = [];
  const invites = await createAwsInviteUrls({
    endpoint: 'http://control.example.com:9527',
    nodeId: 'm4-8-7-mobile-node'
  }, {
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        body: JSON.parse(String(options.body || '{}'))
      });
      if (String(url).endsWith('/v0/webui/nodes/invites')) {
        return new Response(JSON.stringify({
          ok: true,
          joinUrl: 'http://control.example.com:9527/v0/node-rpc/join?code=node-code',
          invite: { id: 'invite-node' }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        pairUrl: 'http://control.example.com:9527/v0/fabric/device-pair?code=device-code',
        invite: { id: 'invite-device' }
      }), { status: 200 });
    }
  });

  assert.equal(invites.joinUrl, 'http://control.example.com:9527/v0/node-rpc/join?code=node-code');
  assert.equal(invites.pairUrl, 'http://control.example.com:9527/v0/fabric/device-pair?code=device-code');
  assert.equal(invites.nodeInviteId, 'invite-node');
  assert.equal(invites.deviceInviteId, 'invite-device');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.nodeId, 'm4-8-7-mobile-node');
  assert.deepEqual(requests[0].body.capabilities, ['status', 'sessions']);
  assert.deepEqual(requests[1].body.scopes, ['control-plane:read', 'nodes:read', 'sessions:read', 'sessions:write', 'status:read']);
});

test('mobile pwa smoke joins node and pairs device with one management key', async () => {
  const requests = [];
  const prepared = await prepareNodeAndDeviceViaApi({
    nodeId: 'm4-8-7-mobile-node',
    nodeManagementKey: 'node-secret',
    joinUrl: 'http://control.example.com:9527/v0/node-rpc/join?code=node-code',
    pairUrl: 'http://control.example.com:9527/v0/fabric/device-pair?code=device-code'
  }, {
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        method: options.method,
        body: JSON.parse(String(options.body || '{}'))
      });
      if (String(url).includes('/v0/node-rpc/join')) {
        return new Response(JSON.stringify({
          ok: true,
          node: { id: 'm4-8-7-mobile-node' }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        result: {
          device: { id: 'm4-8-7-mobile-pwa-smoke-device' },
          token: 'device-token'
        }
      }), { status: 200 });
    }
  });

  assert.equal(prepared.nodeManagementKey, 'node-secret');
  assert.equal(prepared.deviceToken, 'device-token');
  assert.equal(requests[0].body.node.managementKey, 'node-secret');
  assert.equal(requests[0].body.node.transportKind, 'relay');
  assert.equal(requests[1].body.device.platform, 'mobile-pwa-browser');
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
    sessionAccountId: '1',
    sessionModel: 'gpt-5.5',
    sessionProjectPath: '/repo/project',
    sessionTimeoutMs: 5000
  }, 'device-token');
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
    sessionAccountId: '1',
    sessionModel: '',
    sessionProjectPath: '/home/ubuntu/aih-fabric-current',
    sessionTimeoutMs: 5000
  }, 'device-token');
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
    sessionAccountId: '1',
    sessionModel: '',
    sessionProjectPath: '/home/ubuntu/aih-fabric-current',
    sessionTimeoutMs: 5000
  }, 'device-token');
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
    sessionAccountId: '1',
    sessionModel: '',
    sessionProjectPath: '/home/ubuntu/aih-fabric-current',
    sessionTimeoutMs: 1000
  }, 'device-token');
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
