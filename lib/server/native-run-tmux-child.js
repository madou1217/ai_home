'use strict';

// tmux run 的「虚拟 child」：对 native-session-chat 暴露与 node-pty child 相同的最小接口
// （onData/onExit/write/kill/resize），内部由 日志 tail + 退出标记 + 会话死亡轮询 驱动。
// 这样 spawnNativeSessionStream 的全部下游逻辑（JSONL 行解析/finish/abort/输入回写）零改动。

const { createNativeRunLogTail } = require('./native-run-log-tail');
const {
  RUN_EXIT_MARKER,
  hasRunSession,
  killRunServer,
  sendRunKeys
} = require('./native-run-tmux');

function createTmuxRunChild(options = {}) {
  const socket = String(options.socket || '');
  const logPath = String(options.logPath || '');
  const fs = options.fs;
  const deathPollMs = Math.max(500, Number(options.deathPollMs) || 2000);
  let dataListener = null;
  let exitListener = null;
  let exited = false;
  let deathTimer = null;

  const fireExit = (exitCode) => {
    if (exited) return;
    exited = true;
    tail.flush();
    tail.stop();
    if (deathTimer) clearInterval(deathTimer);
    if (exitListener) exitListener({ exitCode: Number(exitCode) || 0 });
  };

  const tail = createNativeRunLogTail(logPath, {
    fs,
    startOffset: Math.max(0, Number(options.startOffset) || 0),
    onLine(line) {
      const markerIndex = line.indexOf(RUN_EXIT_MARKER);
      if (markerIndex >= 0) {
        const code = Number(line.slice(markerIndex + RUN_EXIT_MARKER.length).trim());
        // 标记行不下发（不是 CLI 输出），直接触发退出。
        fireExit(Number.isFinite(code) ? code : 0);
        return;
      }
      // 下游按 '\n' 分帧,补回换行。
      if (dataListener && !exited) dataListener(`${line}\n`);
    }
  });

  // 兜底：tmux 会话消亡但没写出标记（如 kill-server/进程被信号杀）→ 吸干日志后按异常退出收尾。
  deathTimer = setInterval(() => {
    if (exited) return;
    if (!hasRunSession(socket, options)) {
      tail.flush();
      if (!exited) fireExit(1);
    }
  }, deathPollMs);
  if (typeof deathTimer.unref === 'function') deathTimer.unref();

  return {
    onData(cb) { dataListener = cb; },
    onExit(cb) { exitListener = cb; },
    write(data) {
      const value = String(data == null ? '' : data);
      if (!value) return;
      // writePtyInput 的分块约定：文本与提交键('\r')分开两次 write。
      if (value === '\r' || value === '\n') {
        sendRunKeys(socket, '', { ...options, appendNewline: true });
        return;
      }
      sendRunKeys(socket, value, { ...options, appendNewline: false });
    },
    resize() { /* headless run 无需 PTY 尺寸 */ },
    kill() {
      killRunServer(socket, options);
      // kill-server 后立即确认退出,不等下一轮死亡轮询。
      setTimeout(() => {
        if (!exited && !hasRunSession(socket, options)) fireExit(1);
      }, 120);
    },
    getLogOffset() { return tail.getOffset(); }
  };
}

module.exports = { createTmuxRunChild };
