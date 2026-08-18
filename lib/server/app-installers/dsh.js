'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan
} = require('./official-install');

// DeepSeek Harness 是独立的开源 CLI 工具，不属于 AIH Gateway provider。
// 它仍通过同一生命周期接口接入 Toolkit，避免把独立应用硬编码到 Provider 合同。
const PACKAGE_NAME = '@deepseek-ai/dsh';

module.exports = createProviderInstaller({
  provider: 'dsh',
  managedApp: {
    id: 'dsh',
    name: 'DeepSeek Harness',
    clientName: 'DeepSeek Harness',
    type: 'cli',
    categories: ['ALL', 'CLI Code'],
    binaryName: 'dsh',
    pkg: PACKAGE_NAME,
    description: 'DeepSeek 官方开源 Agent Harness CLI（developer preview）',
    hookSupported: false,
    syncMode: 'unavailable'
  },
  cli: {
    resolveInstallPlans: (options = {}) => [buildNpmPlan(PACKAGE_NAME, options)].filter(Boolean),
    resolveUpdatePlans: (options = {}) => [buildNpmUpdatePlan(PACKAGE_NAME, options)].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan(PACKAGE_NAME, options)].filter(Boolean),
    binaryNames: ['dsh']
  }
});
