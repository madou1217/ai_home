'use strict';

// 原生模式（非网关）自动换号的**判定层**：什么算「这个账号暂时用不了了」。
//
// 动作层不在这里——杀 pty、换凭据、续接会话由 pty-runtime-run 的 switchToAccount
// 负责（真机已验证）。本模块只回答三件事：
//   1. 这个模式开着吗（config:usage 的 auto_switch，或本会话的 AIH_RUNTIME_USAGE 覆盖）
//   2. 用量见底了吗（剩余 <= auto_switch_remaining_pct）
//   3. 这段输出是不是「429 + provider 给的恢复时刻」，以及冷却到什么时候
//
// 为什么 429 必须带恢复时刻才换号：429 有短促的（几百毫秒后就好）也有窗口级的
// （CodeBuddy 的 6004「usage will reset at 2026-10-31 14:57:00 UTC+8」）。前者换号
// 是白折腾，后者不换就要一直撞墙。用户要的正是后者；没有恢复提示时宁可不动，
// 交给用量阈值那条路。

const { parseResetAtTimestampMs } = require('../../../server/retry-hints');

// 冷却上限：provider 偶尔会给很远的时刻（日额度 / 误报）。锁一天足够，到期复核。
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// 429 识别窗口：TUI 重绘会把同一句话反复送进来，尾窗太小会错过跨 chunk 的日期。
const LIMIT_SCAN_TAIL_LENGTH = 4000;
// 恢复时刻离现在不到一分钟的限流不值得换号：等它自己过去，比换凭据重启一轮便宜。
const MIN_LIMIT_SWITCH_COOLDOWN_MS = 60 * 1000;

// 只认**上游真的报错**的写法。刻意不收裸的 `rate limit` / `too many requests`：
// 用户自己敲的字也会出现在 PTY 输出里（TUI 回显），那是唯一会造成误换号的来源。
const RATE_LIMIT_SIGNATURES = Object.freeze([
  { id: 'codebuddy-frequency-window', pattern: /usage exceeds (?:the )?frequency limit/i },
  { id: 'api-error-429', pattern: /\bAPI Error:?\s*429\b/i },
  { id: 'http-429', pattern: /\b429\b[\s\S]{0,80}?(?:rate.?limit|too many requests|try again|quota)/i },
  { id: 'resource-exhausted', pattern: /\bRESOURCE_EXHAUSTED\b/i },
  { id: 'agy-credits', pattern: /AI credits balance is too low/i },
  { id: 'quota-exceeded', pattern: /\bquota (?:exceeded|exhausted|reached)\b/i }
]);

const UNIT_MS = Object.freeze({
  ms: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000
});

const RELATIVE_HINT_PATTERNS = Object.freeze([
  /try again in\s+(\d+(?:\.\d+)?)\s*([a-z]+)?/i,
  /retry after\s+(\d+(?:\.\d+)?)\s*([a-z]+)?/i,
  /available (?:again )?in\s+(\d+(?:\.\d+)?)\s*([a-z]+)?/i,
  /resets? in\s+(\d+(?:\.\d+)?)\s*([a-z]+)?/i
]);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function clampPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

function formatPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '?';
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

/** 正文里的恢复提示 → 距现在的毫秒数；没有可用的提示返回 0。 */
function readRelativeResetMs(text) {
  const plain = String(text || '');
  for (const pattern of RELATIVE_HINT_PATTERNS) {
    const match = pattern.exec(plain);
    if (!match) continue;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = String(match[2] || '').toLowerCase();
    const unitMs = UNIT_MS[unit] || 1000;
    return Math.round(amount * unitMs);
  }
  return 0;
}

/**
 * 一段子进程输出 → 限流信号。没有「429 + 恢复时刻」返回 null。
 * `resetAtMs` 一定是**未来**的时刻：历史回滚（用户往上翻日志）不会触发换号。
 */
function detectRateLimitSignal(text, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const plain = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  const signature = RATE_LIMIT_SIGNATURES.find((entry) => entry.pattern.test(plain));
  if (!signature) return null;
  const absoluteMs = parseResetAtTimestampMs(plain);
  const relativeMs = absoluteMs > 0 ? 0 : readRelativeResetMs(plain);
  const resetAtMs = absoluteMs > 0 ? absoluteMs : (relativeMs > 0 ? nowMs + relativeMs : 0);
  if (!(resetAtMs > nowMs)) return null;
  return {
    kind: 'rate_limit',
    signature: signature.id,
    resetAtMs: Math.min(resetAtMs, nowMs + MAX_COOLDOWN_MS)
  };
}

function cooldownKey(accountRef, model) {
  return `${accountRef}|${model || '*'}`;
}

