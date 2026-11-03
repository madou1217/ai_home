'use strict';

// 会话外壳：把 adapter（各协议）、事件总线、交互路由器绑成一个有生命周期的对象。
//
// 分层意图：adapter 只负责「把自家协议翻译成契约事件」，不碰 fan-out、不管谁在听、
// 不做单答者仲裁；这些是外壳的职责。因此换 adapter 不需要重写通知逻辑，
// 加 listener 也不需要改 adapter。

const {
  AgentSessionError,
  assertSessionState,
  isPlainObject,
  nonEmptyString
} = require('./contracts');

const TRANSITIONS = Object.freeze({
  idle: Object.freeze(['starting', 'running', 'closed']),
  starting: Object.freeze(['idle', 'running', 'closed']),
  running: Object.freeze(['waiting_input', 'idle', 'completing', 'interrupting', 'closed']),
  waiting_input: Object.freeze(['running', 'idle', 'completing', 'interrupting', 'closed']),
  completing: Object.freeze(['idle', 'running', 'closed']),
  interrupting: Object.freeze(['idle', 'closed']),
  recovering: Object.freeze(['idle', 'running', 'closed']),
  closed: Object.freeze([])
});

const ADAPTER_REQUIRED_METHODS = Object.freeze([
  'open', 'prompt', 'cancel', 'respond', 'subscribe', 'onInteractionRequest', 'dispose'
]);

function assertAdapter(adapter) {
  if (!isPlainObject(adapter) && typeof adapter !== 'object') {
    throw new AgentSessionError('agent_session_adapter_required');
  }
  for (const method of ADAPTER_REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new AgentSessionError('agent_session_adapter_method_missing', { method, adapter: adapter.id });
    }
  }
  if (!nonEmptyString(adapter.id) || !nonEmptyString(adapter.provider) || !nonEmptyString(adapter.transport)) {
    throw new AgentSessionError('agent_session_adapter_descriptor_incomplete', {
      adapter: nonEmptyString(adapter.id) || null
    });
  }
  return adapter;
}

