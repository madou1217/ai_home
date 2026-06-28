'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildDeviceScopes,
  buildSessionStartPayload,
  getHostAiHomeDir,
  hasSessionSmokeOptions,
  parseArgs,
  prepareExistingEndpointViaApi,
  prepareExistingEndpointStores,
  prepareStores,
  resolveExistingNodeManagementKey,
  resolveExistingHostHome,
  runDeviceNodeSessionSmoke,
  summarizeChild
} = require('../scripts/fabric-real-outbound-relay-smoke');

const { readRemoteRegistry } = require('../lib/server/remote/remote-registry-store');
const { readRemoteSecret } = require('../lib/server/remote/secret-store');
const { readServerConfig, writeServerConfig } = require('../lib/server/server-config-store');
const {
  authorizeControlPlaneDeviceToken
} = require('../lib/server/control-plane-device-pairing');

test('parseArgs accepts minimal outbound relay smoke options', () => {
  const options = parseArgs([
    '--node-id',
    'home-node-1',
    '--timeout-ms',
    '3000',
    '--control-port',
    '19001',
    '--node-port=19002',
    '--keep-temp'
  ]);

  assert.equal(options.nodeId, 'home-node-1');
  assert.equal(options.timeoutMs, 3000);
  assert.equal(options.controlPort, 19001);
  assert.equal(options.nodePort, 19002);
  assert.equal(options.keepTemp, true);
});

test('parseArgs accepts existing endpoint session smoke options without opening ports', () => {
  const options = parseArgs([
    '--endpoint',
    'http://127.0.0.1:9527/',
    '--client-endpoint',
    'http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy/',
    '--host-home',
    '/tmp/aih-host',
    '--node-join-url',
    'http://127.0.0.1:9527/v0/node-rpc/join?code=node-code',
    '--device-pair-url',
    'http://127.0.0.1:9527/v0/fabric/device-pair?code=device-code',
    '--node-id',
    'aws-node-1',
    '--session-provider',
    'codex',
    '--session-account',
    '3',
    '--session-model',
    'gpt-5.5',
    '--session-project',
    '/repo/project',
    '--session-prompt',
    'reply with the joined token parts',
    '--expect-output',
    'AIH_REAL_SESSION_OK',
    '--expect-artifact',
    '--artifact-threshold',
    '256',
    '--session-timeout-ms',
    '30000'
  ]);

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.equal(options.clientEndpoint, 'http://127.0.0.1:9527/v0/fabric/broker/servers/aws-current/proxy');
  assert.equal(options.hostHome, '/tmp/aih-host');
  assert.equal(options.nodeJoinUrl, 'http://127.0.0.1:9527/v0/node-rpc/join?code=node-code');
  assert.equal(options.devicePairUrl, 'http://127.0.0.1:9527/v0/fabric/device-pair?code=device-code');
  assert.equal(options.nodeId, 'aws-node-1');
  assert.equal(options.sessionProvider, 'codex');
  assert.equal(options.sessionAccountId, '3');
  assert.equal(options.sessionModel, 'gpt-5.5');
  assert.equal(options.sessionProjectPath, '/repo/project');
  assert.equal(options.expectOutput, 'AIH_REAL_SESSION_OK');
  assert.equal(options.expectArtifact, true);
  assert.equal(options.sessionArtifactThreshold, 256);
  assert.equal(options.sessionTimeoutMs, 30000);
  assert.equal(hasSessionSmokeOptions(options), true);
});

