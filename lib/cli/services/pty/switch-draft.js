'use strict';

// 换号时保留用户正在输入的内容。
//
// 原生 TUI 把草稿保存在**子进程内存**里；换号必须杀进程重开，草稿本来会丢。
// aih 是 stdin 的转发者，能看到的只有用户按下的原始字节，因此这里按「最后一次
// 回车之后的输入」做一份原样缓冲，换号后写回新 PTY。
//
// 为什么保留原始字节而不是只留可见文本：
//   - 退格、方向键、Ctrl+W 都是 TUI 自己解释的编辑操作，只留文本会得到错误的草稿；
//   - 原样回放让新 TUI 自己重建光标位置和编辑历史。
//
// 哪些输入会清空草稿：
//   - 回车/换行（消息已提交，不是草稿）；
//   - Ctrl+C / Ctrl+D（取消/退出意图，回放可能把新会话也关掉）；
//   - 单独的 Esc（TUI 常把它当取消；CSI 序列的 Esc 不算）。
// 括号粘贴（ESC[200~ … ESC[201~）里的换行是内容，不清空。

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const DEFAULT_MAX_BYTES = 64 * 1024;
const REPLAY_READY_DELAY_MS = 250;
const REPLAY_TIMEOUT_MS = 15000;

function toLatin1(data) {
  if (Buffer.isBuffer(data)) return data.toString('latin1');
  return Buffer.from(String(data == null ? '' : data), 'utf8').toString('latin1');
}

function createSwitchDraft(options = {}) {
  const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) > 0
    ? Math.floor(Number(options.maxBytes))
    : DEFAULT_MAX_BYTES;
  let buffer = '';
  let pasting = false;

  function clear() {
    buffer = '';
  }

  function append(text) {
    if (!text) return;
    buffer += text;
    if (buffer.length > maxBytes) buffer = buffer.slice(-maxBytes);
  }

  // 判断 ESC 是否是一个「完整的序列开头」。单独的 Esc 是取消；CSI / SS3 是
  // 方向键、Home/End 等编辑键，必须保留。
  function isEscapeSequenceStart(text, index) {
    const next = text[index + 1];
    if (next === '[' || next === 'O') return true;
    if (next === undefined) return false;
    // Alt+key 也是 ESC 开头，但它不是取消：保留。
    return next.charCodeAt(0) >= 0x20;
  }

  function observe(data) {
    const text = toLatin1(data);
    if (!text) return;
    let index = 0;
    while (index < text.length) {
      if (pasting) {
        const end = text.indexOf(PASTE_END, index);
        if (end < 0) {
          append(text.slice(index));
          return;
        }
        append(text.slice(index, end + PASTE_END.length));
        index = end + PASTE_END.length;
        pasting = false;
        continue;
      }

      if (text.startsWith(PASTE_START, index)) {
        append(PASTE_START);
        index += PASTE_START.length;
        pasting = true;
        continue;
      }

      const char = text[index];
      const code = char.charCodeAt(0);
      if (code === 0x03 || code === 0x04) {
        clear();
        index += 1;
        continue;
      }
      if (code === 0x0d || code === 0x0a) {
        clear();
        index += 1;
        continue;
      }
      if (code === 0x1b && !isEscapeSequenceStart(text, index)) {
        clear();
        index += 1;
        continue;
      }
      append(char);
      index += 1;
    }
  }

  function take() {
    const value = buffer;
    buffer = '';
    return value;
  }

  return {
    observe,
    take,
    clear,
    peek: () => buffer,
    size: () => buffer.length
  };
}

/**
 * 新 PTY 就绪后再写回草稿。
 *
 * `isReady()` 由运行时提供（通常是 hasReceivedData）。TUI 启动首帧之前写进去的
 * 按键经常被丢掉，所以先等首帧，再留一小段渲染时间。超时后放弃——宁可丢草稿，
 * 也不要把按键打到未知的启动提示上。
 *
 * @returns {{cancel: Function}|null}
 */
function scheduleDraftReplay(options = {}) {
  const draft = String(options.draft == null ? '' : options.draft);
  if (!draft) return null;
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const isReady = typeof options.isReady === 'function' ? options.isReady : () => true;
  const write = typeof options.write === 'function' ? options.write : () => {};
  const schedule = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;
  const readyDelayMs = Number.isFinite(Number(options.readyDelayMs))
    ? Math.max(0, Number(options.readyDelayMs))
    : REPLAY_READY_DELAY_MS;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(0, Number(options.timeoutMs))
    : REPLAY_TIMEOUT_MS;
  const startedAt = Date.now();
  let timer = null;
  let finished = false;

  function cancel() {
    finished = true;
    if (timer !== null) cancelTimer(timer);
    timer = null;
  }

  function tick() {
    timer = null;
    if (finished || !isCurrent()) return;
    if (isReady()) {
      timer = schedule(() => {
        timer = null;
        if (finished || !isCurrent()) return;
        finished = true;
        try {
          write(draft);
        } catch (_error) {
          // 新 PTY 可能在等待期间退出：草稿写不进去就算了，不能因此抛到运行时。
        }
      }, Math.max(0, Math.min(readyDelayMs, 2000)));
      if (timer && typeof timer.unref === 'function') timer.unref();
      return;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      finished = true;
      return;
    }
    timer = schedule(tick, 200);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  timer = schedule(tick, 200);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { cancel };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  createSwitchDraft,
  scheduleDraftReplay
};
