'use strict';

// 交互式 PTY 会话的终端标题（OSC 0）内容策略。
//
// 背景：标题此前只承载账号用量标签（`[o:1:78%]` / `[a:1]`），同一个 provider 的
// 每个标签页因此完全一样，用户在 Warp / iTerm 的标签栏里无法区分会话。现在标题在
// 「当前会话名」与「当前账号」之间轮播，生成中叠加转圈帧，中断 / API 错误作为额外
// 的轮播项。
//
// 通道约定：OSC 0（`ESC ] 0 ; <text> BEL`）只设置窗口 / 图标标题，不触碰屏幕
// 缓冲区、光标、滚动区或 SGR，因此对全屏 TUI 安全（见 [[usage-in-terminal-title-not-screen]]
// 的约束）。aih 从 tmux 客户端的**外层**写 stdout，字节直达终端；pane 内进程写的
// OSC 0 才会被 tmux 的 pane_title 截获，所以标题必须由 aih 自己写。
//
// 本模块是 OSC 0 的唯一写者：usage-status-runtime 只提供账号 / 用量文本。

const CYCLE_INTERVAL_MS = 5000;
const SPINNER_INTERVAL_MS = 120;
// 子进程最后一次输出之后仍视为「生成中」的时间。TUI 在思考 / 流式输出时持续重绘，
// 等待输入时静止，因此短 TTL 足以区分两种状态，又不会被单帧抖动打断。
const BUSY_TTL_MS = 2000;
const MAX_TITLE_LENGTH = 160;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ASCII = ['|', '/', '-', '\\'];

// 标题文本里不能出现控制字符：OSC 0 以 BEL 结束，混入 \x07 会提前截断序列，
// 混入 \r\n 会让部分终端把标题拆成两行。
function sanitizeTitleText(value) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

// 空标题是有意义的（退出时把命名权还给终端），但那条路径走 reset() 的显式写入，
// 这里的「拼一个非空标题」就不该产出空序列——否则调用方无从区分「没内容」与
// 「有意清空」。
function buildTitleSequence(text) {
  const clean = sanitizeTitleText(text);
  return clean ? `\x1b]0;${clean}\x07` : '';
}

function resolveSpinnerFrames(platform) {
  return String(platform || '').trim() === 'win32' ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES;
}

