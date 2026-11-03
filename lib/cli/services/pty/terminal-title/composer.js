'use strict';

// 纯函数层：帧 + 状态 → 一行标题文本 → OSC 序列。**不碰终端、不碰定时器、不做 I/O**。
//
// 分层的意义：轮播、抑制、去重、写终端都在门面里，这里只留「文本怎么拼」这一件事，
// 于是标题的排版规则可以被单独读、单独改，不会被终端细节缠住。

const SEPARATOR = ' · ';
const MAX_TITLE_LENGTH = 200;

const SPINNER_INTERVAL_MS = 120;
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

// 空标题是有意义的（退出时把命名权还给终端），但那条路径走门面的 reset() 显式写入，
// 这里的「拼一个非空标题」就不该产出空序列——否则调用方无从区分「没内容」与「有意清空」。
function buildTitleSequence(text) {
  const clean = sanitizeTitleText(text);
  return clean ? `\x1b]0;${clean}\x07` : '';
}

function resolveSpinnerFrames(platform) {
  return String(platform || '').trim() === 'win32' ? SPINNER_FRAMES_ASCII : SPINNER_FRAMES;
}

// 轮播取帧：越界一律取模，负索引也安全（调用方不必自己夹）。
function pickFrame(frames, index) {
  const list = Array.isArray(frames) ? frames.filter((frame) => sanitizeTitleText(frame)) : [];
  if (list.length === 0) return '';
  const at = Math.abs(Math.trunc(Number(index) || 0)) % list.length;
  return sanitizeTitleText(list[at]);
}

// 状态前缀：**出错 > 生成中 > 空闲**取一个。空闲态不加任何常态标签——「已启用 /
// 已空闲」这类文案是噪音（见项目的 UI 约定）。
// 出错时只留图标、不写错误文案：具体原因在会话屏幕里看得更清楚，标签栏只要传达
// 「这个出事了」。
function decorateTitleLine(text, state = {}) {
  const body = sanitizeTitleText(text);
  if (!body) return '';
  const errorIcon = sanitizeTitleText(state.errorIcon, 8);
  if (errorIcon) return `${errorIcon} ${body}`;
  if (!state.busy) return body;
  const frames = Array.isArray(state.frames) && state.frames.length > 0 ? state.frames : SPINNER_FRAMES;
  const index = Math.abs(Math.trunc(Number(state.frame) || 0)) % frames.length;
  return `${frames[index]} ${body}`;
}

// 一次渲染的完整产出：取当前帧 → 加状态前缀。空帧返回空串（门面据此不写标题）。
function composeTitleLine(frames, index, state = {}) {
  return decorateTitleLine(pickFrame(frames, index), state);
}

module.exports = {
  SEPARATOR,
  MAX_TITLE_LENGTH,
  SPINNER_INTERVAL_MS,
  SPINNER_FRAMES,
  SPINNER_FRAMES_ASCII,
  sanitizeTitleText,
  buildTitleSequence,
  resolveSpinnerFrames,
  pickFrame,
  decorateTitleLine,
  composeTitleLine
};
