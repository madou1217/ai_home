'use strict';

function isSseWritable(res) {
  return Boolean(res && !res.destroyed && !res.writableEnded);
}

function writeSseFrame(res, frame) {
  if (!isSseWritable(res)) return false;
  try {
    res.write(frame);
    return true;
  } catch (_error) {
    return false;
  }
}

function openSseStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}

function writeSseJson(res, payload) {
  return writeSseFrame(res, `data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseComment(res, comment) {
  return writeSseFrame(res, `: ${String(comment || '').trim()}\n\n`);
}

function removeSseWatcher(watchers, watcher, onWatcherRemoved) {
  if (!watchers.has(watcher)) return false;
  watchers.delete(watcher);
  try {
    clearInterval(watcher.heartbeat);
  } catch (_error) {}
  if (onWatcherRemoved) onWatcherRemoved(watcher);
  return true;
}

function broadcastSseJson(watchers, payload, options = {}) {
  const onWatcherRemoved = typeof options.onWatcherRemoved === 'function'
    ? options.onWatcherRemoved
    : null;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const watcher of [...watchers]) {
    if (!writeSseFrame(watcher.res, data)) {
      removeSseWatcher(watchers, watcher, onWatcherRemoved);
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
    ctx: options.context || null,
    heartbeat: setInterval(() => {
      if (!writeSseComment(res, 'heartbeat')) {
        removeSseWatcher(watchers, watcher, onWatcherRemoved);
      }
    }, heartbeatMs)
  };
  if (typeof watcher.heartbeat.unref === 'function') watcher.heartbeat.unref();
  watchers.add(watcher);

  const cleanup = () => removeSseWatcher(watchers, watcher, onWatcherRemoved);
  if (req && typeof req.on === 'function') req.on('close', cleanup);
  if (res && typeof res.on === 'function') {
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  return watcher;
}

module.exports = {
  openSseStream,
  writeSseJson,
  // 漏导出曾导致全服崩溃循环：terminal mux 心跳解构得 undefined → 定时器抛
  // TypeError（未捕获）→ 进程退出 → systemd 拉起 → 浏览器 EventSource 重连 → 30s 后再崩。
  // 只要有一个开着终端面板的页面,server 就每 ~33s 崩一次,顺带杀光所有 native run。
  writeSseComment,
  broadcastSseJson,
  attachSseWatcher,
  removeSseWatcher
};
