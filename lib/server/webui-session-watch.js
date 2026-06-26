'use strict';

const {
  openSseStream,
  writeSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');
const { defaultSessionEventBus } = require('./session-event-bus');

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

  const unsubscribe = sessionEventBus.subscribe({
    provider,
    sessionId,
    projectDirName
  }, (event) => {
    try {
      writeSseJson(res, {
        type: 'update',
        provider: event.provider || provider,
        sessionId: event.sessionId || sessionId,
        projectDirName: event.projectDirName || projectDirName,
        projectPath: event.projectPath || '',
        source: event.source || 'session-event-bus',
        eventType: event.type || 'session:update',
        reason: event.reason || '',
        eventName: event.eventName || '',
        phase: event.phase || ''
      });
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
  handleWebUiSessionWatchRequest
};
