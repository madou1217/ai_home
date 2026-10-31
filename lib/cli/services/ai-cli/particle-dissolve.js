'use strict';

/**
 * 终端里的"粒子消散"动画：把一行文字逐步打散成粒子并淡出。
 *
 * 设计约束：
 *   - 只做 6~8 帧、每帧 55~70ms，总共 < 500ms，不阻塞输入循环太久；
 *   - 每帧的显示宽度与原始行一致（用空格补齐），避免把后面的列顶歪；
 *   - 非 TTY / CI / 关闭动画时直接返回 []，调用方退化成"立即删除"。
 */

const PARTICLES = Object.freeze(['·', '˙', '∙', '✦', '✧', '⁺', '˚']);
const DEFAULT_FRAMES = 7;
const DEFAULT_INTERVAL_MS = 60;

function charWidth(code) {
  if (code < 0x1100) return 1;
  if (code <= 0x115f) return 2;
  if (code === 0x2329 || code === 0x232a) return 2;
  if (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) return 2;
  if (code >= 0xac00 && code <= 0xd7a3) return 2;
  if (code >= 0xf900 && code <= 0xfaff) return 2;
  if (code >= 0xfe30 && code <= 0xfe6f) return 2;
  if (code >= 0xff00 && code <= 0xff60) return 2;
  if (code >= 0xffe0 && code <= 0xffe6) return 2;
  return 1;
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text || '')) width += charWidth(char.codePointAt(0));
  return width;
}

/** 第 frame 帧：保留的字符比例从 1 线性降到 0，其余位置变成粒子。 */
function dissolveFrame(text, frame, frames = DEFAULT_FRAMES, seed = 1) {
  const chars = Array.from(String(text || ''));
  const keepRatio = Math.max(0, 1 - (frame + 1) / (frames + 1));
  let state = seed;
  const nextRandom = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return chars.map((char) => {
    if (char === ' ') return ' ';
    if (nextRandom() < keepRatio) return char;
    const particle = PARTICLES[Math.floor(nextRandom() * PARTICLES.length)] || '·';
    // 宽字符（中文）用「粒子 + 空格」保持列宽
    return charWidth(char.codePointAt(0)) === 2 ? `${particle} ` : particle;
  }).join('');
}

function dissolveFrames(text, options = {}) {
  const frames = Math.max(2, Number(options.frames) || DEFAULT_FRAMES);
  const seed = Number(options.seed) || (Date.now() % 9973);
  const out = [];
  for (let frame = 0; frame < frames; frame += 1) {
    out.push(dissolveFrame(text, frame, frames, seed + frame * 131));
  }
  return out;
}

function sleepSync(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (!duration) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
  } catch (_error) {
    const end = Date.now() + duration;
    while (Date.now() < end) { /* 忙等兜底 */ }
  }
}

/**
 * 就地播放：每帧用 \r + 清行重写同一行，播完再清一次。
 * 调用方负责保证光标在独立的一行（列表渲染完之后）。
 */
function playDissolve(write, text, options = {}) {
  const value = String(text || '').trimEnd();
  if (!value) return;
  const frames = dissolveFrames(value, options);
  const interval = Math.max(16, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  for (const frame of frames) {
    write(`\r\x1b[2K${frame}`);
    sleepSync(interval);
  }
  write('\r\x1b[2K');
}

module.exports = {
  DEFAULT_FRAMES,
  DEFAULT_INTERVAL_MS,
  dissolveFrame,
  dissolveFrames,
  displayWidth,
  playDissolve,
  sleepSync
};
