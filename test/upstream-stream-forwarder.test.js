const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const zlib = require('node:zlib');
const { fetchWithTimeout } = require('../lib/server/http-utils');
const {
  createBoundedTailCapture,
  createDownstreamAbortContext,
  pipeReadableBodyToResponse
} = require('../lib/server/upstream-stream-forwarder');

function createWritableCapture(writeResults = []) {
  const response = new EventEmitter();
  response.body = Buffer.alloc(0);
  response.writableEnded = false;
  response.write = (chunk) => {
    response.body = Buffer.concat([response.body, Buffer.from(chunk)]);
    return writeResults.length > 0 ? writeResults.shift() : true;
  };
  return response;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

test('stream forwarder trusts body magic when fetch already decoded a gzip response', async (t) => {
  const payload = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip'
    });
    res.end(zlib.gzipSync(payload));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  const upstream = await fetchWithTimeout(`http://127.0.0.1:${port}/events`, {}, 3000);
  assert.equal(upstream.headers.get('content-encoding'), 'gzip');

  const downstream = createWritableCapture();
  const result = await pipeReadableBodyToResponse(upstream.body, downstream);

  assert.equal(result.downstreamDisconnected, false);
  assert.equal(downstream.body.toString('utf8'), payload);
});

test('stream forwarder pauses upstream reads until downstream drain', async () => {
  let readCount = 0;
  let resolveSecondRead;
  const secondRead = new Promise((resolve) => {
    resolveSecondRead = resolve;
  });
  const body = {
    async *[Symbol.asyncIterator]() {
      readCount += 1;
      yield Buffer.from('first');
      readCount += 1;
      resolveSecondRead();
      yield Buffer.from('second');
    }
  };
  const downstream = createWritableCapture([false, true]);

  const completion = pipeReadableBodyToResponse(body, downstream);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readCount, 1);

  downstream.emit('drain');
  await secondRead;
  await completion;
  assert.equal(downstream.body.toString('utf8'), 'firstsecond');
});

test('downstream abort context detects a client disconnected before listener binding', () => {
  const context = createDownstreamAbortContext(
    { aborted: true },
    { destroyed: true, writableEnded: false }
  );

  assert.equal(context.signal.aborted, true);
  assert.equal(context.isDisconnected(), true);
  context.dispose();

  const endedContext = createDownstreamAbortContext({}, { writableEnded: true });
  assert.equal(endedContext.signal.aborted, true);
  assert.equal(endedContext.isDisconnected(), true);
  endedContext.dispose();
});

test('stream forwarder cancels the source when downstream closes under backpressure', async () => {
  let sourceCancelled = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      try {
        yield Buffer.from('first');
        yield Buffer.from('second');
      } finally {
        sourceCancelled = true;
      }
    }
  };
  const downstream = createWritableCapture([false]);

  const completion = pipeReadableBodyToResponse(body, downstream);
  await new Promise((resolve) => setImmediate(resolve));
  downstream.emit('close');
  const result = await completion;

  assert.equal(result.downstreamDisconnected, true);
  assert.equal(sourceCancelled, true);
  assert.equal(downstream.body.toString('utf8'), 'first');
});

test('stream forwarder treats a downstream error as cancellation under backpressure', async () => {
  let sourceCancelled = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      try {
        yield Buffer.from('first');
        yield Buffer.from('second');
      } finally {
        sourceCancelled = true;
      }
    }
  };
  const downstream = createWritableCapture([false]);

  const completion = pipeReadableBodyToResponse(body, downstream);
  await new Promise((resolve) => setImmediate(resolve));
  const socketError = new Error('socket reset');
  socketError.code = 'ECONNRESET';
  downstream.emit('error', socketError);
  const result = await completion;

  assert.equal(result.downstreamDisconnected, true);
  assert.equal(sourceCancelled, true);
  assert.equal(downstream.body.toString('utf8'), 'first');
});

test('stream forwarder treats a synchronous response write failure as cancellation', async () => {
  let sourceCancelled = false;
  const body = {
    async *[Symbol.asyncIterator]() {
      try {
        yield Buffer.from('first');
      } finally {
        sourceCancelled = true;
      }
    }
  };
  const downstream = createWritableCapture();
  downstream.write = () => {
    const socketError = new Error('socket closed');
    socketError.code = 'EPIPE';
    throw socketError;
  };

  const result = await pipeReadableBodyToResponse(body, downstream);

  assert.equal(result.downstreamDisconnected, true);
  assert.equal(sourceCancelled, true);
});

test('stream forwarder detects headerless gzip magic split across chunks', async () => {
  const payload = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const compressed = zlib.gzipSync(payload);
  const body = {
    async *[Symbol.asyncIterator]() {
      yield compressed.subarray(0, 1);
      yield compressed.subarray(1, 2);
      yield compressed.subarray(2);
    }
  };
  const downstream = createWritableCapture();

  await pipeReadableBodyToResponse(body, downstream);

  assert.equal(downstream.body.toString('utf8'), payload);
});

test('bounded tail capture retains only the configured stream suffix', () => {
  const capture = createBoundedTailCapture(16);

  capture.append(Buffer.alloc(1024 * 1024, 0x61));
  capture.append(Buffer.from('0123456789abcdefTAIL'));

  assert.equal(capture.size, 16);
  assert.equal(capture.capacity, 16);
  assert.equal(capture.toBuffer().toString('utf8'), '456789abcdefTAIL');
});
