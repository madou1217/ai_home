'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { resolvePlatformPath } = require('../../../../runtime/platform-path');
const { packageManagerLifecycle } = require('../tool-lifecycle/package-manager-lifecycle');
const { tmuxConfigPath } = require('./session-config');

function resolveEnv(options = {}) {
  const processObj = options.processObj || process;
  return options.env || processObj.env || process.env || {};
}

// psmux 由 WinGet 安装时只在 Links 目录落地，服务进程 PATH 往往不含该目录。
function resolveWingetLinkPath(options = {}) {
  const env = resolveEnv(options);
  const pathImpl = resolvePlatformPath('win32', options.path || nodePath);
  const fsImpl = options.fs || nodeFs;
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || env.localappdata || '';
  const userProfile = env.USERPROFILE || env.UserProfile || env.userprofile || '';
  const candidates = Array.from(new Set([
    localAppData && pathImpl.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'psmux.exe'),
    userProfile && pathImpl.join(userProfile, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'psmux.exe')
  ].filter(Boolean)));
  return candidates.find((candidate) => {
    try { return fsImpl.existsSync(candidate); } catch (_error) { return false; }
  }) || '';
}

module.exports = Object.freeze({
  id: 'psmux',
  category: 'session-runtimes',
  name: 'psmux',
  role: 'Windows 原生 tmux 兼容运行时',
  platforms: Object.freeze(['win32']),
  commands: Object.freeze(['psmux']),
  versionArgs: Object.freeze([['-V'], ['--version']]),
  capabilities: Object.freeze(['detect', 'version', 'sessions', 'config-edit']),
  config: Object.freeze({ name: '.tmux.conf', format: 'text', resolvePath: tmuxConfigPath,
    template: '# psmux user configuration\n', note: '宿主 psmux 配置。AIH 交互会话使用独立的透明配置。' }),
  lifecycle: packageManagerLifecycle({ winget: 'marlocarlo.psmux' }),
  resolveExecutableFallback: resolveWingetLinkPath
});
