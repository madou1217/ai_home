'use strict';

const { createClashFamilyRenderer } = require('./clash-family');
const { SHADOW_TLS, canonicalShadowsocksPlugin } = require('../../proxy-pool/shadowsocks-plugin');
const { protocolFieldError } = require('../../proxy-pool/protocol-fields');

// Premium 内核的 ss 插件只到 obfs / v2ray-plugin：ShadowTLS 是 Meta 系（mihomo / Stash）的扩展，
// 写进经典版会被整份配置拒掉，所以这里跳过并给出原因。
function adaptProxy(proxy, node) {
  const plugin = canonicalShadowsocksPlugin(node);
  if (plugin && plugin.name === SHADOW_TLS) throw protocolFieldError(`unsupported_shadowsocks_plugin_${SHADOW_TLS}`);
  return proxy;
}

/** Clash 经典版（Premium 内核：Clash for Windows、ClashX）：不支持 VLESS / Hysteria / TUIC 等新协议，规则集用 YAML。 */
module.exports = createClashFamilyRenderer({
  // 'clash' 早已是 mihomo 的别名（已有订阅链接在用），经典版用独立 id。
  id: 'clash-classic',
  name: 'Clash（经典 / Premium）',
  protocols: ['shadowsocks', 'shadowsocksr', 'vmess', 'trojan', 'snell', 'socks5', 'http', 'https'],
  ruleSetFile: 'clash-yaml',
  adaptProxy
});
