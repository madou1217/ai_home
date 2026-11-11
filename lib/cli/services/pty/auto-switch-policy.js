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

const { parseResetAtTimestampMatch } = require('../../../server/retry-hints');

// 冷却上限：provider 偶尔会给很远的时刻（日额度 / 误报）。锁一天足够，到期复核。
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
// 429 识别窗口：TUI 重绘会把同一句话反复送进来，尾窗太小会错过跨 chunk 的日期。
const LIMIT_SCAN_TAIL_LENGTH = 4000;
// 恢复时刻离现在不到一分钟的限流不值得换号：等它自己过去，比换凭据重启一轮便宜。
const MIN_LIMIT_SWITCH_COOLDOWN_MS = 60 * 1000;
// 「额度/积分已耗尽」不是限流窗口：上游不会给恢复时刻，买额度之前这个账号一直不可用。
// 仍然要换号，但冷却不能是 0——否则看门狗下一拍会把刚换走的账号又选回来。1 小时是
// 「足够久到不来回弹，又短到用户充值后不必等一天」的折中；到期后由真实请求复核。
const HARD_EXHAUSTION_COOLDOWN_MS = 60 * 60 * 1000;

// 只认**上游真的报错**的写法。刻意不收裸的 `rate limit` / `too many requests`：
// 用户自己敲的字也会出现在 PTY 输出里（TUI 回显），那是唯一会造成误换号的来源。
//
// 2026-11-03 真机补：CodeBuddy 中文站只发中文文案
//   `您的使用量已超出频率限制，将在 2026-11-04 13:34:21 UTC+8 重置，您也可以切换其他模型继续使用。`
// 里面既没有 `429` 也没有英文关键字，之前的名单整条漏判——用户看到「没有自动切换，
// 下一次用户消息才触发」。中文签名与英文签名同权，恢复时刻仍由 retry-hints 解析。
const RATE_LIMIT_SIGNATURES = Object.freeze([
  // CodeBuddy 国际站把「积分用完」报成 429 Credits exhausted，并直接给出购买页
  // （真机 2026-11-10，业务码 14018）。这条没有恢复时刻，也不属于限流窗口：
  // 买额度之前账号一直不可用，所以标记成 hardExhaustion —— 检测层会补一个默认冷却
  // 并立即换号，而不是等用量阈值（快照往往在报错之后才更新到 0）。
  {
    id: 'codebuddy-credits-exhausted',
    pattern: /\b429\b[\s\S]{0,80}?credits?\s+(?:are\s+|have\s+been\s+)?exhausted/i,
    hardExhaustion: true
  },
  // TUI 折行可能把 429 甩到上一屏；购买页/加购文案是同样强的证据。
  {
    id: 'codebuddy-credits-purchase',
    pattern: /credits?\s+(?:are\s+|have\s+been\s+)?exhausted[\s\S]{0,160}?(?:add-on packs|purchase (?:add-on|more) credits|profile\/usage)/i,
    hardExhaustion: true
  },
  { id: 'codebuddy-frequency-window', pattern: /usage exceeds (?:the )?frequency limit/i },
  { id: 'codebuddy-zh-frequency-window', pattern: /使用量已超出频率限制/ },
  { id: 'codebuddy-zh-quota-exhausted', pattern: /(?:额度|用量|使用量)(?:已|已经)?(?:用尽|耗尽|用完|达到上限)/ },
  { id: 'api-error-429', pattern: /\bAPI Error:?\s*429\b/i },
  { id: 'http-429', pattern: /\b429\b[\s\S]{0,80}?(?:rate.?limit|too many requests|try again|quota)/i },
  { id: 'resource-exhausted', pattern: /\bRESOURCE_EXHAUSTED\b/i },
  { id: 'agy-credits', pattern: /AI credits balance is too low/i },
  { id: 'quota-exceeded', pattern: /\bquota (?:exceeded|exhausted|reached)\b/i }
]);

// 便宜的前置过滤：TUI 每帧都会过一遍，绝大多数输出连这些词都没有。命中与否只决定
// 「要不要往下走」，真正的判定仍是 RATE_LIMIT_SIGNATURES + 恢复时刻。导出给运行时
// 复用，避免两处名单各自漂移（中文漏判就是这么来的）。
const RATE_LIMIT_PREFILTER = /429|RESOURCE_EXHAUSTED|frequency limit|credits balance|credits?\s+(?:are\s+|have\s+been\s+)?exhausted|add-on packs|quota|try again|retry after|频率限制|使用量已超出|额度.{0,6}(?:用尽|耗尽|用完|达到上限)/i;

function mightContainRateLimitSignal(text) {
  return RATE_LIMIT_PREFILTER.test(String(text == null ? '' : text));
}

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
 * 一段子进程输出 → 限流/额度信号。没有「429 + 恢复时刻」返回 null，
 * 唯一例外是 hardExhaustion 签名（额度/积分耗尽）：它没有恢复时刻，用默认冷却兜底。
 * `resetAtMs` 一定是**未来**的时刻：历史回滚（用户往上翻日志）不会触发换号。
 *
 * 中文 TUI 会在**任意两个汉字之间**折行，所以同一段文字要按两个视图看：
 *   - `plain`：空白压成单空格——英文签名/相对提示按它匹配；
 *   - `dewrap`：去掉换行及其缩进、保留原有空格——`使\n用` → `使用`，
 *     `重\n置` → `重置`，中文短语和中文语序的时刻都靠它还原。
 * 2026-11-04 矩阵实测：只按 plain 匹配时，32 个单换行切点里有 27 个漏判。
 */
