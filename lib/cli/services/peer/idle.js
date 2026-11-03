'use strict';

// aih peer 的**空闲判定**：投递前先确认目标 pane 已经安静下来。
//
// 为什么需要：往一个正在重绘的 TUI 里 `send-keys -l` 正文，轻则内容被吞、重则和
// 半截重绘粘在一起。用户手打不会遇到这个问题（人在等提示符），但 aih 是异步投递。
//
// 信号来源与账号活性探测同源：tmux 的 `#{window_activity}` 是「当前窗口最后一次有
// 输出」的时刻（`persistent-session.js:822` 已经解析成 `lastActivityAt`）。模型答题
// 时 TUI 必然持续重绘，所以「静默超过 quietMs」就等价于「在等输入或回合已结束」。
//
// 这是启发式，不是权威：长时间无输出的工具调用会被误判成空闲。所以 `send` 只在
// **短超时**（默认 3s）内等安静期，等不到就入队交给补投 tick——宁可晚一点，也不
// 在忙碌中打扰。

const DEFAULT_QUIET_MS = 1_200;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_MS = 250;

function normalizeMs(value, fallback, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.max(minimum, Math.floor(number));
}

/** 没有活动时间（旧版 tmux / 字段缺失）时不猜「空闲」，按可投处理。 */
function isQuiet(lastActivityAt, options = {}) {
  const at = Number(lastActivityAt) || 0;
  if (at <= 0) return true;
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const quietMs = normalizeMs(options.quietMs, DEFAULT_QUIET_MS);
  return now - at >= quietMs;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 轮询单个会话的 window_activity，直到安静 quietMs 或超时。
 *
 * `readActivityAt` 必须由调用方注入（测试用假时钟；生产用 tmux display-message）。
 * **不要**在这里调 `collectGlobalPersistentSessionRows`：那会全量扫账号 + tmux，
 * 250ms 一轮会把调用方拖死。
 *
 * 返回 { quiet, lastActivityAt, waitedMs }。
 */
async function waitForQuiet(options = {}) {
  const quietMs = normalizeMs(options.quietMs, DEFAULT_QUIET_MS);
  const timeoutMs = normalizeMs(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const pollMs = normalizeMs(options.pollMs, DEFAULT_POLL_MS, 1);
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const readActivityAt = options.readActivityAt;

  if (timeoutMs === 0) {
    const lastActivityAt = await safeRead(readActivityAt);
    return { quiet: isQuiet(lastActivityAt, { now: now(), quietMs }), lastActivityAt, waitedMs: 0 };
  }

  const startedAt = now();
  let lastActivityAt = 0;
  for (;;) {
    lastActivityAt = await safeRead(readActivityAt);
    if (isQuiet(lastActivityAt, { now: now(), quietMs })) {
      return { quiet: true, lastActivityAt, waitedMs: now() - startedAt };
    }
    if (now() - startedAt >= timeoutMs) {
      return { quiet: false, lastActivityAt, waitedMs: now() - startedAt };
    }
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (now() - startedAt))));
  }
}

async function safeRead(readActivityAt) {
  if (typeof readActivityAt !== 'function') return 0;
  try {
    return Number(await readActivityAt()) || 0;
  } catch (_error) {
    // 读不到活动时间（会话刚没 / tmux 忙）不等于忙：交给上层按「可投」处理，
    // 真正投不进去时 send-keys 会报错，那才是权威失败。
    return 0;
  }
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_QUIET_MS,
  DEFAULT_TIMEOUT_MS,
  isQuiet,
  waitForQuiet
};
