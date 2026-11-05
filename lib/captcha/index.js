'use strict';

// 通用交互式验证码解算器。
//
// 设计边界：
//   * 本模块只认识「控件快照」和「拖动动作」，不认识浏览器生命周期 —— CDP 连接、
//     启动参数、窗口离屏都由调用方（aliyun-captcha.js）负责，换厂商时不用重造浏览器。
//   * 厂商差异收敛在 profile 里（见 aliyun.js 的 WIDGET_PROBE_EXPRESSION /
//     classifyChallenge / buildPuzzleOffsetExpression）。新增一种验证码 =
//     新增一个 profile + 在 DEFAULT_SOLVERS 里注册解算器。
//   * 轨迹与事件派发在 drag.js，纯函数部分可以单测。
//
// 目前支持：
//   puzzle-drag    拖动滑块把拼图块拖到缺口（阿里云 PUZZLE / INPAINTING）
//   slide-to-end   按住滑块拖到最右边（阿里云 SLIDING）
//   text-click     只识别、不解算（抛出 captcha_unsupported，交给人工）

const { classifyChallenge, buildPuzzleOffsetExpression, WIDGET_PROBE_EXPRESSION } = require('./aliyun');
const { buildDragPlan, clamp, performDrag } = require('./drag');

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 15_000;
const DEFAULT_OUTCOME_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// 厂商 profile：一个探测表达式 + 一个判定函数 + 一个缺口偏移表达式。
// 新增一家 = 提供这三样，解算流程不用动。
const ALIYUN_PROFILE = Object.freeze({
  name: 'aliyun',
  probe: WIDGET_PROBE_EXPRESSION,
  classify: classifyChallenge,
  buildPuzzleOffsetExpression
});

function resolveProfile(options) {
  const profile = options && options.profile;
  return profile && typeof profile.probe === 'string' && typeof profile.classify === 'function'
    ? profile
    : ALIYUN_PROFILE;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSleep(options) {
  return options && typeof options.sleep === 'function' ? options.sleep : defaultSleep;
}

function centerOf(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

async function evaluate(cdp, sessionId, expression, awaitPromise) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: Boolean(awaitPromise),
    returnByValue: true
  }, sessionId);
  if (response && response.exceptionDetails) {
    const exception = response.exceptionDetails.exception;
    const detail = (exception && (exception.description || exception.value)) || 'unknown';
    throw new Error(`captcha_evaluate_failed:${String(detail).slice(0, 200)}`);
  }
  return response && response.result ? response.result.value : null;
}

/** 读一次控件状态。轮询用，不碰像素。 */
async function readWidget(cdp, sessionId, options = {}) {
  return evaluate(cdp, sessionId, resolveProfile(options).probe, false);
}

/**
 * 等交互式挑战出现。无痕验证直接通过时返回 null（调用方接着读 outcome）。
 * 拼图块的图片是异步加载的，`ready=false` 时继续等，不要退化成「拖到最右边」。
 */
async function waitForChallenge(cdp, sessionId, options = {}) {
  const sleep = readSleep(options);
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_CHALLENGE_TIMEOUT_MS);
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await readWidget(cdp, sessionId, options);
    if (snapshot && snapshot.settled) return null;
    const challenge = resolveProfile(options).classify(snapshot);
    if (challenge && challenge.ready) return challenge;
    if (Date.now() >= deadline) return null;
    await sleep(pollIntervalMs);
  }
}

/**
 * 重新等一个「可解算」的挑战。失败后 SDK 会自动换图，所以每次尝试都要重读。
 *
 * `excludePuzzleSrc`：上一次拖动用的拼图地址。失败后 SDK 换图需要一点时间，
 * 只等「图片有尺寸」会拿到旧图、算出旧缺口，白拖一次。这里等到 src 变了再动手；
 * 如果 SDK 没换图（比如它复用了同一张），1.5s 后也接受，避免死等。
 */
