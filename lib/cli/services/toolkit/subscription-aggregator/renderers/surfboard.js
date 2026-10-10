'use strict';

const { SKIP_PROXY, createSurgeFamilyRenderer } = require('./surge-family');

/** Surfboard（Android）：Surge 语法的子集，不支持 Hysteria2。 */
module.exports = createSurgeFamilyRenderer({
  id: 'surfboard',
  name: 'Surfboard',
  protocols: ['shadowsocks', 'vmess', 'trojan', 'socks5', 'http', 'https'],
  general: (testUrl) => [
    'dns-server = system, 223.5.5.5, 119.29.29.29',
    `skip-proxy = ${SKIP_PROXY}`,
    `proxy-test-url = ${testUrl}`,
    'internet-test-url = http://www.gstatic.com/generate_204',
    'test-timeout = 5'
  ]
});
