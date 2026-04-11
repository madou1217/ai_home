'use strict';

const { resolveSessionFilePath } = require('../sessions/session-reader');

function handleWebUiSessionWatchRequest(ctx) {
  const {
    url,
    req,
    res,
    fs,
    writeJson
  } = ctx;

  const sessionId = url.searchParams?.get('sessionId') || '';
  const provider = url.searchParams?.get('provider') || '';
  const projectDirName = url.searchParams?.get('projectDirName') || '';

  if (!sessionId || !provider) {
    writeJson(res, 400, { ok: false, error: 'missing_params' });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('data: {"type":"connected"}\n\n');

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
          res.write(`data: ${JSON.stringify({ type: 'update', sessionId })}\n\n`);
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

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_error) {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) watcher.close();
    if (poller) clearInterval(poller);
  });

  return true;
}

module.exports = {
  handleWebUiSessionWatchRequest
};
