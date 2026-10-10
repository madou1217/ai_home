'use strict';

const { createClashFamilyRenderer } = require('./clash-family');

// Stash 的个别键名与 mihomo 不同（mihomo 也认这些 Stash 写法）：在 mihomo 条目上补写。
function adaptProxy(proxy, node) {
  if (proxy.type === 'hysteria') {
    proxy['up-speed'] = Number(node.upMbps);
    proxy['down-speed'] = Number(node.downMbps);
    if (proxy.protocol) proxy['obfs-protocol'] = proxy.protocol;
  }
  // Stash 的 TUIC 缺省按 v4（token）处理，v5 要显式声明。
  if (proxy.type === 'tuic') proxy.version = 5;
  return proxy;
}

/** Stash（iOS / macOS）：Clash 语法 + VLESS / Hysteria / TUIC / WireGuard 等扩展，读不了 .mrs，规则集用 YAML。 */
module.exports = createClashFamilyRenderer({
  id: 'stash',
  name: 'Stash',
  protocols: [
    'shadowsocks', 'shadowsocksr', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'wireguard', 'snell',
    'socks5', 'http', 'https'
  ],
  ruleSetFile: 'clash-yaml',
  adaptProxy
});
