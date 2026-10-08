'use strict';

// Go 解码拒收 -> Node 接手（Chain of Responsibility 的回退一环）。
//
// Go 的 Canonical 协议解码比 Node 透传严格：客户端新增的字段、尚未建模的输入项
// （如 Codex 桌面端的 custom_tool_call、internal_chat_message_metadata_passthrough），
// 或 Go 侧不支持的请求体形状（如 Canonical 路径不认的 gzip/zstd 内容编码）都会在
// 解码阶段失败。解码发生在选账号和请求上游之前，没有任何副作用，所以只有带 Go 显式
// 标记的这一类失败可以把同一份已缓冲请求体交还 Node；其它任何失败（包括上游透出的
// 4xx、Canonical 失败、5xx）都不得重放，避免重复计费或重复执行工具。

// 与 Go internal/transport/http/inferenceapi.DecodeRejectedHeader 一致（Node 头名为小写）。
const DECODE_REJECTED_HEADER = 'x-aih-decode-rejected';

function isGoDecodeRejection(upstreamResponse) {
  if (!upstreamResponse) return false;
  const status = Number(upstreamResponse.statusCode) || 0;
  // 解码阶段的拒收只可能是 4xx（400 形状不识别、415 媒体类型/内容编码不支持）；
  // 5xx 一律是服务端失败，不得重放。
  if (status < 400 || status >= 500) return false;
  const value = upstreamResponse.headers && upstreamResponse.headers[DECODE_REJECTED_HEADER];
  return String(Array.isArray(value) ? value[0] : value || '').trim() === '1';
}

module.exports = {
  DECODE_REJECTED_HEADER,
  isGoDecodeRejection
};
