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

function loadTransportModule(entry) {
  const ts = require('../web/node_modules/typescript');
  const cache = new Map();
  const stubs = {
    '@tauri-apps/api/event': { listen: async () => () => {} },
    '@tauri-apps/api/tauri': {
      convertFileSrc: () => '',
      invoke: async () => { throw new Error('unexpected native invoke'); }
    }
  };

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
      if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
      throw new Error(`Unexpected transport test dependency: ${request}`);
    };
    Function('module', 'exports', 'require', outputText)(
      moduleRef,
      moduleRef.exports,
      requireFromModule
    );
    return moduleRef.exports;
  };

  return load(path.join(TRANSPORT_DIR, entry));
}

test('Tauri JSON requests construct an auth-free, allowlisted IPC envelope', async () => {
  const { TauriServerTransport } = loadTransportModule('tauri-adapter');
  const invocations = [];
  const transport = new TauriServerTransport({
    invokeImpl: async (command, args) => {
      invocations.push({ command, args });
      return {
        status: 200,
        headers: { contentType: 'application/json' },
        body: { ok: true }
      };
    }
  });

  const response = await transport.requestJson({
    profileId: 'aws',
    method: 'POST',
    path: '/v0/test?q=1',
    body: { hello: 'world' },
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-ignored': 'not-forwarded'
    }
  });

  assert.deepEqual(response.data, { ok: true });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, 'desktop_http_request');
  assert.deepEqual(invocations[0].args.input, {
    profileId: 'aws',
    method: 'POST',
    path: '/v0/test?q=1',
    body: { hello: 'world' },
    accept: 'application/json',
    contentType: 'application/json'
  });
  const serialized = JSON.stringify(invocations[0].args.input).toLowerCase();
  for (const forbidden of ['authorization', 'managementkey', 'credentialref', 'endpoint']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('Tauri requests reject credentials before invoking Rust', async () => {
  const { TauriServerTransport } = loadTransportModule('tauri-adapter');
  let invokeCount = 0;
  const transport = new TauriServerTransport({
    invokeImpl: async () => {
      invokeCount += 1;
      return { status: 200, headers: {}, body: null };
    }
  });

  await assert.rejects(transport.requestJson({
    profileId: 'aws',
    method: 'GET',
    path: '/v0/test',
    headers: { Authorization: 'Bearer secret' }
  }), /forbidden_server_request_header/);
  await assert.rejects(transport.requestJson({
    profileId: 'aws',
    method: 'POST',
    path: '/v0/test',
    body: { managementKey: 'secret' }
  }), /native_request_contains_management_credential/);

  assert.equal(invokeCount, 0);
});

test('Tauri POST SSE forwards the body exactly once and decodes native chunks', async () => {
  const { TauriServerTransport } = loadTransportModule('tauri-adapter');
  let streamListener = null;
  const invocations = [];
  const transport = new TauriServerTransport({
    invokeImpl: async (command, args) => {
      invocations.push({ command, args });
      if (command === 'desktop_stream_open') {
        for (let sequence = 0; sequence < 300; sequence += 1) {
          streamListener?.({
            payload: {
              requestId: 'another-stream',
              sequence,
              kind: 'chunk',
              chunkBase64: Buffer.from('ignored').toString('base64')
            }
          });
        }
        return { requestId: args.input.requestId, status: 200 };
      }
      if (command === 'desktop_stream_cancel') return { cancelled: true };
      throw new Error('unexpected command');
    },
    listenImpl: async (eventName, listener) => {
      assert.equal(eventName, 'aih://server-stream');
      streamListener = listener;
      return () => {};
    }
  });
  const events = [];
  const stream = await transport.openSse({
    profileId: 'aws',
    method: 'POST',
    path: '/v0/webui/chat',
    body: { message: 'hello', stream: true },
    headers: { 'content-type': 'application/json' }
  }, {
    onEvent: (event) => events.push(event)
  });

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, 'desktop_stream_open');
  assert.deepEqual(invocations[0].args.input.body, { message: 'hello', stream: true });
  assert.equal(invocations[0].args.input.method, 'POST');
  const requestId = invocations[0].args.input.requestId;
  assert.match(requestId, /^[a-z\d._-]+$/i);

  const bytes = new TextEncoder().encode('data: 你好🙂\r\n\r\n');
  let sequence = 1;
  for (let offset = 0; offset < bytes.length; offset += 2, sequence += 1) {
    streamListener({
      payload: {
        requestId,
        sequence,
        kind: 'chunk',
        chunkBase64: Buffer.from(bytes.slice(offset, offset + 2)).toString('base64')
      }
    });
  }
  streamListener({
    payload: {
      requestId,
      sequence,
      kind: 'end'
    }
  });
  await stream.done;

  assert.deepEqual(events, [{ type: 'message', data: '你好🙂' }]);
  assert.equal(invocations.filter((item) => item.command === 'desktop_stream_open').length, 1);
});

