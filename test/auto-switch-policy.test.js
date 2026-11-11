'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HARD_EXHAUSTION_COOLDOWN_MS,
  LIMIT_SCAN_TAIL_LENGTH,
  MAX_COOLDOWN_MS,
  createAutoSwitchPolicy,
  detectRateLimitSignal,
  formatCooldownLabel,
  mightContainRateLimitSignal,
  readRelativeResetMs,
  shouldTrustTextRateLimitSignal,
  signalLooksLikeUserEcho
} = require('../lib/cli/services/pty/auto-switch-policy');
const { createUserInputEchoBuffer } = require('../lib/cli/services/pty/user-input-echo');
const { normalizeConfig, DEFAULTS } = require('../lib/usage/config-store');

// 2026-10-31 14:57:00 UTC+8 = 06:57:00Z
const CODEBUDDY_429 = 'API Error: 429 usage exceeds frequency limit, please try again later. '
  + 'your usage will reset at 2026-10-31 14:57:00 UTC+8';
const CODEBUDDY_RESET_MS = Date.UTC(2026, 9, 31, 6, 57, 0);
const BEFORE_RESET_MS = Date.UTC(2026, 9, 31, 5, 0, 0);

// 英文折行矩阵专用：秒非零。半截匹配（`14:57`）会算出不同的时刻，
// 矩阵才能同时守住「不丢信号」和「不提前定案」两件事。
const CODEBUDDY_EN_WRAP_429 = 'API Error: 429 usage exceeds frequency limit, please try again later. '
  + 'your usage will reset at 2026-10-31 14:57:21 UTC+8';
const CODEBUDDY_EN_WRAP_RESET_MS = Date.UTC(2026, 9, 31, 6, 57, 21);

// 2026-11-03 真机：codebuddycn 的 429 只有中文，没有 `429`、没有英文关键字。
// 中文语序是「将在 <时刻> 重置」，时间戳在动词前面。
const CODEBUDDY_ZH_429 = '您的使用量已超出频率限制，将在 2026-11-04 13:34:21 UTC+8 重置，'
  + '您也可以切换其他模型继续使用。';
const CODEBUDDY_ZH_RESET_MS = Date.UTC(2026, 10, 4, 5, 34, 21);
const ZH_BEFORE_RESET_MS = Date.UTC(2026, 10, 3, 6, 0, 0);

// 2026-11-10 真机：CodeBuddy 国际站积分耗尽，业务码 14018，没有恢复时刻。
// 用户会话里直接收到这句后没有换号，整个会话在「买加量包」之前一直撞墙。
const CODEBUDDY_CREDITS_EXHAUSTED = '429 Credits exhausted. Please visit the link below to purchase '
  + 'add-on packs and get more credits: https://www.codebuddy.ai/profile/usage';

test('codebuddy 429 Credits exhausted（没有恢复时刻）也立即换号', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_CREDITS_EXHAUSTED, { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.kind, 'quota_exhausted');
  assert.equal(signal.signature, 'codebuddy-credits-exhausted');
  assert.equal(signal.hardExhaustion, true);
  assert.equal(signal.resetAtMs, BEFORE_RESET_MS + HARD_EXHAUSTION_COOLDOWN_MS);
});

test('Credits exhausted 被 TUI 换行/分块拆开仍然命中', () => {
  const wrapped = '429 Credits exhausted. Please visit the link below to purchase\n  '
    + 'add-on packs and get more credits: https://www.codebuddy.ai/profile/usage';
  const signal = detectRateLimitSignal(wrapped, { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.kind, 'quota_exhausted');
  assert.equal(signal.resetAtMs, BEFORE_RESET_MS + HARD_EXHAUSTION_COOLDOWN_MS);
});

test('Credits exhausted 前置过滤命中，但普通讨论不会触发', () => {
  assert.equal(mightContainRateLimitSignal(CODEBUDDY_CREDITS_EXHAUSTED), true);
  assert.equal(mightContainRateLimitSignal('what does credits exhausted mean?'), true);
  // 只有 credits exhausted 这个词、没有 429/购买页的正文不构成账号故障。
  assert.equal(detectRateLimitSignal('what does credits exhausted mean?', { nowMs: BEFORE_RESET_MS }), null);
  assert.equal(
    detectRateLimitSignal('credits exhausted is a phrase in the docs', { nowMs: BEFORE_RESET_MS }),
    null
  );
});

test('codebuddy 中文 429（时间戳在「重置」之前）也是换号信号', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_ZH_429, { nowMs: ZH_BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.kind, 'rate_limit');
  assert.equal(signal.signature, 'codebuddy-zh-frequency-window');
  assert.equal(signal.resetAtMs, CODEBUDDY_ZH_RESET_MS);
});

