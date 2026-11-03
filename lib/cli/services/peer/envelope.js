'use strict';

// aih peer 的**单行信封**。
//
// 注入通道只有「往输入框敲一行字 + Enter」这一种表达能力（见
// `persistent-session.js:buildSendKeysCommands`：字面量一条、Enter 一条）。所以
// 信封必须压成一行，并且自带三件收件方需要的信息：
//
//   1. 这是别的会话发来的，不是用户手打；
//   2. 谁发的；
//   3. 怎么回（msg-id + 完整命令）。
//
// 真实换行会被 TUI 当成提前提交，破坏「字面量 + 单独 Enter」的约束，所以正文里的
// 换行一律转成字面 `\n`（两个字符）。原文仍完整保存在收件箱里，`aih peer read`
// 可以看到真实换行。
//
// native 通道也复用这个信封：Claude 那边已经有 `<cross-session-message from=…>`
// 外层，但那层只有名字、没有 id，回复时对不上号。

const DEFAULT_MAX_BODY_CHARS = 4000;

// 除换行外还要清掉的 C0 控制字符：`send-keys -l` 会把它们原样打进 pane，
// 轻则污染输入框，重则触发终端的快捷键（Ctrl-C 之类）。
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function senderName(from) {
  const source = from && typeof from === 'object' ? from : {};
  const name = String(source.name || '').trim();
  if (name) return name;
  const address = String(source.address || '').trim();
  if (address) return address;
  const sessionId = String(source.sessionId || '').trim();
  return sessionId || 'unknown';
}

/** 正文压成单行：换行 → 字面 \n，去掉其余控制字符，超长截断。 */
function collapseBody(body, options = {}) {
  const maxChars = Number.isFinite(Number(options.maxBodyChars)) && Number(options.maxBodyChars) > 0
    ? Math.floor(Number(options.maxBodyChars))
    : DEFAULT_MAX_BODY_CHARS;
  const text = String(body == null ? '' : body)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/\n/g, '\\n');
  if (text.length <= maxChars) return text;
  const short = String(options.id || '').trim();
  const hint = short ? ` … (完整内容: aih peer read ${short})` : ' …';
  return `${text.slice(0, Math.max(0, maxChars - hint.length))}${hint}`;
}

function formatPeerEnvelope(input = {}) {
  const short = String(input.id || '').trim();
  const body = collapseBody(input.body, { maxBodyChars: input.maxBodyChars, id: short });
  if (!short) return body;
  const header = `[aih-peer #${short} from ${senderName(input.from)} | reply: aih peer reply ${short}]`;
  return body ? `${header} ${body}` : header;
}

module.exports = {
  DEFAULT_MAX_BODY_CHARS,
  collapseBody,
  formatPeerEnvelope,
  senderName
};
