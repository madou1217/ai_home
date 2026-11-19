'use strict';

// 客户端声明的推理归属（诊断用）。
//
// 推理入口全部由 Go 网关承接，因此当前唯一取值是 `go`：跨 Provider harness 的启动器
// 带上该头，表示这条请求预期由 Go 的网关路由执行。宿主不再依据它改变请求归属，也不会
// 把它转发给上游；未知取值按普通客户端处理。

const ROUTE_OWNER_HEADER = 'x-aih-route-owner';
const ROUTE_OWNER_GO = 'go';

module.exports = {
  ROUTE_OWNER_HEADER,
  ROUTE_OWNER_GO
};