test('中文 429 被 TUI 换行拆开时仍能还原恢复时刻', () => {
  const wrapped = '您的使用量已超出频率限制，将在\n  2026-11-04 13:34:21\n  UTC+8 重置，'
    + '您也可以切换其他模型继续使用。';
  const signal = detectRateLimitSignal(wrapped, { nowMs: ZH_BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.resetAtMs, CODEBUDDY_ZH_RESET_MS);
});

test('中文折行把「重置」拆成两半也不丢恢复时刻', () => {
  // 中文 TUI 会在任意两个汉字之间折行；归一化后动词锚点就断了，但签名仍是强证据。
  const wrapped = '您的使用量已超出频率限制，将在 2026-11-04 13:34:21 UTC+8 重\n置，'
    + '您也可以切换其他模型继续使用。';
  const signal = detectRateLimitSignal(wrapped, { nowMs: ZH_BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.resetAtMs, CODEBUDDY_ZH_RESET_MS);
});

test('中文 429 在任意汉字之间折行都不丢信号（全切点矩阵）', () => {
  const chars = Array.from(CODEBUDDY_ZH_429);
  for (let i = 1; i < chars.length; i += 1) {
    const wrapped = chars.slice(0, i).join('') + '\n' + chars.slice(i).join('');
    const signal = detectRateLimitSignal(wrapped, { nowMs: ZH_BEFORE_RESET_MS });
    assert.ok(signal, `split at char ${i}`);
    assert.equal(signal.resetAtMs, CODEBUDDY_ZH_RESET_MS, `split at char ${i}`);
  }
});

test('分块到达（运行时逐帧累积尾部）在任意切点都能还原', () => {
  // 复刻 observeRateLimitSignal：每帧都拼进 4KB 尾部，尾部命中关键字才判定。
  // 按 chunk 单独过滤会漏判——签名可能正好被切在两段之间。
  const stream = (chunks) => {
    let tail = '';
    for (const chunk of chunks) {
      tail = (tail + chunk).slice(-LIMIT_SCAN_TAIL_LENGTH);
      if (!mightContainRateLimitSignal(tail)) continue;
      const signal = detectRateLimitSignal(tail, { nowMs: ZH_BEFORE_RESET_MS });
      if (signal) return signal;
    }
    return null;
  };
  const chars = Array.from(CODEBUDDY_ZH_429);
  for (let i = 1; i < chars.length; i += 1) {
    const signal = stream([chars.slice(0, i).join(''), chars.slice(i).join('')]);
    assert.ok(signal, `split at char ${i}`);
  }
  // 多段：签名、日期、秒、时区、动词分别被切开。
  const chunks = [
    '您的使',
    '用量已超出频率限',
    '制，将在 2026-11-0',
    '4 13:34:2',
    '1 UTC',
    '+8 重',
    '置，您也可以切换其他模型继续使用。'
  ];
  const signal = stream(chunks);
  assert.ok(signal);
  assert.equal(signal.resetAtMs, CODEBUDDY_ZH_RESET_MS);
});

test('中文 429 没有恢复时刻时不动手（交给用量阈值那条路）', () => {
  assert.equal(detectRateLimitSignal('您的使用量已超出频率限制，请稍后再试。', { nowMs: ZH_BEFORE_RESET_MS }), null);
});

test('中文恢复时刻已经过去 = 历史日志，不是信号', () => {
  assert.equal(detectRateLimitSignal(CODEBUDDY_ZH_429, { nowMs: CODEBUDDY_ZH_RESET_MS + 60_000 }), null);
});

test('前置过滤与签名名单同源：中文命中、普通正文不命中', () => {
  assert.equal(mightContainRateLimitSignal(CODEBUDDY_ZH_429), true);
  assert.equal(mightContainRateLimitSignal('您的额度已用尽，将在 2026-11-04 13:34:21 UTC+8 重置'), true);
  assert.equal(mightContainRateLimitSignal('API Error: 429'), true);
  assert.equal(mightContainRateLimitSignal('帮我看看这个组件为什么渲染两次'), false);
  assert.equal(mightContainRateLimitSignal(''), false);
});

test('codebuddy 429 with an absolute reset time is a switch signal', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_429, { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.kind, 'rate_limit');
  assert.equal(signal.signature, 'codebuddy-frequency-window');
  assert.equal(signal.resetAtMs, CODEBUDDY_RESET_MS);
});

test('429 without a recovery time is not a switch signal', () => {
  assert.equal(detectRateLimitSignal('API Error: 429 Too Many Requests', { nowMs: BEFORE_RESET_MS }), null);
  assert.equal(detectRateLimitSignal('rate limit exceeded', { nowMs: BEFORE_RESET_MS }), null);
});

test('a reset time that already passed is history, not a signal', () => {
  assert.equal(detectRateLimitSignal(CODEBUDDY_429, { nowMs: CODEBUDDY_RESET_MS + 60_000 }), null);
});

test('relative retry hints are converted to an absolute deadline', () => {
  assert.equal(readRelativeResetMs('try again in 90 seconds'), 90_000);
  assert.equal(readRelativeResetMs('Please retry after 5 minutes'), 300_000);
  assert.equal(readRelativeResetMs('available again in 2 hours'), 7_200_000);
  assert.equal(readRelativeResetMs('try again later'), 0);
  const signal = detectRateLimitSignal('429 RESOURCE_EXHAUSTED, try again in 10 minutes', { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.resetAtMs, BEFORE_RESET_MS + 600_000);
});

test('the detector ignores ordinary prose that merely mentions rate limiting', () => {
  assert.equal(detectRateLimitSignal('为什么我会看到 rate limit 和 429 错误？', { nowMs: BEFORE_RESET_MS }), null);
  assert.equal(detectRateLimitSignal('quota policy discussion', { nowMs: BEFORE_RESET_MS }), null);
  assert.equal(detectRateLimitSignal('', { nowMs: BEFORE_RESET_MS }), null);
});

test('detection survives TUI line wrapping inside the message', () => {
  const wrapped = 'API Error: 429 usage exceeds frequency limit\n  your usage will reset at\n  2026-10-31 14:57:00 UTC+8';
  const signal = detectRateLimitSignal(wrapped, { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.resetAtMs, CODEBUDDY_RESET_MS);
});

test('英文 429 在任意字符之间折行都不丢信号且时刻正确（全切点矩阵）', () => {
  const chars = Array.from(CODEBUDDY_EN_WRAP_429);
  for (const indent of ['\n', '\n  ']) {
    for (let i = 1; i < chars.length; i += 1) {
      const wrapped = chars.slice(0, i).join('') + indent + chars.slice(i).join('');
      const label = `split at char ${i} with ${JSON.stringify(indent)}`;
      const signal = detectRateLimitSignal(wrapped, { nowMs: BEFORE_RESET_MS });
      assert.ok(signal, label);
      assert.equal(signal.resetAtMs, CODEBUDDY_EN_WRAP_RESET_MS, label);
    }
  }
});

test('英文 429 分块到达：半截时间戳等下一帧，最终时刻正确', () => {
  // 复刻 observeRateLimitSignal + 200ms 静默窗口：每帧都拼进尾部并记下当帧结论；
  // 运行时不在命中那一帧动手，定时器到点时拿**最新**尾部重判——所以断言最后那一帧。
  const stream = (chunks) => {
    let tail = '';
    const frames = [];
    for (const chunk of chunks) {
      tail = (tail + chunk).slice(-LIMIT_SCAN_TAIL_LENGTH);
      frames.push(mightContainRateLimitSignal(tail)
        ? detectRateLimitSignal(tail, { nowMs: BEFORE_RESET_MS })
        : null);
    }
    return { frames, final: detectRateLimitSignal(tail, { nowMs: BEFORE_RESET_MS }) };
  };

  const chars = Array.from(CODEBUDDY_EN_WRAP_429);
  for (let i = 1; i < chars.length; i += 1) {
    const { final } = stream([chars.slice(0, i).join(''), chars.slice(i).join('')]);
    assert.ok(final, `split at char ${i}`);
    assert.equal(final.resetAtMs, CODEBUDDY_EN_WRAP_RESET_MS, `split at char ${i}`);
  }

  // 秒被切掉：`14:57` 落在帧尾、既无时区也无动词——这一帧判不了，等下一帧。
  const secondsAt = CODEBUDDY_EN_WRAP_429.indexOf(':21');
  const halfSeconds = stream([
    CODEBUDDY_EN_WRAP_429.slice(0, secondsAt),
    CODEBUDDY_EN_WRAP_429.slice(secondsAt)
  ]);
  assert.equal(halfSeconds.frames[0], null);
  assert.equal(halfSeconds.final.resetAtMs, CODEBUDDY_EN_WRAP_RESET_MS);

  // `UTC` 先到、`+8` 后到：先到的那帧会被当成 0 偏移（差 8 小时），不能动手。
  const utcAt = CODEBUDDY_EN_WRAP_429.indexOf('UTC');
  const bareUtc = stream([
    CODEBUDDY_EN_WRAP_429.slice(0, utcAt + 3),
    CODEBUDDY_EN_WRAP_429.slice(utcAt + 3)
  ]);
  assert.ok(bareUtc.frames[0]);
  assert.notEqual(bareUtc.frames[0].resetAtMs, CODEBUDDY_EN_WRAP_RESET_MS);
  assert.equal(bareUtc.final.resetAtMs, CODEBUDDY_EN_WRAP_RESET_MS);

  // 多段：签名、日期、秒、时区分别被切开。
  const streamed = stream([
    'API Error: 429 usage exceeds fre',
    'quency limit, please try again later. your usage will reset at 2026-10-3',
    '1 14:57',
    ':21 UTC',
    '+8'
  ]);
  assert.equal(streamed.frames[0], null);
  assert.ok(streamed.final);
  assert.equal(streamed.final.resetAtMs, CODEBUDDY_EN_WRAP_RESET_MS);
});

test('a far-future hint is clamped to the 24h cooldown ceiling', () => {
  const signal = detectRateLimitSignal('429 quota exceeded, try again in 30 days', { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.equal(signal.resetAtMs, BEFORE_RESET_MS + MAX_COOLDOWN_MS);
});

test('config: the mode is off by default and the threshold follows threshold_pct', () => {
  assert.equal(DEFAULTS.auto_switch, false);
  assert.equal(DEFAULTS.auto_switch_remaining_pct, null);
  const policy = createAutoSwitchPolicy({ readConfig: () => ({ ...DEFAULTS }) });
  assert.equal(policy.isEnabled(), false);
  assert.equal(policy.readSettings().remainingPct, 5);
  assert.equal(policy.evaluateUsage(0).switch, false);
});

test('config: enabling switches only at or below the configured threshold', () => {
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true, auto_switch_remaining_pct: 0 })
  });
  assert.equal(policy.isEnabled(), true);
  assert.equal(policy.evaluateUsage(0.4).switch, false);
  assert.equal(policy.evaluateUsage(0).switch, true);
  assert.match(policy.evaluateUsage(0).reason, /额度剩余 0%/);

  const followThreshold = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true, auto_switch_remaining_pct: null, threshold_pct: 80 })
  });
  assert.equal(followThreshold.readSettings().remainingPct, 20);
  assert.equal(followThreshold.evaluateUsage(21).switch, false);
  assert.equal(followThreshold.evaluateUsage(20).switch, true);
});

