'use strict';

// 「用户刚敲进去的原文」记忆 —— 文本限流识别的输入侧事实。
//
// TUI 会把用户输入原样画回输出流，于是「用户自己打了一句 429」与「上游真的回了
// 429」在文本层面完全同形（2026-11-10 用户实测：把报错原文粘进对话框，会话当场
// 被换号）。文本本身无法区分来源，唯一的外部事实在输入侧：这句原文是不是刚被
// 用户敲进去过。本模块只负责把 stdin 原文按时间窗留下来，判定在
// auto-switch-policy 的 shouldTrustTextRateLimitSignal。
//
// 为什么存字节而不是解码后的字符串：stdin 是任意切分的字节流，一个汉字的 UTF-8
// 编码可能正好被切在两个 chunk 之间。逐块 `toString('utf8')` 会把这种汉字变成
// U+FFFD，回显比对就永远认不出中文原文——用户粘一句中文 429 反而会触发换号。
// latin1 是 1:1 的字节视图（拼接不丢字节），读取时整段再按 UTF-8 解码。

const DEFAULT_WINDOW_MS = 2 * 60 * 1000;
// 最多留 16KB：换号草稿/长粘贴都不该无限增长，两分钟内的原文足够覆盖回显。
const DEFAULT_MAX_BYTES = 16 * 1024;

function normalizePositive(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function toBytes(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(String(data), 'utf8');
}

/**
 * @returns {{remember: Function, read: Function, clear: Function}}
 */
function createUserInputEchoBuffer(options = {}) {
  const windowMs = normalizePositive(options.windowMs, DEFAULT_WINDOW_MS);
  const maxBytes = normalizePositive(options.maxBytes, DEFAULT_MAX_BYTES);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let bytes = '';
  let updatedAt = 0;

  /** 记一段 stdin 原文（Buffer 或字符串）。只要求「最近敲过」，不解释按键。 */
  function remember(data) {
    const buffer = toBytes(data);
    if (buffer.length === 0) return false;
    bytes = (bytes + buffer.toString('latin1')).slice(-maxBytes);
    updatedAt = now();
    return true;
  }

  /** 时间窗内的原文（字符串形式）；窗口过期或从未输入返回空串。 */
  function read(at = now()) {
    if (!bytes) return '';
    if (at - updatedAt > windowMs) return '';
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }

  function clear() {
    bytes = '';
    updatedAt = 0;
  }

  return { remember, read, clear };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_WINDOW_MS,
  createUserInputEchoBuffer
};
