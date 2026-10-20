'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan
} = require('./official-install');

// Pi 是独立的开源 Terminal Agent，不属于 AIH Gateway provider。
// 通过与 DSH 相同的 managed app 生命周期接入 Toolkit / WebUI 安装入口。
const PACKAGE_NAME = '@earendil-works/pi-coding-agent';

module.exports = createProviderInstaller({
  provider: 'pi',
  managedApp: {
    id: 'pi',
    name: 'Pi',
    clientName: 'Pi',
    type: 'cli',
    categories: ['ALL', 'CLI Code'],
    binaryName: 'pi',
    pkg: PACKAGE_NAME,
    description: '轻量 Terminal Agent harness，可通过 AIH Gateway 使用账号模型',
    hookSupported: false,
    syncMode: 'unavailable'
  },
  cli: {
    resolveInstallPlans: (options = {}) => [buildNpmPlan(PACKAGE_NAME, options)].filter(Boolean),
    resolveUpdatePlans: (options = {}) => [buildNpmUpdatePlan(PACKAGE_NAME, options)].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan(PACKAGE_NAME, options)].filter(Boolean),
    binaryNames: ['pi']
  }
});
