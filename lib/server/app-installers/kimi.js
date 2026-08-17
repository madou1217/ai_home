'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCommandPlan,
  buildNpmPlan,
  normalizePlatform
} = require('./official-install');

const KIMI_INSTALL_SH = 'https://code.kimi.com/kimi-code/install.sh';
const KIMI_INSTALL_PS1 = 'https://code.kimi.com/kimi-code/install.ps1';

function collectCliPathEntries(options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  return home ? [require('node:path').join(home, '.local', 'bin')] : [];
}

module.exports = createProviderInstaller({
  provider: 'kimi',
  cli: {
    resolveInstallPlans: (options = {}) => {
      const platform = normalizePlatform(options);
      const official = platform === 'win32'
        ? buildPowerShellScriptPlan({
          id: 'kimi_windows_official',
          label: 'Kimi Code CLI 官方 Windows 安装器',
          url: KIMI_INSTALL_PS1,
          hosts: ['kimi.com'],
          options
        })
        : buildPosixScriptPlan({
          id: 'kimi_posix_official',
          label: 'Kimi Code CLI 官方 macOS/Linux 安装器',
          url: KIMI_INSTALL_SH,
          hosts: ['kimi.com'],
          options
        });
      const uv = buildCommandPlan(
        'kimi_uv_official',
        'uv 安装 Kimi Code CLI（官方文档）',
        normalizePlatform(options) === 'win32' ? 'uv.exe' : 'uv',
        ['tool', 'install', '--python', '3.13', 'kimi-cli']
      );
      const npm = buildNpmPlan('@moonshot-ai/kimi-code', options);
      return npm ? [official, uv, npm] : [official, uv];
    },
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['kimi']
  }
});
