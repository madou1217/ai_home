const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TRANSPORT_DIR = path.join(
  __dirname,
  '..',
  'web',
  'src',
  'services',
  'server-transport'
);

function loadBrowserTransport() {
  const ts = require('../web/node_modules/typescript');
  const cache = new Map();
  const load = (filePath) => {
    const normalized = filePath.endsWith('.ts') ? filePath : `${filePath}.ts`;
    if (cache.has(normalized)) return cache.get(normalized).exports;
    const source = fs.readFileSync(normalized, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020
      }
    });
    const moduleRef = { exports: {} };
    cache.set(normalized, moduleRef);
    const requireFromModule = (request) => {
      if (request.startsWith('.')) {
        return load(path.resolve(path.dirname(normalized), request));
      }
      throw new Error(`Unexpected transport test dependency: ${request}`);
    };
    Function('module', 'exports', 'require', outputText)(
      moduleRef,
      moduleRef.exports,
      requireFromModule
    );
    return moduleRef.exports;
  };
  return load(path.join(TRANSPORT_DIR, 'browser-adapter'));
}

test('Browser POST SSE uses one authenticated fetch and parses split chunks', async () => {
  const { BrowserServerTransport } = loadBrowserTransport();
  const bytes = new TextEncoder().encode('data: first\r\ndata: 第二🙂\r\n\r\n');
  let fetchCount = 0;
  let capturedUrl = '';
  let capturedInit = null;
  const transport = new BrowserServerTransport({
    resolveProfile: async () => ({
      endpoint: 'https://server.example/base',
      managementKey: 'browser-only-key'
    }),
    createRequestId: () => 'browser-stream-1',
    fetchImpl: async (input, init) => {
      fetchCount += 1;
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 17));
          controller.enqueue(bytes.slice(17));
          controller.close();
        }
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' }
      });
    }
  });
  const events = [];

  const stream = await transport.openSse({
    profileId: 'aws',
    method: 'POST',
    path: '/v0/chat?stream=1',
    body: { message: 'hello' }
  }, {
    onEvent: (event) => events.push(event)
  });
  await stream.done;

  assert.equal(fetchCount, 1);
  assert.equal(capturedUrl, 'https://server.example/base/v0/chat?stream=1');
  assert.equal(new Headers(capturedInit.headers).get('authorization'), 'Bearer browser-only-key');
  assert.equal(capturedInit.body, JSON.stringify({ message: 'hello' }));
  assert.deepEqual(events, [{ type: 'message', data: 'first\n第二🙂' }]);
});

test('Browser SSE cancellation stops the reader without reconnecting', async () => {
  const { BrowserServerTransport } = loadBrowserTransport();
  let fetchCount = 0;
  let sourceCancelled = false;
  const transport = new BrowserServerTransport({
    resolveProfile: () => ({ endpoint: 'https://server.example' }),
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response(new ReadableStream({
        cancel() {
          sourceCancelled = true;
        }
      }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }
  });
  const closeReasons = [];

  const stream = await transport.openSse({
    profileId: 'aws',
    method: 'GET',
    path: '/v0/watch'
  }, {
    onEvent: () => {},
    onClose: (reason) => closeReasons.push(reason)
  });
  await stream.cancel();
  await stream.done;

  assert.equal(fetchCount, 1);
  assert.equal(sourceCancelled, true);
  assert.deepEqual(closeReasons, ['cancelled']);
});