test('config: AIH_RUNTIME_USAGE auto_switch overrides the stored config per session', () => {
  const onViaEnv = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: false }),
    readEnvField: (key) => (key === 'auto_switch' ? '1' : '')
  });
  assert.equal(onViaEnv.isEnabled(), true);
  const offViaEnv = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true }),
    readEnvField: (key) => (key === 'auto_switch' ? '0' : '')
  });
  assert.equal(offViaEnv.isEnabled(), false);
});

test('config: the threshold can be overridden per session', () => {
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true, auto_switch_remaining_pct: 0 }),
    readEnvField: (key) => (key === 'auto_switch_remaining' ? '100' : '')
  });
  assert.equal(policy.readSettings().remainingPct, 100);
  assert.equal(policy.evaluateUsage(100).switch, true);
  const junk = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true, auto_switch_remaining_pct: 0 }),
    readEnvField: (key) => (key === 'auto_switch_remaining' ? 'abc' : '')
  });
  assert.equal(junk.readSettings().remainingPct, 0);
});

test('cooldown is keyed by (account, model) and expires on its own', () => {
  let nowMs = BEFORE_RESET_MS;
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true }),
    now: () => nowMs
  });
  const recorded = policy.noteRateLimit({ accountRef: 'acct_a', model: 'deepseek', resetAtMs: CODEBUDDY_RESET_MS });
  assert.equal(recorded.untilMs, CODEBUDDY_RESET_MS);
  assert.equal(policy.isCooling('acct_a', 'deepseek'), true);
  assert.equal(policy.isCooling('acct_a', 'glm-5'), false);
  assert.equal(policy.isCooling('acct_b', 'deepseek'), false);
  assert.deepEqual(policy.coolingAccountRefs(), ['acct_a']);
  assert.equal(policy.describeCooldown('acct_a', 'deepseek'), formatCooldownLabel(CODEBUDDY_RESET_MS, nowMs));

  nowMs = CODEBUDDY_RESET_MS + 1000;
  assert.equal(policy.isCooling('acct_a', 'deepseek'), false);
  assert.deepEqual(policy.coolingAccountRefs(), []);
});

