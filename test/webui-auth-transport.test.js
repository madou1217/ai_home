const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function loadTransportModule() {
  const filename = path.join(__dirname, '../web/src/services/webui-auth-transport.ts');
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
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === './native-server-profile-repository') {
      return { isNativeDesktopRuntime: () => false };
    }
    if (request === './native-server-transport') {
      return { isNativeServerTransportAvailable: () => false };
    }
    return originalRequire(request);
  };
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

function installBrowserFixture(t, options = {}) {
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  const previousEventSource = global.EventSource;
  const storage = new Map();
  storage.set('aih:control-plane-profiles:v1', JSON.stringify([
    {
      id: 'local-server',
      endpoint: 'http://127.0.0.1:9527',
      managementKey: 'local-management-key'
    },
    {
      id: 'aws-server',
      endpoint: 'https://aws.example.com',
      managementKey: 'aws-management-key'
    }
  ]));
  storage.set('aih:active-control-plane-profile:v1', 'aws-server');
  global.window = {
    location: { origin: 'http://localhost:9527' },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    setTimeout,
    clearTimeout
  };
  global.EventSource = { CONNECTING: 0, OPEN: 1, CLOSED: 2 };
  global.fetch = options.fetchImpl || previousFetch;
  t.after(() => {
    global.window = previousWindow;
    global.fetch = previousFetch;
    global.EventSource = previousEventSource;
  });
}

test('webui auth transport keeps Management Key and remote Server id out of URLs', async (t) => {
  const calls = [];
  installBrowserFixture(t, {
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const transport = loadTransportModule();

  assert.equal(transport.resolveWebUiManagementKey(), 'local-management-key');
  assert.deepEqual(transport.resolveActiveServer(), { serverId: 'aws-server', isRemote: true });
  assert.equal(transport.isSameServerOrigin('http://localhost:9527', 'http://127.0.0.1:9527'), true);
  assert.equal(transport.isSameServerOrigin('https://server.example.com', 'http://server.example.com'), false);
  await transport.fetchAuthorizedWebUiResource('/v0/webui/projects?cursor=1');

  assert.equal(calls[0].input, '/v0/webui/projects?cursor=1');
  assert.equal(calls[0].input.includes('management-key'), false);
  assert.equal(calls[0].input.includes('x-aih-server-id'), false);
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer local-management-key');
  assert.equal(calls[0].init.headers.get('x-aih-server-id'), 'aws-server');
});

test('webui fetch event stream authenticates by header and exposes EventSource-compatible frames', async (t) => {
  const encoder = new TextEncoder();
  const calls = [];
  installBrowserFixture(t, {
    fetchImpl: async (input, init) => {
      calls.push({ input: String(input), init });
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"snapshot"}\n\n'));
          }
        })
      };
    }
  });
  const transport = loadTransportModule();

  const payload = await new Promise((resolve, reject) => {
    const stream = transport.guardedWebUiEventSource('/v0/webui/projects/watch');
    stream.onmessage = (event) => {
      stream.close();
      resolve(JSON.parse(event.data));
    };
    stream.onerror = () => reject(new Error('unexpected_stream_error'));
  });

  assert.deepEqual(payload, { type: 'snapshot' });
  assert.equal(calls[0].input, '/v0/webui/projects/watch');
  assert.equal(calls[0].init.headers.get('authorization'), 'Bearer local-management-key');
  assert.equal(calls[0].init.headers.get('x-aih-server-id'), 'aws-server');
  assert.equal(calls[0].input.includes('access_token'), false);
});