test('parseArgs rejects invalid node id and invalid ports', () => {
  assert.throws(
    () => parseArgs(['--node-id', 'X']),
    /--node-id must match AIH remote node id rules/
  );
  assert.throws(
    () => parseArgs(['--control-port', '70000']),
    /--control-port must be a TCP port or 0/
  );
  assert.throws(
    () => parseArgs(['--timeout-ms', '500']),
    /--timeout-ms must be an integer/
  );
  assert.throws(
    () => parseArgs(['--endpoint', 'ws://127.0.0.1:9527']),
    /--endpoint must be a valid http\(s\) URL/
  );
  assert.throws(
    () => parseArgs(['--client-endpoint', 'http://127.0.0.1:9527/proxy']),
    /--client-endpoint requires --endpoint/
  );
  assert.throws(
    () => parseArgs(['--endpoint', 'http://127.0.0.1:9527', '--client-endpoint', 'ws://127.0.0.1:9527/proxy']),
    /--client-endpoint must be a valid http\(s\) URL/
  );
  assert.throws(
    () => parseArgs(['--endpoint', 'http://127.0.0.1:9527', '--control-port', '19001']),
    /--control-port\/--node-port cannot be used with --endpoint/
  );
  assert.throws(
    () => parseArgs([
      '--endpoint',
      'http://127.0.0.1:9527',
      '--node-join-url',
      'http://127.0.0.1:9527/v0/node-rpc/join?code=abc'
    ]),
    /--node-join-url and --device-pair-url must be provided together/
  );
  assert.throws(
    () => parseArgs([
      '--endpoint',
      'http://127.0.0.1:9527',
      '--node-join-url',
      'ws://127.0.0.1:9527/v0/node-rpc/join?code=abc',
      '--device-pair-url',
      'http://127.0.0.1:9527/v0/fabric/device-pair?code=abc'
    ]),
    /must be valid http\(s\) URLs/
  );
  assert.throws(
    () => parseArgs([
      '--endpoint',
      'http://127.0.0.1:9527',
      '--session-provider',
      'codex'
    ]),
    /session smoke requires --session-account/
  );
  assert.throws(
    () => parseArgs([
      '--endpoint',
      'http://127.0.0.1:9527',
      '--session-provider',
      'codex',
      '--session-account',
      '3',
      '--session-prompt',
      'AIH_REAL_SESSION_OK',
      '--expect-output',
      'AIH_REAL_SESSION_OK'
    ]),
    /must not contain --expect-output/
  );
  assert.throws(
    () => parseArgs([
      '--endpoint',
      'http://127.0.0.1:9527',
      '--session-provider',
      'codex',
      '--session-account',
      '3',
      '--session-prompt',
      'reply',
      '--expect-output',
      'ok',
      '--artifact-threshold',
      '128'
    ]),
    /--artifact-threshold must be an integer/
  );
});

