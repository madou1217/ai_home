'use strict';

// `aih ls` / `aih <provider> ls` 的运行中账号动画前缀。
//
// 数据源是 server 周期性落盘的 run/account-activity.json（1s 原子写），
// 与 server 内存中的 per-account in-flight/rate 一致。TTY 下整屏重绘 Braille
// 转圈，转速按账号 rate（最近 10s 请求数）缩放；非 TTY 退化为静态 ●/- 标记。

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ASCII = ['|', '/', '-', '\\'];
const TICK_MS = 100;
const MAX_FRAME_STEP = 4;
const ACTIVITY_FILE = 'account-activity.json';

function resolveFrames(platform) {
  return platform === 'win32' ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES;
}

function readAccountActivity(aiHomeDir, fs) {
  const activities = new Map();
  try {
    const raw = fs.readFileSync(`${aiHomeDir}/run/${ACTIVITY_FILE}`, 'utf8');
    const parsed = JSON.parse(raw);
    const accounts = parsed && parsed.accounts;
    if (!accounts || typeof accounts !== 'object') return activities;
    for (const [key, value] of Object.entries(accounts)) {
      const ref = String(value && value.accountRef || '').trim();
      const inFlight = Math.max(0, Number(value && value.inFlight) || 0);
      const rate = Math.max(0, Number(value && value.rate) || 0);
      if (!ref) continue;
      activities.set(key, { accountRef: ref, inFlight, rate });
    }
  } catch (_error) {
    // 文件不存在/损坏（server 未运行或首次落盘前）→ 全部视为空闲。
  }
  return activities;
}

function activityOf(activities, provider, accountRef) {
  const key = `${String(provider || '').trim().toLowerCase()}:${accountRef}`;
  const activity = activities.get(key);
  if (!activity || activity.inFlight <= 0) return null;
  return activity;
}

// 每账号帧推进步长：rate 越高每次 tick 跳的帧越多（视觉上转得更猛）。
function frameStepFor(activity) {
  if (!activity) return 0;
  return Math.max(1, Math.min(MAX_FRAME_STEP, Math.ceil(activity.rate / 3)));
}

// 前缀渲染：动画帧 / 静态运行标记 / 空闲横线。宽度固定 4 列，行内位置不动。
function renderPrefix(activity, frame, options = {}) {
  const staticMarker = options.staticMarker !== undefined ? options.staticMarker : '●';
  if (!activity) return '  - ';
  if (frame === null) return `  ${staticMarker} `;
  return `  ${frame} `;
}

// 整屏动画：renderLine(prefix, lineIndex) 返回该行当前帧下的完整文本。
// 返回 stop()，调用方在 SIGINT / 完成时调用。
function runAnimatedList(options = {}) {
  const {
    renderLine,
    lineCount,
    readActivity,
    processObj,
    onExit
  } = options;
  const stdout = processObj.stdout;
  const animated = Boolean(stdout && typeof stdout.write === 'function' && stdout.isTTY);
  const frames = resolveFrames(processObj.platform);
  // 保活：真实 CLI 由 stdin.resume() 维持进程（等 Ctrl+C）；无 stdin 的环境
  // （测试/管道）让 timer unref，避免进程被动画挂住。
  const keepAlive = options.keepAlive !== false;

  if (!animated) return null;

  const frameIndexes = new Array(lineCount).fill(0);
  let stopped = false;
  let ticker = null;

  function redraw() {
    if (stopped) return;
    const activities = readActivity();
    stdout.write('\x1b[H\x1b[J');
    for (let i = 0; i < lineCount; i += 1) {
      const activity = options.activityOfRow ? options.activityOfRow(activities, i) : null;
      const step = frameStepFor(activity);
      if (step > 0) frameIndexes[i] = (frameIndexes[i] + step) % frames.length;
      const frame = activity ? frames[frameIndexes[i]] : null;
      stdout.write(`${renderLine(renderPrefix(activity, frame), i)}\n`);
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (typeof onExit === 'function') onExit();
  }

  redraw();
  ticker = setInterval(redraw, TICK_MS);
  if (!keepAlive && typeof ticker.unref === 'function') ticker.unref();
  return { stop };
}

module.exports = {
  SPINNER_FRAMES,
  TICK_MS,
  readAccountActivity,
  activityOf,
  frameStepFor,
  renderPrefix,
  runAnimatedList
};