'use strict';

const { encodeNaiveLink, parseNaiveLink } = require('../protocol-parsers/naive-parser');
const { requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { protocolFieldError } = require('../protocol-fields');
const { optionalString } = require('../protocol-parsers/clash-fields');

/**
 * NaiveProxy：HTTP/2（或 QUIC）伪装的 HTTPS 代理。只有 sing-box 有出站，而且官方发布的构建里
 * 也不是全都带（需要 libcronet）——所以只在「官方 App」客户端上输出；mihomo 系一律跳过。
 * 分享链接是 `naive+https://` / `naive+quic://`。
 */
module.exports = Object.freeze({
  id: 'naive',
  capability: 'proxy-pool.protocol',
  name: 'NaiveProxy',
  protocols: Object.freeze(['naive']),
  aliases: Object.freeze([]),
  uriSchemes: Object.freeze(['naive+https', 'naive+quic']),
  fields: Object.freeze({ username: 'string', password: 'string', quic: 'boolean', sni: 'string' }),
  required: Object.freeze(['username', 'password']),
  singBoxSince: '1.13.0',
  imports: Object.freeze({
    'sing-box': Object.freeze({
      types: Object.freeze(['naive']),
      parse(outbound) {
        const tls = outbound.tls && typeof outbound.tls === 'object' ? outbound.tls : {};
        return {
          username: optionalString(outbound.username),
          password: optionalString(outbound.password),
          quic: outbound.quic === true || undefined,
          sni: optionalString(tls.server_name)
        };
      }
    })
  }),
  parse: parseNaiveLink,
  encode: encodeNaiveLink,
  compile: Object.freeze({
    // mihomo 系没有 naive 出站：默认输出格式直接跳过，预览里给出原因。
    mihomo() {
      throw protocolFieldError('unsupported_proxy_protocol_naive');
    },
    'sing-box'(node, base, options = {}) {
      // 只有官方 App（自带 libcronet）的内核认得出 naive 出站，自建内核会让整份配置被拒。
      if (options.officialApp !== true) throw protocolFieldError('requires_sing_box_official_app');
      const outbound = {
        ...base,
        username: requireSingBoxString(node.username, 'missing_required_proxy_field_username'),
        password: requireSingBoxString(node.password, 'missing_required_proxy_field_password'),
        // naive 的 tls 只认 server_name / certificate / certificate_path / ech。
        tls: { enabled: true }
      };
      if (node.quic === true) outbound.quic = true;
      if (node.sni) outbound.tls.server_name = String(node.sni);
      return outbound;
    }
  })
});
