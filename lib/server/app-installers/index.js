'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Provider 安装器注册表只负责发现独立模块，不包含 Provider 名单或安装参数。
// 新 Provider 只需新增同名文件；这里不需要再维护第二份列表。
function loadInstallers() {
  const installers = {};
  let files = [];
  try {
    files = fs.readdirSync(__dirname, { withFileTypes: true });
  } catch (_error) {
    return Object.freeze(installers);
  }
  for (const entry of files) {
    if (!entry.isFile() || !/^[a-z0-9][a-z0-9-]*\.js$/i.test(entry.name)) continue;
    if (
      entry.name === 'index.js'
      || entry.name === 'provider-factory.js'
      || entry.name === 'official-install.js'
      || entry.name === 'ide-installer-factory.js'
    ) continue;
    try {
      const installer = require(path.join(__dirname, entry.name));
      const provider = String(installer && installer.provider || '').trim().toLowerCase();
      if (provider) installers[provider] = installer;
    } catch (_error) {
      // 单个 Provider 安装器损坏不能拖垮其它 Provider 的入口发现。
    }
  }
  return Object.freeze(installers);
}

const INSTALLERS = loadInstallers();

function getAppInstaller(provider) {
  return INSTALLERS[String(provider || '').trim().toLowerCase()] || null;
}

function listManagedAppInstallers() {
  return Object.values(INSTALLERS)
    .filter((installer) => installer && installer.managedApp && typeof installer.managedApp === 'object')
    .sort((left, right) => String(left.managedApp.name || left.provider)
      .localeCompare(String(right.managedApp.name || right.provider)));
}

module.exports = {
  getAppInstaller,
  listManagedAppInstallers,
  INSTALLERS
};
