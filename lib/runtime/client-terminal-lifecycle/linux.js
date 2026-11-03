'use strict';

const { buildPackagePlans } = require('./package-plans');

/**
 * Linux 终端插件的标准生命周期：有 Flatpak 用 Flatpak，否则走插件给出的官方安装（AppImage / 发行版仓库）。
 */
function flatpakOrOfficial(terminalPackage, buildOfficialPlans) {
  return (context = {}, dependencies = {}) => {
    if (typeof dependencies.resolveExecutable !== 'function') return [];
    const homeDir = String(context.hostHomeDir || context.env && context.env.HOME || '').trim();
    const fallbackPaths = [
      '/usr/bin/flatpak',
      '/usr/local/bin/flatpak',
      homeDir && context.path ? context.path.join(homeDir, '.local', 'bin', 'flatpak') : ''
    ].filter(Boolean);
    const executable = dependencies.resolveExecutable(['flatpak'], fallbackPaths, context);
    const packagePlans = buildPackagePlans({ id: 'flatpak', executable }, terminalPackage.packageId, terminalPackage.label);
    return packagePlans.length ? packagePlans : buildOfficialPlans(context);
  };
}

module.exports = {
  flatpakOrOfficial
};
