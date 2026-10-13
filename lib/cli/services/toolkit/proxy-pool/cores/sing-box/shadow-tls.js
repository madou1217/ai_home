'use strict';

// ShadowTLS 在 sing-box 里不是 SIP003 插件，而是独立的传输层出站：Shadowsocks 出站用 detour 指过去，
// 所以一个节点要输出两个出站。辅助出站不能出现在客户端的服务器列表里（Hiddify / Karing 会把所有
// 非选择器出站都列成「服务器」），因此 tag 带 §hide§ 标记，由客户端隐藏。

const { requiredString } = require('./outbound-fields');

const HIDE_MARK = '§hide§';
const DEFAULT_VERSION = 3;

/** 辅助出站的 tag：主出站的 tag 加隐藏标记；已经带标记的原样返回。 */
function hiddenTag(tag) {
  const name = String(tag ?? '').trim() || 'node';
  return name.includes(HIDE_MARK) ? name : `${name}${HIDE_MARK}`;
}

/** 中立参数（host / password / version）→ sing-box 的 shadowtls 出站。 */
function buildShadowTlsOutbound(canonical, base) {
  const version = Number(canonical && canonical.version);
  const outbound = {
    type: 'shadowtls',
    tag: hiddenTag(base.tag),
    server: base.server,
    server_port: base.server_port,
    version: Number.isInteger(version) && version > 0 ? version : DEFAULT_VERSION,
    password: requiredString(canonical && canonical.password, 'missing_required_proxy_field_shadowTlsPassword')
  };
  const host = String((canonical && canonical.host) || '').trim();
  outbound.tls = host ? { enabled: true, server_name: host } : { enabled: true };
  return outbound;
}

/** sing-box 的 shadowtls 出站 → 中立参数（导入时按 tag 找回来合并进节点）。 */
function readShadowTlsOutbound(outbound) {
  const entry = outbound && typeof outbound === 'object' ? outbound : {};
  const tls = entry.tls && typeof entry.tls === 'object' ? entry.tls : {};
  return {
    host: tls.server_name === undefined ? undefined : String(tls.server_name),
    password: entry.password === undefined ? undefined : String(entry.password),
    version: entry.version === undefined ? undefined : String(entry.version)
  };
}

module.exports = {
  HIDE_MARK,
  buildShadowTlsOutbound,
  hiddenTag,
  readShadowTlsOutbound
};
