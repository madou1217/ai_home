'use strict';

const { SKIP_PROXY, createSurgeFamilyRenderer } = require('./surge-family');

/**
 * Surfboard（Android）：Surge 语法的子集。协议集与 Surge 不同（没有 VLESS / ShadowsocksR，
 * 但 Surge 的部分协议它也不支持），所以走自己的编译钩子（compile.surfboard，缺省回落 compile.surge）。
 */
module.exports = createSurgeFamilyRenderer({
  id: 'surfboard',
  name: 'Surfboard',
  protocols: [
    'shadowsocks', 'vmess', 'trojan', 'snell', 'tuic', 'hysteria2', 'anytls', 'wireguard', 'socks5', 'http', 'https'
  ],
  compileTarget: 'surfboard',
  general: (testUrl) => [
    'dns-server = system, 223.5.5.5, 119.29.29.29',
    `skip-proxy = ${SKIP_PROXY}`,
    `proxy-test-url = ${testUrl}`,
    'internet-test-url = http://www.gstatic.com/generate_204',
    'test-timeout = 5'
  ]
});
