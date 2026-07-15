const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function loadControlPlaneApiClientModule() {
  const filename = path.join(__dirname, '../web/src/services/control-plane-api-client.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

test('control plane api client normalizes endpoint base path and request urls', () => {
  const { ControlPlaneApiClient, normalizeControlPlaneEndpoint, buildControlPlaneHttpUrl } = loadControlPlaneApiClientModule();
  const client = new ControlPlaneApiClient({
    endpoint: 'https://control.example.com/aih/ui/'
  });

  assert.equal(normalizeControlPlaneEndpoint('control.example.com/ui/'), 'https://control.example.com');
  assert.equal(client.endpoint, 'https://control.example.com/aih');
  assert.equal(
    client.buildHttpUrl('/v0/node-rpc/device-status?limit=1'),
    'https://control.example.com/aih/v0/node-rpc/device-status?limit=1'
  );
  assert.equal(
    client.buildEventSourceUrl('/v0/node-rpc/device-events?cursor=10'),
    'https://control.example.com/aih/v0/node-rpc/device-events?cursor=10'
  );
  assert.deepEqual(
    client.buildEventStreamRequest('/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd', {
      managementKey: 'management-key',
      requireManagementKey: true
    }),
    {
      url: 'https://control.example.com/aih/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd',
      headers: {
        accept: 'text/event-stream',
        authorization: 'Bearer management-key'
      }
    }
  );
  assert.equal(
    client.buildWebSocketUrl('/v0/node-rpc/device-stream'),
    'wss://control.example.com/aih/v0/node-rpc/device-stream'
  );
  assert.equal(
    buildControlPlaneHttpUrl('http://127.0.0.1:9527/ui', '/v0/node-rpc/descriptor'),
    'http://127.0.0.1:9527/v0/node-rpc/descriptor'
  );
  assert.throws(
    () => client.buildHttpUrl('https://evil.example.com/v0/node-rpc/status'),
    /invalid_control_plane_request_path/
  );
});

test('control plane api client sends bearer json requests without browser credentials', async () => {
  const { ControlPlaneApiClient } = loadControlPlaneApiClientModule();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      credentials: init.credentials,
      body: init.body
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    };
  };
  const client = new ControlPlaneApiClient({
    endpoint: 'https://control.example.com',
    managementKey: 'management-key',
    fetchImpl
  });

  assert.deepEqual(
    await client.getJson('/v0/node-rpc/device-status', { requireManagementKey: true }),
    { ok: true }
  );
  assert.deepEqual(
    await client.postJson('/v0/node-rpc/device-node-session-input', { input: 'continue' }, {
      requireManagementKey: true,
      httpErrorPrefix: 'node_session_input_http'
    }),
    { ok: true }
  );

  assert.equal(calls[0].url, 'https://control.example.com/v0/node-rpc/device-status');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.authorization, 'Bearer management-key');
  assert.equal(calls[0].headers.accept, 'application/json');
  assert.equal(calls[0].credentials, 'omit');
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers.authorization, 'Bearer management-key');
  assert.equal(calls[1].headers['content-type'], 'application/json');
  assert.equal(calls[1].body, JSON.stringify({ input: 'continue' }));
});

test('control plane api client validates management key and preserves http error prefix', async () => {
  const { ControlPlaneApiClient } = loadControlPlaneApiClientModule();
  const client = new ControlPlaneApiClient({
    endpoint: 'https://control.example.com',
    fetchImpl: async () => {
      return {
        ok: false,
        status: 403,
        json: async () => ({ ok: false })
      };
    }
  });

  await assert.rejects(
    () => client.getJson('/v0/node-rpc/device-status', { requireManagementKey: true }),
    /missing_management_key/
  );
  assert.throws(
    () => client.buildEventStreamRequest('/v0/node-rpc/device-session-stream', { requireManagementKey: true }),
    /missing_management_key/
  );
  await assert.rejects(
    () => client.getJson('/v0/node-rpc/descriptor', { httpErrorPrefix: 'descriptor_http' }),
    /descriptor_http_403/
  );
});

test('control plane api client consumes authorized fetch event streams', async () => {
  const { consumeControlPlaneEventStream } = loadControlPlaneApiClientModule();
  const frames = [];
  const calls = [];
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': heartbeat\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"chunk","text":"hel'));
      controller.enqueue(encoder.encode('lo"}\n\n'));
      controller.close();
    }
  });

  await consumeControlPlaneEventStream({
    url: 'https://control.example.com/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd',
    headers: {
      accept: 'text/event-stream',
      authorization: 'Bearer management-key'
    }
  }, {
    onFrame: (frame) => frames.push(frame)
  }, {
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        headers: init.headers,
        credentials: init.credentials
      });
      return {
        ok: true,
        status: 200,
        body
      };
    }
  });

  assert.deepEqual(frames, [
    { type: 'connected' },
    { type: 'chunk', text: 'hello' }
  ]);
  assert.equal(calls[0].url, 'https://control.example.com/v0/node-rpc/device-session-stream?sessionRef=sess_0123456789abcdefabcd');
  assert.equal(calls[0].headers.authorization, 'Bearer management-key');
  assert.equal(calls[0].credentials, 'omit');
});
