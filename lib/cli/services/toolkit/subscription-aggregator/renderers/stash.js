'use strict';

const { createClashFamilyRenderer } = require('./clash-family');

/** Stash（iOS / macOS）：Clash 语法 + VLESS / Hysteria2 等扩展，读不了 .mrs，规则集用 YAML。 */
module.exports = createClashFamilyRenderer({
  id: 'stash',
  name: 'Stash',
  protocols: ['shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'socks5', 'http', 'https'],
  ruleSetFile: 'clash-yaml'
});
