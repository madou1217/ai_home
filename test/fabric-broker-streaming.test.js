'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  createBrokerRequestHandler
} = require('../lib/cli/services/fabric/broker-connect');
const {
  handleFabricBrokerProxyRequest,
  isFabricBrokerRouteAllowed,
  streamBrokerResponse
} = require('../lib/server/fabric-broker-router');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.frames = [];
  }

  send(value) {
    this.frames.push(JSON.parse(value));
  }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
    this.headersSent = false;
    this.destroyed = false;
  }

  setHeader(name, value) {
    this.headers[name] = value;
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.emit('finish');
  }
}

function createBrokerProxyContext(socket, response, overrides = {}) {
  const request = new EventEmitter();
  request.headers = {};
  request.resume = () => {};
  return {
    method: 'GET',
    pathname: '/v0/fabric/broker/servers/local-home/proxy/v0/webui/projects',
    url: new URL('http://aws.example.com/v0/fabric/broker/servers/local-home/proxy/v0/webui/projects'),
    req: request,
    res: response,
    deps: {
      brokerMaxConcurrentRequests: 1,
      fabricBrokerSessionRegistry: {
        getBrokerSession: () => ({ serverId: 'local-home', socket }),
        getBrokerServerStatus: () => ({ serverId: 'local-home', online: true })
      },
      readRequestBody: async () => Buffer.alloc(0),
      writeJson(res, statusCode, payload) {
        res.statusCode = statusCode;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      },
      ...overrides
    }
  };
}

function completeBrokerRequest(socket, requestId, status = 200) {
  socket.emit('message', JSON.stringify({
    type: 'broker.response.start',
    requestId,
    status,
    headers: { 'content-type': 'application/json' }
  }));
  socket.emit('message', JSON.stringify({
    type: 'broker.response.end',
    requestId
  }));
}

test('broker route policy permits Client API methods but blocks key rotation and arbitrary URLs', () => {
  assert.equal(isFabricBrokerRouteAllowed('GET', '/v0/webui/projects?open=true'), true);
  assert.equal(isFabricBrokerRouteAllowed('POST', '/v0/webui/chat'), true);
  assert.equal(isFabricBrokerRouteAllowed('PATCH', '/v0/webui/openai-models'), true);
  assert.equal(isFabricBrokerRouteAllowed('DELETE', '/v0/webui/accounts/claude/account-1'), true);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/healthz'), true);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/readyz'), true);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/v0/fabric/descriptor'), true);
  assert.equal(isFabricBrokerRouteAllowed('POST', '/v0/webui/server-config/management-key/rotate'), false);
  assert.equal(isFabricBrokerRouteAllowed('GET', '/v0/management/accounts'), false);
  assert.equal(isFabricBrokerRouteAllowed('POST', '/v1/responses'), false);
  assert.equal(isFabricBrokerRouteAllowed('GET', 'http://169.254.169.254/latest/meta-data'), false);
});

test('local broker handler frames streaming response chunks without buffering the whole response', async () => {
  const socket = new FakeSocket();
  let requestTimeoutCleared = false;
  let releaseSecondChunk;
  const secondChunk = new Promise((resolve) => {
    releaseSecondChunk = resolve;
  });
  const handler = createBrokerRequestHandler({
    localUrl: 'http://127.0.0.1:9527',
    requestTimeoutMs: 1000
  }, {
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {
      requestTimeoutCleared = true;
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([
        ['content-type', 'text/event-stream'],
        ['cache-control', 'no-cache']
      ]),
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(Buffer.from('data: first\n\n'));
          await secondChunk;
          controller.enqueue(Buffer.from('data: second\n\n'));
          controller.close();
        }
      })
    })
  });

  const pending = handler(socket, {
    type: 'broker.request',
    requestId: 'request-1',
    method: 'GET',
    pathname: '/v0/webui/projects/watch',
    headers: { accept: 'text/event-stream' }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(socket.frames.map((frame) => frame.type), [
    'broker.response.start',
    'broker.response.chunk'
  ]);
  assert.equal(requestTimeoutCleared, true);
  assert.equal(
    Buffer.from(socket.frames[1].bodyBase64, 'base64').toString('utf8'),
    'data: first\n\n'
  );

  releaseSecondChunk();
  await pending;
  assert.deepEqual(socket.frames.map((frame) => frame.type), [
    'broker.response.start',
    'broker.response.chunk',
    'broker.response.chunk',
    'broker.response.end'
  ]);
});

