'use strict';

// 交互路由器：把「harness 要人回一句话」变成一次有 id、有版本、有超时的请求。
//
// 三条硬规则：
//   1. 一个交互只有一个 responder。listener 是观察者，不能改状态；
//      重复 respond（用户连按两次、两个消费者同时抢答）必须以
//      agent_session_interaction_already_resolved 拒绝，不能二次写回 harness。
//   2. 不认识的 id 一律拒绝，绝不「顺手新建一个」——那会把错配掩盖成成功。
//   3. 超时/自动决议走同一条落库路径，保证 requested 一定有 resolved 或 expired 收尾，
//      否则 terminal title 的 ? 提示会永久钉住（attention 帧不会自己消失）。

const {
  AgentSessionError,
  INTERACTION_STATES,
  isPlainObject,
  nonEmptyString,
  normalizeDecision,
  normalizeInteractionRequest
} = require('./contracts');

const DEFAULT_TIMEOUT_MS = 0;

function createInteractionRouter(options) {
  const config = isPlainObject(options) ? options : {};
  const sessionId = nonEmptyString(config.sessionId);
  if (!sessionId) throw new AgentSessionError('agent_session_id_required');
  const bus = config.bus;
  if (!bus || typeof bus.publish !== 'function') {
    throw new AgentSessionError('agent_session_bus_required');
  }
  const now = typeof config.now === 'function' ? config.now : () => Date.now();
  const setTimer = typeof config.setTimeout === 'function' ? config.setTimeout : setTimeout;
  const clearTimer = typeof config.clearTimeout === 'function' ? config.clearTimeout : clearTimeout;
  const defaultTimeoutMs = Number.isFinite(Number(config.timeoutMs))
    ? Math.max(0, Math.floor(Number(config.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const records = new Map();
  let disposed = false;

  function publish(type, record, extra) {
    return bus.publish({
      type,
      turnId: record.turnId || undefined,
      itemId: record.itemId || undefined,
      payload: Object.assign({
        interactionId: record.interactionId,
        kind: record.kind,
        revision: record.revision,
        state: record.state
      }, extra || {})
    });
  }

  function clearRecordTimer(record) {
    if (!record.timer) return;
    clearTimer(record.timer);
    record.timer = null;
  }

  function publicView(record) {
    return Object.freeze({
      interactionId: record.interactionId,
      kind: record.kind,
      payload: record.payload,
      turnId: record.turnId,
      itemId: record.itemId,
      revision: record.revision,
      state: record.state,
      requestedAt: record.requestedAt,
      resolvedAt: record.resolvedAt,
      decision: record.decision,
      resolution: record.resolution
    });
  }

  function scheduleTimeout(record) {
    const timeoutMs = record.timeoutMs || defaultTimeoutMs;
    if (!timeoutMs) return;
    record.timer = setTimer(() => {
      record.timer = null;
      expire(record.interactionId, 'timeout');
    }, timeoutMs);
    if (record.timer && typeof record.timer.unref === 'function') record.timer.unref();
  }

  function scheduleAutoResolution(record) {
    const auto = record.autoResolution;
    if (!isPlainObject(auto)) return;
    const inactivityMs = Number(auto.inactivityMs);
    if (!Number.isFinite(inactivityMs) || inactivityMs <= 0) return;
    record.timer = setTimer(() => {
      record.timer = null;
      const decision = auto.onExpire === 'submit_empty'
        ? { action: 'submit', answers: {} }
        : { action: 'decline' };
      settle(record, 'resolved', decision, 'auto_resolution');
    }, inactivityMs);
    if (record.timer && typeof record.timer.unref === 'function') record.timer.unref();
  }

  function request(input) {
    if (disposed) throw new AgentSessionError('agent_session_router_disposed');
    const normalized = normalizeInteractionRequest(input);
    const existing = records.get(normalized.interactionId);
    if (existing && existing.state === 'pending') {
      // 同一 id 重复请求：版本号相同视为重放，直接返回现值（幂等）；
      // 内容不同则是两个交互撞了 id，必须报错。
      if (existing.revision === 1 && samePayload(existing.payload, normalized.payload)) {
        return publicView(existing);
      }
      throw new AgentSessionError('agent_session_interaction_duplicate', {
        interactionId: normalized.interactionId
      });
    }
    const record = {
      interactionId: normalized.interactionId,
      kind: normalized.kind,
      payload: normalized.payload,
      turnId: normalized.turnId,
      itemId: normalized.itemId,
      timeoutMs: normalized.timeoutMs || 0,
      autoResolution: normalized.autoResolution || null,
      revision: 1,
      state: 'pending',
      requestedAt: now(),
      resolvedAt: null,
      decision: null,
      resolution: null,
      timer: null
    };
    records.set(record.interactionId, record);
    publish('interaction.requested', record, { payload: record.payload });
    scheduleTimeout(record);
    if (!record.timer) scheduleAutoResolution(record);
    return publicView(record);
  }

  function update(interactionId, patch) {
    const record = requirePending(interactionId, 'update');
    const input = isPlainObject(patch) ? patch : {};
    if (input.payload !== undefined) {
      const normalized = normalizeInteractionRequest({
        interactionId: record.interactionId,
        kind: record.kind,
        payload: input.payload,
        turnId: record.turnId,
        itemId: record.itemId
      });
      record.payload = normalized.payload;
    }
    record.revision += 1;
    publish('interaction.updated', record, { payload: record.payload });
    return publicView(record);
  }

  function respond(interactionId, decision) {
    const record = requirePending(interactionId, 'respond');
    const normalizedDecision = normalizeDecision(record.kind, record.payload, decision);
    return settle(record, 'resolved', normalizedDecision, 'answered');
  }

  function expire(interactionId, reason) {
    const record = records.get(nonEmptyString(interactionId));
    if (!record) throw new AgentSessionError('agent_session_interaction_unknown', { interactionId });
    if (record.state !== 'pending') return publicView(record);
    return settle(record, 'expired', null, nonEmptyString(reason) || 'expired');
  }

  function settle(record, state, decision, resolution) {
    clearRecordTimer(record);
    record.state = state;
    record.decision = decision;
    record.resolution = resolution;
    record.resolvedAt = now();
    const type = state === 'expired' ? 'interaction.expired' : 'interaction.resolved';
    publish(type, record, { decision, resolution });
    return publicView(record);
  }

  function requirePending(interactionId, operation) {
    const id = nonEmptyString(interactionId);
    const record = records.get(id);
    if (!record) throw new AgentSessionError('agent_session_interaction_unknown', { interactionId: id, operation });
    if (record.state !== 'pending') {
      throw new AgentSessionError('agent_session_interaction_already_resolved', {
        interactionId: id,
        state: record.state
      });
    }
    return record;
  }

  function samePayload(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function get(interactionId) {
    const record = records.get(nonEmptyString(interactionId));
    return record ? publicView(record) : null;
  }

  function pending() {
    return Array.from(records.values())
      .filter((record) => record.state === 'pending')
      .map(publicView);
  }

  function pendingCount() {
    let count = 0;
    for (const record of records.values()) if (record.state === 'pending') count += 1;
    return count;
  }

  function dispose(reason) {
    if (disposed) return;
    for (const record of records.values()) {
      if (record.state === 'pending') settle(record, 'expired', null, nonEmptyString(reason) || 'disposed');
      else clearRecordTimer(record);
    }
    disposed = true;
  }

  return {
    sessionId,
    request,
    update,
    respond,
    expire,
    get,
    pending,
    pendingCount,
    dispose,
    states: INTERACTION_STATES,
    get disposed() {
      return disposed;
    }
  };
}

module.exports = { createInteractionRouter, DEFAULT_TIMEOUT_MS };
