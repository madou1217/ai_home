'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');

/**
 * nginx provider：生成本机反代/转发配置、校验（`nginx -t`）、重载（`nginx -s reload`）。
 *
 * 三种形态（plan.mode）：
 * - `split`（推荐）：**一个公网端口同时扛 HTTPS（WebUI）与 SOCKS5（中转）+ UDP**。
 *   443/TCP 用 `ssl_preread` 分流：TLS 交给本地终结（真证书、WebUI 走 https），非 TLS 直接进 AIH
 *   （AIH 自己的首字节分流认 0x05）；443/UDP 直接透传给 AIH 的 UDP relay。
 * - `passthrough`：只做四层透传（TCP+UDP），最省事；WebUI 就只能 http（或另开端口）。
 * - `http-only`：只在应用层做 TLS 反代（WebUI https）；SOCKS5 上不了这个端口，中转得走别的路
 *   （frp / dedicated 模式）。等价于「Caddy 那种」能力。
 *
 * 与 nginx.conf 的关系：stream 块必须在顶层，站点块在 http 内。所以本 provider 写两个文件，
 * 并在 nginx.conf 里**幂等地**补 include（写入前备份；`nginx -t` 不过就整体回滚）。
 */

const MARKER = '# managed by aih (edge-proxy)';
const SITE_MARKER = `${MARKER} - site`;

function resolveBinary({ fs: fsImpl = nativeFs, env = {} } = {}) {
  const candidates = [
    env.AIH_EDGE_NGINX_BIN,
    '/opt/homebrew/bin/nginx',
    '/usr/local/bin/nginx',
    '/usr/sbin/nginx',
    '/usr/bin/nginx'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fsImpl.accessSync(candidate, fsImpl.constants?.X_OK || nativeFs.constants.X_OK);
      return candidate;
    } catch (_error) { /* 试下一个 */ }
  }
  return '';
}

/** 从 `nginx -V` 的 stderr 里抠出配置目录（--conf-path 所在目录）；抠不到给常见默认值。 */
function configDirFromVersionOutput(output) {
  const match = /--conf-path=([^\s]+)/.exec(String(output || ''));
  if (!match) return '';
  return nativePath.dirname(match[1]);
}

function resolveConfigDir({ fs: fsImpl = nativeFs, env = {}, versionOutput = '' } = {}) {
  const explicit = String(env.AIH_EDGE_NGINX_CONF_DIR || '').trim();
  if (explicit) return explicit;
  const fromVersion = configDirFromVersionOutput(versionOutput);
  const candidates = [fromVersion, '/opt/homebrew/etc/nginx', '/usr/local/etc/nginx', '/etc/nginx'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fsImpl.existsSync(candidate)) return candidate;
    } catch (_error) { /* 试下一个 */ }
  }
  return '';
}

function fileNames(domain) {
  const safe = String(domain || 'aih').replace(/[^A-Za-z0-9.-]/g, '_');
  return {
    streamFile: 'aih-edge-stream.conf',
    siteFile: `aih-edge-${safe}.conf`
  };
}

/** 顶层 stream 段（TLS 与 SOCKS5 分流 + UDP 透传）。 */
function streamConfig({ domain, aihPort, tlsTerminatorPort }) {
  return `${MARKER}
# 一个公网端口同时承载：HTTPS（WebUI，TLS 在这里终结）与 SOCKS5（AIH 中转）+ UDP relay。
# 依据：TLS ClientHello 以 0x16 开头、SOCKS5 以 0x05 开头，用 ssl_preread 分辨（nginx 1.25+）。
map $ssl_preread_protocol $aih_443_backend {
    ""      127.0.0.1:${aihPort};          # 非 TLS：SOCKS5 客户端 → AIH 首字节分流
    default 127.0.0.1:${tlsTerminatorPort}; # TLS：交给下面本地那个 HTTPS 前端终结
}

server {
    listen 443;
    listen [::]:443;
    ssl_preread on;
    proxy_pass $aih_443_backend;
    proxy_connect_timeout 5s;
    proxy_timeout 1h;      # 代理会话可能很长
}

# UDP relay（SOCKS5 UDP ASSOCIATE 的数据报）直接透传：QUIC/HTTP3、DoQ、游戏都走这里。
server {
    listen 443 udp;
    listen [::]:443 udp;
    proxy_pass 127.0.0.1:${aihPort};
    proxy_timeout 60s;
}
`;
}

/** TLS 终结 + 反代到 AIH（只服务 WebUI/API；SOCKS5 不走这里）。 */
function siteConfig({ domain, aihPort, tlsTerminatorPort, certDir }) {
  const cert = certDir ? `\n    ssl_certificate     ${certDir}/fullchain.pem;\n    ssl_certificate_key ${certDir}/privkey.pem;` : '';
  return `${SITE_MARKER} (${domain})
server {
    listen 127.0.0.1:${tlsTerminatorPort} ssl;
    server_name ${domain};${cert}

    location / {
        proxy_pass http://127.0.0.1:${aihPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        # SSE / WebSocket / 长轮询：不能缓冲，读超时放长。
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
}

/** 纯应用层反代（http-only）：WebUI 上 https，中转不在这个端口上。 */
function httpOnlySiteConfig({ domain, aihPort, certDir }) {
  const cert = certDir ? `\n    ssl_certificate     ${certDir}/fullchain.pem;\n    ssl_certificate_key ${certDir}/privkey.pem;` : '';
  return `${SITE_MARKER} (${domain})
server {
    listen 443 ssl;
    server_name ${domain};${cert}

    location / {
        proxy_pass http://127.0.0.1:${aihPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
}

/** 纯四层透传（TCP+UDP → AIH）：最省事，但 WebUI 只能 http。 */
function passthroughStreamConfig({ aihPort }) {
  return `${MARKER}
server {
    listen 443;
    listen [::]:443;
    proxy_pass 127.0.0.1:${aihPort};
    proxy_timeout 1h;
}

server {
    listen 443 udp;
    listen [::]:443 udp;
    proxy_pass 127.0.0.1:${aihPort};
    proxy_timeout 60s;
}
`;
}

module.exports = {
  MARKER,
  SITE_MARKER,
  configDirFromVersionOutput,
  fileNames,
  httpOnlySiteConfig,
  passthroughStreamConfig,
  resolveBinary,
  resolveConfigDir,
  siteConfig,
  streamConfig
};
