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
// native 使用独立的完整正文包装；只有终端注入才需要压行与截断。

const { notificationStatus, autoDeliverUntilOf } = require('./delivery-policy');

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

function readableMetadata(input = {}) {
  const plain = (value, fallback = '未说明') => {
    const text = String(value == null ? '' : value).replace(CONTROL_CHARS, '').replace(/[\r\n\t]+/g, ' ').trim();
    return text ? text.slice(0, 240) : fallback;
  };
  const policies = { required: '需要回复', optional: '可选回复', none: '无需回复' };
  const at = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const state = notificationStatus(input, at).notificationState;
  const formatTime = (value) => {
    const date = new Date(Number(value));
    return Number(value) > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : '未说明';
  };
  let validity = '当前有效';
  if (state === 'expired' || (Number(input.expiresAt) > 0 && Number(input.expiresAt) <= at)) validity = '已过期，仅供查阅，请勿继续旧行动';
  else if (state === 'canceled' || Number(input.canceledAt) > 0) validity = '已撤回，仅供查阅';
  else if (state === 'manual') validity = '自动通知期已结束或需手动处理，请先确认当前需要';
  else if (Number(input.expiresAt) > 0) validity = `有效至 ${formatTime(input.expiresAt)}`;
  else validity = '未设内容截止时间';
  const fields = [`主题：${plain(input.subject)}`, `缘由：${plain(input.purpose)}`, `待办：${plain(input.action)}`,
    `回复：${policies[input.replyPolicy] || '未说明'}`, `发送：${formatTime(input.createdAt)}`, `有效性：${validity}`];
  if (input.summary) fields.splice(1, 0, `摘要：${plain(input.summary)}`);
  if (autoDeliverUntilOf(input) > 0 && autoDeliverUntilOf(input) <= at) fields.push('时效提示：旧消息，行动前请核对最新进展');
  return fields.join('｜');
}

function formatPeerEnvelope(input = {}) {
  const short = String(input.id || '').trim();
  const body = collapseBody(input.body, { maxBodyChars: input.maxBodyChars, id: short });
  if (!short) return body;
  const sender = collapseBody(senderName(input.from), { maxBodyChars: 120 });
  const header = `[aih-peer #${short} from ${sender} | reply: aih peer reply ${short}]`;
  return `${header} ${readableMetadata(input)}${body ? `｜原文：${body}` : ''}`;
}

/** UDS/JSON is not a terminal paste: original body stays byte-for-byte as text. */
function formatNativePeerEnvelope(input = {}) {
  const body = String(input.body == null ? '' : input.body);
  const short = String(input.id || '').trim();
  if (!short) return body;
  const sender = collapseBody(senderName(input.from), { maxBodyChars: 120 });
  return `[aih-peer #${short} from ${sender} | reply: aih peer reply ${short}] ${readableMetadata(input)}\n原文：\n${body}`;
}

module.exports = {
  DEFAULT_MAX_BODY_CHARS,
  collapseBody,
  formatPeerEnvelope,
  formatNativePeerEnvelope,
  readableMetadata,
  senderName
};
