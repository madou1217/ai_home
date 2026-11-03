'use strict';

// 客户端可显式声明「这条请求必须由 Node 完整实现处理」。
//
// 背景：Go Core 已承接部分数据面入口，但同一入口上的跨 Provider 协议桥仍有未对齐
// 的语义（例如 Anthropic /v1/messages -> Codex Responses 的缓冲/流式差异）。跨
// Provider harness 由 aih 自己启动，因此由启动器注入该头，网关在转发前据此把请求
// 留在 Node；普通客户端不携带该头，划转行为不变。
//
// 该头只在 Node 宿主内消费，绝不转发给 Go 或上游。
const ROUTE_OWNER_HEADER = 'x-aih-route-owner';
const ROUTE_OWNER_NODE = 'node';

module.exports = {
  ROUTE_OWNER_HEADER,
  ROUTE_OWNER_NODE
};
