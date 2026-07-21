'use strict';

const { defaultSessionEventBus } = require('./session-event-bus');
const { createRetryStatus } = require('./native-retry-status');
const { normalizeProviderHookEvent } = require('./provider-hook-event-normalizer');
const {
  scheduleSessionPrewarm
} = require('./chat-runtime/session-prewarm-scheduler');

const CLI_RETRY_EVENT_NAME = 'AihRetryStatus';
const CLI_INTERACTION_SYNC_EVENT_NAME = 'AihCliInteractionSync';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
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
  const bus = deps.sessionEventBus || defaultSessionEventBus;

  if (eventName === CLI_INTERACTION_SYNC_EVENT_NAME) {
    const correlatedSession = correlationRegistry && correlationRegistry.resolve(correlationId);
    if (!correlatedSession) {
      writeJson(ctx.res, 409, { ok: false, error: 'session_correlation_not_ready' });
      return true;
    }
    const coordinator = deps.cliInteractionCoordinator;
    if (!coordinator || typeof coordinator.sync !== 'function') {
      writeJson(ctx.res, 503, { ok: false, error: 'cli_interaction_unavailable' });
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
    const correlatedSession = correlationRegistry && correlationRegistry.resolve(correlationId);
    if (!correlatedSession) {
      writeJson(ctx.res, 409, { ok: false, error: 'session_correlation_not_ready' });
      return true;
    }
    const retryStatus = createRetryStatus({
      ...(body.retryStatus && typeof body.retryStatus === 'object' ? body.retryStatus : {}),
      provider: correlatedSession.provider,
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

  if (correlationId && correlationRegistry) {
    correlationRegistry.bind(correlationId, normalized.session);
  }
  const published = bus.publish(normalized.session, normalized.event);
  scheduleNativeSessionPrewarm(deps.chatRuntimeService, normalized.session);
  writeJson(ctx.res, 200, {
    ok: true,
    published,
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
