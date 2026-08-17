'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCaskPlan,
  buildWingetPlan,
  buildNpmPlan,
  normalizePlatform
} = require('./official-install');

const CODEX_INSTALL_SH = 'https://chatgpt.com/codex/install.sh';
const CODEX_INSTALL_PS1 = 'https://chatgpt.com/codex/install.ps1';

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const npm = buildNpmPlan('@openai/codex', options);
  const plans = npm ? [npm] : [];
  if (platform === 'darwin') {
    plans.push(buildCaskPlan('codex', 'Homebrew 安装 Codex CLI'));
  }
  plans.push(platform === 'win32'
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
  return home ? [require('node:path').join(home, '.local', 'bin')] : [];
}

module.exports = createProviderInstaller({
  provider: 'codex',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['codex']
  },
  desktop: {
    darwin: { plans: [buildCaskPlan('chatgpt', 'Homebrew 安装 ChatGPT Desktop')] },
    win32: { plans: [buildWingetPlan('OpenAI.ChatGPT', 'winget 安装 ChatGPT Desktop')] }
  }
});
