const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
} = require('../lib/server/webui-sse-broadcaster');

function createStreamResCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = { ...this.headers, ...headers };
    },
    write(chunk = '') {
      this.body += String(chunk);
      return true;
    }
  };
}

test('openSseStream writes standard event stream headers', () => {
  const res = createStreamResCapture();

  openSseStream(res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.headers, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
});

test('writeSseJson serializes payload as SSE data frame', () => {
  const res = createStreamResCapture();

  writeSseJson(res, { type: 'connected', ok: true });

  assert.equal(res.body, 'data: {"type":"connected","ok":true}\n\n');
});

test('attachSseWatcher registers watcher and removes it on close', async () => {
  const watchers = new Set();
  const req = new EventEmitter();
  const res = createStreamResCapture();
  let removedCount = 0;

  attachSseWatcher(watchers, req, res, {
    heartbeatMs: 50,
    onWatcherRemoved: () => {
      removedCount += 1;
    }
  });

  assert.equal(watchers.size, 1);
  req.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(watchers.size, 0);
  assert.equal(removedCount, 1);
});

test('broadcastSseJson removes broken watchers and keeps healthy watchers', () => {
  const healthyRes = createStreamResCapture();
  const brokenRes = {
    write() {
      throw new Error('broken_pipe');
    }
  };
  const healthyWatcher = { res: healthyRes, heartbeat: setInterval(() => {}, 1000) };
  const brokenWatcher = { res: brokenRes, heartbeat: setInterval(() => {}, 1000) };
  if (typeof healthyWatcher.heartbeat.unref === 'function') healthyWatcher.heartbeat.unref();
  if (typeof brokenWatcher.heartbeat.unref === 'function') brokenWatcher.heartbeat.unref();
  const watchers = new Set([healthyWatcher, brokenWatcher]);
  const removed = [];

  broadcastSseJson(watchers, { type: 'runtime', running: true }, {
    onWatcherRemoved: (watcher) => {
      removed.push(watcher);
    }
  });

  clearInterval(healthyWatcher.heartbeat);

  assert.equal(watchers.size, 1);
  assert.ok(watchers.has(healthyWatcher));
  assert.deepEqual(removed, [brokenWatcher]);
  assert.equal(healthyRes.body, 'data: {"type":"runtime","running":true}\n\n');
});