test('an unknown model is treated as account-wide (conservative)', () => {
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true }),
    now: () => BEFORE_RESET_MS
  });
  policy.noteRateLimit({ accountRef: 'acct_a', model: 'deepseek', resetAtMs: CODEBUDDY_RESET_MS });
  assert.equal(policy.isCooling('acct_a', ''), true);
});

test('a cooldown never extends past the 24h ceiling and never goes backwards', () => {
  const nowMs = BEFORE_RESET_MS;
  const policy = createAutoSwitchPolicy({
    readConfig: () => ({ ...DEFAULTS, auto_switch: true }),
    now: () => nowMs
  });
  const far = policy.noteRateLimit({ accountRef: 'acct_a', model: 'm', resetAtMs: nowMs + 30 * 86400000 });
  assert.equal(far.untilMs, nowMs + MAX_COOLDOWN_MS);
  const sooner = policy.noteRateLimit({ accountRef: 'acct_a', model: 'm', resetAtMs: nowMs + 60_000 });
  assert.equal(sooner.untilMs, nowMs + MAX_COOLDOWN_MS);
  assert.equal(policy.noteRateLimit({ accountRef: 'acct_a', model: 'm', resetAtMs: nowMs - 1 }), null);
  assert.equal(policy.noteRateLimit({ accountRef: '', model: 'm', resetAtMs: nowMs + 60_000 }), null);
});

