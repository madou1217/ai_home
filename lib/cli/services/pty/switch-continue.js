'use strict';

// 换号续接成功后，替用户把被打断的那一轮「继续」下去。
//
// 用户 2026-11-05：自动换号把会话接回来了，但那一轮在 429 处已经中断，模型停在
// 原地，还得用户自己敲一句 continue 才会接着干。这里在新 TUI 就绪后把一条**普通
// 用户消息**写进 PTY —— 对 TUI 来说和用户亲手敲的完全一样，用户不必再介入。
//
// 时序（与 switch-draft 的回放同一套口径）：
//   1. 等首帧（isReady）。TUI 启动前写进去的按键会被吞掉；
//   2. 再留一小段渲染时间，让输入框真正就绪；
//   3. 先写文字，隔几十毫秒再单独写回车。一次写 `continue\r` 在部分 TUI 里会被
//      当成粘贴内容，回车不生效；
//   4. 全程用 isCurrent 兜底：换号后用户又切走 / 进程退出，就不能再往旧 PTY 写。
//
// 超时（默认 15s）放弃：宁可让用户自己敲，也不要把按键打到未知的启动提示上。

const CONTINUE_PROMPT = 'continue';
const DEFAULT_READY_DELAY_MS = 700;
const DEFAULT_ENTER_DELAY_MS = 60;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 200;

function normalizeDelay(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

/**
 * @returns {{cancel: Function}}
 */
function scheduleContinuePrompt(options = {}) {
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const isReady = typeof options.isReady === 'function' ? options.isReady : () => true;
  const write = typeof options.write === 'function' ? options.write : () => {};
  const schedule = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;
  const readyDelayMs = Math.min(
    normalizeDelay(options.readyDelayMs, DEFAULT_READY_DELAY_MS),
    2000
  );
  const enterDelayMs = normalizeDelay(options.enterDelayMs, DEFAULT_ENTER_DELAY_MS);
  const timeoutMs = normalizeDelay(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, normalizeDelay(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS));
  const prompt = String(options.prompt == null ? CONTINUE_PROMPT : options.prompt);
  const startedAt = Date.now();
  let timer = null;
  let finished = false;

  function cancel() {
    finished = true;
    if (timer !== null) cancelTimer(timer);
    timer = null;
  }

  function arm(fn, delayMs) {
    timer = schedule(fn, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function sendEnter() {
    timer = null;
    if (finished || !isCurrent()) return;
    finished = true;
    try {
      write('\r');
    } catch (_error) {
      // 新 PTY 可能已经退出：写不进去就算了。
    }
  }

  function sendPrompt() {
    timer = null;
    if (finished || !isCurrent()) return;
    try {
      write(prompt);
    } catch (_error) {
      finished = true;
      return;
    }
    arm(sendEnter, enterDelayMs);
  }

  function tick() {
    timer = null;
    if (finished || !isCurrent()) return;
    if (isReady()) {
      arm(sendPrompt, readyDelayMs);
      return;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      finished = true;
      return;
    }
    arm(tick, pollIntervalMs);
  }

  arm(tick, pollIntervalMs);
  return { cancel };
}

module.exports = {
  CONTINUE_PROMPT,
  scheduleContinuePrompt
};
