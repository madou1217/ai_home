'use strict';

function normalizeHeaderBag(headers) {
  if (!headers) return {};
  if (headers instanceof Map) {
    return Object.fromEntries(Array.from(headers.entries()).map(([key, value]) => [String(key).toLowerCase(), String(value)]));
  }
  if (typeof headers.get === 'function') {
    const entries = {};
    ['retry-after', 'retry-after-ms', 'anthropic-ratelimit-unified-reset', 'x-ratelimit-reset-requests', 'x-codex-ratelimit-reset'].forEach((key) => {
      const value = headers.get(key);
      if (value != null && value !== '') entries[key] = String(value);
    });
    return entries;
  }
  return Object.entries(headers).reduce((acc, [key, value]) => {
    const normalizedKey = String(key || '').toLowerCase();
    if (!normalizedKey) return acc;
    if (Array.isArray(value)) {
      acc[normalizedKey] = value.map((item) => String(item || '').trim()).filter(Boolean).join(', ');
      return acc;
    }
    acc[normalizedKey] = String(value == null ? '' : value);
    return acc;
  }, {});
}

function parseRetryAfterHeaderMs(value, nowMs) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const seconds = Number.parseInt(text, 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(text);
  if (Number.isFinite(dateMs) && dateMs > nowMs) {
    return dateMs - nowMs;
  }
  return 0;
}

/**
 * `retry-after-ms`：非标准但真实存在的毫秒头（Anthropic SDK 与 opencode 自己的客户端都认）。
 * 必须比 `retry-after` 先看 —— opencode 2.1.2 的 `ra(headers)` 就是这个顺序，两个头同时
 * 出现时以毫秒头为准（见 opencode-zen-free-client 的重置时刻口径）。
 */
function parseRetryAfterMsHeaderMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const ms = Number(text);
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 0;
}

function parseJsonSafe(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function readNestedValue(input, pathParts) {
  let cursor = input;
  for (let i = 0; i < pathParts.length; i += 1) {
    if (!cursor || typeof cursor !== 'object') return '';
    cursor = cursor[pathParts[i]];
  }
  return String(cursor || '').trim();
}

function parseGeminiRetryDelayMs(body) {
  const payload = typeof body === 'object' && body ? body : parseJsonSafe(body);
  if (!payload || typeof payload !== 'object') return 0;

  const details = Array.isArray(payload.error && payload.error.details) ? payload.error.details : [];
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue;
    if (String(detail['@type'] || '').trim() === 'type.googleapis.com/google.rpc.RetryInfo') {
      const retryDelay = String(detail.retryDelay || '').trim();
      const parsed = Number.isFinite(Date.parse(retryDelay)) ? 0 : retryDelay;
      if (parsed) {
        const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/i);
        if (match) return Math.ceil(Number(match[1]) * 1000);
      }
    }
    if (String(detail['@type'] || '').trim() === 'type.googleapis.com/google.rpc.ErrorInfo') {
      const quotaResetDelay = readNestedValue(detail, ['metadata', 'quotaResetDelay']);
      if (quotaResetDelay) {
        const match = quotaResetDelay.match(/^(\d+(?:\.\d+)?)(ms|s)$/i);
        if (match) {
          const amount = Number(match[1]);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          return match[2].toLowerCase() === 'ms' ? Math.ceil(amount) : Math.ceil(amount * 1000);
        }
      }
    }
  }

  const message = readNestedValue(payload, ['error', 'message']);
  const match = message.match(/after\s+(\d+)s\b/i);
  if (match) return Number(match[1]) * 1000;
  return 0;
}

/**
 * 正文里的**绝对恢复时刻**：`... your usage will reset at 2026-10-31 14:57:00 UTC+8 ...`
 * （CodeBuddy 家族 429 / 业务码 6004，真机 2026-10-30）。时区写成 `UTC+8` / `UTC+08:00` /
 * `GMT-5`，缺省按 UTC。返回 epoch ms；没有提示返回 0。
 */
const RESET_AT_PATTERN = /reset(?:s)?\s+at\s+(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?|utc|gmt|z)?/i;

/**
 * 中文语序：`将在 2026-11-04 13:34:21 UTC+8 重置`（CodeBuddy 家族 2026-11-03 真机文案）。
 * 时间戳在动词**前面**，英文那条正则接不住；锚点是结尾的「重置 / 恢复 / 解禁」，
 * 所以正文里随便一个日期不会被误当成恢复时刻。
 */
