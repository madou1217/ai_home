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
      writeSseJson(res, canonicalizeWatchPayload(ctx, provider, {
        type: 'update',
        provider: event.provider || provider,
        sessionId: event.sessionId || sessionId,
        projectDirName: event.projectDirName || projectDirName,
        projectPath: event.projectPath || '',
        source: event.source || 'session-event-bus',
        eventType: event.type || 'session:update',
        reason: event.reason || '',
        eventName: event.eventName || '',
        phase: event.phase || '',
        // native run 的生命周期/交互 prompt 透传字段：detached 重连的页面靠它们恢复
        // 运行中状态（runId → input/abort 回写）与 PlanChoiceDock（prompt/promptId）。
        ...(event.runId ? { runId: String(event.runId) } : {}),
        ...(event.promptId ? { promptId: String(event.promptId) } : {}),
        ...(event.prompt && typeof event.prompt === 'object' ? { prompt: event.prompt } : {}),
        ...(event.retryStatus && typeof event.retryStatus === 'object'
          ? { retryStatus: event.retryStatus }
          : {})
      }));
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
