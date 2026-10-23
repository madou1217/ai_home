'use strict';

// 终端标题门面（Facade）——**消费方只 import 这里**。
//
// 把两条轴收在一处：
//
//   终端轴      transports.js（工厂，按 supports 选通道）
//   Provider 轴 registry.js（倒排，按 priority 出帧）+ sources/（各来源）
//
// 门面自己负责三件**横切**的事，来源与 transport 都不碰：
//
//   1. **抑制**：什么情况下根本不该动标题（登录流、非交互、用户开关关闭、
//      全屏 TUI、shell drawer 可见、auth 恢复提示）。这是策略，不是事实。
//   2. **轮播**：多帧之间按节拍切换（会话名 → 身份 → 路由 → 额度 → 账号）。
//      单帧时不启动定时器——没有可轮播的内容就不要空转。
//   3. **去重与写**：内容没变不写（用量 watcher 会周期性触发，无去重会持续刷终端）。
//
// 事件驱动：回合起停、用量刷新、账号切换、错误出现与消失各自发生时重算并刷新；
// 轮播是**唯一的**定时器（加上生成中的转圈动画），不是轮询。

const {
  SPINNER_INTERVAL_MS,
  buildTitleSequence,
  sanitizeTitleText,
  resolveSpinnerFrames,
  pickFrame
} = require('./composer');
const { getTitleSourceRegistry } = require('./registry');
const { resolveTitleTransport } = require('./transports');

const DEFAULT_ROTATE_INTERVAL_MS = 4000;

