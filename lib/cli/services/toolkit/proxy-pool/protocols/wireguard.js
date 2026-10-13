'use strict';

const { encodeWireGuardLink, parseWireGuardLink, splitAddresses, splitWireGuardEndpoint } = require('../protocol-parsers/wireguard-parser');
const { formatServerHost } = require('../protocol-parsers/base-parser');
const { requiredString } = require('../cores/mihomo/proxy-fields');
const { configError, requiredString: requireSingBoxString } = require('../cores/sing-box/outbound-fields');
const { requiredText, surgeError } = require('../cores/surge/proxy-fields');
const { asObject, optionalString } = require('../protocol-parsers/clash-fields');
const { quoted, raw, splitTopLevel, unquote } = require('../protocol-parsers/surge-line');
const { requiredValue } = require('../cores/egern/proxy-fields');
const { protocolFieldError } = require('../protocol-fields');
const { SECTION_SLOT } = require('../compile-result');

const TUNNEL_PREFIX = /\/(?:32|128)$/;

// reserved 两种写法：逗号分隔的字节（1,2,3）或 base64 字符串；内核都接受数组或字符串。
function reservedValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return /^\d{1,3}(?:\s*,\s*\d{1,3}){2}$/.test(text) ? text.split(',').map((item) => Number(item.trim())) : text;
}

// Egern 只收三个字节的数组：base64 写法解码成字节。
function reservedBytes(value) {
  const reserved = reservedValue(value);
  if (reserved === undefined) return undefined;
  const bytes = Array.isArray(reserved) ? reserved : [...Buffer.from(reserved, 'base64')];
  if (bytes.length !== 3 || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw protocolFieldError('invalid_proxy_field_reserved');
  }
  return bytes;
}

function reservedText(value) {
  if (Array.isArray(value)) return value.join(',');
  return optionalString(value);
}

/** Surge 的 self-ip / Loon 的 interface-ip 都写纯地址，不带 /32、/128。 */
function addressOnly(value) {
  const text = String(value ?? '').trim();
  return text ? text.replace(TUNNEL_PREFIX, '') : '';
}

/** 隧道本机地址：Surge 的 self-ip 与 Loon 的 interface-ip 至少要有其一。 */
function tunnelAddresses(node) {
  const ip = addressOnly(node.ip);
  const ipv6 = addressOnly(node.ipv6);
  if (!ip && !ipv6) throw surgeError('missing_required_proxy_field_ip');
  return { ip, ipv6 };
}

function endpointText(node) {
  const server = String(node.server || '').trim();
  const port = Number(node.port);
  if (!server || !Number.isInteger(port) || port <= 0) throw surgeError('invalid_wireguard_endpoint');
  return `${formatServerHost(server)}:${port}`;
}

/** `(public-key = …, allowed-ips = "…")` / `{…}` / `[…]` → 字段表（方括号与引号里的逗号不算分隔符）。 */
function delimitedFields(value) {
  const text = String(value ?? '').trim();
  const inner = /^[[({]/.test(text) && /[\])}]$/.test(text) ? text.slice(1, -1) : text;
  const fields = {};
  for (const token of splitTopLevel(inner)) {
    const match = token.match(/^([A-Za-z0-9-]+)\s*=\s*([\s\S]*)$/);
    if (match) fields[match[1].toLowerCase()] = unquote(match[2]);
  }
  return fields;
}

/** `[WireGuard x]` 段的正文（`key = value` 每行一条）→ 字段表。 */
function sectionFields(lines) {
  const fields = {};
  for (const line of lines || []) {
    const match = String(line).match(/^\s*([A-Za-z0-9-]+)\s*=\s*([\s\S]*?)\s*$/);
    if (match) fields[match[1].toLowerCase()] = match[2];
  }
  return fields;
}

/** Surge 的 client-id（83/12/235）与 Loon 的 reserved=[1,2,3] 都还原成节点的 reserved 写法。 */
function reservedFromList(value) {
  const text = String(value ?? '').trim().replace(/[[\]]/g, '');
  if (!text) return undefined;
  return text.includes('/') ? text.split('/').map((item) => item.trim()).join(',') : text;
}

// 本机地址可以是字符串或列表 → splitAddresses 认的逗号分隔写法。
function localAddresses(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join(',');
}

// 本机地址带前缀长度时原样使用，否则按单主机补 /32、/128。
function addresses(node) {
  const withPrefix = (address, bits) => (String(address).includes('/') ? String(address) : `${address}/${bits}`);
  const list = [node.ip ? withPrefix(node.ip, 32) : '', node.ipv6 ? withPrefix(node.ipv6, 128) : ''].filter(Boolean);
  if (!list.length) throw configError('missing_required_proxy_field_ip');
  return list;
}

