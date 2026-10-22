'use strict';

// IP → 归属地查询的**策略链**（Node 侧；Go 侧 internal/geo 同构实现，见该目录注释）。
//
// 为什么要本地库、不要在线 API（2026-10-22 用户决策）：
//   在线服务（ipinfo / ip-api）不稳定、有速率限制、且每次都要经节点出网，
//   慢且不可控。改成「本地 mmdb 数据文件 + 纯本地查询」，查询是内存二分查找（微秒级）。
//
// 分工（关键，别混淆）：
//   ① 拿出口 IP   —— 必须经节点出网一次（唯一能知道出口真实 IP 的方式），**不由本模块负责**；
//   ② IP → 归属地 —— 本模块负责，**纯本地**、零网络。
//
// 数据源做成 provider：每个 provider 声明自己的能力（有没有城市 / ASN），
// 按顺序尝试，**前一个不可用或查不到就自动切下一个**；ASN 单独从 ASN 库补齐
// （本机 Surge 的 GeoLite2-ASN.mmdb 就是这种「只补一个字段」的库）。
//
// 诚实边界：城市级只有 City 库才有。本机现成的是 Country / ASN 库，所以默认
// 结果里 city 为空 —— 界面与地区规则据此工作（规则里 city 不命中就是不命中，不猜）。

const { GeoLookupChain } = require('./chain');
const { listGeoProviders, getGeoProvider } = require('./providers');

module.exports = {
  GeoLookupChain,
  getGeoProvider,
  listGeoProviders
};
