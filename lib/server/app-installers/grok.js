'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  normalizePlatform
} = require('./official-install');
const { resolvePlatformPath } = require('../../runtime/platform-path');

const GROK_INSTALL_SH = 'https://x.ai/cli/install.sh';
const GROK_INSTALL_PS1 = 'https://x.ai/cli/install.ps1';

function collectCliPathEntries(options = {}) {
  const hostHome = String(options.hostHomeDir || '').trim();
  if (!hostHome) return [];
  const platform = normalizePlatform(options);
  const pathImpl = resolvePlatformPath(platform, options.path || require('node:path'));
  return [pathImpl.join(hostHome, '.grok', 'bin')];
}

module.exports = createProviderInstaller({
  provider: 'grok',
  cli: {
    resolveInstallPlans: (options = {}) => [normalizePlatform(options) === 'win32'
      ? buildPowerShellScriptPlan({
        id: 'grok_windows_official',
        label: 'Grok CLI 官方 Windows 安装器',
        url: GROK_INSTALL_PS1,
        hosts: ['x.ai'],
        options
      })
      : buildPosixScriptPlan({
        id: 'grok_posix_official',
        label: 'Grok CLI 官方 macOS/Linux 安装器',
        url: GROK_INSTALL_SH,
        hosts: ['x.ai'],
        options
      })],
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['grok']
  }
});
