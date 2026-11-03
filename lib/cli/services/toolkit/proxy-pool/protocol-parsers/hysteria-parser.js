'use strict';

const { formatServerHost, inferCountryCode, normalizeServerHost } = require('./base-parser');
const { firstPortOf, formatPortRanges, normalizePortRanges } = require('../port-range');

/**
 * Hysteria2 分享链接（hy2:// 或 hysteria2://）：hy2://password@server:port?sni=…&insecure=1&obfs=…#name
 * hysteria://（v1）格式不同，由 hysteria1-parser 处理。
 *
 * 端口跳跃有两种写法：`mport=1000-2000,3000`，或者把端口列表直接写在主机段（`host:1000-2000,3000`）。
 * 主机段里出现逗号、短横或冒号时 new URL 会直接判为非法端口，所以这里先自己拆主机段
 * （含 IPv6 的方括号写法），再交给 URLSearchParams 读查询参数。
 */

const PORT_LIST_PATTERN = /[,;\-:]/;

function splitHostPort(hostport) {
  const text = String(hostport || '');
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close === -1) return { host: text, portText: '' };
    const rest = text.slice(close + 1);
    return { host: text.slice(1, close), portText: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  const separator = text.indexOf(':');
  if (separator === -1) return { host: text, portText: '' };
  return { host: text.slice(0, separator), portText: text.slice(separator + 1) };
}

/** 把 `hy2://…` 拆成主机段与查询串；结构不对时返回 null。 */
function splitHysteriaLink(link) {
  const schemeEnd = link.indexOf('://');
  if (schemeEnd === -1) return null;
  const afterScheme = link.slice(schemeEnd + 3);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const remainder = authorityEnd === -1 ? '' : afterScheme.slice(authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at <= 0) return null;
  const hashIndex = remainder.indexOf('#');
  const beforeHash = hashIndex === -1 ? remainder : remainder.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : remainder.slice(hashIndex + 1);
  const queryIndex = beforeHash.indexOf('?');
  return {
    userinfo: authority.slice(0, at),
    ...splitHostPort(authority.slice(at + 1)),
    query: queryIndex === -1 ? '' : beforeHash.slice(queryIndex + 1),
    hash
  };
}

function parseHysteriaLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('hy2://') && !cleanLink.startsWith('hysteria2://')) return null;

  try {
    const parts = splitHysteriaLink(cleanLink);
    if (!parts) return null;

    const password = decodeURIComponent(parts.userinfo);
    const server = normalizeServerHost(parts.host);
    const name = parts.hash ? decodeURIComponent(parts.hash) : 'Hysteria2 Node';
    const params = new URLSearchParams(parts.query);

    // 端口跳跃：mport 优先；没有它时看主机段是不是端口列表。单端口不算跳跃。
    const mport = params.get('mport') || '';
    const portText = String(parts.portText || '').trim();
    const isPortList = PORT_LIST_PATTERN.test(portText);
    const hostPorts = isPortList ? normalizePortRanges(portText) : undefined;
    const ports = (mport ? normalizePortRanges(mport) : undefined) || hostPorts;
    // 主机段写了单个端口就用它；只给了端口列表时取列表里的第一个端口。
    const singlePort = /^\d{1,5}$/.test(portText) ? Number(portText) : undefined;
    if (portText && singlePort === undefined && !hostPorts) return null;
    const port = singlePort || firstPortOf(ports) || 443;

    if (!password || !server || !port) return null;

    const sni = params.get('sni') || '';
    const insecure = params.get('insecure') === '1';
    const obfs = params.get('obfs') || '';
    const obfsPassword = params.get('obfs-password') || '';
    const upmbps = params.get('upmbps') || '';
    const downmbps = params.get('downmbps') || '';
    const hopInterval = Number(params.get('hop-interval'));

    const country = inferCountryCode(name, server);

    return {
      protocol: 'hysteria2',
      name,
      server,
      port: Number(port),
      password,
      tls: true,
      sni: sni || undefined,
      insecure,
      obfs: obfs || undefined,
      obfsPassword: obfsPassword || undefined,
      upMbps: upmbps ? Number(upmbps) : undefined,
      downMbps: downmbps ? Number(downmbps) : undefined,
      ports,
      hopInterval: Number.isFinite(hopInterval) && hopInterval > 0 ? hopInterval : undefined,
      countryCode: country.code,
      countryName: country.name,
      countryFlag: country.flag,
      rawUri: cleanLink
    };
  } catch (_e) {
    return null;
  }
}

function encodeHysteriaLink(node) {
  const scheme = 'hy2';
  const params = new URLSearchParams();
  if (node.sni) params.set('sni', node.sni);
  if (node.insecure) params.set('insecure', '1');
  if (node.obfs) params.set('obfs', node.obfs);
  if (node.obfsPassword) params.set('obfs-password', node.obfsPassword);
  if (node.upMbps) params.set('upmbps', String(node.upMbps));
  if (node.downMbps) params.set('downmbps', String(node.downMbps));
  // 端口跳跃写在 mport 里；主机段只放单个端口（列表写法各家客户端支持不一）。
  const mport = formatPortRanges(node.ports);
  if (mport) params.set('mport', mport);

  const query = params.toString() ? `?${params.toString()}` : '';
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `${scheme}://${encodeURIComponent(node.password)}@${formatServerHost(node.server)}:${node.port}${query}${hash}`;
}

module.exports = {
  parseHysteriaLink,
  encodeHysteriaLink
};
