'use strict';

// 事件总线：一个事件、多个 listener。
// 上一轮用探针证明过 ACP 的 onNotification 是单槽的（第二次注册静默覆盖第一次），
// 这里就是那个坑的回归守卫。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEventBus } = require('../lib/agent-session/event-bus');

function busWithClock() {
  let clock = 1000;
  let seq = 0;
  return createEventBus({
    sessionId: 's1',
    now: () => (clock += 1),
    newEventId: () => `evt_${++seq}`
  });
}

test('one event reaches every listener', () => {
  const bus = busWithClock();
  const seen = [[], [], []];
  seen.forEach((bucket) => bus.subscribe((event) => bucket.push(event.type)));
  bus.publish({ type: 'turn.started' });
  assert.deepEqual(seen, [['turn.started'], ['turn.started'], ['turn.started']]);
  assert.equal(bus.listenerCount(), 3);
});

test('a throwing listener does not starve the others', () => {
  const bus = busWithClock();
  const seen = [];
  bus.subscribe(() => { throw new Error('boom'); });
  bus.subscribe((event) => seen.push(event.type));
  bus.publish({ type: 'turn.completed' });
  assert.deepEqual(seen, ['turn.completed']);
  const errors = bus.listenerErrors();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'agent_session_listener_threw');
  assert.equal(errors[0].message, 'boom');
});

test('envelope carries schema, monotonic seq and timestamp', () => {
  const bus = busWithClock();
  const first = bus.publish({ type: 'turn.started', turnId: 't1', payload: { a: 1 } });
  const second = bus.publish({ type: 'turn.completed' });
  assert.equal(first.schema, 'aih.chat.event.v1');
  assert.equal(first.sessionId, 's1');
  assert.equal(first.turnId, 't1');
  assert.deepEqual(first.payload, { a: 1 });
  assert.equal(first.seq + 1, second.seq);
  assert.ok(second.at > first.at);
  assert.deepEqual(second.payload, {});
});

test('unsubscribe removes exactly one listener and is idempotent', () => {
  const bus = busWithClock();
  const a = [];
  const b = [];
  const offA = bus.subscribe((event) => a.push(event.type));
  bus.subscribe((event) => b.push(event.type));
  offA();
  offA();
  bus.publish({ type: 'turn.started' });
  assert.deepEqual(a, []);
  assert.deepEqual(b, ['turn.started']);
});

test('unknown event types are rejected instead of silently published', () => {
  const bus = busWithClock();
  assert.throws(() => bus.publish({ type: 'turn.startd' }), (error) => error.code === 'agent_session_event_type_unknown');
  assert.equal(bus.seq, 0);
});

test('close publishes session.closed once and then refuses writes', () => {
  const bus = busWithClock();
  const seen = [];
  bus.subscribe((event) => seen.push(event.type));
  bus.close('done');
  assert.deepEqual(seen, ['session.closed']);
  assert.equal(bus.closed, true);
  assert.throws(() => bus.publish({ type: 'turn.started' }), (error) => error.code === 'agent_session_bus_closed');
  assert.equal(bus.close(), null);
});

test('subscribing after close is rejected', () => {
  const bus = busWithClock();
  bus.close();
  assert.throws(() => bus.subscribe(() => {}), (error) => error.code === 'agent_session_bus_closed');
});
