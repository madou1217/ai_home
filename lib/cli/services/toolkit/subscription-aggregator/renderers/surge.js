'use strict';

const { SKIP_PROXY, createSurgeFamilyRenderer } = require('./surge-family');

/** Surge（iOS / macOS）完整配置：#!MANAGED-CONFIG 托管更新，规则集走 AIH 的转换地址。
 *  WireGuard 的地址写在 [WireGuard x] 段里（代理行只引用 section-name），段落由渲染时展开。
 *
 *  Surge 没有 VLESS 这一档（官方协议表里只有 ss / vmess / trojan / tuic / hysteria2 / snell /
 *  anytls / wireguard / http(s) / socks5 / ssh / masque / tailscale），机场订阅里最常见的
 *  vless:// 节点因此一个都进不了 [Proxy] —— 全丢光时预览会说「选中的节点都不被 Surge 支持」。
 *  relayFallback 就是给这种情况的：同机跑 AIH 时由 sing-box 边车代拨这些节点，Surge 里只留
 *  一行本地 socks5 入口，名字与策略组引用都不变（见 relay/relay-fallback）。 */
module.exports = createSurgeFamilyRenderer({
  id: 'surge',
  name: 'Surge',
  protocols: [
    'shadowsocks', 'vmess', 'trojan', 'hysteria2', 'tuic', 'snell', 'anytls', 'wireguard', 'socks5', 'http', 'https'
  ],
  compileTarget: 'surge',
  finalSuffix: ',dns-failed',
  proxyChain: 'underlying-proxy',
  relayFallback: true,
  general: (testUrl) => [
    'loglevel = notify',
    'ipv6 = false',
    'dns-server = system, 223.5.5.5, 119.29.29.29',
    `skip-proxy = ${SKIP_PROXY}`,
    'exclude-simple-hostnames = true',
    'internet-test-url = http://www.apple.com/library/test/success.html',
    `proxy-test-url = ${testUrl}`,
    'test-timeout = 5'
  ]
});
