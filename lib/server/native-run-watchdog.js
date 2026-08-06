'use strict';

// 原生会话运行看门狗：给「进程起来了、上游却一直不回话」的 run 加主动熔断。
//
// 阈值全部由实测反推,不拍脑袋。语料：~/.codex/sessions rollout（30 天 495 个会话 /
// 11912 轮）+ ~/.ai_home/logs/webui-runs（21 个 run 日志,其中 7 个撞上重试风暴）。
//
// 一、`task_started` → 上游第一个真实事件（TTFT,已剔除会话恢复/压缩回放的 0ms 伪样本,
//     n=1737）：p50 16.1s / p90 34.4s / p95 55.5s / p99.5 83.4s。
//     也就是说健康轮次里有 79.9% 超过 10s——「10s 没响应就当超时」会误杀近八成正常请求。
//     120s 静默预算只砍掉 0.288% 的轮次,且会话首轮无一超过 120s。→ 第一级维持 120s。
//
// 二、重试风暴的恢复率：7 次风暴 7 次跑满 `Reconnecting... 1/5` → `5/5` 后以 turn.failed
//     收场,恢复 0 次(全是 aihub 502)。既然「等下去能自愈」在实测里从未发生,第二级预算
//     就该压到刚好能观察到一次完整重试失败的长度：重连行约 ~40s 一条,45s 正好覆盖一次,
//     而 CLI 自己跑完 5 次要 ~216s。→ 第二级 60s 收紧到 45s,故障暴露快 4.8 倍。
//     例外：上游/CLI 自己声明了退避时间(claude 的 retry_delay_ms、opencode 的 next)时
//     必须等到那个点之后再给一个完整预算,否则等于把排好队的健康重试当故障杀掉。
//
// 三、出过内容之后的静默(stall)：轮内最大间隔 p99 = 377s,>600s 的样本共 17 个。逐条看过,
//     其中 12 个是 `request_user_input`(用户离开去干别的了)——这类本来就被 pause 停表;
//     剩下 5 个是真跑很久的本地工具：12.4h(rm+发布)、8h(shell 脚本)、3.4h(git clone)、
//     1.5h(ssh rm -rf)、1.2h(rm)。任何分钟级的 stall 预算都会误杀它们,而 headless
//     `exec --json` 只发 item.completed、不发 item.started,拿不到「工具是否在跑」来豁免。
//     → 第三级默认保持关闭,只作为可选开关留给明确知道自己不跑长工具的场景。
//
// 关键约束：心跳只认「上游真进展」（delta/result/工具调用），错误行与重连行【不】刷新计时器。
// 否则每 ~40s 一条 `Reconnecting...` 会让朴素的 idle 计时器永远不触发——那正是老行为。

const DEFAULT_FIRST_PROGRESS_TIMEOUT_MS = 120000;
const DEFAULT_UPSTREAM_ERROR_TIMEOUT_MS = 45000;
const DEFAULT_STALL_TIMEOUT_MS = 0;
const DEFAULT_KILL_GRACE_MS = 8000;

// 上游声明的退避最多认到这里。再长就不该是「悄悄干等」而该给用户一个明确失败；
// 同时挡住 retryAt 单位错配(秒/毫秒、绝对/相对混用)时算出的荒谬未来时间。
const MAX_ADVISED_RETRY_WAIT_MS = 300000;

const TIMEOUT_CODE = 'native_session_timeout';

// 上游确实回话了的证据。terminal-output 只在交互式 CLI（TUI 原样渲染）下算进展，
// headless JSON 流里它是 CLI 自己的 stderr 噪声，不能当上游心跳。
const PROGRESS_EVENT_TYPES = new Set([
  'delta',
  'thinking',
  'result',
  'assistant_tool_call',
  'assistant_tool_result'
]);

