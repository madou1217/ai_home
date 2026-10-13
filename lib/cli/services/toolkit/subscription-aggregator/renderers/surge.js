'use strict';

const { SKIP_PROXY, createSurgeFamilyRenderer } = require('./surge-family');

/** Surge（iOS / macOS）完整配置：#!MANAGED-CONFIG 托管更新，规则集走 AIH 的转换地址。
 *  WireGuard 的地址写在 [WireGuard x] 段里（代理行只引用 section-name），段落由渲染时展开。 */
module.exports = createSurgeFamilyRenderer({
  id: 'surge',
  name: 'Surge',
  protocols: [
    'shadowsocks', 'vmess', 'trojan', 'hysteria2', 'tuic', 'snell', 'anytls', 'wireguard', 'socks5', 'http', 'https'
  ],
  compileTarget: 'surge',
  finalSuffix: ',dns-failed',
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
