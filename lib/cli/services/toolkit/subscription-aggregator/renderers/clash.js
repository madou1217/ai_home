'use strict';

const { createClashFamilyRenderer } = require('./clash-family');

/** Clash 经典版（Premium 内核：Clash for Windows、ClashX）：不支持 VLESS / Hysteria / TUIC 等新协议，规则集用 YAML。 */
module.exports = createClashFamilyRenderer({
  // 'clash' 早已是 mihomo 的别名（已有订阅链接在用），经典版用独立 id。
  id: 'clash-classic',
  name: 'Clash（经典 / Premium）',
  protocols: ['shadowsocks', 'shadowsocksr', 'vmess', 'trojan', 'snell', 'socks5', 'http', 'https'],
  ruleSetFile: 'clash-yaml'
});