// 生成态的保质期：子进程最后一次输出之后仍视为「生成中」的时间。TUI 在思考 /
// 流式输出时持续重绘，等待输入时静止，因此短 TTL 足以把「停止」变成一个可观测
// 的事件——不需要谁显式调用 markIdle()。
const BUSY_TTL_MS = 2000;
// 错误在标题里停留的时长。错误是**瞬时事件**：上游恢复后标题不能永远钉在故障上。
// 足够让人看到，但不会在上游已经恢复后还钉着。
const ERROR_TTL_MS = 15000;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function createTerminalTitle(deps = {}) {
  const processObj = deps.processObj || process;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const setTimeoutImpl = deps.setTimeout || setTimeout;
  const clearTimeoutImpl = deps.clearTimeout || clearTimeout;

  const frames = resolveSpinnerFrames(processObj.platform);
  const spinnerIntervalMs = Math.max(50, Number(deps.spinnerIntervalMs) || SPINNER_INTERVAL_MS);
  const busyTtlMs = Math.max(0, Number(deps.busyTtlMs) || BUSY_TTL_MS);
  const errorTtlMs = Math.max(0, Number(deps.errorTtlMs) || ERROR_TTL_MS);
  const rotateIntervalMs = Math.max(0, Number(deps.rotateIntervalMs) || DEFAULT_ROTATE_INTERVAL_MS);

  // 抑制 / 取数都是**注入的**：门面不认 provider，也不读全局状态。
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => true;
  const isSuppressed = typeof deps.isSuppressed === 'function' ? deps.isSuppressed : () => false;
  const collectContext = typeof deps.collectContext === 'function' ? deps.collectContext : () => ({});

  const registry = getTitleSourceRegistry(deps);
  const transport = deps.transport || resolveTitleTransport({ processObj });

  let spinnerTimer = null;
  let errorTimer = null;
  let rotateTimer = null;
  let frameIndex = 0;
  let rotateIndex = 0;
  let busyUntil = 0;
  let errorIcon = '';
  let errorUntil = 0;
  let lastWritten = '';
  let cachedFrames = [];
  let stopped = false;

  function isBusy() {
    return busyUntil > 0 && now() < busyUntil;
  }

  // 错误态同样有保质期：到点自动消失，不靠用户输入才能脱离。
  function activeErrorIcon() {
    if (!errorIcon) return '';
    if (errorUntil > 0 && now() >= errorUntil) {
      errorIcon = '';
      errorUntil = 0;
      return '';
    }
    return errorIcon;
  }

  // 每帧自己就是一条完整标题：来源产出的帧直接显示，不与其他帧拼接。
  function refreshFrames() {
    try {
      cachedFrames = registry.collectFrames(collectContext() || {});
    } catch (_error) {
      cachedFrames = [];
    }
    if (rotateIndex >= cachedFrames.length) rotateIndex = 0;
    return cachedFrames;
  }

  function currentText() {
    const frame = pickFrame(cachedFrames, rotateIndex);
    if (!frame) return '';
    const icon = sanitizeTitleText(activeErrorIcon(), 8);
    if (icon) return `${icon} ${frame}`;
    if (!isBusy()) return frame;
    const index = Math.abs(Math.trunc(frameIndex) || 0) % frames.length;
    return `${frames[index]} ${frame}`;
  }

  function writeTitle(text) {
    if (typeof transport.writeTitle !== 'function') return;
    transport.writeTitle(text);
  }

  // 事件落点：任何状态变化都走这里。内容没变就不写。
  function render() {
    if (stopped || !isEnabled() || isSuppressed()) return;
    refreshFrames();
    const text = currentText();
    if (!text || text === lastWritten) return;
    lastWritten = text;
    writeTitle(text);
  }

  // 轮播：只在**多于一个**可轮播帧时启动。单帧时定时器纯属空转，且会让
  // 「内容没变不写」的去重失去意义。
  function syncRotateTimer() {
    if (rotateTimer) {
      clearIntervalImpl(rotateTimer);
      rotateTimer = null;
    }
    if (stopped || cachedFrames.length <= 1 || rotateIntervalMs <= 0) return;
    if (!isEnabled() || isSuppressed()) return;
    rotateTimer = setIntervalImpl(() => {
      if (stopped || isSuppressed() || !isEnabled()) return;
      // 帧集合可能因为账号切换 / 用量刷新而变长变短，每个节拍重新取一次。
      refreshFrames();
      if (cachedFrames.length <= 1) {
        syncRotateTimer();
        render();
        return;
      }
      rotateIndex = (rotateIndex + 1) % cachedFrames.length;
      render();
    }, rotateIntervalMs);
    if (rotateTimer && typeof rotateTimer.unref === 'function') rotateTimer.unref();
  }

  // 错误 TTL 到点时重绘一次，把图标撞下去。用单个定时器（而非轮询）：
  // 它只在真的有错误时存在，到点自己清掉。
  function syncErrorTimer() {
    if (errorTimer) {
      clearTimeoutImpl(errorTimer);
      errorTimer = null;
    }
    if (!errorIcon || errorUntil <= 0) return;
    const delay = Math.max(0, errorUntil - now());
    errorTimer = setTimeoutImpl(() => {
      errorTimer = null;
      render();
    }, delay);
    if (errorTimer && typeof errorTimer.unref === 'function') errorTimer.unref();
  }

  // 转圈只在生成中运行。每个节拍都复查 busy——子进程静下来之后没人会再显式调用
  // markIdle()，定时器必须自己退出，否则「空闲时转圈还在转」。
  function syncSpinnerTimer() {
    if (isBusy()) {
      if (spinnerTimer) return;
      spinnerTimer = setIntervalImpl(() => {
        if (!isBusy()) {
          syncSpinnerTimer();
          // 回合结束（子进程静下来）——网关路由观测正在此刻可能刚刚到达，
          // 所以这里重算而不只是重绘。
          refresh();
          return;
        }
        frameIndex += 1;
        render();
      }, spinnerIntervalMs);
      if (spinnerTimer && typeof spinnerTimer.unref === 'function') spinnerTimer.unref();
      return;
    }
    if (spinnerTimer) {
      clearIntervalImpl(spinnerTimer);
      spinnerTimer = null;
    }
  }

  // 会话启动：写一次当前状态即可，之后都由事件推动。
  function start() {
    if (stopped) return false;
    render();
    syncRotateTimer();
    return true;
  }

  // 事件：子进程有输出 → 这一回合正在生成。持续输出会不断续期。
  function markBusy(options = {}) {
    const requested = Number(options.ttlMs);
    const ttl = Number.isFinite(requested) ? requested : busyTtlMs;
    busyUntil = now() + Math.max(0, ttl);
    syncSpinnerTimer();
    render();
  }

  // 事件：回合结束 / 用户接管 → 生成态结束。
  //
  // 这里同时重算轮播帧：网关模式的**路由观测是异步到达的**（服务端选完号
  // 才落盘），而回合结束正是它到达的时刻——不在这里重算，那一帧就永远
  // 进不了标题。这不是轮询：它由“回合结束”这个事件触发。
  function markIdle() {
    busyUntil = 0;
    syncSpinnerTimer();
    refresh();
  }

  // 事件：中断 / 上游错误出现。立刻可见，不等任何节拍。只接图标——故障类别由
  // 识别方（labels.js 的 detectFailure）决定用哪个。带 TTL：到点自动消失。
  function setError(icon, options = {}) {
    const next = sanitizeTitleText(icon, 8);
    const requested = Number(options.ttlMs);
    const ttl = Number.isFinite(requested) ? requested : errorTtlMs;
    if (next === errorIcon && next) return;
    errorIcon = next;
    errorUntil = next ? now() + Math.max(0, ttl) : 0;
    syncErrorTimer();
    render();
  }

  function clearError() {
    setError('');
  }

  // 事件：用量 / 账号 / 会话名 / 路由变了（由各自的来源在变化时调用）。
  function refresh() {
    render();
    syncRotateTimer();
  }

  function stop() {
    stopped = true;
    if (spinnerTimer) {
      clearIntervalImpl(spinnerTimer);
      spinnerTimer = null;
    }
    if (errorTimer) {
      clearTimeoutImpl(errorTimer);
      errorTimer = null;
    }
    if (rotateTimer) {
      clearIntervalImpl(rotateTimer);
      rotateTimer = null;
    }
  }

  // 会话退出：清掉标题，把命名权还给终端自己。这是**有意**写空标题，不能走
  // buildTitleSequence（那条路径对空内容返回空串）。
  function reset() {
    if (!lastWritten) return;
    lastWritten = '';
    if (typeof transport.clearTitle === 'function') transport.clearTitle();
  }

  return {
    start,
    stop,
    reset,
    refresh,
    markBusy,
    markIdle,
    setError,
    clearError,
    isBusy,
    currentText,
    // 诊断面：当前轮播帧与所用通道（`aih <cli> --help` 之外的排查入口）。
    currentFrames: () => cachedFrames.slice(),
    transportId: () => String(transport.id || ''),
    buildSequence: buildTitleSequence
  };
}

module.exports = {
  DEFAULT_ROTATE_INTERVAL_MS,
  createTerminalTitle,
  // 兼容既有调用点：这些纯函数曾经由 terminal-title.js 直接导出。
  buildTitleSequence,
  sanitizeTitleText,
  resolveSpinnerFrames,
  SPINNER_INTERVAL_MS,
  BUSY_TTL_MS,
  ERROR_TTL_MS,
  normalizeText
};