async function waitForSolvableChallenge(cdp, sessionId, options = {}) {
  const sleep = readSleep(options);
  const timeoutMs = Math.max(0, Number(options.readyTimeoutMs) || DEFAULT_CHALLENGE_TIMEOUT_MS);
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const excludePuzzleSrc = options.excludePuzzleSrc || '';
  for (;;) {
    const snapshot = await readWidget(cdp, sessionId, options);
    if (snapshot && snapshot.settled) return { settled: true, snapshot };
    const challenge = resolveProfile(options).classify(snapshot);
    if (challenge && challenge.ready) {
      const src = (challenge.puzzle && challenge.puzzle.src) || '';
      const changed = !excludePuzzleSrc || src !== excludePuzzleSrc || Date.now() - startedAt > 1_500;
      if (changed) return { challenge };
    }
    if (Date.now() >= deadline) return { timeout: true };
    await sleep(pollIntervalMs);
  }
}

/**
 * 等一次验证结果：`verified` / `failed` / `timeout`。
 * 同时看 SDK 回调（window.__aihCaptchaOutcome）和控件自身的状态类，
 * 因为成功回调有时比 DOM 慢半拍。
 */
async function waitForOutcome(cdp, sessionId, options = {}) {
  const sleep = readSleep(options);
  const timeoutMs = Math.max(0, Number(options.outcomeTimeoutMs) || DEFAULT_OUTCOME_TIMEOUT_MS);
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs) || 150);
  const baselinePuzzleSrc = options.baselinePuzzleSrc || '';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await readWidget(cdp, sessionId, options);
    if (snapshot && snapshot.outcome) return snapshot.outcome.ok ? 'verified' : 'failed';
    const state = (snapshot && snapshot.trackState) || [];
    if (state.includes('verified')) return 'verified';
    if (state.includes('fail')) {
      // 拖错后 SDK 会换一张拼图；图没换说明 fail 是上一轮残留，不能当成这次的结果。
      const src = (snapshot.puzzle && snapshot.puzzle.src) || '';
      if (!baselinePuzzleSrc || src !== baselinePuzzleSrc) return 'failed';
    }
    if (Date.now() >= deadline) return 'timeout';
    await sleep(pollIntervalMs);
  }
}

async function fetchAsDataUrl(url, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (!url || typeof fetchImpl !== 'function') return '';
  try {
    const response = await fetchImpl(url);
    if (!response || response.ok === false) return '';
    const contentType = response.headers && typeof response.headers.get === 'function'
      ? String(response.headers.get('content-type') || 'image/png')
      : 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) return '';
    return `data:${contentType.split(';')[0]};base64,${buffer.toString('base64')}`;
  } catch (_error) {
    return '';
  }
}

/**
 * 求拼图缺口位移。优先在页面内用 canvas 读 alpha；
 * 画布被跨域污染时，由 Node 取图片字节再以 data URL 注入（data URL 同源，不污染）。
 */
async function readPuzzleOffset(cdp, sessionId, challenge, options = {}) {
  const profile = resolveProfile(options);
  const buildOffset = typeof profile.buildPuzzleOffsetExpression === 'function'
    ? profile.buildPuzzleOffsetExpression
    : buildPuzzleOffsetExpression;
  const value = await evaluate(cdp, sessionId, buildOffset(), true);
  if (value && value.ok) return value;
  if (value && value.reason === 'tainted_canvas' && value.src) {
    const dataUrl = await fetchAsDataUrl(value.src, options);
    if (dataUrl) {
      const boxWidth = (challenge.box && challenge.box.width) || (challenge.track && challenge.track.width) || 0;
      const displayWidth = (challenge.puzzle && challenge.puzzle.rect && challenge.puzzle.rect.width) || 0;
      const retried = await evaluate(
        cdp,
        sessionId,
        buildOffset({ dataUrl, boxWidth, displayWidth }),
        true
      );
      if (retried) return retried;
    }
  }
  return value || { ok: false, reason: 'evaluate_failed' };
}

