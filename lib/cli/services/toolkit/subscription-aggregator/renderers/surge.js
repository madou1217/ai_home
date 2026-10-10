'use strict';

const { SKIP_PROXY, createSurgeFamilyRenderer } = require('./surge-family');

/** Surge（iOS / macOS）完整配置：#!MANAGED-CONFIG 托管更新，规则集走 AIH 的转换地址。 */
module.exports = createSurgeFamilyRenderer({
  id: 'surge',
  name: 'Surge',
  protocols: ['shadowsocks', 'vmess', 'trojan', 'hysteria2', 'socks5', 'http', 'https'],
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
