'use strict';

// 网络类失败的诊断片段：**只写生效出口**，不写环境变量名。
//
// 2026-10-26 的实际代价：server 的出口是保存下来的 `proxy_url`（当时指向出口池端口），
// 而 hint 里写的是 `proxy=AIH_SERVER_PROXY_URL/https_proxy/http_proxy`，于是「出口池 DNS
// 挂了」被读成「网关有 bug」，排障方向整体跑偏。codex-adapter 早就按生效出口写过一次
// （那里的注释也这么说），本模块把它抽成唯一实现，两条请求路径共用，避免再次分叉。

/** 代理地址可能带 userinfo；诊断面向客户端与日志，剥掉凭据只留主机端口。 */
function redactProxyUrl(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** `proxy=<url>`；没有代理就是 `proxy=none (direct)`。 */
function describeEgressHint(proxyUrl) {
  const redacted = redactProxyUrl(proxyUrl);
  return redacted ? `proxy=${redacted}` : 'proxy=none (direct)';
}

module.exports = {
  describeEgressHint,
  redactProxyUrl
};
