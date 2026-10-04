'use strict';

const { encodeHysteriaLink, parseHysteriaLink } = require('../protocol-parsers/hysteria-parser');
const { requiredString } = require('../cores/mihomo/proxy-fields');
const { buildTls, requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');

module.exports = Object.freeze({
  id: 'hysteria2',
  capability: 'proxy-pool.protocol',
  name: 'Hysteria2',
  protocols: Object.freeze(['hysteria2']),
  aliases: Object.freeze(['hy2']),
  // hysteria:// (v1) 仍按原样解析/编码，但不在受支持的运行协议内。
  legacyProtocols: Object.freeze(['hysteria']),
  uriSchemes: Object.freeze(['hy2', 'hysteria2', 'hysteria']),
  // WebUI 节点编辑表单（字段描述）与可提交的协议字段白名单。
  editor: Object.freeze({
    fields: Object.freeze([
      { key: 'password', label: '密码 / 密钥', type: 'password', required: true, requiredMessage: '请输入密码或密钥' },
      { key: 'sni', label: 'SNI / Server name', type: 'text', row: 'tls', placeholder: '可选' }
    ])
  }),
  nodeFields: Object.freeze(['password', 'tls', 'sni', 'insecure', 'allowInsecure', 'obfs', 'obfsPassword', 'upMbps', 'downMbps']),
  parse: parseHysteriaLink,
  encode: encodeHysteriaLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'hysteria2';
      proxy.password = requiredString(node, 'password');
      if (node.sni) proxy.sni = String(node.sni);
      proxy['skip-cert-verify'] = Boolean(node.insecure || node.allowInsecure);
      if (node.obfs) {
        proxy.obfs = String(node.obfs);
        proxy['obfs-password'] = requiredString(node, 'obfsPassword');
      }
      if (node.upMbps !== undefined) {
        const value = Number(node.upMbps);
        if (!Number.isFinite(value) || value <= 0) throw new Error('invalid_proxy_field_upMbps');
        proxy.up = `${value} Mbps`;
      }
      if (node.downMbps !== undefined) {
        const value = Number(node.downMbps);
        if (!Number.isFinite(value) || value <= 0) throw new Error('invalid_proxy_field_downMbps');
        proxy.down = `${value} Mbps`;
      }
      return proxy;
    },
    'sing-box'(node, base) {
      const outbound = {
        ...base,
        password: requireSingBoxString(node.password, 'missing_required_proxy_field_password'),
        tls: buildTls(node, { force: true })
      };
      if (node.upMbps !== undefined) outbound.up_mbps = Number(node.upMbps);
      if (node.downMbps !== undefined) outbound.down_mbps = Number(node.downMbps);
      const obfsType = String(node.obfs || '').trim();
      const obfsPassword = String(node.obfsPassword || '').trim();
      if (obfsType || obfsPassword) {
        outbound.obfs = {
          type: obfsType || 'salamander',
          password: requireSingBoxString(obfsPassword, 'missing_required_proxy_field_obfsPassword')
        };
      }
      return outbound;
    }
  })
});