test('config-store round-trips the two new fields and rejects junk', () => {
  const enabled = normalizeConfig({ auto_switch: 'on', auto_switch_remaining_pct: '0' });
  assert.equal(enabled.auto_switch, true);
  assert.equal(enabled.auto_switch_remaining_pct, 0);

  const disabled = normalizeConfig({ auto_switch: 'maybe', auto_switch_remaining_pct: 'abc' });
  assert.equal(disabled.auto_switch, false);
  assert.equal(disabled.auto_switch_remaining_pct, null);

  assert.equal(normalizeConfig({ auto_switch_remaining_pct: 250 }).auto_switch_remaining_pct, 100);
  assert.equal(normalizeConfig({ auto_switch_remaining_pct: -3 }).auto_switch_remaining_pct, 0);
  // 老配置（没有这两个键）读出来仍然是「关闭 + 跟随 threshold_pct」。
  const legacy = normalizeConfig({ threshold_pct: 90 });
  assert.equal(legacy.auto_switch, false);
  assert.equal(legacy.auto_switch_remaining_pct, null);
});

// ── 用户输入回显：PTY 会把用户打的字原样画回输出流 ─────────────────────────────
// 2026-11-10 用户实测：把 `429 Credits exhausted …` 粘进对话框，会话当场被换号。
// 文本本身无法区分来源，唯一的外部事实是「这句原文刚被用户敲进去过」。

test('命中的签名原文会带出来，供回显比对使用', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_CREDITS_EXHAUSTED, { nowMs: BEFORE_RESET_MS });
  assert.ok(signal);
  assert.match(signal.matchedText, /429\s+Credits exhausted/i);
});

test('用户把 429 原文粘进输入框 → 判为回显，不换号', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_CREDITS_EXHAUSTED, { nowMs: BEFORE_RESET_MS });
  assert.equal(signalLooksLikeUserEcho(signal, CODEBUDDY_CREDITS_EXHAUSTED), true);
});

test('TUI 折行 + 输入框边框插进原文也不影响回显判定', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_CREDITS_EXHAUSTED, { nowMs: BEFORE_RESET_MS });
  // 输入框会把一段粘贴拆成多行，每行带边框字符，并在折行处插空格。
  const echoed = '│ 429 Credits exhausted. Please visit the link below to\n'
    + '│ purchase add-on packs and get more credits:\n'
    + '│ https://www.codebuddy.ai/profile/usage';
  assert.equal(signalLooksLikeUserEcho(signal, echoed), true);
});