test('local broker handler never follows or republishes redirect locations', async () => {
  const socket = new FakeSocket();
  let redirectMode = '';
  const handler = createBrokerRequestHandler({
    localUrl: 'http://127.0.0.1:9527',
    requestTimeoutMs: 1000
  }, {
    fetchImpl: async (_url, init) => {
      redirectMode = init.redirect;
      return {
        ok: false,
        status: 302,
        headers: new Map([
          ['content-type', 'text/plain'],
          ['location', 'https://attacker.invalid/capture'],
          ['set-cookie', 'session=secret']
        ]),
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0)
      };
    }
  });

  await handler(socket, {
    type: 'broker.request',
    requestId: 'redirect-1',
    method: 'GET',
    pathname: '/v0/webui/projects',
    headers: { authorization: 'Bearer local-management-key' }
  });

  assert.equal(redirectMode, 'manual');
  const start = socket.frames.find((frame) => frame.type === 'broker.response.start');
  assert.equal(Object.hasOwn(start.headers, 'location'), false);
  assert.equal(Object.hasOwn(start.headers, 'set-cookie'), false);
});

test('cancel frame aborts the matching local Client API request', async () => {
  const socket = new FakeSocket();
  let observedSignal;
  const handler = createBrokerRequestHandler({
    localUrl: 'http://127.0.0.1:9527',
    requestTimeoutMs: 5000
  }, {
    fetchImpl: async (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
  });

  const pending = handler(socket, {
    type: 'broker.request',
    requestId: 'request-2',
    method: 'GET',
    pathname: '/v0/webui/projects/watch'
  });
  await new Promise((resolve) => setImmediate(resolve));
  await handler(socket, {
    type: 'broker.request.cancel',
    requestId: 'request-2'
  });
  await pending;

  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(socket.frames, []);
});

test('AWS broker writes streaming frames as they arrive and cancels when the Client disconnects', async () => {
  const socket = new FakeSocket();
  const response = new FakeResponse();
  let responseTimeoutCleared = false;
  const pending = streamBrokerResponse({
    socket,
    requestId: 'request-3',
    serverId: 'local-home',
    res: response,
    timeoutMs: 1000,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {
      responseTimeoutCleared = true;
    }
  });

  socket.emit('message', JSON.stringify({
    type: 'broker.response.start',
    requestId: 'request-3',
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  }));
  socket.emit('message', JSON.stringify({
    type: 'broker.response.chunk',
    requestId: 'request-3',
    sequence: 0,
    bodyBase64: Buffer.from('data: first\n\n').toString('base64')
  }));

  assert.equal(Buffer.concat(response.chunks).toString('utf8'), 'data: first\n\n');
  assert.equal(response.writableEnded, false);
  assert.equal(responseTimeoutCleared, true);

  response.emit('close');
  await pending;
  assert.equal(socket.frames.at(-1).type, 'broker.request.cancel');
  assert.equal(socket.frames.at(-1).requestId, 'request-3');
});

test('AWS broker limits concurrent requests per Server and releases the slot after completion', async () => {
  const socket = new FakeSocket();
  const firstResponse = new FakeResponse();
  const firstPending = handleFabricBrokerProxyRequest(
    createBrokerProxyContext(socket, firstResponse)
  );
  await new Promise((resolve) => setImmediate(resolve));
  const firstFrame = socket.frames.find((frame) => frame.type === 'broker.request');

  const secondResponse = new FakeResponse();
  const secondPending = handleFabricBrokerProxyRequest(
    createBrokerProxyContext(socket, secondResponse)
  );
  await new Promise((resolve) => setImmediate(resolve));
  const secondStatus = secondResponse.statusCode;
  const secondBody = Buffer.concat(secondResponse.chunks).toString('utf8');

  socket.frames.filter((frame) => frame.type === 'broker.request').forEach((frame) => {
    completeBrokerRequest(socket, frame.requestId);
  });
  await Promise.all([firstPending, secondPending]);

  assert.equal(secondStatus, 429);
  assert.equal(JSON.parse(secondBody).error, 'fabric_broker_concurrency_limited');
  assert.equal(socket.frames.filter((frame) => frame.type === 'broker.request').length, 1);

  const thirdResponse = new FakeResponse();
  const thirdPending = handleFabricBrokerProxyRequest(
    createBrokerProxyContext(socket, thirdResponse)
  );
  await new Promise((resolve) => setImmediate(resolve));
  const thirdFrame = socket.frames.filter((frame) => frame.type === 'broker.request').at(-1);
  assert.notEqual(thirdFrame.requestId, firstFrame.requestId);
  completeBrokerRequest(socket, thirdFrame.requestId);
  await thirdPending;
  assert.equal(thirdResponse.statusCode, 200);
});
