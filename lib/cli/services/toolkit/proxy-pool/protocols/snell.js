'use strict';

const { requiredString } = require('../cores/mihomo/proxy-fields');
const { requiredText } = require('../cores/surge/proxy-fields');
const { protocolFieldError } = require('../protocol-fields');
const { asObject, optionalString } = require('../protocol-parsers/clash-fields');
const { requiredValue } = require('../cores/egern/proxy-fields');

// Clash 系内核只实现到 v3；v4 / v5 只有 Surge 能用。缺省版本按各客户端自己的默认值处理。
const CLASH_VERSIONS = new Set([1, 2, 3]);

function versionOf(node) {
  const version = Number(node.version);
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

/** Snell（Surge 自有协议）：没有分享链接格式，只从 Surge / Clash 配置读入。 */
module.exports = Object.freeze({
  id: 'snell',
  capability: 'proxy-pool.protocol',
  name: 'Snell',
  protocols: Object.freeze(['snell']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze([]),
  fields: Object.freeze({ psk: 'string', version: 'count', obfs: 'string', obfsHost: 'string' }),
  required: Object.freeze(['psk']),
  // v1 / v2 不支持 UDP（mihomo 遇到 udp: true 会拒绝整份配置）。
  udpRelay: (node) => (versionOf(node) || 0) >= 3,
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
      parse: ({ params }) => ({
        psk: optionalString(params.psk),
        version: versionOf(params),
        obfs: optionalString(params.obfs),
        obfsHost: optionalString(params['obfs-host'])
      })
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
