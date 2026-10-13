'use strict';

const { requiredString } = require('../cores/mihomo/proxy-fields');
const { requiredText } = require('../cores/surge/proxy-fields');
const { requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { protocolFieldError } = require('../protocol-fields');
const { asObject, optionalString } = require('../protocol-parsers/clash-fields');
const { requiredValue } = require('../cores/egern/proxy-fields');

// Clash 系内核只实现到 v3；v4 / v5 只有 Surge 能用。缺省版本按各客户端自己的默认值处理。
const CLASH_VERSIONS = new Set([1, 2, 3]);
// sing-box 1.14 起有 snell 出站，但只实现 v4 与 v6（v5 的 QUIC 模式不做）。
const SING_BOX_VERSIONS = new Set([4, 6]);

function versionOf(node) {
  const version = Number(node.version);
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

/** Snell（Surge 自有协议）：没有分享链接格式，只从 Surge / Clash / sing-box 配置读入。 */
module.exports = Object.freeze({
  id: 'snell',
  capability: 'proxy-pool.protocol',
  name: 'Snell',
  protocols: Object.freeze(['snell']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze([]),
  fields: Object.freeze({ psk: 'string', version: 'count', obfs: 'string', obfsHost: 'string', mode: 'string' }),
  required: Object.freeze(['psk']),
  // v1 / v2 不支持 UDP（mihomo 遇到 udp: true 会拒绝整份配置）。
  udpRelay: (node) => (versionOf(node) || 0) >= 3,
  // v6 的流量整形（mode）由客户端自选，服务端都接受，不计入连接指纹。
  clientTuning: Object.freeze(['mode']),
  singBoxSince: '1.14.0',
  form: Object.freeze({
    options: Object.freeze({
      version: Object.freeze([1, 2, 3, 4, 5]),
      obfs: Object.freeze(['http', 'tls']),
      mode: Object.freeze(['default', 'unshaped', 'unsafe-raw'])
    }),
    defaults: Object.freeze({ version: 4 })
  }),
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['snell']),
      parse(proxy) {
        const obfs = asObject(proxy['obfs-opts']);
        return {
          psk: optionalString(proxy.psk),
          version: versionOf(proxy),
          obfs: optionalString(obfs.mode),
          obfsHost: optionalString(obfs.host)
        };
      }
    }),
    surge: Object.freeze({
      types: Object.freeze(['snell']),
      parse({ params }) {
        // Surge 的 Snell 可以套 ShadowTLS，但我们的节点模型把 ShadowTLS 表达在 Shadowsocks 上，
        // 这里表达不了就明确跳过并给出原因，不静默丢掉 shadow-tls-* 参数（丢参数会连错服务器）。
        const shadowTls = ['shadow-tls-password', 'shadow-tls-sni', 'shadow-tls-version']
          .find((key) => params[key] !== undefined);
        if (shadowTls) throw protocolFieldError('unsupported_surge_snell_shadow_tls');
        return {
          psk: optionalString(params.psk),
          version: versionOf(params),
          obfs: optionalString(params.obfs),
          obfsHost: optionalString(params['obfs-host'])
        };
      }
    }),
    egern: Object.freeze({
      types: Object.freeze(['snell']),
      parse: (proxy) => ({
        psk: optionalString(proxy.psk),
        version: versionOf(proxy),
        obfs: optionalString(proxy.obfs),
        obfsHost: optionalString(proxy.obfs_host)
      })
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['snell']),
      parse(outbound) {
        const obfs = optionalString(outbound.obfs_mode);
        const http = String(obfs || '').trim().toLowerCase() === 'http';
        return {
          psk: optionalString(outbound.psk),
          version: versionOf(outbound),
          obfs: http ? 'http' : undefined,
          obfsHost: http ? optionalString(outbound.obfs_host) : undefined,
          mode: optionalString(outbound.mode)
        };
      }
    })
  }),
  parse: () => null,
  encode: () => '',
  compile: Object.freeze({
    mihomo(node, proxy) {
      const version = versionOf(node);
      if (version !== undefined && !CLASH_VERSIONS.has(version)) throw protocolFieldError(`unsupported_snell_version_${version}`);
      proxy.type = 'snell';
      proxy.psk = requiredString(node, 'psk');
      if (version !== undefined) proxy.version = version;
      if (node.obfs) proxy['obfs-opts'] = { mode: String(node.obfs), host: node.obfsHost ? String(node.obfsHost) : undefined };
      return proxy;
    },
    surge: (node) => ({
      type: 'snell',
      params: {
        psk: requiredText(node, 'psk'),
        version: versionOf(node),
        obfs: node.obfs || undefined,
        'obfs-host': node.obfs ? node.obfsHost || undefined : undefined
      }
    }),
    // sing-box 1.14 起有 snell 出站（低版本由 singBoxSince 拦在渲染前）。
    'sing-box'(node, base) {
      const version = versionOf(node);
      if (!SING_BOX_VERSIONS.has(version)) {
        throw protocolFieldError(`unsupported_sing_box_snell_version_${version ?? 'unknown'}`);
      }
      const outbound = {
        ...base,
        version,
        psk: requireSingBoxString(node.psk, 'missing_required_proxy_field_psk')
      };
      if (version === 4) {
        const obfs = String(node.obfs || '').trim().toLowerCase();
        // sing-box 的 v4 只认 none / http；Snell v3 的 tls 混淆它没实现。
        if (obfs === 'tls') throw protocolFieldError('unsupported_sing_box_snell_obfs_tls');
        if (obfs === 'http') {
          outbound.obfs_mode = 'http';
          if (node.obfsHost) outbound.obfs_host = String(node.obfsHost);
        }
      } else if (node.mode) {
        outbound.mode = String(node.mode);
      }
      return outbound;
    },
    egern(node) {
      const version = versionOf(node);
      return {
        type: 'snell',
        fields: {
          psk: requiredValue(node, 'psk'),
          version,
          obfs: node.obfs || undefined,
          obfs_host: node.obfs ? node.obfsHost || undefined : undefined,
          udp_relay: (version || 1) >= 3 || undefined
        }
      };
    }
  })
});
