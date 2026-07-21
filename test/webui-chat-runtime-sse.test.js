'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  openChatRuntimeEventStream
} = require('../lib/server/webui-chat-runtime-sse');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function createFixture() {
  const req = new EventEmitter();
  req.url = '/events';
  req.headers = { host: '127.0.0.1:9527' };
  const res = Object.assign(new EventEmitter(), {
    body: '',
    writableEnded: false,
    writeHead() {},
    write(chunk) { this.body += String(chunk); return true; },
    end(chunk = '') { this.body += String(chunk); this.writableEnded = true; }
  });
  return { ctx: { req, res }, req, res };
}

function createTimers() {
  let callback;
  let clears = 0;
  let milliseconds;
  const handle = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };
  return {
    clearInterval(value) { assert.equal(value, handle); clears += 1; },
    get callback() { return callback; },
    get clears() { return clears; },
    get milliseconds() { return milliseconds; },
    handle,
    setInterval(next, delay) { callback = next; milliseconds = delay; return handle; }
  };
}

test('replay buffer overflow emits stream.error and closes without silent drops', async () => {
  const replay = deferred();
  const timers = createTimers();
  let publish;
  let unsubscribes = 0;
  const service = {
    subscribe(_sessionId, listener) {
      publish = listener;
      return () => { unsubscribes += 1; };
    },
    readEvents: () => replay.promise
  };
  const { ctx, res } = createFixture();
  const opened = openChatRuntimeEventStream(ctx, service, 'session-1', options(timers, {
    replayBufferLimit: 2
  }));

  publish(event(11));
  publish(event(12));
  publish(event(13));
  replay.resolve({ events: [event(10)], throughSeq: 10 });
  await opened;

  assert.equal(res.writableEnded, true);
  assert.match(res.body, /event: stream\.error/);
  assert.match(res.body, /chat_runtime_replay_buffer_overflow/);
  assert.doesNotMatch(res.body, /id: 10/);
  assert.equal(unsubscribes, 1);
  assert.equal(timers.clears, 1);
});

test('backpressure pauses replay and live frames until drain in sequence order', async () => {
  let publish;
  let writeCalls = 0;
  const service = {
    subscribe(_sessionId, listener) { publish = listener; return () => {}; },
    async readEvents() {
      publish(event(13));
      return { events: [event(11), event(12)], throughSeq: 12 };
    }
  };
  const { ctx, req, res } = createFixture();
  res.write = function write(chunk) {
    writeCalls += 1;
    this.body += String(chunk);
    return writeCalls !== 1;
  };

  await openChatRuntimeEventStream(ctx, service, 'session-1', {
    heartbeatMs: 60_000,
    pendingFrameLimit: 4
  });

  assert.match(res.body, /id: 11/);
  assert.doesNotMatch(res.body, /id: 12|id: 13/);
  res.emit('drain');
  assert.ok(res.body.indexOf('id: 11') < res.body.indexOf('id: 12'));
  assert.ok(res.body.indexOf('id: 12') < res.body.indexOf('id: 13'));
  req.emit('close');
});

test('backpressure queue overflow emits stream.error and closes the connection', async () => {
  const timers = createTimers();
  let unsubscribes = 0;
  const service = {
    subscribe() { return () => { unsubscribes += 1; }; },
    async readEvents() {
      return { events: [event(1), event(2), event(3)], throughSeq: 3 };
    }
  };
  const { ctx, res } = createFixture();
  res.write = function write(chunk) { this.body += String(chunk); return false; };

  await openChatRuntimeEventStream(ctx, service, 'session-1', options(timers, {
    pendingFrameLimit: 1
  }));

  assert.equal(res.writableEnded, true);
  assert.match(res.body, /event: stream\.error/);
  assert.match(res.body, /chat_runtime_backpressure_overflow/);
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(unsubscribes, 1);
  assert.equal(timers.clears, 1);
});

test('heartbeat defaults to 15s and req or res termination cleans resources once', async (t) => {
  const signals = [
    ['req', 'close'],
    ['req', 'error'],
    ['res', 'close'],
    ['res', 'error']
  ];
  for (const [target, type] of signals) {
    await t.test(`${target} ${type}`, async () => {
      const timers = createTimers();
      let unsubscribes = 0;
      const service = {
        async readEvents() { return { events: [], throughSeq: 0 }; },
        subscribe() { return () => { unsubscribes += 1; }; }
      };
      const fixture = createFixture();
      await openChatRuntimeEventStream(
        fixture.ctx,
        service,
        'session-1',
        options(timers)
      );

      timers.callback();
      assert.match(fixture.res.body, /: heartbeat\n\n/);
      assert.equal(timers.milliseconds, 15_000);
      assert.equal(timers.handle.unrefCalls, 1);

      fixture[target].emit(type, type === 'error' ? new Error(type) : undefined);
      (target === 'req' ? fixture.res : fixture.req).emit('close');
      assert.equal(unsubscribes, 1);
      assert.equal(timers.clears, 1);
      for (const emitter of [fixture.req, fixture.res]) {
        assert.equal(emitter.listenerCount('close'), 0);
        assert.equal(emitter.listenerCount('error'), 0);
      }
    });
  }
});

test('replay failure cleans heartbeat and subscription before ending the stream', async () => {
  const timers = createTimers();
  let unsubscribes = 0;
  const service = {
    async readEvents() { throw Object.assign(new Error('replay failed'), { code: 'REPLAY' }); },
    subscribe() { return () => { unsubscribes += 1; }; }
  };
  const { ctx, res } = createFixture();

  await openChatRuntimeEventStream(ctx, service, 'session-1', options(timers));

  assert.equal(unsubscribes, 1);
  assert.equal(timers.clears, 1);
  assert.equal(res.writableEnded, true);
  assert.match(res.body, /event: stream\.error/);
  assert.match(res.body, /REPLAY/);
});

function options(timers, overrides = {}) {
  return {
    ...overrides,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval
  };
}

function event(seq) {
  return { seq, type: 'timeline.item.delta', payload: { chunk: `event-${seq}` } };
}
