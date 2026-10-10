'use strict';

const { formatServerHost, inferCountryCode, normalizeServerHost, parseUrlSafe } = require('./base-parser');

/**
 * Hysteria2 分享链接（hy2:// 或 hysteria2://）：hy2://password@server:port?sni=…&insecure=1&obfs=…#name
 * hysteria://（v1）格式不同，由 hysteria1-parser 处理。
 */
function parseHysteriaLink(link) {
  const cleanLink = String(link || '').trim();
  if (!cleanLink.startsWith('hy2://') && !cleanLink.startsWith('hysteria2://')) return null;

  try {
    const url = parseUrlSafe(cleanLink);
    if (!url) return null;

    const password = decodeURIComponent(url.username);
    const server = normalizeServerHost(url.hostname);
    const port = parseInt(url.port || '443', 10);
    const name = url.hash ? decodeURIComponent(url.hash.slice(1)) : 'Hysteria2 Node';

    if (!password || !server || !port) return null;

    const params = url.searchParams;
    const sni = params.get('sni') || '';
    const insecure = params.get('insecure') === '1';
    const obfs = params.get('obfs') || '';
    const obfsPassword = params.get('obfs-password') || '';
    const upmbps = params.get('upmbps') || '';
    const downmbps = params.get('downmbps') || '';

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

  const query = params.toString() ? `?${params.toString()}` : '';
  const hash = node.name ? `#${encodeURIComponent(node.name)}` : '';
  return `${scheme}://${encodeURIComponent(node.password)}@${formatServerHost(node.server)}:${node.port}${query}${hash}`;
}

module.exports = {
  parseHysteriaLink,
  encodeHysteriaLink
};
