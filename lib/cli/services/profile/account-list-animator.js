'use strict';

// `aih ls` / `aih <provider> ls` 的运行中账号动画前缀。
//
// 数据源是 server 周期性落盘的 run/account-activity.json（1s 原子写），
// 与 server 内存中的 per-account in-flight/rate 一致。TTY 下 Braille 转圈，
// 转速按账号 rate（最近 10s 请求数）缩放；非 TTY 退化为静态 ●/- 标记。
//
// 重绘是**逐行增量**的：首帧清一次屏，之后只重写变化的行（见 redraw）。
// 早先是 10 次/秒整屏清屏重画，即使内容没变也照画——终端上就是持续屏闪。

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAMES_ASCII = ['|', '/', '-', '\\'];
const TICK_MS = 100;
const MAX_FRAME_STEP = 4;
const ACTIVITY_FILE = 'account-activity.json';
const ACTIVITY_READ_INTERVAL_MS = 500;

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
// refreshLines() 可选：返回重建后的行数，用于周期刷新行内容（状态/用量）。
// 返回 stop() + onQuit(handler)；真实 TTY 下监听 q/Q/Esc/Ctrl+C 退出（Esc 带延迟防误触）。
function runAnimatedList(options = {}) {
  const {
    renderLine,
    lineCount,
    readActivity,
    processObj,
    onExit,
    refreshLines
  } = options;
  const stdout = processObj.stdout;
  const animated = Boolean(stdout && typeof stdout.write === 'function' && stdout.isTTY);
  const frames = resolveFrames(processObj.platform);
  // 保活：真实 CLI 由 stdin.resume() 维持进程（等 Ctrl+C）；无 stdin 的环境
  // （测试/管道）让 timer unref，避免进程被动画挂住。
  const keepAlive = options.keepAlive !== false;

  if (!animated) return null;

  const stdin = processObj.stdin || {};
  const stdinInteractive = Boolean(
    stdin.isTTY
    && typeof stdin.setRawMode === 'function'
    && typeof stdin.on === 'function'
    && typeof stdin.resume === 'function'
  );
  const wasRaw = !!stdin.isRaw;

  const frameIndexes = new Array(lineCount).fill(0);
  let count = lineCount;
  let stopped = false;
  let ticker = null;
  let refreshTimer = null;
  let quitHandlers = [];
  let pendingInput = '';
  let pendingEscapeTimer = null;
  const escapeDelayMs = Math.max(80, Number(options.escapeDelayMs) || 500);

  // 逐行增量重绘：整屏「清屏 + 重画」10 次/秒在多数终端上就是肉眼可见的屏闪，
  // 而且实测 6 秒 60 帧里有 40 帧内容完全没变 —— 那些重画纯属自找的闪。现在：
  //   1. 内容没变就不写；只有真的有账号在转圈时才推进帧；
  //   2. 只重写变化的行，绝对定位 + 行尾擦除，不再整屏清；
  //   3. 整段写入包在 DECSET 2026（同步更新）里，终端支持就不撕裂，不支持则忽略；
  //   4. 行数变化 / 列表比屏幕还高时才退回「从头部重写」。
  const SYNC_BEGIN = '\x1b[?2026h';
  const SYNC_END = '\x1b[?2026l';
  let paintedLines = null;
  let activityCache = null;
  let activityReadAt = 0;

  function readActivitiesThrottled(nowMs) {
    // 活动文件 1s 才落盘一次，100ms 读一次纯属浪费；转圈帧照常按 tick 推进。
    if (activityCache && nowMs - activityReadAt < ACTIVITY_READ_INTERVAL_MS) return activityCache;
    activityCache = readActivity();
    activityReadAt = nowMs;
    return activityCache;
  }

  function sameLines(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return false;
    }
    return true;
  }

  function redraw(mode = {}) {
    if (stopped && !mode.static) return;
    const activities = readActivitiesThrottled(Date.now());
    const next = new Array(count);
    const staticFrame = mode.static === true;
    for (let i = 0; i < count; i += 1) {
      const activity = options.activityOfRow ? options.activityOfRow(activities, i) : null;
      const step = frameStepFor(activity);
      if (!staticFrame && step > 0) {
        frameIndexes[i] = (frameIndexes[i] + step) % frames.length;
      }
      const frame = staticFrame ? null : (activity ? frames[frameIndexes[i]] : null);
      next[i] = renderLine(renderPrefix(activity, frame), i);
    }
    // 内容没变就一个字节都不写（转圈推进后行文本会变，仍然照常更新）。
    if (paintedLines && sameLines(next, paintedLines)) return;

    // 列表比屏幕高时，顶部若干行已经滚进回滚缓冲区：只能就地更新**可见部分**，
    // 否则每帧从头重写整屏 = 刷屏。屏幕行号 = 列表行号 - 滚出屏幕的行数。
    const screenRows = Number(stdout.rows);
    const hasScreenRows = Number.isFinite(screenRows) && screenRows > 0;
    const scrolledOff = hasScreenRows ? Math.max(0, next.length - (screenRows - 1)) : 0;
    // 终端高度未知时无法判断有没有滚屏，稳妥起见退回"从头部重写"（仍旧不清屏）。
    const canUpdateInPlace = Boolean(paintedLines)
      && next.length === paintedLines.length
      && hasScreenRows;

    try {
      stdout.write(SYNC_BEGIN);
      if (!paintedLines) {
        // 第一帧：接管整屏（本来就要清掉 shell 留下的内容）。
        stdout.write('\x1b[H\x1b[J');
        stdout.write(next.map((line) => `${line}\n`).join(''));
      } else if (canUpdateInPlace) {
        // 只重写变化的行；滚出可见区的行改不了（也不该为此重画整屏）。
        let touched = false;
        for (let i = scrolledOff; i < next.length; i += 1) {
          if (next[i] === paintedLines[i]) continue;
          stdout.write(`\x1b[${i - scrolledOff + 1};1H${next[i]}\x1b[K`);
          touched = true;
        }
        if (touched) {
          const lastVisible = next.length - scrolledOff;
          const parkRow = hasScreenRows ? Math.min(screenRows, lastVisible + 1) : lastVisible + 1;
          stdout.write(`\x1b[${parkRow};1H`);
        }
      } else {
        // 行数变了：从头部重写全部行，多出来的旧行擦掉。
        stdout.write('\x1b[H');
        stdout.write(next.map((line) => `${line}\x1b[K\n`).join(''));
        if (next.length < paintedLines.length) stdout.write('\x1b[J');
      }
    } finally {
      // 同步更新的结束标记必须发出去：支持 DECSET 2026 的终端会一直压住画面直到它到达。
      try { stdout.write(SYNC_END); } catch (_error) {}
      paintedLines = next;
    }
  }

  function refresh() {
    if (stopped || typeof refreshLines !== 'function') return;
    const nextCount = refreshLines();
    if (!Number.isInteger(nextCount) || nextCount < 0) return;
    count = nextCount;
    if (frameIndexes.length !== count) {
      frameIndexes.length = count;
      frameIndexes.fill(0);
    }
    redraw();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (pendingEscapeTimer) clearTimeout(pendingEscapeTimer);
    pendingEscapeTimer = null;
    if (stdinInteractive) {
      try { stdin.off('data', onData); } catch (_error) {}
      try { stdin.setRawMode(wasRaw); } catch (_error) {}
    }
    if (typeof onExit === 'function') onExit();
  }

  function handleAction(action) {
    if (action !== 'quit') return;
    stop();
    quitHandlers.forEach((handler) => {
      try { handler(); } catch (_error) {}
    });
  }

  function consumePendingInput(allowBareEscape = false) {
    while (pendingInput && !stopped) {
      const parsed = parseListKey(pendingInput, { allowBareEscape });
      if (parsed.pending) {
        if (pendingInput === '\x1b' && !pendingEscapeTimer) {
          pendingEscapeTimer = setTimeout(() => {
            pendingEscapeTimer = null;
            consumePendingInput(true);
          }, escapeDelayMs);
        }
        return;
      }
      if (pendingEscapeTimer) {
        clearTimeout(pendingEscapeTimer);
        pendingEscapeTimer = null;
      }
      pendingInput = parsed.rest;
      handleAction(parsed.action);
    }
  }

  function onData(chunk) {
    const key = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (!key || stopped) return;
    if (pendingEscapeTimer) {
      clearTimeout(pendingEscapeTimer);
      pendingEscapeTimer = null;
    }
    pendingInput += key;
    consumePendingInput(false);
  }

  redraw();
  ticker = setInterval(redraw, TICK_MS);
  if (!keepAlive && typeof ticker.unref === 'function') ticker.unref();
  if (typeof refreshLines === 'function') {
    refreshTimer = setInterval(refresh, Math.max(300, Number(options.refreshIntervalMs) || 1000));
    if (!keepAlive && typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }
  if (stdinInteractive) {
    try {
      stdin.setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
    } catch (_error) {}
  }
  return {
    stop,
    // 退出前把转圈定格成静态标记：只走增量重绘，不整屏清，避免退出瞬间闪一下。
    renderStatic: () => redraw({ static: true }),
    onQuit: (handler) => { if (typeof handler === 'function') quitHandlers.push(handler); }
  };
}

