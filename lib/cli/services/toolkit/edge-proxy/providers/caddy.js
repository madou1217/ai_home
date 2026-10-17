'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');

const { readEdgeContextField } = require('../edge-context');

/**
 * Caddy provider：Caddy 自己会申请/续期证书、自己管 HTTPS，所以这里只生成本机反代片段。
 *
 * 边界（必须说清）：**标准 Caddy 不带四层转发**（要 `caddy-l4` 插件、得用 xcaddy 自编译），
 * 所以 Caddy 只能做应用层（WebUI https）；要让「一个端口同时扛 HTTPS 与 SOCKS5」得用 nginx 的
 * ssl_preread 形态或 frp。中转的 SOCKS5 走别的路（frp / dedicated 端口）。
 */

function resolveBinary({ fs: fsImpl = nativeFs, env = {} } = {}) {
  const candidates = [
    readEdgeContextField(env, 'caddyBin'),
    '/opt/homebrew/bin/caddy',
    '/usr/local/bin/caddy',
    '/usr/bin/caddy'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fsImpl.accessSync(candidate, fsImpl.constants?.X_OK || nativeFs.constants.X_OK);
      return candidate;
    } catch (_error) { /* 试下一个 */ }
  }
  return '';
}

function resolveConfigPath({ fs: fsImpl = nativeFs, env = {} } = {}) {
  const explicit = String(readEdgeContextField(env, 'caddyfile')).trim();
  if (explicit) return explicit;
  for (const candidate of ['/opt/homebrew/etc/Caddyfile', '/usr/local/etc/Caddyfile', '/etc/caddy/Caddyfile']) {
    try {
      if (fsImpl.existsSync(candidate)) return candidate;
    } catch (_error) { /* 试下一个 */ }
  }
  return '';
}

function configPathFromArgs(command) {
  const match = /(?:--config|-c)\s+("[^"]+"|[^\s]+)/.exec(String(command || ''));
  if (!match) return '';
  return match[1].replace(/^"|"$/g, '');
}

/** 站点片段：Caddy 自动申请证书并把 AIH 反代到 https://<domain>。 */
function siteConfig({ domain, aihPort }) {
  return `# managed by aih (edge-proxy)
${domain} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:${aihPort} {
		flush_interval -1
		header_up X-Forwarded-Host {host}
	}
}
`;
}

module.exports = {
  configPathFromArgs,
  nativePath,
  resolveBinary,
  resolveConfigPath,
  siteConfig
};
