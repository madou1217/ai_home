'use strict';

// Go 解码拒收 -> Node 接手（Chain of Responsibility 的回退一环）。
//
// Go 的 Canonical 协议解码比 Node 透传严格：客户端新增的字段或尚未建模的输入项
// （如 Codex 桌面端的 custom_tool_call、internal_chat_message_metadata_passthrough）
// 会在解码阶段 400。解码发生在选账号和请求上游之前，没有任何副作用，所以只有带
// Go 显式标记的这一类失败可以把同一份已缓冲请求体交还 Node；其它任何失败（包括
// 上游透出的 400、Canonical 失败）都不得重放，避免重复计费或重复执行工具。

// 与 Go internal/transport/http/inferenceapi.DecodeRejectedHeader 一致（Node 头名为小写）。
const DECODE_REJECTED_HEADER = 'x-aih-decode-rejected';

function isGoDecodeRejection(upstreamResponse) {
  if (!upstreamResponse || upstreamResponse.statusCode !== 400) return false;
  const value = upstreamResponse.headers && upstreamResponse.headers[DECODE_REJECTED_HEADER];
  return String(Array.isArray(value) ? value[0] : value || '').trim() === '1';
}

module.exports = {
  DECODE_REJECTED_HEADER,
  isGoDecodeRejection
};
