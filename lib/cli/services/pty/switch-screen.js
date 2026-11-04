'use strict';

// 换号期间的屏幕过渡。
//
// 旧 TUI 退出时会还原备用屏幕 / 光标，新 TUI 再清屏重绘——两帧之间会闪一下。
// 这里在换号开始前做三件事（全部 best-effort，终端不支持就自动退化为普通输出）：
//
//   1. 隐藏光标：避免旧光标在 tearing 期间乱跳；
//   2. 开启「同步输出」(DECSET 2026)：支持该模式的终端会把后续字节缓冲到
//      结束标记再一次性绘制，看不到中间态；
//   3. 超时兜底：即使新 TUI 一直不出首帧，也必须把光标和同步模式恢复，
//      不能让终端卡在隐藏光标状态。
//
// 调用方在**新 PTY 首帧**时调用 end()；没有新进程（启动失败）时也必须 end()。

const SYNCHRONIZED_UPDATE_BEGIN = '\x1b[?2026h';
const SYNCHRONIZED_UPDATE_END = '\x1b[?2026l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// 旧 TUI 的退出序列被丢弃后，鼠标上报 / 括号粘贴这些「全局终端模式」需要由
// aih 自己收尾，否则新 TUI 若没有重新声明，终端会停在旧模式里。
const RESET_INPUT_MODES = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l';
const DEFAULT_TIMEOUT_MS = 5000;

function beginSwitchScreen(processObj, options = {}) {
  const stdout = processObj && processObj.stdout;
  if (!stdout || stdout.isTTY !== true || typeof stdout.write !== 'function') {
    return { end() {} };
  }
  const write = (value) => {
    try { stdout.write(value); } catch (_error) { /* 终端已关闭 */ }
  };
  const synchronized = options.synchronized !== false;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  let ended = false;
  let timer = null;

  write(RESET_INPUT_MODES);
  write(HIDE_CURSOR);
  if (synchronized) write(SYNCHRONIZED_UPDATE_BEGIN);

  function end() {
    if (ended) return;
    ended = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (synchronized) write(SYNCHRONIZED_UPDATE_END);
    write(SHOW_CURSOR);
  }

  timer = setTimeout(end, timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { end };
}

module.exports = {
  beginSwitchScreen
};
