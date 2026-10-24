'use strict';

const { defaultSessionEventBus } = require('./session-event-bus');
const { createRetryStatus } = require('./native-retry-status');
const { normalizeProviderHookEvent } = require('./provider-hook-event-normalizer');
const persistentSessionRegistry = require('../runtime/persistent-session-registry');
const {
  scheduleSessionPrewarm
} = require('./chat-runtime/session-prewarm-scheduler');
const { resolveAccountRef } = require('./account-ref-store');
const { recordNativeAccountRuntimeSuccess } = require('./native-session-chat');
const { normalizeProviderAccountRef } = require('../runtime/provider-session-context');
const { applyProviderHookAccountActivity, applyProviderHookAccountOutcome } = require('./provider-hook-account-activity');

const CLI_RETRY_EVENT_NAME = 'AihRetryStatus';
const CLI_INTERACTION_SYNC_EVENT_NAME = 'AihCliInteractionSync';

function applyRuntimeSessionState(store, session, input = {}) {
  if (!store || typeof store.apply !== 'function' || !session) return null;
  const type = input.type;
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const revision = Math.max(0, Number(input.revision) || 0);
  const eventId = normalizeText(input.eventId)
    || `${session.provider}:${session.sessionId}:${type}:${revision}:${Number(input.at) || Date.now()}`;
  return store.apply({
    ...session,
    correlationId: input.correlationId,
    eventId,
    type,
    revision,
    at: Number(input.at) || Date.now(),
    source: input.source || 'native-event',
    payload
  });
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

// The in-memory registry is fast, but it is intentionally rebuilt whenever the
// server restarts.  The state store persists the correlation alias so native
// provider processes that outlive the server can continue delivering events.
function resolveCorrelatedSession({ correlationRegistry, providerSessionStateStore, correlationId }) {
  const correlation = normalizeText(correlationId);
  if (!correlation) return null;
  const fromMemory = correlationRegistry && typeof correlationRegistry.resolve === 'function'
    ? correlationRegistry.resolve(correlation)
    : null;
  if (fromMemory) return fromMemory;
  const fromState = providerSessionStateStore && typeof providerSessionStateStore.resolveCorrelation === 'function'
    ? providerSessionStateStore.resolveCorrelation(correlation)
    : null;
  if (fromState && correlationRegistry && typeof correlationRegistry.bind === 'function') {
    correlationRegistry.bind(correlation, fromState);
  }
  return fromState;
}

function parsePayloadRoot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  if (payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)) {
    return payload.payload;
  }
  if (payload.event && typeof payload.event === 'object' && !Array.isArray(payload.event)) {
    return payload.event;
  }
  return payload;
}

function recordVerifiedProviderHookSuccess(ctx, body, normalized) {
  if (!normalized || normalized.event.type !== 'session:turn-completed') return false;
  const accountRef = normalizeProviderAccountRef(body && body.accountRef);
  const provider = normalizeText(normalized.session && normalized.session.provider).toLowerCase();
  const aiHomeDir = normalizeText(ctx.aiHomeDir || ctx.deps && ctx.deps.aiHomeDir);
  if (!accountRef || !provider || !aiHomeDir) return false;
  const account = resolveAccountRef(ctx.fs, aiHomeDir, accountRef, { bestEffort: true });
  if (!account || account.provider !== provider) return false;
  return recordNativeAccountRuntimeSuccess({
    provider,
    accountRef,
    aiHomeDir,
    accountRuntimeEventHub: ctx.deps && ctx.deps.accountRuntimeEventHub,
    accountStateService: ctx.deps && ctx.deps.accountStateService,
    accountRuntimeGate: ctx.deps && ctx.deps.accountRuntimeGate,
    source: 'official_hook',
    happenedAt: normalized.event.at
  });
}

async function readJsonPayload(ctx, maxBytes) {
  return ctx.readRequestBody(ctx.req, { maxBytes })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
}

