'use strict';

// ACP over HTTP + SSE（codebuddy --serve 的变体）。
//
// 现状（2026-11-03）：仓库里**没有**可靠的端点发现方式 —— 没有 `--serve` 的 ACP
// POST 路径、SSE 事件流端点/事件名、HTTP 会话与 ACP sessionId 的关联头的实测证据。
// 因此 open() 默认 fail closed（acp_http_endpoint_unavailable），绝不猜一个 URL 就
// 宣布会话可用：猜错的代价是「连上了别的服务，审批回执发给别人」。
//
// 补齐取证后，把通道按下面的形状注入 context.acpHttpChannel 即可复用同一个协议核
// 与消息映射（本文件不复制任何 ACP 语义）：
//   channel = {
//     send(message) {},        // 发一帧 JSON-RPC（对象）；返回 false 表示没写出去
//     onMessage(handler) {},   // 收一帧 JSON-RPC；返回 unsubscribe
//     onClose(handler) {},     // 通道断开；handler({ code, message })
//     close() {}
//   }
// acpHttpChannel 也可以是工厂 ({ provider, sessionId, context }) => channel。
//
// 需要补的证据（同时写进失败详情，避免下一个人再猜）：
//   1. POST 路径与 Content-Type；
//   2. SSE 事件端点（GET ?）与事件名（message / acp / ...）；
//   3. HTTP 会话与 ACP sessionId 的关联方式（header / query / body）。

const { createAcpAdapter, resolveAcpArgs } = require('./acp-stdio');

const MISSING_EVIDENCE = Object.freeze([
  'codebuddy --serve 的 ACP POST 路径与 Content-Type',
  'SSE 事件流端点与事件名（message / acp / ...）',
  'HTTP 会话与 ACP sessionId 的关联方式（header / query / body）'
]);

function fail(code, message, details) {
  const error = Object.assign(new Error(message || code), { code });
  if (details !== undefined) error.details = details;
  return error;
}

function assertChannel(channel, provider) {
  if (!channel || typeof channel.send !== 'function' || typeof channel.onMessage !== 'function') {
    throw fail('acp_http_channel_invalid', 'ACP HTTP 通道缺少 send/onMessage', { provider });
  }
  return channel;
}

function createHttpTransport(input) {
  // 先查布局表：provider 没声明 http-sse 入口就是 acp_entry_unsupported，
  // 这比「端点不可用」更早、更准确（不是没发现端点，是这个 provider 没这个入口）。
  resolveAcpArgs(input.provider, 'acp-http-sse');
  const source = input.context.acpHttpChannel;
  if (!source) {
    throw fail(
      'acp_http_endpoint_unavailable',
      `${input.provider} 的 ACP HTTP 端点不可发现（缺少实测证据）`,
      { provider: input.provider, missing: MISSING_EVIDENCE.slice() }
    );
  }
  const channel = typeof source === 'function'
    ? source({ provider: input.provider, sessionId: input.sessionId, context: input.context })
    : source;
  return { transport: assertChannel(channel, input.provider) };
}

function createAdapter(options) {
  return createAcpAdapter(Object.assign({}, options, {
    id: 'acp-http-sse',
    transport: 'acp-http-sse',
    createTransport: createHttpTransport
  }));
}

module.exports = {
  MISSING_EVIDENCE,
  createAdapter
};
