'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { packageManagerLifecycle, resolveManagedToolDir } = require('../tool-lifecycle/package-manager-lifecycle');
const nginxProvider = require('../edge-proxy/providers/nginx');

// Windows 官方 zip 里的顶层目录随版本变，这里声明二进制相对路径用于探测。
const WINDOWS_ARCHIVE = Object.freeze({
  url: 'https://nginx.org/download/nginx-1.28.3.zip',
  binaryRelative: 'nginx-1.28.3/nginx.exe'
});

const NGINX_CONFIG_TEMPLATE = `# nginx 配置（由 AIH 创建）
worker_processes auto;
events { worker_connections 1024; }
http {
  default_type application/octet-stream;
  server {
    listen 8080;
    location / { return 200 'aih nginx ok\\n'; }
  }
}
`;

/** 配置位置沿用入口转发里那套探测（brew 前缀从 `nginx -V` 读，可用 AIH_EDGE_NGINX_CONF_DIR 覆盖）。 */
function defaultConfigPath(options = {}) {
  const dir = nginxProvider.resolveConfigDir({ fs: options.fs || nodeFs, env: options.env || {} });
  return dir ? nodePath.join(dir, 'nginx.conf') : '';
}

// AIH 自管安装位置（Windows 压缩包）优先于 PATH。
function preferredExecutable(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const dir = resolveManagedToolDir('nginx', options);
  if (!dir) return '';
  const candidate = nodePath.join(dir, WINDOWS_ARCHIVE.binaryRelative);
  try {
    return fsImpl.existsSync(candidate) ? candidate : '';
  } catch (_error) {
    return '';
  }
}

module.exports = Object.freeze({
  id: 'nginx',
  category: 'edge-entry',
  name: 'nginx',
  role: '本机入口：一个端口同时装 HTTPS(WebUI) 与 SOCKS5 中转',
  platforms: Object.freeze(['darwin', 'linux', 'win32']),
  commands: Object.freeze(['nginx']),
  versionArgs: Object.freeze([['-v']]),
  capabilities: Object.freeze(['detect', 'version', 'config-edit', 'service']),
  runtimeInspectable: true,
  // nginx.conf 是真配置的上下文入口：片段（stream / server）由「入口与转发」写，并在那里跑 `nginx -t` 校验。
  config: Object.freeze({ name: 'nginx.conf', format: 'text' }),
  service: Object.freeze({
    processRole: 'nginx',
    homebrewFormula: 'nginx',
    launchArgs: (configPath) => ['-c', configPath],
    defaultConfigPath,
    configTemplate: NGINX_CONFIG_TEMPLATE
  }),
  preferredExecutable,
  lifecycle: packageManagerLifecycle({
    homebrew: 'nginx',
    apt: { packages: ['nginx', 'libnginx-mod-stream'] },
    windowsArchive: WINDOWS_ARCHIVE
  })
});
