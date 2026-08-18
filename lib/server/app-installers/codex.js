'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCaskPlan,
  buildWingetPlan,
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan,
  normalizePlatform
} = require('./official-install');
const { CLIENT_PLATFORMS, getClientPlatformAdapter } = require('../../runtime/client-platform');

const CODEX_INSTALL_SH = 'https://chatgpt.com/codex/install.sh';
const CODEX_INSTALL_PS1 = 'https://chatgpt.com/codex/install.ps1';

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const npm = buildNpmPlan('@openai/codex', options);
  const plans = npm ? [npm] : [];
  if (platform === CLIENT_PLATFORMS.MACOS) {
    plans.push(buildCaskPlan('codex', 'Homebrew 安装 Codex CLI'));
  }
  plans.push(platform === CLIENT_PLATFORMS.WINDOWS
    ? [buildPowerShellScriptPlan({
      id: 'codex_windows_official',
      label: 'Codex 官方 Windows 安装器',
      url: CODEX_INSTALL_PS1,
      hosts: ['chatgpt.com'],
      options
    })]
    : [buildPosixScriptPlan({
      id: 'codex_posix_official',
      label: 'Codex 官方 macOS/Linux 安装器',
      url: CODEX_INSTALL_SH,
      hosts: ['chatgpt.com'],
      options
    })]);
  return plans.flat();
}

function collectCliPathEntries(options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  const adapter = getClientPlatformAdapter(options);
  return home && adapter ? [adapter.path.join(home, '.local', 'bin')] : [];
}

module.exports = createProviderInstaller({
  provider: 'codex',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    resolveUpdatePlans: (options = {}) => [buildNpmUpdatePlan('@openai/codex', options)].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan('@openai/codex', options)].filter(Boolean),
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['codex']
  },
  desktop: {
    macos: { plans: [buildCaskPlan('chatgpt', 'Homebrew 安装 ChatGPT Desktop')] },
    windows: { plans: [buildWingetPlan('OpenAI.ChatGPT', 'winget 安装 ChatGPT Desktop')] }
  }
});
