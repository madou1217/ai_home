'use strict';

const { createClashFamilyRenderer } = require('./clash-family');

/**
 * Clash 语法 + YAML 规则集，**输出全部协议**（不再按协议挑节点）。
 *
 * 名字里的「经典 / Premium」只是沿用历史 id：`clash-classic`，别名 `clash-premium`，已有订阅链接
 * 与客户端识别表都在用，不能改。Premium 内核（ClashX、Clash for Windows、Clash for Android）
 * 本身只认 ss / ssr / vmess / trojan / snell / socks5 / http —— VLESS / Hysteria2 / TUIC /
 * WireGuard / AnyTLS / SSH 这些是 Clash.Meta（mihomo）系内核才有的能力。所以这个目标的行为是：
 * 选中的节点全部输出，但要用上全部协议，客户端得是 Meta 系内核。
 *
 * 规则集用 .yaml（不是 .mrs），比 mihomo 目标兼容更老的客户端；这也是它与 mihomo 目标唯一的功能差别。
 *
 * relayFallback：这些老客户端**在跑 AIH 的同一台机器上**时，认不出的协议由本机 sing-box 边车代拨，
 * 配置里写成 `socks5: 127.0.0.1:<port>`，于是原版内核也能用上全部节点（见 relay/）。
 */
module.exports = createClashFamilyRenderer({
  // 'clash' 早已是 mihomo 的别名（已有订阅链接在用），这里用独立 id。
  id: 'clash-classic',
  name: 'Clash（YAML 规则集 · 全协议）',
  note: '输出全部协议；VLESS / Hysteria2 / TUIC / WireGuard 等需 Meta 系内核（Clash Verge Rev、mihomo、FlClash）',
  ruleSetFile: 'clash-yaml',
  proxyChain: 'dialer-proxy',
  relayFallback: true
});