/** 拖动滑块把拼图块拖到缺口。失败会自动重试（SDK 换图后重新算偏移）。 */
async function solvePuzzleDrag(cdp, sessionId, challenge, options = {}) {
  const sleep = readSleep(options);
  const maxAttempts = clamp(Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS, 1, 3);
  let lastReason = 'unknown';
  let excludePuzzleSrc = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ready = attempt === 1
      ? { challenge }
      : await waitForSolvableChallenge(cdp, sessionId, { ...options, excludePuzzleSrc });
    if (ready.settled) {
      const ok = Boolean(ready.snapshot && ready.snapshot.outcome && ready.snapshot.outcome.ok);
      return ok
        ? { ok: true, kind: 'puzzle-drag', attempts: attempt - 1, distance: 0, alreadySettled: true }
        : { ok: false, kind: 'puzzle-drag', attempts: attempt - 1, reason: 'settled_failed' };
    }
    if (!ready.challenge) return { ok: false, kind: 'puzzle-drag', attempts: attempt - 1, reason: 'challenge_not_ready' };
    const current = ready.challenge;
    const offset = await readPuzzleOffset(cdp, sessionId, current, options);
    if (!offset.ok) {
      return { ok: false, kind: 'puzzle-drag', attempts: attempt, reason: `offset_${offset.reason || 'unknown'}` };
    }
    const maxDistance = Math.max(0, current.track.width - current.slider.width);
    // 拼图块不一定从 0 开始（SDK 若预置了初始偏移，直接按缺口坐标拖会过头）。
    const pieceLeft = current.puzzle && current.puzzle.rect && current.box
      ? current.puzzle.rect.x - current.box.x
      : 0;
    const distance = clamp(offset.offset - pieceLeft, 0, maxDistance);
    const plan = buildDragPlan({
      origin: centerOf(current.slider),
      distance,
      rng: options.rng,
      steps: options.steps,
      overshoot: options.overshoot
    });
    await performDrag(cdp, sessionId, plan, { sleep });
    const outcome = await waitForOutcome(cdp, sessionId, {
      ...options,
      baselinePuzzleSrc: (current.puzzle && current.puzzle.src) || ''
    });
    if (outcome === 'verified') return { ok: true, kind: 'puzzle-drag', attempts: attempt, distance, offset };
    lastReason = outcome;
    excludePuzzleSrc = (current.puzzle && current.puzzle.src) || '';
    if (outcome === 'timeout') break;
  }
  return { ok: false, kind: 'puzzle-drag', attempts: maxAttempts, reason: lastReason };
}

/** 按住滑块拖到最右边（SLIDING）。 */
async function solveSlideToEnd(cdp, sessionId, challenge, options = {}) {
  const sleep = readSleep(options);
  const maxDistance = Math.max(0, challenge.track.width - challenge.slider.width);
  const plan = buildDragPlan({
    origin: centerOf(challenge.slider),
    distance: maxDistance,
    rng: options.rng,
    steps: options.steps,
    overshoot: options.overshoot
  });
  await performDrag(cdp, sessionId, plan, { sleep });
  const outcome = await waitForOutcome(cdp, sessionId, options);
  return {
    ok: outcome === 'verified',
    kind: 'slide-to-end',
    attempts: 1,
    distance: maxDistance,
    reason: outcome === 'verified' ? undefined : outcome
  };
}

const DEFAULT_SOLVERS = Object.freeze({
  'puzzle-drag': solvePuzzleDrag,
  'slide-to-end': solveSlideToEnd
});

function resolveSolver(kind, options) {
  if (options && options.solvers && typeof options.solvers[kind] === 'function') return options.solvers[kind];
  return DEFAULT_SOLVERS[kind] || null;
}

/**
 * 按挑战类型分派解算器。未知类型抛 `captcha_unsupported:<kind>`，
 * 让上层把「解不了」和「解了但没过」区分开。
 */
async function solveChallenge(cdp, sessionId, challenge, options = {}) {
  const solver = resolveSolver(challenge && challenge.kind, options);
  if (!solver) throw new Error(`captcha_unsupported:${(challenge && challenge.kind) || 'unknown'}`);
  return solver(cdp, sessionId, challenge, options);
}

module.exports = {
  ALIYUN_PROFILE,
  DEFAULT_SOLVERS,
  classifyChallenge,
  readWidget,
  solveChallenge,
  waitForChallenge,
  waitForOutcome
};