const RESET_AT_ZH_PATTERN = /(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?|utc|gmt|z)?\s*(?:重置|恢复|解禁|到期)/i;

/**
 * 裸时刻：`2026-11-04 13:34:21 UTC+8`。
 *
 * 只在**调用方已经确认这段输出是限流报错**时使用（见 detectRateLimitSignal 的
 * allowBareTimestamp）：中文 TUI 会在任意两个汉字之间折行，`重\n置` 被归一成
 * `重 置` 后动词锚点就断了。此时签名（「使用量已超出频率限制」）已经是强证据，
 * 时刻只要落在未来就是恢复时刻。
 *
 * 必须带**数字偏移**（`UTC+8` / `GMT-5`）：裸 `UTC` 可能只是还没到齐的 `UTC+8`
 * 前缀，提前解析会把 +8 当成 0（2026-11-04 分块实测：差 8 小时，被 24h 上限截断）。
 */
const BARE_TIMESTAMP_PATTERN = /(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i;

function timestampMatchToMs(match) {
  const [, y, mo, d, h, mi, s, sign, offH, offM] = match;
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || 0));
  if (!Number.isFinite(utcMs)) return 0;
  const offsetMinutes = sign ? (Number(offH) * 60 + Number(offM || 0)) * (sign === '-' ? -1 : 1) : 0;
  return utcMs - offsetMinutes * 60 * 1000;
}

/**
 * 同一段文字里可能有多条正则命中（英文语序 / 中文语序 / 裸时刻）。**取匹配最长的那条**：
 * 折行会把时间戳切成两半，短匹配往往是「14:57」这种半截（秒被留在了下一段），
 * 按第一条命中返回会得到错误的恢复时刻。调用方（detectRateLimitSignal）还会在
 * 多个视图之间再比一次长度。
 *
 * 返回值带 `complete`：匹配结束在缓冲区末尾、又既没有时区也没有「重置」动词时，
 * 认为这段文字可能还在增长（分块到达），调用方应等下一帧再判。
 */
const TIMEZONE_TOKEN_PATTERN = /(?:^|[^a-z])(?:utc|gmt|z)(?![a-z])/i;

function parseResetAtTimestampMatch(text, options = {}) {
  const plain = String(text || '');
  const candidates = [];
  const consider = (match, flags = {}) => {
    if (!match) return;
    const ms = timestampMatchToMs(match);
    if (!(ms > 0)) return;
    const end = match.index + match[0].length;
    const hasTimezone = TIMEZONE_TOKEN_PATTERN.test(match[0]);
    const hasVerb = flags.hasVerb === true;
    const atEnd = plain.slice(end).trim() === '';
    candidates.push({
      ms,
      length: match[0].length,
      text: match[0],
      atEnd,
      hasTimezone,
      hasVerb,
      complete: hasTimezone || hasVerb || !atEnd
    });
  };
  consider(RESET_AT_PATTERN.exec(plain));
  consider(RESET_AT_ZH_PATTERN.exec(plain), { hasVerb: true });
  if (options.allowBareTimestamp === true) consider(BARE_TIMESTAMP_PATTERN.exec(plain));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.length - left.length);
  return candidates[0];
}

function parseResetAtTimestampMs(text, options = {}) {
  const best = parseResetAtTimestampMatch(text, options);
  return best ? best.ms : 0;
}

function parseProviderRetryHintMs(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const provider = String(options.provider || '').trim().toLowerCase();
  const headers = normalizeHeaderBag(options.headers);
  const body = options.body;

  const retryAfterMsHeader = parseRetryAfterMsHeaderMs(headers['retry-after-ms']);
  if (retryAfterMsHeader > 0) return retryAfterMsHeader;

  const retryAfterMs = parseRetryAfterHeaderMs(headers['retry-after'], nowMs);
  if (retryAfterMs > 0) return retryAfterMs;

  const anthropicResetMs = parseRetryAfterHeaderMs(headers['anthropic-ratelimit-unified-reset'], nowMs);
  if (anthropicResetMs > 0) return anthropicResetMs;

  const openAiResetMs = parseRetryAfterHeaderMs(
    headers['x-ratelimit-reset-requests'] || headers['x-codex-ratelimit-reset'],
    nowMs
  );
  if (openAiResetMs > 0) return openAiResetMs;

  if (provider === 'gemini' || provider === 'agy') {
    return parseGeminiRetryDelayMs(body);
  }

  return 0;
}

module.exports = {
  parseProviderRetryHintMs,
  parseResetAtTimestampMatch,
  parseResetAtTimestampMs
};
