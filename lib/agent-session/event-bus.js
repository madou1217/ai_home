'use strict';

// 每会话事件总线：一个事件，多个 listener。
//
// 关键约束（上一轮用探针验证过 ACP 的 onNotification 是**单槽**的，第二次注册会静默
// 覆盖第一次）：这里必须是多槽，且 listener 之间互相隔离——一个 listener 抛错不能
// 让 terminal title 收不到、也不能让会话失败。错误只记账，不向上抛。

const {
  AGENT_SESSION_EVENT_SCHEMA,
  AgentSessionError,
  assertEventType,
  isPlainObject,
  nonEmptyString
} = require('./contracts');

let fallbackCounter = 0;

function defaultEventId() {
  fallbackCounter += 1;
  return `evt_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`;
}

function createEventBus(options) {
  const config = isPlainObject(options) ? options : {};
  const sessionId = nonEmptyString(config.sessionId);
  if (!sessionId) throw new AgentSessionError('agent_session_id_required');
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const newEventId = typeof config.newEventId === 'function' ? config.newEventId : defaultEventId;
  const onListenerError = typeof config.onListenerError === 'function' ? config.onListenerError : null;

  const listeners = new Set();
  const errors = [];
  let seq = 0;
  let closed = false;
  let last = null;

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new AgentSessionError('agent_session_listener_invalid');
    }
    if (closed) throw new AgentSessionError('agent_session_bus_closed', { sessionId });
    listeners.add(listener);
    let active = true;
    return function unsubscribe() {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  }

  function buildEnvelope(input) {
    const source = isPlainObject(input) ? input : {};
    const type = assertEventType(source.type);
    seq += 1;
    const envelope = {
      schema: AGENT_SESSION_EVENT_SCHEMA,
      eventId: newEventId(),
      sessionId,
      seq,
      type,
      at: now()
    };
    for (const field of ['turnId', 'runId', 'itemId', 'source']) {
      const value = nonEmptyString(source[field]);
      if (value) envelope[field] = value;
    }
    envelope.payload = isPlainObject(source.payload) ? source.payload : {};
    return envelope;
  }

  function publish(input) {
    if (closed) throw new AgentSessionError('agent_session_bus_closed', { sessionId });
    const event = buildEnvelope(input);
    last = event;
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        const record = {
          eventId: event.eventId,
          type: event.type,
          code: error && error.code ? error.code : 'agent_session_listener_threw',
          message: String(error && error.message ? error.message : error)
        };
        errors.push(record);
        if (errors.length > 50) errors.shift();
        if (onListenerError) {
          try {
            onListenerError(record, event);
          } catch (_ignored) {}
        }
      }
    }
    return event;
  }

  function listenerCount() {
    return listeners.size;
  }

  function lastEvent() {
    return last;
  }

  function listenerErrors() {
    return errors.slice();
  }

  function close(reason) {
    if (closed) return null;
    const event = publish({ type: 'session.closed', payload: { reason: nonEmptyString(reason) || null } });
    closed = true;
    listeners.clear();
    return event;
  }

  return {
    sessionId,
    subscribe,
    publish,
    listenerCount,
    lastEvent,
    listenerErrors,
    close,
    get closed() {
      return closed;
    },
    get seq() {
      return seq;
    }
  };
}

module.exports = { createEventBus };