test('Tauri SSE buffers target events until open is acknowledged', async () => {
  const { TauriServerTransport } = loadTransportModule('tauri-adapter');
  let streamListener = null;
  const order = [];
  const transport = new TauriServerTransport({
    invokeImpl: async (command, args) => {
      if (command !== 'desktop_stream_open') throw new Error('unexpected command');
      const requestId = args.input.requestId;
      streamListener({
        payload: {
          requestId,
          sequence: 1,
          kind: 'chunk',
          chunkBase64: Buffer.from('data: early\n\n').toString('base64')
        }
      });
      streamListener({
        payload: { requestId, sequence: 2, kind: 'end' }
      });
      return { requestId, status: 200 };
    },
    listenImpl: async (_eventName, listener) => {
      streamListener = listener;
      return () => {};
    }
  });

  const stream = await transport.openSse({
    profileId: 'aws',
    method: 'GET',
    path: '/v0/watch'
  }, {
    onOpen: () => order.push('open'),
    onEvent: (event) => order.push(`event:${event.data}`),
    onClose: (reason) => order.push(`close:${reason}`)
  });
  await stream.done;

  assert.deepEqual(order, ['open', 'event:early', 'close:completed']);
});

test('Tauri SSE abort during native open cancels after acknowledgement', async () => {
  const { TauriServerTransport } = loadTransportModule('tauri-adapter');
  const controller = new AbortController();
  const commands = [];
  let acknowledgeOpen;
  let markOpenStarted;
  const openStarted = new Promise((resolve) => {
    markOpenStarted = resolve;
  });
  const transport = new TauriServerTransport({
    invokeImpl: async (command, args) => {
      commands.push(command);
      if (command === 'desktop_stream_open') {
        markOpenStarted();
        return new Promise((resolve) => {
          acknowledgeOpen = () => resolve({
            requestId: args.input.requestId,
            status: 200
          });
        });
      }
      if (command === 'desktop_stream_cancel') return { cancelled: true };
      throw new Error('unexpected command');
    },
    listenImpl: async () => () => {}
  });

  const opening = transport.openSse({
    profileId: 'aws',
    method: 'GET',
    path: '/v0/watch',
    signal: controller.signal
  }, { onEvent: () => {} });
  await openStarted;
  controller.abort();
  acknowledgeOpen();

  await assert.rejects(opening, /server_request_cancelled/);
  assert.deepEqual(commands, ['desktop_stream_open', 'desktop_stream_cancel']);
});

test('Tauri Blob handles are fetched without secrets and always released', async () => {
  const { TauriServerTransport } = loadTransportModule('tauri-adapter');
  const commands = [];
  const transport = new TauriServerTransport({
    invokeImpl: async (command) => {
      commands.push(command);
      if (command === 'desktop_blob_request') {
        return { blobId: 'blob-1', contentType: 'image/png', size: 4 };
      }
      if (command === 'desktop_blob_release') return { released: true };
      throw new Error('unexpected command');
    },
    convertFileSrcImpl: (blobId, protocol) => {
      assert.equal(blobId, 'blob-1');
      assert.equal(protocol, 'aihblob');
      return 'https://aihblob.localhost/blob-1';
    },
    fetchImpl: async (_input, init) => {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      assert.equal(init.credentials, 'omit');
      return new Response(Uint8Array.of(1, 2, 3, 4), { status: 200 });
    }
  });

  const result = await transport.requestBlob({
    profileId: 'aws',
    method: 'GET',
    path: '/v0/media/1'
  });

  assert.equal(result.data.size, 4);
  assert.equal(result.data.type, 'image/png');
  assert.deepEqual(commands, ['desktop_blob_request', 'desktop_blob_release']);
});

test('Tauri Blob releases native handles when response headers are invalid', async () => {
  const { TauriServerTransport } = loadTransportModule('tauri-adapter');
  const invalidHeaders = [
    { contentType: 'image/png\r\nx-injected: true' },
    { contentDisposition: 'x'.repeat(4097) }
  ];

  for (const [index, headers] of invalidHeaders.entries()) {
    const commands = [];
    let fetchCount = 0;
    const transport = new TauriServerTransport({
      invokeImpl: async (command) => {
        commands.push(command);
        if (command === 'desktop_blob_request') {
          return {
            blobId: `blob-invalid-header-${index}`,
            size: 0,
            ...headers
          };
        }
        if (command === 'desktop_blob_release') return { released: true };
        throw new Error('unexpected command');
      },
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(new Uint8Array());
      }
    });

    await assert.rejects(transport.requestBlob({
      profileId: 'aws',
      method: 'GET',
      path: `/v0/media/invalid-header-${index}`
    }), /invalid_native_response_header/);

    assert.equal(fetchCount, 0);
    assert.deepEqual(commands, ['desktop_blob_request', 'desktop_blob_release']);
  }
});
