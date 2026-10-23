'use strict';

// 交互式 PTY 会话的终端标题（OSC 0）：多会话时的**状态指示器**。
//
// 目标：同时开着多个 `aih <cli>` 标签时，扫一眼标签栏就知道每个会话在干什么。
// 标题因此是「状态图标 + 身份」的一行：
//
//   ⠋ Cline:1:deepseek-v4.1-flash · 91%    ← 生成中
//   Cline:1:deepseek-v4.1-flash · 91%       ← 空闲（无图标 = 常态）
//   ⚠ Cline:1:deepseek-v4.1-flash           ← 出错
//
// 两条来自实际使用的约束：
//   - **不显示项目名**：同一项目的多个会话挂着同一个目录名，既占宽又区分不了谁是谁；
//     真正把会话区分开的是「哪个账号、哪个模型」。会话段只在 provider 侧有真名字
//     （codex thread title 之类）时才出现。
//   - 状态一律用**图标**表达，不写「限流 / 网络错误」这类简写文本——标签栏里读文字
//     费劲，图标一眼就能看出「这个会话出事了」。空闲态不加任何常态标签（「已启用 /
//     已空闲」这类文案是噪音，见项目的 UI 约定）。
//
// 更新是**事件驱动**的：回合起停、用量刷新、账号切换、错误出现与消失，各自发生时才
// 重写标题；没有定时轮播。唯一的定时器是生成中的转圈动画（约 120ms 换帧），它由
// busy 状态驱动，属于动画而不是轮询。
//
// 通道约定：OSC 0（`ESC ] 0 ; <text> BEL`）只设置窗口 / 图标标题，不触碰屏幕缓冲区、
// 光标、滚动区或 SGR，因此对全屏 TUI 安全。aih 从 tmux 客户端的**外层**写 stdout，
// 字节直达终端；pane 内进程写的 OSC 0 会被 tmux 的 pane_title 截获，所以标题必须由
// aih 自己写。
//
// 本模块是 OSC 0 的唯一写者：usage-status-runtime 只提供账号 / 用量文本。

const SPINNER_INTERVAL_MS = 120;
// 子进程最后一次输出之后仍视为「生成中」的时间。TUI 在思考 / 流式输出时持续重绘，
// 等待输入时静止，因此短 TTL 足以把「停止」变成一个可观测的事件。
const BUSY_TTL_MS = 2000;
const SEPARATOR = ' · ';
const MAX_TITLE_LENGTH = 160;
// 分段限长：截断时先牺牲后面的段（用量 → 会话名），账号最不容易被吃掉。
const MAX_PART_LENGTH = Object.freeze({ session: 40, account: 56, usage: 16 });
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ASCII = ['|', '/', '-', '\\'];

// 标题文本里不能出现控制字符：OSC 0 以 BEL 结束，混入 \x07 会提前截断序列，
// 混入 \r\n 会让部分终端把标题拆成两行。
function sanitizeTitleText(value, maxLength = MAX_TITLE_LENGTH) {
  return String(value == null ? '' : value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
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

// 纯函数：把各部分拼成一行标题。身份（会话名 · 账号 · 用量）恒在，状态图标按
// 「出错 > 生成中 > 空闲」的优先级取一个。出错时**只留图标**，不写错误文案：
// 具体原因在会话屏幕里看得更清楚，标签栏只要传达「这个出事了」。
function composeTerminalTitle(input = {}) {
  const session = sanitizeTitleText(input.sessionLabel, MAX_PART_LENGTH.session);
  const account = sanitizeTitleText(input.accountLabel, MAX_PART_LENGTH.account);
  const usage = sanitizeTitleText(input.usageLabel, MAX_PART_LENGTH.usage);
  const body = [session, account].filter(Boolean).join(SEPARATOR);
  if (!body) return '';
  const tail = usage ? SEPARATOR + usage : '';

  const errorIcon = sanitizeTitleText(input.errorIcon, 8);
  if (errorIcon) return `${errorIcon} ${body}${tail}`;

  if (input.busy) {
    const frames = Array.isArray(input.frames) && input.frames.length > 0 ? input.frames : SPINNER_FRAMES;
    const index = Math.abs(Number(input.frame) || 0) % frames.length;
    return `${frames[index]} ${body}${tail}`;
  }
  return `${body}${tail}`;
}

function createTerminalTitle(deps = {}) {
  const processObj = deps.processObj || process;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const frames = resolveSpinnerFrames(processObj.platform);
  const spinnerIntervalMs = Math.max(50, Number(deps.spinnerIntervalMs) || SPINNER_INTERVAL_MS);
  const busyTtlMs = Math.max(0, Number(deps.busyTtlMs) || BUSY_TTL_MS);
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => true;
  const isSuppressed = typeof deps.isSuppressed === 'function' ? deps.isSuppressed : () => false;
  const getSessionLabel = typeof deps.getSessionLabel === 'function' ? deps.getSessionLabel : () => '';
  const getAccountLabel = typeof deps.getAccountLabel === 'function' ? deps.getAccountLabel : () => '';
  const getUsageLabel = typeof deps.getUsageLabel === 'function' ? deps.getUsageLabel : () => '';

  let spinnerTimer = null;
  let frameIndex = 0;
  let busyUntil = 0;
  let errorIcon = '';
  let lastWritten = '';
  let stopped = false;

  function isBusy() {
    return busyUntil > 0 && now() < busyUntil;
  }

  function currentText() {
    return composeTerminalTitle({
      sessionLabel: getSessionLabel(),
      accountLabel: getAccountLabel(),
      usageLabel: getUsageLabel(),
      errorIcon,
      busy: isBusy(),
      frame: frameIndex,
      frames
    });
  }

  function writeTitle(text) {
    const stdout = processObj.stdout;
    if (!stdout || typeof stdout.write !== 'function') return;
    try { stdout.write(buildTitleSequence(text)); } catch (_error) {}
  }

  // 事件落点：任何状态变化都走这里。内容没变就不写（用量 watcher 会周期性触发，
  // 无去重会持续刷终端）。
  function render() {
    if (stopped || !isEnabled() || isSuppressed()) return;
    const text = currentText();
    if (!text || text === lastWritten) return;
    lastWritten = text;
    writeTitle(text);
  }

  // 转圈只在生成中运行。每个节拍都复查 busy——子进程静下来之后没人会再显式调用
  // markIdle()，定时器必须自己退出，否则「空闲时转圈还在转」。
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

  // 会话启动：写一次当前状态即可，之后都由事件推动。
  function start() {
    if (stopped) return false;
    render();
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
  function markIdle() {
    busyUntil = 0;
    syncSpinnerTimer();
    render();
  }

  // 事件：中断 / 上游错误出现。立刻可见，不等任何节拍。只接图标——故障类别由
  // 识别方（terminal-title-labels.js 的 detectFailure）决定用哪个。
  function setError(icon) {
    const next = sanitizeTitleText(icon, 8);
    if (next === errorIcon) return;
    errorIcon = next;
    render();
  }

  function clearError() {
    setError('');
  }

  // 事件：用量 / 账号 / 会话名变了（由各自的来源在变化时调用）。
  function refresh() {
    render();
  }

  function stop() {
    stopped = true;
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
  createTerminalTitle,
  composeTerminalTitle,
  buildTitleSequence,
  sanitizeTitleText,
  resolveSpinnerFrames,
  SPINNER_INTERVAL_MS,
  BUSY_TTL_MS,
  MAX_PART_LENGTH,
  SPINNER_FRAMES,
  SPINNER_FRAMES_ASCII
};