test('用户输入里没有这句报错 → 不是回显，正常换号', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_429, { nowMs: BEFORE_RESET_MS });
  assert.equal(signalLooksLikeUserEcho(signal, '帮我看看这个 429 报错是什么意思'), false);
  assert.equal(signalLooksLikeUserEcho(signal, ''), false);
});

test('中文 429 的回显同样能认出来', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_ZH_429, { nowMs: ZH_BEFORE_RESET_MS });
  assert.equal(signalLooksLikeUserEcho(signal, CODEBUDDY_ZH_429), true);
  assert.equal(signalLooksLikeUserEcho(signal, '频率限制是什么'), false);
});

test('太短的命中不足以证明来源，不抑制真实报错', () => {
  // 只命中一个 `429` 时，用户输入里出现 429 并不能说明这句报错是回显。
  assert.equal(signalLooksLikeUserEcho({ matchedText: '429' }, '我看到 429 了'), false);
  assert.equal(signalLooksLikeUserEcho({ matchedText: '' }, '429 Credits exhausted'), false);
});

// ── 文本限流信号能不能采信：来源判定 ─────────────────────────────────────────
// 文本路径只在「结构化事实源还看不到这段会话」的启动窗口里兜底，且必须排除
// 用户自己敲进去的原文（TUI 会把它画回输出流）。

test('结构化事实源在观察时，文本命中一律让位（真实报错由会话 jsonl 负责）', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_CREDITS_EXHAUSTED, { nowMs: BEFORE_RESET_MS });
  assert.equal(shouldTrustTextRateLimitSignal({
    signal,
    recentUserInput: '',
    structuredObserving: true
  }), false);
});

test('启动窗口：用户把 429 原文粘进输入框并回显到输出，不采信这条文本', () => {
  const echo = createUserInputEchoBuffer();
  echo.remember(CODEBUDDY_CREDITS_EXHAUSTED);
  // 输入框按宽度折行，只在**行首**插边框（真机形态）；不能把边框插进句子中间，
  // 那样连上游原文都会认不出来，测到的是假的回显。
  const lines = [];
  let current = '';
  for (const word of CODEBUDDY_CREDITS_EXHAUSTED.split(' ')) {
    if (current && (current + ' ' + word).length > 40) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  lines.push(current);
  const echoedOutput = `\r\n${lines.map((line) => `│ ${line}`).join('\r\n')}\r\n`;
  const signal = detectRateLimitSignal(echoedOutput, { nowMs: BEFORE_RESET_MS });
  assert.ok(signal, '签名本身必须命中，否则测不到「采信闸门」');
  assert.equal(shouldTrustTextRateLimitSignal({
    signal,
    recentUserInput: echo.read(),
    structuredObserving: false
  }), false);
});

test('启动窗口：上游真的报错、用户最近输入里没有这句 → 采信', () => {
  const echo = createUserInputEchoBuffer();
  echo.remember('帮我看一下这个项目为什么这么慢');
  const signal = detectRateLimitSignal(CODEBUDDY_429, { nowMs: BEFORE_RESET_MS });
  assert.equal(shouldTrustTextRateLimitSignal({
    signal,
    recentUserInput: echo.read(),
    structuredObserving: false
  }), true);
});

test('没有结构化观察者（非 CodeBuddy 家族）时，文本兜底照常生效', () => {
  const signal = detectRateLimitSignal(CODEBUDDY_ZH_429, { nowMs: ZH_BEFORE_RESET_MS });
  assert.equal(shouldTrustTextRateLimitSignal({ signal, recentUserInput: '' }), true);
  assert.equal(shouldTrustTextRateLimitSignal({
    signal,
    recentUserInput: CODEBUDDY_ZH_429,
    structuredObserving: false
  }), false);
});

test('回显窗口过期后，同一句文本重新可采信（抑制必须有界）', () => {
  let nowMs = BEFORE_RESET_MS;
  const echo = createUserInputEchoBuffer({ windowMs: 1000, now: () => nowMs });
  echo.remember(CODEBUDDY_CREDITS_EXHAUSTED);
  const signal = detectRateLimitSignal(CODEBUDDY_CREDITS_EXHAUSTED, { nowMs: BEFORE_RESET_MS });
  assert.equal(shouldTrustTextRateLimitSignal({
    signal,
    recentUserInput: echo.read(),
    structuredObserving: false
  }), false);
  nowMs += 1001;
  assert.equal(shouldTrustTextRateLimitSignal({
    signal,
    recentUserInput: echo.read(),
    structuredObserving: false
  }), true);
});
