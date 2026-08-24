'use strict';

const PACKAGE_PLAN_BUILDERS = Object.freeze({
  homebrew: (executable, packageId, label) => [
    { action: 'install', label: `安装 ${label}`, packageManager: 'homebrew', file: executable, args: ['install', '--cask', packageId] },
    { action: 'update', label: `更新 ${label}`, packageManager: 'homebrew', file: executable, args: ['upgrade', '--cask', packageId] },
    { action: 'uninstall', label: `卸载 ${label}`, packageManager: 'homebrew', file: executable, args: ['uninstall', '--cask', packageId] }
  ],
  winget: (executable, packageId, label) => [
    { action: 'install', label: `安装 ${label}`, packageManager: 'winget', file: executable, args: ['install', '--id', packageId, '--exact', '--source', 'winget'] },
    { action: 'update', label: `更新 ${label}`, packageManager: 'winget', file: executable, args: ['upgrade', '--id', packageId, '--exact', '--source', 'winget'] },
    { action: 'uninstall', label: `卸载 ${label}`, packageManager: 'winget', file: executable, args: ['uninstall', '--id', packageId, '--exact'] }
  ],
  flatpak: (executable, packageId, label) => [
    { action: 'install', label: `安装 ${label}`, packageManager: 'flatpak', file: executable, args: ['install', '--user', '-y', 'flathub', packageId] },
    { action: 'update', label: `更新 ${label}`, packageManager: 'flatpak', file: executable, args: ['update', '--user', '-y', packageId] },
    { action: 'uninstall', label: `卸载 ${label}`, packageManager: 'flatpak', file: executable, args: ['uninstall', '--user', '-y', packageId] }
  ]
});

function buildPackagePlans(packageManager, packageId, label) {
  if (!packageManager || !packageManager.executable) return [];
  const buildPlans = PACKAGE_PLAN_BUILDERS[packageManager.id];
  return buildPlans ? buildPlans(packageManager.executable, packageId, label) : [];
}

module.exports = {
  buildPackagePlans
};