/** 冷却到期时刻的可读形式：今天只给时分，跨天带上日期。 */
function formatCooldownLabel(untilMs, nowMs = Date.now()) {
  const until = Number(untilMs);
  if (!Number.isFinite(until) || until <= nowMs) return '';
  const date = new Date(until);
  const nowDate = new Date(nowMs);
  const pad = (value) => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === nowDate.getFullYear()
    && date.getMonth() === nowDate.getMonth()
    && date.getDate() === nowDate.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function createAutoSwitchPolicy(options = {}) {
  const readConfig = typeof options.readConfig === 'function' ? options.readConfig : () => ({});
  const readEnvField = typeof options.readEnvField === 'function' ? options.readEnvField : () => '';
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  // accountRef|model → untilMs。进程内即可：换号是同一进程里杀 pty 重启，
  // 跨进程的冷却由服务端的失败门禁负责（codebuddy 家族的会话观察者）。
  const cooldowns = new Map();

  function readSettings() {
    let config = {};
    try { config = readConfig() || {}; } catch (_error) { config = {}; }
    // 本会话显式覆盖优先：`AIH_RUNTIME_USAGE=auto_switch=1 aih agy 1` 不必改全局设置。
    const envValue = normalizeText(readEnvField('auto_switch')).toLowerCase();
    const enabled = envValue
      ? envValue === '1' || envValue === 'true' || envValue === 'on'
      : config.auto_switch === true;
    // 阈值也能按会话覆盖（AIH_RUNTIME_USAGE=auto_switch=1,auto_switch_remaining=100）：
    // 试一次「一有额度变化就换」不必改全局设置，真机验证也靠它把触发条件调成确定性的。
    const envRemaining = normalizeText(readEnvField('auto_switch_remaining'));
    const envRemainingValue = envRemaining === '' ? NaN : Number(envRemaining);
    const configured = Number.isFinite(envRemainingValue) ? envRemainingValue : config.auto_switch_remaining_pct;
    const hasConfigured = configured !== null && configured !== undefined && Number.isFinite(Number(configured));
    // 缺省跟随 threshold_pct（默认 95 → 剩余 ≤ 5%），与选号门禁同一换算。
    const remainingPct = hasConfigured
      ? clampPct(configured)
      : Math.max(0, 100 - clampPct(Number(config.threshold_pct) || 95));
    return { enabled, remainingPct };
  }

  function isEnabled() {
    return readSettings().enabled;
  }

  /** 用量阈值判定：只有开着模式、且剩余真的到了阈值才换。 */
  function evaluateUsage(remainingPct) {
    const settings = readSettings();
    if (!settings.enabled) return { switch: false, reason: '', thresholdPct: settings.remainingPct };
    const value = Number(remainingPct);
    if (!Number.isFinite(value)) return { switch: false, reason: '', thresholdPct: settings.remainingPct };
    if (value > settings.remainingPct) return { switch: false, reason: '', thresholdPct: settings.remainingPct };
    return {
      switch: true,
      reason: `额度剩余 ${formatPct(value)}%（阈值 ≤${formatPct(settings.remainingPct)}%）`,
      thresholdPct: settings.remainingPct
    };
  }

  /** 记一条 (账号, 模型) 冷却。返回 `{ untilMs }`；没有可用恢复时刻返回 null。 */
  function noteRateLimit(input = {}) {
    const accountRef = normalizeText(input.accountRef);
    if (!accountRef) return null;
    const at = now();
    const untilMs = Math.min(Number(input.resetAtMs) || 0, at + MAX_COOLDOWN_MS);
    if (!(untilMs > at)) return null;
    const model = normalizeText(input.model);
    const key = cooldownKey(accountRef, model);
    const previous = Number(cooldowns.get(key)) || 0;
    cooldowns.set(key, Math.max(previous, untilMs));
    return { untilMs: Math.max(previous, untilMs) };
  }

  /** 该 (账号, 模型) 的冷却到期时刻；模型未知时按账号级（保守）。 */
  function cooldownUntil(accountRef, model) {
    const ref = normalizeText(accountRef);
    if (!ref) return 0;
    const at = now();
    const wanted = normalizeText(model);
    let until = 0;
    for (const [key, value] of cooldowns) {
      const separator = key.lastIndexOf('|');
      const keyRef = key.slice(0, separator);
      const keyModel = key.slice(separator + 1);
      if (value <= at) { cooldowns.delete(key); continue; }
      if (keyRef !== ref) continue;
      if (wanted && keyModel !== '*' && keyModel !== wanted) continue;
      until = Math.max(until, value);
    }
    return until;
  }

  function isCooling(accountRef, model) {
    return cooldownUntil(accountRef, model) > now();
  }

  /** 仍在冷却里的账号 ref 列表——换号选目标时要避开它们。 */
  function coolingAccountRefs() {
    const at = now();
    const refs = new Set();
    for (const [key, value] of cooldowns) {
      if (value <= at) { cooldowns.delete(key); continue; }
      refs.add(key.slice(0, key.lastIndexOf('|')));
    }
    return Array.from(refs);
  }

  function describeCooldown(accountRef, model) {
    return formatCooldownLabel(cooldownUntil(accountRef, model), now());
  }

  return {
    readSettings,
    isEnabled,
    evaluateUsage,
    noteRateLimit,
    cooldownUntil,
    isCooling,
    coolingAccountRefs,
    describeCooldown
  };
}

module.exports = {
  LIMIT_SCAN_TAIL_LENGTH,
  MAX_COOLDOWN_MS,
  MIN_LIMIT_SWITCH_COOLDOWN_MS,
  RATE_LIMIT_SIGNATURES,
  createAutoSwitchPolicy,
  detectRateLimitSignal,
  formatCooldownLabel,
  readRelativeResetMs
};
