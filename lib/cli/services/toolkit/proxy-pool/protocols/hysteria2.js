'use strict';

const { encodeHysteriaLink, parseHysteriaLink } = require('../protocol-parsers/hysteria-parser');
const { requiredString } = require('../cores/mihomo/proxy-fields');
const { buildTls, requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { TLS_FIELDS } = require('../protocol-fields');
const { clashTls, numericRate, optionalString } = require('../protocol-parsers/clash-fields');
const { singBoxTls } = require('../protocol-parsers/sing-box-fields');
const { loonTlsParams, requiredText, surgeError, surgeTlsParams } = require('../cores/surge/proxy-fields');
const { loonTlsFields, surgeTlsFields } = require('../protocol-parsers/surge-fields');
const { quoted } = require('../protocol-parsers/surge-line');
const { egernTls, requiredValue } = require('../cores/egern/proxy-fields');

module.exports = Object.freeze({
  id: 'hysteria2',
  capability: 'proxy-pool.protocol',
  name: 'Hysteria2',
  protocols: Object.freeze(['hysteria2']),
  aliases: Object.freeze(['hy2']),
  uriSchemes: Object.freeze(['hy2', 'hysteria2']),
  fields: Object.freeze({
    password: 'string',
    insecure: 'boolean',
    obfs: 'string',
    obfsPassword: 'string',
    upMbps: 'positive',
    downMbps: 'positive',
    ...TLS_FIELDS
  }),
  required: Object.freeze(['password']),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['hysteria2', 'hy2']),
      parse: (proxy) => ({
        password: optionalString(proxy.password),
        ...clashTls(proxy, { forceTls: true }),
        obfs: optionalString(proxy.obfs),
        obfsPassword: optionalString(proxy['obfs-password']),
        upMbps: numericRate(proxy.up),
        downMbps: numericRate(proxy.down)
      })
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['hysteria2']),
      parse(outbound) {
        const obfs = outbound.obfs && typeof outbound.obfs === 'object' ? outbound.obfs : {};
        return {
          password: optionalString(outbound.password),
          ...singBoxTls(outbound, { forceTls: true }),
          obfs: optionalString(obfs.type),
          obfsPassword: optionalString(obfs.password),
          upMbps: numericRate(outbound.up_mbps),
          downMbps: numericRate(outbound.down_mbps)
        };
      }
    }),
    surge: Object.freeze({
      types: Object.freeze(['hysteria2']),
      parse: ({ params }) => ({
        password: optionalString(params.password),
        ...surgeTlsFields(params, { forceTls: true }),
        downMbps: numericRate(params['download-bandwidth'])
      })
    }),
    loon: Object.freeze({
      types: Object.freeze(['hysteria2']),
      parse: ({ args, params }) => ({
        password: optionalString(args[2]),
        ...loonTlsFields(params, { forceTls: true }),
        downMbps: numericRate(params['download-bandwidth']),
        ...(params['salamander-password'] ? { obfs: 'salamander', obfsPassword: params['salamander-password'] } : {})
      })
    })
  }),
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
    },
    surge(node) {
      if (node.obfs || node.obfsPassword) throw surgeError('unsupported_hysteria2_obfs');
      return {
        type: 'hysteria2',
        params: {
          password: requiredText(node, 'password'),
          ...surgeTlsParams(node),
          'download-bandwidth': node.downMbps
        }
      };
    },
    loon(node) {
      const obfs = String(node.obfs || '').trim().toLowerCase();
      if (obfs && obfs !== 'salamander') throw surgeError(`unsupported_hysteria2_obfs_${obfs}`);
      return {
        type: 'Hysteria2',
        args: [quoted(requiredText(node, 'password'))],
        params: {
          ...loonTlsParams(node, { forceTls: true }),
          'download-bandwidth': node.downMbps,
          'salamander-password': obfs ? quoted(requiredText(node, 'obfsPassword')) : undefined,
          udp: true
        }
      };
    },
    // 带宽（bandwidth）会让 Egern 启用 Brutal 拥塞控制，不从订阅的带宽提示推断。
    egern(node) {
      const obfs = String(node.obfs || '').trim().toLowerCase();
      if (obfs && obfs !== 'salamander') throw surgeError(`unsupported_hysteria2_obfs_${obfs}`);
      return {
        type: 'hysteria2',
        fields: {
          auth: requiredValue(node, 'password'),
          ...egernTls(node),
          obfs: obfs || undefined,
          obfs_password: obfs ? requiredValue(node, 'obfsPassword') : undefined
        }
      };
    }
  })
});