test('prepareExistingEndpointViaApi registers node and pairs device through HTTP APIs', async () => {
  const requests = [];
  const prepared = await prepareExistingEndpointViaApi({
    controlEndpoint: 'http://control.local:9527',
    nodeId: 'local-cross-node',
    nodeManagementKey: 'node-secret',
    nodeJoinUrl: 'http://control.local:9527/v0/node-rpc/join?code=node-code',
    devicePairUrl: 'http://control.local:9527/v0/fabric/device-pair?code=device-code',
    deps: {
      fetchImpl: async (url, options) => {
        requests.push({
          url: String(url),
          method: options.method,
          body: JSON.parse(String(options.body || '{}'))
        });
        if (String(url).includes('/v0/node-rpc/join')) {
          return new Response(JSON.stringify({
            ok: true,
            node: {
              id: 'local-cross-node',
              transports: [{ kind: 'relay' }]
            }
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          ok: true,
          result: {
            device: {
              id: 'api-endpoint-relay-smoke-device',
              scopes: buildDeviceScopes()
            },
            token: 'device-token'
          }
        }), { status: 200 });
      }
    }
  });

  assert.equal(prepared.deviceToken, 'device-token');
  assert.deepEqual(prepared.preparation, {
    mode: 'api',
    controlEndpoint: 'http://control.local:9527',
    joinStatus: 200,
    pairStatus: 200
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'http://control.local:9527/v0/node-rpc/join?code=node-code');
  assert.deepEqual(requests[0].body.node, {
    id: 'local-cross-node',
    name: 'API Endpoint Relay Smoke Node',
    transportKind: 'relay',
    managementKey: 'node-secret'
  });
  assert.equal(requests[1].url, 'http://control.local:9527/v0/fabric/device-pair?code=device-code');
  assert.equal(requests[1].body.device.id, 'api-endpoint-relay-smoke-device');
});

test('prepareStores writes real registry, secret, server config, and device token', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-relay-smoke-test-'));
  const controlAiHomeDir = path.join(tempRoot, 'control', '.ai_home');
  const nodeAiHomeDir = path.join(tempRoot, 'node', '.ai_home');

  const prepared = prepareStores({
    controlAiHomeDir,
    nodeAiHomeDir,
    controlEndpoint: 'http://127.0.0.1:19001',
    nodeId: 'office-node-1',
    nodePort: 19002,
    nodeManagementKey: 'node-secret'
  });

  const registry = readRemoteRegistry({ fs, aiHomeDir: controlAiHomeDir });
  assert.equal(registry.nodes.length, 1);
  assert.equal(registry.nodes[0].id, 'office-node-1');
  assert.deepEqual(registry.nodes[0].preferredTransports, ['relay']);
  assert.ok(registry.nodes[0].capabilities.includes('sessions'));

  const secret = readRemoteSecret(prepared.node.authRef, { fs, aiHomeDir: controlAiHomeDir });
  assert.equal(secret.managementKey, 'node-secret');

  const serverConfig = readServerConfig({ fs, aiHomeDir: nodeAiHomeDir });
  assert.equal(serverConfig.host, '127.0.0.1');
  assert.equal(serverConfig.port, 19002);
  assert.equal(serverConfig.managementKey, 'node-secret');

  const auth = authorizeControlPlaneDeviceToken(prepared.deviceToken, 'nodes:read', {
    fs,
    aiHomeDir: controlAiHomeDir
  });
  assert.equal(auth.ok, true);
  assert.equal(auth.device.id, 'relay-smoke-device');
  const writeAuth = authorizeControlPlaneDeviceToken(prepared.deviceToken, 'sessions:write', {
    fs,
    aiHomeDir: controlAiHomeDir
  });
  assert.equal(writeAuth.ok, true);
  assert.deepEqual(buildDeviceScopes(), ['control-plane:read', 'nodes:read', 'sessions:read', 'sessions:write', 'status:read']);
});

test('prepareExistingEndpointStores writes relay node and session-capable device into one host home', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-existing-endpoint-test-'));
  const hostHome = path.join(tempRoot, 'host');
  const aiHomeDir = getHostAiHomeDir(hostHome);

  const prepared = prepareExistingEndpointStores({
    aiHomeDir,
    controlEndpoint: 'http://127.0.0.1:9527',
    nodeId: 'aws-node-1',
    nodeManagementKey: 'node-secret'
  });

  const registry = readRemoteRegistry({ fs, aiHomeDir });
  assert.equal(registry.nodes.length, 1);
  assert.equal(registry.nodes[0].id, 'aws-node-1');
  assert.deepEqual(registry.nodes[0].preferredTransports, ['relay']);
  assert.ok(registry.nodes[0].tags.includes('existing-endpoint'));

  const secret = readRemoteSecret(prepared.node.authRef, { fs, aiHomeDir });
  assert.equal(secret.managementKey, 'node-secret');

  const auth = authorizeControlPlaneDeviceToken(prepared.deviceToken, 'sessions:write', {
    fs,
    aiHomeDir
  });
  assert.equal(auth.ok, true);
  assert.equal(auth.device.id, 'existing-endpoint-relay-smoke-device');
});

test('endpoint helpers resolve host home and build session payload without exposing prompt text in report fields', () => {
  const home = path.join(os.tmpdir(), 'aih-home');
  assert.equal(
    resolveExistingHostHome('~/aih-host', { HOME: home }),
    path.join(home, 'aih-host')
  );
  assert.equal(getHostAiHomeDir('/tmp/host'), '/tmp/host/.ai_home');

  const payload = buildSessionStartPayload({
    nodeId: 'aws-node-1',
    sessionProvider: 'codex',
    sessionAccountId: '3',
    sessionPrompt: 'reply with token parts',
    sessionProjectPath: '/repo/project',
    sessionModel: 'gpt-5.5',
    sessionArtifactThreshold: 256
  });

  assert.deepEqual(payload, {
    nodeId: 'aws-node-1',
    provider: 'codex',
    accountId: '3',
    prompt: 'reply with token parts',
    projectPath: '/repo/project',
    model: 'gpt-5.5',
    artifactThreshold: 256,
    cols: 100,
    rows: 30
  });
});