// q/Q/Esc/Ctrl+C 退出；Esc 需要延迟确认（方向键序列以 \x1b 开头，避免误退）。
function parseListKey(input, options = {}) {
  const text = String(input || '');
  if (!text) return { pending: false, action: '', rest: '' };
  const first = text[0];

  if (first === '\x1b') {
    if (text.length === 1) {
      return options.allowBareEscape
        ? { pending: false, action: 'quit', rest: '' }
        : { pending: true, action: '', rest: text };
    }
    if (/^\x1b\[[0-9;?]*$/.test(text)) {
      return { pending: true, action: '', rest: text };
    }
    const csi = text.match(/^\x1b\[[0-9;?]*([A-Za-z~])/);
    if (csi) return { pending: false, action: '', rest: text.slice(csi[0].length) };
    const ss3 = text.match(/^\x1bO([A-Za-z])/);
    if (ss3) return { pending: false, action: '', rest: text.slice(ss3[0].length) };
    if (text === '\x1bO') return { pending: true, action: '', rest: text };
    return { pending: false, action: '', rest: text.slice(1) };
  }

  if (first === '\x03') return { pending: false, action: 'quit', rest: text.slice(1) };
  if (first === 'q' || first === 'Q') return { pending: false, action: 'quit', rest: text.slice(1) };
  return { pending: false, action: '', rest: text.slice(1) };
}

module.exports = {
  SPINNER_FRAMES,
  TICK_MS,
  readAccountActivity,
  activityOf,
  frameStepFor,
  renderPrefix,
  runAnimatedList,
  parseListKey
};