// 循环项固定为「会话名 → 账号」，错误态作为附加项追加在最后（用户要求：中断 /
// API 错误也进这个循环）。任一来源为空就跳过，绝不写空标题——空标题会让终端回落到
// 自己的默认命名，那正是「所有标签页长得一样」的成因。
function createTerminalTitleCycler(deps = {}) {
  const processObj = deps.processObj || process;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const frames = resolveSpinnerFrames(processObj.platform);
  const cycleIntervalMs = Math.max(500, Number(deps.cycleIntervalMs) || CYCLE_INTERVAL_MS);
  const spinnerIntervalMs = Math.max(50, Number(deps.spinnerIntervalMs) || SPINNER_INTERVAL_MS);
  const busyTtlMs = Math.max(0, Number(deps.busyTtlMs) || BUSY_TTL_MS);
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => true;
  const isSuppressed = typeof deps.isSuppressed === 'function' ? deps.isSuppressed : () => false;
  const getSessionLabel = typeof deps.getSessionLabel === 'function' ? deps.getSessionLabel : () => '';
  const getAccountLabel = typeof deps.getAccountLabel === 'function' ? deps.getAccountLabel : () => '';

  let cycleTimer = null;
  let spinnerTimer = null;
  let cycleIndex = 0;
  let frameIndex = 0;
  let busyUntil = 0;
  let errorLabel = '';
  let lastWritten = '';
  let stopped = false;

  function isBusy() {
    return busyUntil > 0 && now() < busyUntil;
  }

  function items() {
    const list = [];
    const session = sanitizeTitleText(getSessionLabel());
    if (session) list.push(session);
    const account = sanitizeTitleText(getAccountLabel());
    if (account) list.push(account);
    const error = sanitizeTitleText(errorLabel);
    if (error) list.push(error);
    return list;
  }

  function currentText() {
    const list = items();
    if (list.length === 0) return '';
    // cycleIndex 只做「前进」，取模保证它在项数变化时仍然落在合法范围；项数改变
    // （错误项加入 / 撤下）时不让位置突兀地跳到别处。
    if (cycleIndex >= list.length) cycleIndex = 0;
    const item = list[cycleIndex];
    if (!isBusy()) return item;
    return `${frames[Math.abs(frameIndex) % frames.length]} ${item}`;
  }

  function writeTitle(text) {
    const stdout = processObj.stdout;
    if (!stdout || typeof stdout.write !== 'function') return;
    try { stdout.write(buildTitleSequence(text)); } catch (_error) {}
  }

  function render(force = false) {
    if (stopped || !isEnabled() || isSuppressed()) return;
    const text = currentText();
    if (!text) return;
    if (!force && text === lastWritten) return;
    lastWritten = text;
    writeTitle(text);
  }

  // 转圈只在生成中运行：空闲时让标题静止，不制造无谓的重写。
  // 每个节拍都复查 busy——子进程静下来之后没人会再显式调用 markIdle()，
  // 定时器必须自己退出，否则「空闲时转圈还在转」。
  function syncSpinnerTimer() {
    if (isBusy()) {
      if (spinnerTimer) return;
      spinnerTimer = setIntervalImpl(() => {
        if (!isBusy()) {
          syncSpinnerTimer();
          // 转圈停下时把帧前缀撤掉，回到纯文本标题。
          render();
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

  function start() {
    if (stopped || cycleTimer) return false;
    cycleTimer = setIntervalImpl(() => {
      cycleIndex += 1;
      render();
    }, cycleIntervalMs);
    if (cycleTimer && typeof cycleTimer.unref === 'function') cycleTimer.unref();
    render(true);
    return true;
  }

  function markBusy(options = {}) {
    const requested = Number(options.ttlMs);
    const ttl = Number.isFinite(requested) ? requested : busyTtlMs;
    busyUntil = now() + Math.max(0, ttl);
    syncSpinnerTimer();
    render();
  }

  function markIdle() {
    busyUntil = 0;
    syncSpinnerTimer();
    render();
  }

  function setError(text) {
    const next = sanitizeTitleText(text);
    if (next === errorLabel) return;
    errorLabel = next;
    // 错误是刚发生的事件，立即切到它，不等下一个循环节拍。清除时回到第一项
    // （会话名）——那也是用户最常需要看的身份。
    const list = items();
    cycleIndex = next ? Math.max(0, list.length - 1) : 0;
    render(true);
  }

  function clearError() {
    setError('');
  }

  // 账号 / 用量数字变了就重绘；内容没变就什么都不写（idle watcher 每 900ms 调一次，
  // 无去重会持续刷终端）。
  function refresh() {
    render();
  }

  function stop() {
    stopped = true;
    if (cycleTimer) {
      clearIntervalImpl(cycleTimer);
      cycleTimer = null;
    }
    if (spinnerTimer) {
      clearIntervalImpl(spinnerTimer);
      spinnerTimer = null;
    }
  }

  // 会话退出：清掉标题，把命名权还给终端自己。这是**有意**写空标题，不能走
  // buildTitleSequence（那条路径对空内容返回空串）。
  function reset() {
    if (!lastWritten) return;
    lastWritten = '';
    const stdout = processObj.stdout;
    if (stdout && typeof stdout.write === 'function') {
      try { stdout.write('\x1b]0;\x07'); } catch (_error) {}
    }
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
    buildSequence: buildTitleSequence
  };
}

module.exports = {
  createTerminalTitleCycler,
  buildTitleSequence,
  sanitizeTitleText,
  resolveSpinnerFrames,
  CYCLE_INTERVAL_MS,
  SPINNER_INTERVAL_MS,
  BUSY_TTL_MS,
  SPINNER_FRAMES,
  SPINNER_FRAMES_ASCII
};
