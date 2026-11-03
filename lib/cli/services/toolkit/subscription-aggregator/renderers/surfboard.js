'use strict';

const { SKIP_PROXY, createSurgeFamilyRenderer } = require('./surge-family');

/**
 * Surfboard（Android）：Surge 语法的子集。协议集与 Surge 不同（没有 VLESS / ShadowsocksR，
 * 但 Surge 的部分协议它也不支持），所以走自己的编译钩子（compile.surfboard，缺省回落 compile.surge）。
 *
 * relayFallback：Surfboard 也没有 VLESS，而这些节点在手机上同样要能用 —— 远端形态下中转入口写的是
 * AIH 那台机器的可达地址（不是手机的 127.0.0.1），所以这个回退对手机一样成立（见 relay/）。
 */
module.exports = createSurgeFamilyRenderer({
  id: 'surfboard',
  name: 'Surfboard',
  protocols: [
    'shadowsocks', 'vmess', 'trojan', 'snell', 'tuic', 'hysteria2', 'anytls', 'wireguard', 'socks5', 'http', 'https'
  ],
  compileTarget: 'surfboard',
  relayFallback: true,
  general: (testUrl) => [
    'dns-server = system, 223.5.5.5, 119.29.29.29',
    `skip-proxy = ${SKIP_PROXY}`,
    `proxy-test-url = ${testUrl}`,
    'internet-test-url = http://www.gstatic.com/generate_204',
    'test-timeout = 5'
  ]
});