function createAgentSession(options) {
  const config = isPlainObject(options) ? options : {};
  const sessionId = nonEmptyString(config.sessionId);
  if (!sessionId) throw new AgentSessionError('agent_session_id_required');
  const bus = config.bus;
  const router = config.router;
  if (!bus || !router) throw new AgentSessionError('agent_session_bus_required');
  const adapter = assertAdapter(config.adapter);

  let state = 'idle';
  let turnSeq = 0;
  const disposers = [];

  function transition(next) {
    const target = assertSessionState(next);
    const allowed = TRANSITIONS[state] || [];
    if (!allowed.includes(target)) {
      throw new AgentSessionError('agent_session_state_transition_invalid', { from: state, to: target });
    }
    state = target;
  }

  function forward(event) {
    if (!isPlainObject(event)) return;
    bus.publish(event);
  }

  function onRequest(request) {
    try {
      return router.request(request);
    } catch (error) {
      bus.publish({
        type: 'stream.error',
        payload: {
          source: 'agent-session',
          code: error && error.code ? error.code : 'agent_session_interaction_rejected',
          message: String(error && error.message ? error.message : error)
        }
      });
      throw error;
    }
  }

  // router 侧超时（或任何本地收尾）要回写给 harness，否则它会一直等这个审批。
  // 只在 adapter 提供了 expire 时接：没有回写通道的 adapter 不该被假装通知过。
  if (typeof adapter.expire === 'function') {
    disposers.push(bus.subscribe((event) => {
      if (event.type !== 'interaction.expired') return;
      if (state === 'closed') return;
      try {
        adapter.expire(event.payload.interactionId, event.payload.resolution);
      } catch (_error) {}
    }));
  }

  disposers.push(adapter.subscribe(forward));
  disposers.push(adapter.onInteractionRequest(onRequest));
  // 可选通道：adapter 发现交互已经不可能被回答（提示被顶掉、屏幕变干净）时，
  // 主动让 router 收尾。没有这条通道，attention 帧会一直钉在标题上。
  if (typeof adapter.onInteractionExpire === 'function') {
    disposers.push(adapter.onInteractionExpire((interactionId, reason) => {
      try {
        router.expire(interactionId, reason || 'adapter_retracted');
      } catch (error) {
        if (!error || error.code !== 'agent_session_interaction_unknown') throw error;
      }
    }));
  }

  async function open(openOptions) {
    transition('starting');
    try {
      const result = await adapter.open(openOptions || {});
      bus.publish({ type: 'session.created', payload: { provider: adapter.provider, transport: adapter.transport } });
      transition('idle');
      return result;
    } catch (error) {
      transition('idle');
      throw error;
    }
  }

  async function prompt(promptOptions) {
    if (state === 'closed') throw new AgentSessionError('agent_session_closed', { sessionId });
    if (state === 'running') throw new AgentSessionError('agent_session_turn_in_progress', { sessionId });
    turnSeq += 1;
    const turnId = nonEmptyString(promptOptions && promptOptions.turnId) || `turn_${turnSeq}`;
    transition('running');
    bus.publish({ type: 'turn.started', turnId, payload: { provider: adapter.provider } });
    try {
      const result = await adapter.prompt(Object.assign({}, promptOptions, { turnId }));
      // dispose 之后 bus 已关：再 transition/publish 会把真实结果盖成
      // agent_session_state_transition_invalid，调用方就看不到真正发生了什么。
      if (state === 'closed') return Object.assign({ turnId }, result);
      const stopReason = nonEmptyString(result && result.stopReason) || null;
      transition('idle');
      bus.publish({ type: 'turn.completed', turnId, payload: { stopReason } });
      return Object.assign({ turnId }, result);
    } catch (error) {
      if (state === 'closed') throw error;
      transition('idle');
      bus.publish({
        type: 'turn.failed',
        turnId,
        payload: {
          code: error && error.code ? error.code : 'agent_session_turn_failed',
          message: String(error && error.message ? error.message : error)
        }
      });
      throw error;
    }
  }

  async function cancel(reason) {
    if (state === 'closed') throw new AgentSessionError('agent_session_closed', { sessionId });
    const active = state === 'running' || state === 'waiting_input';
    // 先落到 interrupting 再等 adapter：adapter 通常会同步 reject 在飞的 prompt，
    // 那条 catch 会把 running 迁回 idle；如果这里仍停在 running，两步就会互相打架。
    if (active) transition('interrupting');
    bus.publish({ type: 'turn.interrupt.requested', payload: { reason: nonEmptyString(reason) || null } });
    try {
      const result = await adapter.cancel(reason);
      if (state === 'interrupting') transition('idle');
      bus.publish({ type: 'turn.interrupted', payload: { reason: nonEmptyString(reason) || null } });
      return result;
    } catch (error) {
      // cancel 失败不能让会话卡在 interrupting：那是「永远转圈」的经典形态。
      if (state === 'interrupting') transition('idle');
      bus.publish({
        type: 'stream.error',
        payload: { code: error && error.code ? error.code : 'agent_session_cancel_failed' }
      });
      throw error;
    }
  }

  function respond(interactionId, decision) {
    // 先由路由器仲裁（唯一 responder、重复拒绝），再回写 harness：
    // 顺序反过来会出现「harness 已收到两次答案、本地只记一次」。
    const resolved = router.respond(interactionId, decision);
    try {
      adapter.respond(interactionId, resolved.decision);
    } catch (error) {
      bus.publish({
        type: 'stream.error',
        payload: {
          code: error && error.code ? error.code : 'agent_session_adapter_respond_failed',
          interactionId: resolved.interactionId
        }
      });
      throw error;
    }
    return resolved;
  }

  function setMode(modeId) {
    if (typeof adapter.setMode !== 'function') {
      throw new AgentSessionError('agent_session_adapter_unsupported_operation', { operation: 'setMode' });
    }
    return adapter.setMode(modeId);
  }

  function setModel(modelId) {
    if (typeof adapter.setModel !== 'function') {
      throw new AgentSessionError('agent_session_adapter_unsupported_operation', { operation: 'setModel' });
    }
    return adapter.setModel(modelId);
  }

  function snapshot() {
    return {
      sessionId,
      provider: adapter.provider,
      adapterId: adapter.id,
      transport: adapter.transport,
      state,
      interactions: router.pending(),
      lastEvent: bus.lastEvent()
    };
  }

  function dispose(reason) {
    if (state === 'closed') return;
    for (const disposer of disposers.splice(0)) {
      try {
        if (typeof disposer === 'function') disposer();
      } catch (_ignored) {}
    }
    // 先落 closed：adapter.dispose 通常会 reject 在飞的 prompt，那条 catch
    // 必须看见 closed 才知道「不要再去 transition/publish」。
    state = 'closed';
    try {
      adapter.dispose(reason);
    } catch (_ignored) {}
    router.dispose(reason);
    bus.close(reason);
  }

  return {
    sessionId,
    adapter,
    bus,
    router,
    open,
    prompt,
    cancel,
    respond,
    setMode,
    setModel,
    subscribe: (listener) => bus.subscribe(listener),
    snapshot,
    dispose,
    get state() {
      return state;
    }
  };
}

module.exports = { createAgentSession, TRANSITIONS };
