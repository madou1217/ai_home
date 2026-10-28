'use strict';

/**
 * 退出前把 stdout/stderr 排空。
 *
 * 为什么必须有它：`process.exit()` 会**丢弃**还在队列里的 stdout/stderr 写入；当 stdout 是
 * 管道（`out=$(aih …)`、`aih … | tee`、被 execSync 读取）时这些写入是异步的，于是
 * **输出会被截断**。2026-10-28 实测：`aih shell snippet --shell zsh` 共 9164 字节，
 * 经 execSync 读取只拿到 8192 字节（正好卡在 stdio 缓冲边界、且断在半行），
 * 而 `eval "$(aih shell snippet)"` 正是官方文档给的用法——半截片段会加载出一个坏 shell。
 *
 * 做法：`write('', cb)` 在流真正排空后回调；带 2s 兜底，卡住的消费者不能把进程吊死。
 * 调用方注入 processObj（测试里是 stub：没有 stdout/stderr 时立刻 exit，行为不变）。
 */

function exitAfterFlush(processObj, code, options = {}) {
  const target = processObj || process;
  const finalCode = Number.isInteger(code) ? code : 0;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 2000;
  const setTimeoutImpl = options.setTimeout || setTimeout;
  const clearTimeoutImpl = options.clearTimeout || clearTimeout;
  target.exitCode = finalCode;
  const pendingStreams = [target.stdout, target.stderr].filter((stream) => (
    stream && typeof stream.write === 'function' && typeof stream.writableLength === 'number' && stream.writableLength > 0
  ));
  if (pendingStreams.length === 0) {
    target.exit(finalCode);
    return;
  }
  let remaining = pendingStreams.length;
  let exited = false;
  const finish = () => {
    if (exited) return;
    exited = true;
    target.exit(finalCode);
  };
  const fallbackTimer = setTimeoutImpl(finish, timeoutMs);
  if (fallbackTimer && typeof fallbackTimer.unref === 'function') fallbackTimer.unref();
  pendingStreams.forEach((stream) => {
    const onDrained = () => {
      remaining -= 1;
      if (remaining <= 0) {
        clearTimeoutImpl(fallbackTimer);
        finish();
      }
    };
    try {
      stream.write('', onDrained);
    } catch (_error) {
      onDrained();
    }
  });
}

module.exports = {
  exitAfterFlush
};
