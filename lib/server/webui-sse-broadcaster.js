'use strict';

function openSseStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}

function writeSseJson(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseComment(res, comment) {
  res.write(`: ${String(comment || '').trim()}\n\n`);
}

function broadcastSseJson(watchers, payload, options = {}) {
  const onWatcherRemoved = typeof options.onWatcherRemoved === 'function'
    ? options.onWatcherRemoved
    : null;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const watcher of [...watchers]) {
    try {
      watcher.res.write(data);
    } catch (_error) {
      watchers.delete(watcher);
      try {
        clearInterval(watcher.heartbeat);
      } catch (_innerError) {}
      if (onWatcherRemoved) onWatcherRemoved(watcher);
    }
  }
}

function attachSseWatcher(watchers, req, res, options = {}) {
  const heartbeatMs = Number(options.heartbeatMs) || 30_000;
  const onWatcherRemoved = typeof options.onWatcherRemoved === 'function'
    ? options.onWatcherRemoved
    : null;
  const watcher = {
    res,
    heartbeat: setInterval(() => {
      try {
        writeSseComment(res, 'heartbeat');
      } catch (_error) {
        watchers.delete(watcher);
        clearInterval(watcher.heartbeat);
        if (onWatcherRemoved) onWatcherRemoved(watcher);
      }
    }, heartbeatMs)
  };
  if (typeof watcher.heartbeat.unref === 'function') watcher.heartbeat.unref();
  watchers.add(watcher);

  req.on('close', () => {
    watchers.delete(watcher);
    clearInterval(watcher.heartbeat);
    if (onWatcherRemoved) onWatcherRemoved(watcher);
  });

  return watcher;
}

module.exports = {
  openSseStream,
  writeSseJson,
  broadcastSseJson,
  attachSseWatcher
};
