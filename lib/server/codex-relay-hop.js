'use strict';

// codex Responses 跨机中转的**跳数**语义（Node 与 Go 的唯一真相）。
//
// 该头记录「本请求已经被几台 aih 网关转发过」：
//   0（或无头）客户端直连本网关；1 本网关把它转给了对端网关。
//
// 历史上这条链路把「头存在」直接当成自环并拒绝（Node 侧 508 / Go 侧 508），于是
// 「本机 aih → 远程 server 上的 aih」这种**跨机中转**永远打不通 —— 对端一律回
// `Gateway proxy loop detected`。真正要防的是 A→B→A 的无限环，而不是一跳中转。
// 现在与 fabric 反向网关同一套设计（lib/server/fabric-gateway-protocol.js 的
// MAX_FABRIC_GATEWAY_HOPS）：只有超过上限才判环。
//
// 常量的字节值必须与 Go 侧 internal/adapters/codex/responses/native.go 的
// MaxNativeRelayHops / NativeRelayHop 保持一致，否则两侧对同一条链的判定会分叉。

const CODEX_RELAY_HOP_HEADER = 'x-aih-codex-relay-hop';
const MAX_CODEX_RELAY_HOPS = 1;

/** 解析请求已走过的网关跳数；缺失/非法一律按 0（未中转）。 */
function readCodexRelayHop(headers = {}) {
  const raw = headers[CODEX_RELAY_HOP_HEADER] !== undefined
    ? headers[CODEX_RELAY_HOP_HEADER]
    : headers['X-Aih-Codex-Relay-Hop'];
  const text = Array.isArray(raw) ? String(raw[0] || '').trim() : String(raw == null ? '' : raw).trim();
  if (!text) return 0;
  const hop = Number(text);
  return Number.isInteger(hop) && hop >= 0 ? hop : 0;
}

/** 本请求是否已经超过允许的网关跳数（即出现环）。 */
function exceedsCodexRelayHopLimit(headers = {}) {
  return readCodexRelayHop(headers) > MAX_CODEX_RELAY_HOPS;
}

/** 本网关把请求转给对端时应当写下的跳数。 */
function nextCodexRelayHop(headers = {}) {
  return String(readCodexRelayHop(headers) + 1);
}

module.exports = {
  CODEX_RELAY_HOP_HEADER,
  MAX_CODEX_RELAY_HOPS,
  readCodexRelayHop,
  exceedsCodexRelayHopLimit,
  nextCodexRelayHop
};