test('runDeviceNodeSessionSmoke sends device session traffic through client endpoint', async () => {
  const requestedUrls = [];
  const clientEndpoint = 'http://broker.local:9527/v0/fabric/broker/servers/aws-current/proxy';
  const controlEndpoint = 'http://control.local:9527';

  const session = await runDeviceNodeSessionSmoke({
    controlEndpoint,
    clientEndpoint,
    deviceToken: 'device-token',
    options: {
      nodeId: 'aws-node-1',
      sessionProvider: 'codex',
      sessionAccountId: '3',
      sessionPrompt: 'reply with token parts',
      sessionProjectPath: '/repo/project',
      expectOutput: 'AIH_REAL_SESSION_OK',
      expectArtifact: true,
      sessionTimeoutMs: 5000
    }
  }, {
    fetchImpl: async (url, options = {}) => {
      requestedUrls.push(String(url));
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/v0/node-rpc/device-node-session-start')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { runId: 'run-1' }
        }), { status: 200 });
      }
      if (pathname.endsWith('/v0/node-rpc/device-node-session-run-events')) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            cursor: 1,
            completed: true,
            status: 'completed',
            events: [
              {
                type: 'artifact_ref',
                artifactId: 'art_1',
                artifact: {
                  artifactId: 'art_1',
                  kind: 'terminal-output',
                  byteLength: 4097
                }
              }
            ]
          }
        }), { status: 200 });
      }
      if (pathname.endsWith('/v0/node-rpc/device-node-session-artifact')) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            artifact: {
              artifactId: 'art_1',
              kind: 'terminal-output',
              byteLength: 4097,
              preview: 'large terminal output'
            },
            content: 'AIH_REAL_SESSION_OK'
          }
        }), { status: 200 });
      }
      if (pathname.endsWith('/v0/node-rpc/device-node-session-run-input')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { accepted: true }
        }), { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    }
  });

  assert.equal(session.ok, true);
  assert.equal(session.artifacts.required, true);
  assert.equal(session.artifacts.fetched, 1);
  assert.equal(requestedUrls.length >= 4, true);
  assert.equal(requestedUrls.every((url) => url.startsWith(clientEndpoint)), true);
  assert.equal(requestedUrls.some((url) => url.startsWith(controlEndpoint)), false);
  assert.equal(requestedUrls.some((url) => url.includes('/v0/node-rpc/device-node-session-artifact')), true);
});

test('resolveExistingNodeManagementKey prefers server config to avoid command argv secrets', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-existing-key-test-'));
  const aiHomeDir = path.join(tempRoot, '.ai_home');
  writeServerConfig({ managementKey: 'configured-secret' }, { fs, aiHomeDir });

  assert.deepEqual(resolveExistingNodeManagementKey(aiHomeDir), {
    key: 'configured-secret',
    source: 'server-config',
    passCliArg: false
  });

  const generated = resolveExistingNodeManagementKey(path.join(tempRoot, 'empty', '.ai_home'));
  assert.equal(generated.source, 'generated');
  assert.equal(generated.passCliArg, true);
  assert.match(generated.key, /^node_/);
});

test('summarizeChild only includes process metadata and output tails', () => {
  const summary = summarizeChild({
    label: 'relay-client',
    child: { pid: 12345 },
    exited: false,
    exitCode: null,
    signal: '',
    stdout: 'connected',
    stderr: 'warning'
  });

  assert.deepEqual(summary, {
    label: 'relay-client',
    pid: 12345,
    exited: false,
    exitCode: null,
    signal: '',
    stdoutTail: 'connected',
    stderrTail: 'warning'
  });
});
