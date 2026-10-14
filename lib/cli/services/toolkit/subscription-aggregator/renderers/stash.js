'use strict';

const { createClashFamilyRenderer } = require('./clash-family');

// Stash 的个别键名与 mihomo 不同（mihomo 也认这些 Stash 写法）：在 mihomo 条目上补写。
function adaptProxy(proxy, node) {
  if (proxy.type === 'hysteria') {
    proxy['up-speed'] = Number(node.upMbps);
    proxy['down-speed'] = Number(node.downMbps);
    if (proxy.protocol) proxy['obfs-protocol'] = proxy.protocol;
  }
  // Stash 的 TUIC 缺省按 v4（token）处理，只有 v5（uuid + password）才显式声明版本。
  if (proxy.type === 'tuic' && proxy.uuid) proxy.version = 5;
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
  adaptProxy,
  // 代理链（3.2.5+ / 4.1+）：字段名与 mihomo 相同，可层层指定成多跳，指向不存在的节点时 Stash 会拒绝连接。
  proxyChain: 'dialer-proxy'
});