// 上游失败信号：codex 把 `Reconnecting... n/5` 也吐成 error 事件，retry-status 是
// claude/opencode 的等价物。两者都不算心跳，只用来启动第二级（更短的）预算。
const UPSTREAM_FAILURE_EVENT_TYPES = new Set(['error', 'retry-status']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readTimeoutMs(env, key, fallback) {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.trunc(number);
}

function resolveNativeRunWatchdogConfig(env = process.env, overrides = {}) {
  const explicitlyDisabled = String((env && env.AIH_NATIVE_RUN_WATCHDOG) || '1') === '0';
  const enabled = overrides.enabled === false
    ? false
    : !explicitlyDisabled;
  const pick = (overrideValue, key, fallback) => (
    Number.isFinite(Number(overrideValue)) && Number(overrideValue) >= 0
      ? Math.trunc(Number(overrideValue))
      : readTimeoutMs(env, key, fallback)
  );
  return {
    enabled,
    firstProgressTimeoutMs: pick(
      overrides.firstProgressTimeoutMs,
      'AIH_NATIVE_FIRST_PROGRESS_TIMEOUT_MS',
      DEFAULT_FIRST_PROGRESS_TIMEOUT_MS
    ),
    upstreamErrorTimeoutMs: pick(
      overrides.upstreamErrorTimeoutMs,
      'AIH_NATIVE_UPSTREAM_ERROR_TIMEOUT_MS',
      DEFAULT_UPSTREAM_ERROR_TIMEOUT_MS
    ),
    stallTimeoutMs: pick(
      overrides.stallTimeoutMs,
      'AIH_NATIVE_STALL_TIMEOUT_MS',
      DEFAULT_STALL_TIMEOUT_MS
    ),
    killGraceMs: pick(
      overrides.killGraceMs,
      'AIH_NATIVE_TIMEOUT_KILL_GRACE_MS',
      DEFAULT_KILL_GRACE_MS
    )
  };
}

function classifyWatchdogEvent(event, options = {}) {
  const type = event && typeof event.type === 'string' ? event.type : '';
  if (!type) return 'ignore';
  if (PROGRESS_EVENT_TYPES.has(type)) return 'progress';
  if (type === 'terminal-output') {
    return options.terminalOutputIsProgress === true ? 'progress' : 'ignore';
  }
  // 传输层已恢复(app-server 重连成功)是正面证据：撤销错误预算，但它本身不是上游进展。
  if (type === 'retry-status' && normalizeString(event.phase) === 'recovered') return 'upstream-recovered';
  if (UPSTREAM_FAILURE_EVENT_TYPES.has(type)) return 'upstream-failure';
  // 交互 prompt / 审批期间的等待是「等用户」，不是上游慢，必须暂停计时。
  if (type === 'interactive-prompt') return 'pause';
  if (type === 'interactive-prompt-cleared') return 'resume';
  return 'ignore';
}

// 上游/CLI 自报的「下次重试时刻」。claude 走 retryAfterMs(相对)、opencode 走 retryAt(绝对),
// 两者都可能超过 45s 预算——那是排好队的健康重试,不是故障,不能按预算杀。
function resolveAdvisedRetryAt(event, currentAt) {
  if (!event) return 0;
  let advised = 0;
  const after = Number(event.retryAfterMs);
  if (Number.isFinite(after) && after > 0) advised = Math.max(advised, currentAt + after);
  const at = Number(event.retryAt);
  if (Number.isFinite(at) && at > currentAt) advised = Math.max(advised, at);
  if (!advised) return 0;
  return Math.min(advised, currentAt + MAX_ADVISED_RETRY_WAIT_MS);
}

function describeTimeout(reason, limitMs, lastUpstreamFailure) {
  const seconds = Math.round(limitMs / 1000);
  if (reason === 'upstream_error_persisted') {
    const detail = normalizeString(lastUpstreamFailure);
    return `上游持续报错 ${seconds}s 未恢复，已主动熔断本轮${detail ? `：${detail}` : ''}`;
  }
  if (reason === 'stalled') {
    return `原生会话 ${seconds}s 没有新进展，已主动熔断本轮`;
  }
  return `原生会话 ${seconds}s 内没有收到上游任何响应，已主动熔断本轮`;
}

function createNativeRunWatchdog(options = {}) {
  const config = options.config
    || resolveNativeRunWatchdogConfig(options.env || process.env, options);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;
  const onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : () => {};
  const terminalOutputIsProgress = options.terminalOutputIsProgress === true;

  let timer = null;
  let running = false;
  let fired = false;
  let startedAt = 0;
  let firstProgressAt = 0;
  let lastProgressAt = 0;
  let upstreamFailureAt = 0;
  let upstreamRetryFloorAt = 0;
  let lastUpstreamFailure = '';
  let pausedAt = 0;
  // 两类「停表」来源语义不同,不能混用一个布尔：
  //   waitHolds —— 显式 pause()/resume() 的调用方(codex app-server 审批)可以同时挂起多个
  //     审批请求,必须计数,否则第一个决策回来就把表重新启动、剩下的审批算进预算;
  //   promptHold —— 事件流里的 interactive-prompt 由探测器维护「同一时刻只有一个活跃 prompt」,
  //     且换 prompt 时会直接再发一条 interactive-prompt(不补 cleared),计数会永久失衡,所以用闩。
  let waitHolds = 0;
  let promptHold = false;

  const clearActiveTimer = () => {
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  };

  const nextDeadline = () => {
    let best = null;
    const consider = (reason, at, limitMs) => {
      if (!(limitMs > 0)) return;
      if (!best || at < best.at) best = { reason, at, limitMs };
    };
    if (!firstProgressAt) {
      consider('no_first_progress', startedAt + config.firstProgressTimeoutMs, config.firstProgressTimeoutMs);
    }
    if (upstreamFailureAt) {
      consider('upstream_error_persisted', upstreamFailureAt + config.upstreamErrorTimeoutMs, config.upstreamErrorTimeoutMs);
    }
    if (firstProgressAt) {
      consider('stalled', lastProgressAt + config.stallTimeoutMs, config.stallTimeoutMs);
    }
    // 上游自报了重试时刻,就在「那一刻 + 一个完整预算」之前一律不开火：这是排好队的健康
    // 重试,被哪一级砍掉都是误杀——尤其第一级,静默 120s 往往还没等到承诺的重试落地。
    // 预算为 0 = 第二级关闭,此时承诺也不该反过来把计时器往后推。
    if (best && upstreamRetryFloorAt && config.upstreamErrorTimeoutMs > 0) {
      const floorAt = upstreamRetryFloorAt + config.upstreamErrorTimeoutMs;
      if (floorAt > best.at) {
        best = {
          reason: 'upstream_error_persisted',
          at: floorAt,
          limitMs: floorAt - (upstreamFailureAt || startedAt)
        };
      }
    }
    return best;
  };

  const fire = (deadline, firedAt) => {
    fired = true;
    running = false;
    clearActiveTimer();
    onTimeout({
      code: TIMEOUT_CODE,
      reason: deadline.reason,
      message: describeTimeout(deadline.reason, deadline.limitMs, lastUpstreamFailure),
      limitMs: deadline.limitMs,
      elapsedMs: Math.max(0, firedAt - startedAt),
      sinceProgressMs: firstProgressAt ? Math.max(0, firedAt - lastProgressAt) : null,
      sinceUpstreamFailureMs: upstreamFailureAt ? Math.max(0, firedAt - upstreamFailureAt) : null,
      lastUpstreamFailure
    });
  };

  const isPaused = () => waitHolds > 0 || promptHold;

  const tick = () => {
    timer = null;
    if (!running || fired || isPaused()) return;
    const deadline = nextDeadline();
    if (!deadline) return;
    const current = now();
    if (current < deadline.at) {
      schedule();
      return;
    }
    fire(deadline, current);
  };

  function schedule() {
    clearActiveTimer();
    if (!running || fired || isPaused()) return;
    const deadline = nextDeadline();
    if (!deadline) return;
    const delay = Math.max(0, deadline.at - now());
    timer = setTimer(tick, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // 停表/复表统一在这里换挡：调用方只改 hold 状态,由它决定是否真的动计时器。
  const applyPauseState = (wasPaused) => {
    const paused = isPaused();
    if (paused === wasPaused) return;
    if (paused) {
      pausedAt = now();
      clearActiveTimer();
      return;
    }
    // 等用户的这段时间整体后移基线，等价于「不计时」。
    const waited = Math.max(0, now() - pausedAt);
    pausedAt = 0;
    startedAt += waited;
    if (lastProgressAt) lastProgressAt += waited;
    if (upstreamFailureAt) upstreamFailureAt += waited;
    if (upstreamRetryFloorAt) upstreamRetryFloorAt += waited;
    schedule();
  };

  const pause = () => {
    const wasPaused = isPaused();
    waitHolds += 1;
    applyPauseState(wasPaused);
  };

  const resume = () => {
    if (waitHolds === 0) return;
    const wasPaused = isPaused();
    waitHolds -= 1;
    applyPauseState(wasPaused);
  };

  const setPromptHold = (held) => {
    const wasPaused = isPaused();
    promptHold = held === true;
    applyPauseState(wasPaused);
  };

  return {
    enabled: config.enabled === true,
    config,
    start() {
      if (!config.enabled || running || fired) return;
      running = true;
      startedAt = now();
      schedule();
    },
    observe(event) {
      if (!config.enabled || !running || fired) return;
      const kind = classifyWatchdogEvent(event, { terminalOutputIsProgress });
      if (kind === 'ignore') return;
      if (kind === 'pause') {
        setPromptHold(true);
        return;
      }
      if (kind === 'resume') {
        setPromptHold(false);
        return;
      }
      if (kind === 'progress') {
        const at = now();
        if (!firstProgressAt) firstProgressAt = at;
        lastProgressAt = at;
        // 上游恢复了：撤销第二级（错误）预算，避免恢复后仍被旧失败信号误杀。
        upstreamFailureAt = 0;
        upstreamRetryFloorAt = 0;
      } else if (kind === 'upstream-recovered') {
        upstreamFailureAt = 0;
        upstreamRetryFloorAt = 0;
      } else if (kind === 'upstream-failure') {
        const at = now();
        if (!upstreamFailureAt) upstreamFailureAt = at;
        // 只往后推,不回缩：多条重连行里最靠后的那个承诺才是真正要等到的时刻。
        const advisedAt = resolveAdvisedRetryAt(event, at);
        if (advisedAt > upstreamRetryFloorAt) upstreamRetryFloorAt = advisedAt;
        const detail = normalizeString(event && (event.message || event.reason));
        if (detail) lastUpstreamFailure = detail;
      }
      schedule();
    },
    // 审批/交互等待不走事件流的调用方(如 codex app-server runner)直接用这两个开关。
    pause,
    resume,
    stop() {
      running = false;
      clearActiveTimer();
    },
    snapshot() {
      return {
        enabled: config.enabled === true,
        running,
        fired,
        paused: isPaused(),
        waitHolds,
        promptHold,
        startedAt,
        firstProgressAt,
        lastProgressAt,
        upstreamFailureAt,
        upstreamRetryFloorAt,
        lastUpstreamFailure
      };
    }
  };
}

module.exports = {
  DEFAULT_FIRST_PROGRESS_TIMEOUT_MS,
  DEFAULT_UPSTREAM_ERROR_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  MAX_ADVISED_RETRY_WAIT_MS,
  NATIVE_SESSION_TIMEOUT_CODE: TIMEOUT_CODE,
  classifyWatchdogEvent,
  createNativeRunWatchdog,
  describeTimeout,
  resolveNativeRunWatchdogConfig
};
