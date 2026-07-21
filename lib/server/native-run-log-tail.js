'use strict';

// tmux 化 native run 的日志 tailer：轮询读增量、按行吐给解析器。
// run 的 stdout 直接重定向进日志文件（非 pipe-pane,避免首行竞态与 pane 渲染噪声）,
// 所以这里读到的就是 CLI 的原始 JSONL,可直接喂 parseNativeStreamEvent。

const nodeFs = require('node:fs');

function createNativeRunLogTail(logPath, options = {}) {
  const fs = options.fs || nodeFs;
  const intervalMs = Math.max(50, Number(options.intervalMs) || 150);
  const onLine = typeof options.onLine === 'function' ? options.onLine : () => {};
  let offset = Math.max(0, Number(options.startOffset) || 0);
  let partial = '';
  let stopped = false;
  let timer = null;

  const readAppended = () => {
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch (_error) {
      return; // 文件尚未创建（tmux 还没跑起来）——下一轮再看。
    }
    if (size < offset) {
      // 文件被截断/替换：从头重读，避免卡死在旧 offset。
      offset = 0;
      partial = '';
    }
    if (size === offset) return;
    let chunk = '';
    try {
      const fd = fs.openSync(logPath, 'r');
      try {
        const length = size - offset;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, offset);
        chunk = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (_error) {
      return;
    }
    offset += Buffer.byteLength(chunk, 'utf8');
    partial += chunk;
    while (true) {
      const newlineIndex = partial.indexOf('\n');
      if (newlineIndex < 0) break;
      const line = partial.slice(0, newlineIndex).replace(/\r$/, '');
      partial = partial.slice(newlineIndex + 1);
      onLine(line);
    }
  };

  timer = setInterval(() => {
    if (stopped) return;
    try {
      readAppended();
    } catch (_error) { /* 单轮失败不终止 tail */ }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    // 最终收尾前调用：同步吸干剩余内容（含无换行结尾的最后一行）。
    flush() {
      try { readAppended(); } catch (_error) { /* ignore */ }
      if (partial) {
        const line = partial.replace(/\r$/, '');
        partial = '';
        onLine(line);
      }
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    getOffset() {
      return offset;
    }
  };
}

module.exports = { createNativeRunLogTail };
