'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCmdScriptPlan,
  buildCaskPlan,
  buildWingetPlan,
  normalizePlatform
} = require('./official-install');
const { CLIENT_PLATFORMS, getClientPlatformAdapter } = require('../../runtime/client-platform');

const CLAUDE_INSTALL_SH = 'https://claude.ai/install.sh';
const CLAUDE_INSTALL_PS1 = 'https://claude.ai/install.ps1';
const CLAUDE_INSTALL_CMD = 'https://claude.ai/install.cmd';

function collectCliPathEntries(options = {}) {
  const adapter = getClientPlatformAdapter(options);
  return adapter && adapter.id === CLIENT_PLATFORMS.WINDOWS && String(options.hostHomeDir || '').trim()
    ? [adapter.path.join(String(options.hostHomeDir).trim(), '.local', 'bin')]
    : [];
}

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const plan = platform === 'windows'
    ? buildPowerShellScriptPlan({
      id: 'claude_windows_official',
      label: 'Claude Code 官方 Windows PowerShell 安装器',
      url: CLAUDE_INSTALL_PS1,
      hosts: ['claude.ai'],
      options
    })
    : buildPosixScriptPlan({
      id: 'claude_posix_official',
      label: 'Claude Code 官方 macOS/Linux 安装器',
      url: CLAUDE_INSTALL_SH,
      hosts: ['claude.ai'],
      options
    });
  const cmd = platform === 'windows'
    ? buildCmdScriptPlan({
      id: 'claude_windows_cmd_official',
      label: 'Claude Code 官方 Windows CMD 安装器',
      url: CLAUDE_INSTALL_CMD,
      hosts: ['claude.ai'],
      options
    })
    : null;
  const fallbacks = platform === 'macos'
    ? [buildCaskPlan('claude-code', 'Homebrew 安装 Claude Code（稳定频道）')]
    : platform === 'windows'
      ? [buildWingetPlan('Anthropic.ClaudeCode', 'WinGet 安装 Claude Code')]
      : [];
  return [plan, ...(cmd ? [cmd] : []), ...fallbacks];
}

module.exports = createProviderInstaller({
  provider: 'claude',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['claude']
  },
  desktop: {
    macos: { plans: [buildCaskPlan('claude', 'Homebrew 安装 Claude Desktop')] },
    windows: { plans: [buildWingetPlan('Anthropic.Claude', 'winget 安装 Claude Desktop')] }
  }
});