async function handleProviderHookSessionEventRequest(ctx) {
  const { url, writeJson, deps } = ctx;
  const body = await readJsonPayload(ctx, 256 * 1024);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }

  const rawEvent = parsePayloadRoot(body);
  const provider = url.searchParams.get('provider') || body.provider || rawEvent.provider || '';
  const eventName = url.searchParams.get('event')
    || body.eventName
    || body.hookEventName
    || rawEvent.eventName
    || rawEvent.hookEventName
    || rawEvent.hook_event_name
    || '';
  const correlationId = normalizeText(body.correlationId || body.correlation_id);
  const correlationRegistry = deps.providerSessionCorrelationRegistry;
  const providerSessionStateStore = deps.providerSessionStateStore;
  const bus = deps.sessionEventBus || defaultSessionEventBus;

  if (eventName === CLI_INTERACTION_SYNC_EVENT_NAME) {
    const correlatedSession = resolveCorrelatedSession({
      correlationRegistry,
      providerSessionStateStore,
      correlationId
    });
    if (!correlatedSession) {
      writeJson(ctx.res, 409, { ok: false, error: 'session_correlation_not_ready' });
      return true;
    }
    const coordinator = deps.cliInteractionCoordinator;
    const prompt = body.prompt && typeof body.prompt === 'object' ? body.prompt : null;
    const cleared = normalizeText(body.clearedPromptId);
    const stateResult = applyRuntimeSessionState(providerSessionStateStore, correlatedSession, {
        type: prompt ? 'question-opened' : (cleared ? 'question-cleared' : ''),
        correlationId,
        revision: Number(body.promptRevision || body.clearedPromptRevision || 0),
        eventId: prompt
          ? `codex:question:${prompt.promptId || body.promptRevision || Date.now()}`
          : `codex:question-clear:${cleared}:${body.clearedPromptRevision || Date.now()}`,
        payload: prompt ? {
          question: prompt.question || prompt.text || prompt.prompt,
          options: Array.isArray(prompt.options) ? prompt.options.map((option) => option.value || option.label || option).slice(0, 32) : []
        } : { reason: 'cleared' }
    });
    if (!coordinator || typeof coordinator.sync !== 'function') {
      writeJson(ctx.res, stateResult && stateResult.accepted !== false ? 200 : 409, {
        ok: Boolean(stateResult && stateResult.accepted !== false),
        ...(stateResult ? { state: stateResult.state } : {})
      });
      return true;
    }
    try {
      const result = await coordinator.sync({
        session: correlatedSession,
        correlationId,
        accountRef: body.accountRef,
        prompt: body.prompt,
        promptRevision: body.promptRevision,
        clearedPromptId: body.clearedPromptId,
        clearedPromptRevision: body.clearedPromptRevision,
        resolvedDeliveryId: body.resolvedDeliveryId
      });
      if (result.promptChanged) {
        scheduleSessionPrewarm(deps.chatRuntimeService, { sessionId: result.sessionId });
      }
      writeJson(ctx.res, 200, result);
    } catch (error) {
      writeJson(ctx.res, Number(error && error.statusCode) || 422, {
        ok: false,
        error: String(error && error.code || 'cli_interaction_sync_failed')
      });
    }
    return true;
  }

  if (eventName === CLI_RETRY_EVENT_NAME) {
    const correlatedSession = resolveCorrelatedSession({
      correlationRegistry,
      providerSessionStateStore,
      correlationId
    });
    if (!correlatedSession) {
      writeJson(ctx.res, 409, { ok: false, error: 'session_correlation_not_ready' });
      return true;
    }
    const retryStatus = createRetryStatus({
      ...(body.retryStatus && typeof body.retryStatus === 'object' ? body.retryStatus : {}),
      provider: correlatedSession.provider,
      source: 'provider-runtime'
    });
    applyRuntimeSessionState(providerSessionStateStore, correlatedSession, {
      type: 'retry-updated',
      correlationId,
      eventId: `retry:${correlationId}:${retryStatus.attempt || 0}:${retryStatus.maxAttempts || 0}`,
      payload: retryStatus,
      source: 'provider-runtime'
    });
    const published = bus.publish(correlatedSession, {
      type: 'session:retry-status',
      source: 'provider-runtime',
      reason: 'cli_retry',
      phase: 'turn-updated',
      retryStatus,
      at: Date.now()
    });
    writeJson(ctx.res, 200, { ok: true, published });
    return true;
  }
  const normalized = normalizeProviderHookEvent(provider, rawEvent, {
    eventName,
    sessionId: url.searchParams.get('sessionId') || body.sessionId || body.session_id || '',
    projectDirName: url.searchParams.get('projectDirName') || body.projectDirName || body.project_dir_name || '',
    projectPath: url.searchParams.get('projectPath') || body.projectPath || body.project_path || ''
  });
  if (!normalized.ok) {
    writeJson(ctx.res, 400, { ok: false, error: normalized.error || 'invalid_provider_hook_event' });
    return true;
  }

  const normalizedEvent = {
    ...normalized.event,
    provider: normalized.session.provider,
    sessionId: normalized.session.sessionId,
    projectPath: normalized.session.projectPath,
    projectDirName: normalized.session.projectDirName,
    correlationId,
    eventId: normalizeText(body.eventId || body.event_id)
      || `${normalized.session.provider}:${normalized.session.sessionId}:${normalized.event.eventName || normalized.event.type}:${normalized.event.at}`,
    revision: Number(body.revision || body.eventRevision || 0),
    payload: normalized.event.payload || {}
  };
  if (providerSessionStateStore && typeof providerSessionStateStore.apply === 'function') {
    const stateResult = providerSessionStateStore.apply(normalizedEvent);
    if (!stateResult.accepted && stateResult.reason === 'correlation_conflict') {
      writeJson(ctx.res, 409, { ok: false, error: 'session_correlation_conflict' });
      return true;
    }
  }

  if (correlationId && correlationRegistry) {
    correlationRegistry.bind(correlationId, normalized.session);
  }
  if (
    correlationId
    && normalized.session.provider === 'codex'
    && normalizeText(deps.aiHomeDir)
  ) {
    const registry = deps.persistentSessionRegistry || persistentSessionRegistry;
    try {
      registry.bindNativeSessionByCorrelation(
        deps.aiHomeDir,
        'codex',
        correlationId,
        normalized.session.sessionId,
        { fs: deps.fs }
      );
    } catch (_error) {}
  }
  // 原生会话不经网关 attempt 编排；回合事件是它唯一的「正在服务」信号。
  applyProviderHookAccountActivity({
    accountActivity: deps.accountActivity,
    provider: normalized.session.provider,
    accountRef: body.accountRef,
    eventType: normalized.event.type,
    eventName: normalized.event.eventName
  });
  // 同一批事件也是「CLI-only 账号」唯一的结果证据：写进账号结果桶，健康统计不再只认网关流量。
  applyProviderHookAccountOutcome({
    nodeAccountOutcomes: deps.nodeAccountOutcomes,
    provider: normalized.session.provider,
    accountRef: body.accountRef,
    eventType: normalized.event.type,
    eventName: normalized.event.eventName,
    atMs: normalized.event.at
  });
  const published = bus.publish(normalized.session, normalized.event);
  const runtimeRecovered = recordVerifiedProviderHookSuccess(ctx, body, normalized);
  scheduleNativeSessionPrewarm(deps.chatRuntimeService, normalized.session);
  writeJson(ctx.res, 200, {
    ok: true,
    published,
    runtimeRecovered,
    event: {
      type: normalized.event.type,
      provider: normalized.session.provider,
      sessionId: normalized.session.sessionId,
      projectDirName: normalized.session.projectDirName,
      projectPath: normalized.session.projectPath,
      source: normalized.event.source,
      eventName: normalized.event.eventName,
      phase: normalized.event.phase
    }
  });
  return true;
}

function scheduleNativeSessionPrewarm(service, nativeSession) {
  if (normalizeText(nativeSession && nativeSession.provider).toLowerCase() !== 'codex') return false;
  const sessions = service && service.store && service.store.sessions;
  if (!sessions || typeof sessions.findByNativeIdentity !== 'function') return false;
  const session = sessions.findByNativeIdentity({
    provider: nativeSession.provider,
    nativeSessionId: nativeSession.sessionId
  });
  if (!session) return false;
  scheduleSessionPrewarm(service, session);
  return true;
}

module.exports = {
  handleProviderHookSessionEventRequest,
  parsePayloadRoot
};