function dewrapLineBreaks(text) {
  return String(text == null ? '' : text).replace(/\r?\n[ \t]*/g, '').trim();
}

function detectRateLimitSignal(text, options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const source = String(text == null ? '' : text);
  const plain = source.replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  const dewrap = dewrapLineBreaks(source);
  const views = dewrap && dewrap !== plain ? [plain, dewrap] : [plain];
  // 命中的**原文**也要带出去：PTY 会把用户输入原样回显，调用方需要拿这段文字
  // 与「用户刚敲的内容」比对，才能区分「上游报的」和「用户说的」。
  let signature = null;
  let matchedText = '';
  for (const entry of RATE_LIMIT_SIGNATURES) {
    for (const view of views) {
      const match = entry.pattern.exec(view);
      if (!match) continue;
      signature = entry;
      matchedText = match[0];
      break;
    }
    if (signature) break;
  }
  if (!signature) return null;
  // 签名已经证明这是限流报错；折行可能拆散「重置」或中文语序，两个视图都试。
  // 裸时刻只在签名命中后允许——它落在未来就是恢复时刻。
  // **取匹配最长的完整候选**：折行会把时间戳切成两半，短匹配可能是「14:57」这种
  // 半截（秒/时区在下一段）。结束在缓冲区末尾、又没有时区/动词的匹配视为「可能还
  // 没收完」，这一帧不判——分块到达时下一帧会带着后半段再来。
  let bestMatch = null;
  for (const view of views) {
    const candidate = parseResetAtTimestampMatch(view, { allowBareTimestamp: true });
    if (!candidate || candidate.complete !== true) continue;
    if (!bestMatch || candidate.length > bestMatch.length) bestMatch = candidate;
  }
  const absoluteMs = bestMatch ? bestMatch.ms : 0;
  let relativeMs = 0;
  if (!(absoluteMs > 0)) {
    for (const view of views) {
      relativeMs = readRelativeResetMs(view);
      if (relativeMs > 0) break;
    }
  }
  let resetAtMs = absoluteMs > 0 ? absoluteMs : (relativeMs > 0 ? nowMs + relativeMs : 0);
  const kind = signature.hardExhaustion === true ? 'quota_exhausted' : 'rate_limit';
  if (!(resetAtMs > nowMs)) {
    // 额度/积分耗尽没有恢复时刻：上游明确要求购买才能恢复。这不是「等一会儿就好」的
    // 限流，不能按「没有恢复时刻就不动手」处理——否则整个账号在买额度前一直撞墙。
    if (signature.hardExhaustion !== true) return null;
    resetAtMs = nowMs + HARD_EXHAUSTION_COOLDOWN_MS;
  }
  return {
    kind,
    signature: signature.id,
    matchedText: String(matchedText || '').slice(0, 400),
    resetAtMs: Math.min(resetAtMs, nowMs + MAX_COOLDOWN_MS),
    hardExhaustion: signature.hardExhaustion === true
  };
}

// ── 用户输入回显 ────────────────────────────────────────────────────────────
// TUI 会把用户敲进去的文字原样画回输出流，于是「用户自己打了一句 429」与
// 「上游真的回了 429」在文本层面**完全同形**。2026-11-10 用户实测：把报错原文
// 粘进对话框，会话当场被换号。文本本身无法区分，唯一的外部事实在输入侧：
// 这句报错的原文是不是刚被用户敲进去过。
//
// 比对用「只留字母/数字/汉字」的形式：TUI 会按窗口宽度折行，还会在折行处插进
// 输入框边框和空格，逐字符比对永远对不上；把这些噪音全部丢掉才能稳定命中。
function compactForEcho(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 命中的签名原文是否来自用户输入（= TUI 回显，不是上游报错）。
 * `userInputText` 是用户最近敲进 PTY 的原文（调用方负责时间窗）。
 * 太短的命中（例如只有一个 `429`）不足以证明来源，不抑制。
 */
function signalLooksLikeUserEcho(signal, userInputText) {
  const matchKey = compactForEcho(signal && signal.matchedText);
  // 只命中一个 `429` 不足以证明来源：用户随口提到 429 时不能把真实报错压掉。
  if (matchKey.length < 4) return false;
  const inputKey = compactForEcho(userInputText);
  if (!inputKey) return false;
  return inputKey.includes(matchKey);
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
  HARD_EXHAUSTION_COOLDOWN_MS,
  LIMIT_SCAN_TAIL_LENGTH,
  MAX_COOLDOWN_MS,
  MIN_LIMIT_SWITCH_COOLDOWN_MS,
  RATE_LIMIT_PREFILTER,
  RATE_LIMIT_SIGNATURES,
  createAutoSwitchPolicy,
  detectRateLimitSignal,
  formatCooldownLabel,
  mightContainRateLimitSignal,
  readRelativeResetMs,
  signalLooksLikeUserEcho
};
