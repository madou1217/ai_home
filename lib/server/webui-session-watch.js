'use strict';

const {
  openSseStream,
  writeSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');
const { defaultSessionEventBus } = require('./session-event-bus');
const { canonicalizeProviderResourceValue } = require('../runtime/provider-resource-path');

function canonicalizeWatchPayload(ctx, provider, payload) {
  const deps = ctx.deps || {};
  return canonicalizeProviderResourceValue(payload, {
    provider,
    aiHomeDir: deps.aiHomeDir || ctx.aiHomeDir,
    hostHomeDir: deps.hostHomeDir || ctx.hostHomeDir
  });
}

function buildSessionWatchPayload(ctx, session, event) {
  return canonicalizeWatchPayload(ctx, session.provider, {
    type: 'update',
    provider: event.provider || session.provider,
    sessionId: event.sessionId || session.sessionId,
    projectDirName: event.projectDirName || session.projectDirName,
    projectPath: event.projectPath || '',
    source: event.source || 'session-event-bus',
    eventType: event.type || 'session:update',
    reason: event.reason || '',
    eventName: event.eventName || '',
    phase: event.phase || '',
    // SSE 与 WebSocket 共用同一投影，保留后台任务的交互提示和重试状态。
    ...(event.runId ? { runId: String(event.runId) } : {}),
    ...(event.promptId ? { promptId: String(event.promptId) } : {}),
    ...(event.prompt && typeof event.prompt === 'object' ? { prompt: event.prompt } : {}),
    ...(event.retryStatus && typeof event.retryStatus === 'object' ? { retryStatus: event.retryStatus } : {})
  });
}

function handleWebUiSessionWatchRequest(ctx) {
  const {
    url,
    req,
    res,
    writeJson,
    sessionEventBus = defaultSessionEventBus
  } = ctx;
  const watchers = new Set();

  const sessionId = url.searchParams?.get('sessionId') || '';
  const provider = url.searchParams?.get('provider') || '';
  const projectDirName = url.searchParams?.get('projectDirName') || '';

  if (!sessionId || !provider) {
    writeJson(res, 400, { ok: false, error: 'missing_params' });
    return true;
  }

  openSseStream(res);
  writeSseJson(res, { type: 'connected' });
  attachSseWatcher(watchers, req, res);

  const session = { provider, sessionId, projectDirName };
  const unsubscribe = sessionEventBus.subscribe(session, (event) => {
    try {
      writeSseJson(res, buildSessionWatchPayload(ctx, session, event));
    } catch (_error) {
      // client disconnected
    }
  });

  req.on('close', () => {
    unsubscribe();
  });

  return true;
}

module.exports = {
  buildSessionWatchPayload,
  handleWebUiSessionWatchRequest
};
