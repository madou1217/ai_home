'use strict';

const { resolveSessionFilePath } = require('../sessions/session-reader');
const {
  openSseStream,
  writeSseJson,
  attachSseWatcher
} = require('./webui-sse-broadcaster');

function handleWebUiSessionWatchRequest(ctx) {
  const {
    url,
    req,
    res,
    fs,
    writeJson
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

  const watchPath = resolveSessionFilePath(provider, {
    sessionId,
    projectDirName
  });

  let watcher = null;
  let poller = null;
  let debounceTimer = null;

  if (watchPath && fs.existsSync(watchPath)) {
    let lastMtimeMs = 0;
    try {
      lastMtimeMs = Number(fs.statSync(watchPath).mtimeMs) || 0;
    } catch (_error) {
      lastMtimeMs = 0;
    }

    const emitUpdate = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          writeSseJson(res, { type: 'update', sessionId });
        } catch (_error) {
          // client disconnected
        }
      }, 500);
    };

    watcher = fs.watch(watchPath, () => {
      emitUpdate();
    });

    poller = setInterval(() => {
      try {
        const nextMtimeMs = Number(fs.statSync(watchPath).mtimeMs) || 0;
        if (nextMtimeMs > lastMtimeMs) {
          lastMtimeMs = nextMtimeMs;
          emitUpdate();
        }
      } catch (_error) {
        // ignore transient stat failures
      }
    }, 500);
    if (typeof poller.unref === 'function') poller.unref();
  }

  req.on('close', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) watcher.close();
    if (poller) clearInterval(poller);
  });

  return true;
}

module.exports = {
  handleWebUiSessionWatchRequest
};
