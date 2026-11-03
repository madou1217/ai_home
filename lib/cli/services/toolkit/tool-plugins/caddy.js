'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeOs = require('node:os');
const crypto = require('node:crypto');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { packageManagerLifecycle, resolveManagedToolDir } = require('../tool-lifecycle/package-manager-lifecycle');
const caddyProvider = require('../edge-proxy/providers/caddy');

const WINDOWS_ARCHIVE = Object.freeze({
  url: 'https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_windows_amd64.zip',
  binaryRelative: 'caddy.exe'
});

const CADDY_CONFIG_TEMPLATE = `# Caddyfile（由 AIH 创建）
:8080 {
	respond "aih caddy ok" 200
}
`;

/** 配置位置沿用入口转发探测（可用 AIH_EDGE_CONTEXT 的 caddyfile 覆盖）。 */
function defaultConfigPath(options = {}) {
  return caddyProvider.resolveConfigPath({ fs: options.fs || nodeFs, env: options.env || {} });
}

function preferredExecutable(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const dir = resolveManagedToolDir('caddy', options);
  if (!dir) return '';
  const candidate = nodePath.join(dir, WINDOWS_ARCHIVE.binaryRelative);
  try {
    return fsImpl.existsSync(candidate) ? candidate : '';
  } catch (_error) {
    return '';
  }
}

/**
 * 保存前用 `caddy validate --config <临时文件>` 校验：Caddyfile 是完整配置，能独立校验，
 * 因此校验失败不落盘（nginx 的片段不行，那边靠应用时的 `nginx -t` + 回滚兜底）。
 */
function verifyCaddyConfig(content, context = {}) {
  const executablePath = String(context.executablePath || '').trim();
  if (!executablePath) return { ok: true, skipped: true };
  const fs = context.fs || nodeFs;
  const spawnSync = context.spawnSync || nodeSpawnSync;
  const tmpFile = nodePath.join(nodeOs.tmpdir(), `aih-caddy-verify-${crypto.randomBytes(4).toString('hex')}.caddy`);
  try {
    fs.writeFileSync(tmpFile, String(content || ''), { encoding: 'utf8', mode: 0o600 });
    const result = spawnSync(executablePath, ['validate', '--config', tmpFile], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    });
    if (result && result.status === 0) return { ok: true };
    const output = `${result && result.stdout || ''}\n${result && result.stderr || ''}\n${result && result.error ? result.error.message : ''}`
      .split(tmpFile).join('Caddyfile')
      .trim();
    return { ok: false, message: output.slice(0, 800) || 'caddy validate 未通过' };
  } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch (_error) { /* 忽略 */ }
  }
}

module.exports = Object.freeze({
  id: 'caddy',
  category: 'edge-entry',
  name: 'caddy',
  role: '给 WebUI 上 HTTPS（证书自动申请）',
  platforms: Object.freeze(['darwin', 'linux', 'win32']),
  commands: Object.freeze(['caddy']),
  versionArgs: Object.freeze([['version']]),
  capabilities: Object.freeze(['detect', 'version', 'config-edit', 'config-validate', 'service']),
  runtimeInspectable: true,
  config: Object.freeze({ name: 'Caddyfile', format: 'text', validate: verifyCaddyConfig }),
  service: Object.freeze({
    processRole: 'caddy',
    homebrewFormula: 'caddy',
    launchArgs: (configPath) => ['run', '--config', configPath],
    defaultConfigPath,
    configTemplate: CADDY_CONFIG_TEMPLATE
  }),
  preferredExecutable,
  lifecycle: packageManagerLifecycle({
    homebrew: 'caddy',
    apt: { packages: ['caddy'] },
    windowsArchive: WINDOWS_ARCHIVE
  })
});
