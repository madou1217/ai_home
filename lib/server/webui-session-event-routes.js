'use strict';

const { defaultSessionEventBus } = require('./session-event-bus');
const { normalizeProviderHookEvent } = require('./provider-hook-event-normalizer');

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

  const bus = deps.sessionEventBus || defaultSessionEventBus;
  const published = bus.publish(normalized.session, normalized.event);
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

module.exports = {
  handleProviderHookSessionEventRequest,
  parsePayloadRoot
};
