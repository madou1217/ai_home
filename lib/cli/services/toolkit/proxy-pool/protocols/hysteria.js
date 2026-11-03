'use strict';

const { encodeHysteria1Link, parseHysteria1Link } = require('../protocol-parsers/hysteria1-parser');
const { buildTls, configError } = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS } = require('../protocol-fields');
const { safeBase64Decode } = require('../protocol-parsers/base-parser');
const { alpnList, clashTls, numericRate, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls } = require('../protocol-parsers/sing-box-fields');

// mihomo 与 sing-box 都要求声明上下行带宽：订阅里没有就报缺字段，不替用户编一个值。
// 认证有两种写法：auth-str（明文）与 auth（base64 字节）；节点统一存明文。
function authString(text, base64) {
  return optionalString(text) ?? (base64 ? optionalString(safeBase64Decode(base64)) : undefined);
}

function bandwidth(node, field) {
  const value = Number(node[field]);
  if (!Number.isFinite(value) || value <= 0) throw configError(`missing_required_proxy_field_${field}`);
  return value;
}

module.exports = Object.freeze({
  id: 'hysteria',
  capability: 'proxy-pool.protocol',
  name: 'Hysteria',
  protocols: Object.freeze(['hysteria']),
  aliases: Object.freeze(['hysteria1', 'hy1']),
  uriSchemes: Object.freeze(['hysteria']),
  fields: Object.freeze({
    authStr: 'string',
    hysteriaProtocol: 'string',
    obfs: 'string',
    upMbps: 'positive',
    downMbps: 'positive',
    ...TLS_FIELDS
  }),
  required: Object.freeze([]),
  form: Object.freeze({
    options: Object.freeze({ hysteriaProtocol: Object.freeze(['udp', 'wechat-video', 'faketcp']) }),
    defaults: Object.freeze({ tls: true })
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['hysteria']),
      parse: (proxy) => ({
        authStr: authString(proxy['auth-str'] ?? proxy.auth_str, proxy.auth),
        // Stash 把传输协议写作 obfs-protocol、带宽写作 up-speed / down-speed（单位 Mbps）。
        hysteriaProtocol: optionalString(proxy.protocol ?? proxy['obfs-protocol']),
        obfs: optionalString(proxy.obfs),
        upMbps: numericRate(proxy.up ?? proxy['up-speed']),
        downMbps: numericRate(proxy.down ?? proxy['down-speed']),
        ...clashTls(proxy, { forceTls: true })
      })
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['hysteria']),
      parse: (outbound) => ({
        authStr: authString(outbound.auth_str, outbound.auth),
        obfs: optionalString(outbound.obfs),
        upMbps: numericRate(outbound.up_mbps),
        downMbps: numericRate(outbound.down_mbps),
        ...singBoxTls(outbound, { forceTls: true })
      })
    })
  }),
  parse: parseHysteria1Link,
  encode: encodeHysteria1Link,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'hysteria';
      proxy.up = `${bandwidth(node, 'upMbps')} Mbps`;
      proxy.down = `${bandwidth(node, 'downMbps')} Mbps`;
      if (node.authStr) proxy['auth-str'] = String(node.authStr);
      if (node.hysteriaProtocol) proxy.protocol = String(node.hysteriaProtocol);
      if (node.obfs) proxy.obfs = String(node.obfs);
      if (node.sni) proxy.sni = String(node.sni);
      const alpn = alpnList(node.alpn);
      if (alpn) proxy.alpn = Array.isArray(alpn) ? alpn : alpn.split(',').map((item) => item.trim()).filter(Boolean);
      if (node.allowInsecure || node.insecure) proxy['skip-cert-verify'] = true;
      return proxy;
    },
    'sing-box'(node, base) {
      const transportProtocol = String(node.hysteriaProtocol || 'udp').toLowerCase();
      if (transportProtocol !== 'udp') throw configError(`unsupported_hysteria_protocol_${transportProtocol}`);
      const outbound = {
        ...base,
        up_mbps: bandwidth(node, 'upMbps'),
        down_mbps: bandwidth(node, 'downMbps'),
        tls: buildTls(node, { force: true })
      };
      if (node.authStr) outbound.auth_str = String(node.authStr);
      if (node.obfs) outbound.obfs = String(node.obfs);
      return outbound;
    }
  })
});