module.exports = Object.freeze({
  id: 'wireguard',
  capability: 'proxy-pool.protocol',
  name: 'WireGuard',
  protocols: Object.freeze(['wireguard']),
  aliases: Object.freeze(['wg']),
  uriSchemes: Object.freeze(['wireguard', 'wg']),
  fields: Object.freeze({
    privateKey: 'string',
    publicKey: 'string',
    presharedKey: 'string',
    ip: 'string',
    ipv6: 'string',
    mtu: 'count',
    reserved: 'string'
  }),
  required: Object.freeze(['privateKey', 'publicKey']),
  // sing-box 1.11 起 WireGuard 是 endpoint（1.13 移除了旧式 outbound），写在配置的 endpoints 里。
  singBoxSection: 'endpoints',
  singBoxSince: '1.11.0',
  imports: Object.freeze({
    clash: Object.freeze({
      types: Object.freeze(['wireguard']),
      parse(proxy) {
        // mihomo 也允许把对端写进 peers 列表：取第一个对端。
        const peer = Array.isArray(proxy.peers) && proxy.peers.length ? asObject(proxy.peers[0]) : {};
        const source = Object.keys(peer).length ? peer : proxy;
        return {
          ...(Object.keys(peer).length ? { server: peer.server, port: Number(peer.port) } : {}),
          privateKey: optionalString(proxy['private-key']),
          publicKey: optionalString(source['public-key']),
          presharedKey: optionalString(source['pre-shared-key'] ?? source['preshared-key']),
          ip: optionalString(proxy.ip),
          ipv6: optionalString(proxy.ipv6),
          mtu: Number(proxy.mtu) || undefined,
          reserved: reservedText(source.reserved)
        };
      }
    }),
    'sing-box': Object.freeze({
      types: Object.freeze(['wireguard']),
      parse(entry) {
        // endpoint 与旧式多对端 outbound 把对端写在 peers 里（取第一个）；旧式单对端直接带 server 与 peer_public_key。
        const peer = Array.isArray(entry.peers) && entry.peers.length ? asObject(entry.peers[0]) : null;
        const local = entry.address ?? entry.local_address;
        return {
          ...(peer ? { server: optionalString(peer.address ?? peer.server), port: Number(peer.port ?? peer.server_port) } : {}),
          privateKey: optionalString(entry.private_key),
          publicKey: optionalString(peer ? peer.public_key : entry.peer_public_key),
          presharedKey: optionalString(peer ? peer.pre_shared_key : entry.pre_shared_key),
          ...splitAddresses(localAddresses(local)),
          mtu: Number(entry.mtu) || undefined,
          reserved: reservedText(peer ? peer.reserved : entry.reserved)
        };
      }
    }),
    egern: Object.freeze({
      types: Object.freeze(['wireguard']),
      parse: (proxy) => ({
        privateKey: optionalString(proxy.private_key),
        publicKey: optionalString(proxy.peer_public_key),
        presharedKey: optionalString(proxy.preshared_key),
        ip: optionalString(proxy.local_ipv4),
        ipv6: optionalString(proxy.local_ipv6),
        mtu: Number(proxy.mtu) || undefined,
        reserved: reservedText(proxy.reserved)
      })
    }),
    // 解析器已从 peers[0].endpoint 取出服务器，user 即这个对端；本机私钥、地址、MTU 与 reserved 在 settings 上。
    xray: Object.freeze({
      types: Object.freeze(['wireguard']),
      parse({ outbound, user }) {
        const settings = asObject(outbound.settings);
        return {
          privateKey: optionalString(settings.secretKey),
          publicKey: optionalString(user.publicKey),
          presharedKey: optionalString(user.preSharedKey),
          ...splitAddresses(localAddresses(settings.address)),
          mtu: Number(settings.mtu) || undefined,
          reserved: reservedText(settings.reserved)
        };
      }
    }),
    // Surge / Surfboard：代理行只引用 section-name，地址与密钥在同名 [WireGuard x] 段里。
    surge: Object.freeze({
      types: Object.freeze(['wireguard']),
      parse({ sections }) {
        const fields = sections || {};
        const peer = delimitedFields(fields.peer);
        const endpoint = splitWireGuardEndpoint(peer.endpoint);
        return {
          server: endpoint.address,
          port: endpoint.port,
          privateKey: optionalString(fields['private-key']),
          publicKey: optionalString(peer['public-key']),
          presharedKey: optionalString(peer['preshared-key']),
          ...splitAddresses([fields['self-ip'], fields['self-ip-v6']].filter(Boolean).join(',')),
          mtu: Number(fields.mtu) || undefined,
          reserved: reservedFromList(peer['client-id'])
        };
      }
    }),
    // Loon：地址、密钥与对端都在代理行里（interface-ip / private-key / peers=[{…}]）。
    loon: Object.freeze({
      types: Object.freeze(['wireguard']),
      parse({ params }) {
        const peer = delimitedFields(String(params.peers || '').replace(/^\s*\[/, '').replace(/\]\s*$/, ''));
        const endpoint = splitWireGuardEndpoint(peer.endpoint);
        return {
          server: endpoint.address,
          port: endpoint.port,
          privateKey: optionalString(params['private-key']),
          publicKey: optionalString(peer['public-key']),
          presharedKey: optionalString(peer['preshared-key']),
          ip: optionalString(params['interface-ip']),
          ipv6: optionalString(params['interface-ipv6']),
          mtu: Number(params.mtu) || undefined,
          reserved: reservedFromList(peer.reserved)
        };
      }
    })
  }),
  parse: parseWireGuardLink,
  encode: encodeWireGuardLink,
  compile: Object.freeze({
    mihomo(node, proxy) {
      proxy.type = 'wireguard';
      proxy['private-key'] = requiredString(node, 'privateKey');
      proxy['public-key'] = requiredString(node, 'publicKey');
      addresses(node);
      if (node.ip) proxy.ip = String(node.ip);
      if (node.ipv6) proxy.ipv6 = String(node.ipv6);
      if (node.presharedKey) proxy['pre-shared-key'] = String(node.presharedKey);
      if (node.mtu) proxy.mtu = Number(node.mtu);
      const reserved = reservedValue(node.reserved);
      if (reserved !== undefined) proxy.reserved = reserved;
      return proxy;
    },
    // endpoint 形态（见 singBoxSection）：对端放进 peers，策略组按 tag 引用。
    'sing-box'(node, base) {
      const peer = {
        address: base.server,
        port: base.server_port,
        public_key: requireSingBoxString(node.publicKey, 'missing_required_proxy_field_publicKey'),
        allowed_ips: ['0.0.0.0/0', '::/0']
      };
      if (node.presharedKey) peer.pre_shared_key = String(node.presharedKey);
      const reserved = reservedValue(node.reserved);
      if (reserved !== undefined) peer.reserved = reserved;
      const endpoint = {
        type: 'wireguard',
        tag: base.tag,
        address: addresses(node),
        private_key: requireSingBoxString(node.privateKey, 'missing_required_proxy_field_privateKey'),
        peers: [peer]
      };
      if (node.mtu) endpoint.mtu = Number(node.mtu);
      return endpoint;
    },
    egern(node) {
      addresses(node);
      return {
        type: 'wireguard',
        fields: {
          private_key: requiredValue(node, 'privateKey'),
          peer_public_key: requiredValue(node, 'publicKey'),
          preshared_key: node.presharedKey || undefined,
          reserved: reservedBytes(node.reserved),
          local_ipv4: node.ip || undefined,
          local_ipv6: node.ipv6 || undefined,
          mtu: node.mtu ? Number(node.mtu) : undefined
        }
      };
    },
    // Surge / Surfboard：代理行只写 section-name，其余在同名 [WireGuard x] 段里。
    // 段名由渲染器按出现顺序编号（行里的 SECTION_SLOT 占位符），避免节点名里的 [ ] 进段头。
    surge(node) {
      const { ip, ipv6 } = tunnelAddresses(node);
      const bytes = reservedBytes(node.reserved);
      const peer = [
        `public-key = ${requiredText(node, 'publicKey')}`,
        node.presharedKey ? `preshared-key = ${String(node.presharedKey)}` : '',
        'allowed-ips = "0.0.0.0/0, ::/0"',
        `endpoint = ${endpointText(node)}`,
        bytes ? `client-id = ${bytes.join('/')}` : ''
      ].filter(Boolean).join(', ');
      return {
        type: 'wireguard',
        omitAddress: true,
        params: { 'section-name': SECTION_SLOT },
        sections: [{
          header: 'WireGuard',
          prefix: 'wg',
          lines: [
            `private-key = ${requiredText(node, 'privateKey')}`,
            ip ? `self-ip = ${ip}` : '',
            ipv6 ? `self-ip-v6 = ${ipv6}` : '',
            node.mtu ? `mtu = ${Number(node.mtu)}` : '',
            `peer = (${peer})`
          ].filter(Boolean)
        }]
      };
    },
    // Loon：全部写在代理行里，对端是原样的 peers=[{…}]（不加引号，里面的逗号不能当分隔符）。
    loon(node) {
      const { ip, ipv6 } = tunnelAddresses(node);
      const bytes = reservedBytes(node.reserved);
      const peer = [
        `public-key="${requiredText(node, 'publicKey')}"`,
        node.presharedKey ? `preshared-key="${String(node.presharedKey)}"` : '',
        bytes ? `reserved=[${bytes.join(',')}]` : '',
        'allowed-ips="0.0.0.0/0,::/0"',
        `endpoint=${endpointText(node)}`
      ].filter(Boolean).join(',');
      return {
        type: 'WireGuard',
        omitAddress: true,
        params: {
          'interface-ip': ip || undefined,
          'interface-ipv6': ipv6 || undefined,
          'private-key': quoted(requiredText(node, 'privateKey')),
          mtu: node.mtu ? Number(node.mtu) : undefined,
          peers: raw(`[{${peer}}]`),
          udp: true
        }
      };
    }
  })
});
