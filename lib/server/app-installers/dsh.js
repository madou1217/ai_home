'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan
} = require('./official-install');
const { buildDshTuiProfileUpdatePlans } = require('../../harness/dsh-tui');

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
    description: 'DeepSeek 官方开源 Agent Harness（web profile + 终端 TUI profile，共享安装与升级）',
    hookSupported: false,
    syncMode: 'unavailable'
  },
  cli: {
    resolveInstallPlans: (options = {}) => [buildNpmPlan(PACKAGE_NAME, options)].filter(Boolean),
    // 应用卡片只有一张：升级 DSH 时把各账号投影里的 dsh-tui profile bundle 一并升上去。
    // profile 是 aih 的派生状态，DSH 自己的 npm 升级不会碰它（见 lib/harness/dsh-tui.js）。
    // 没有已存在的 profile 时这里返回空数组，升级行为与只有 npm 计划时完全一致。
    resolveUpdatePlans: (options = {}) => [
      buildNpmUpdatePlan(PACKAGE_NAME, options),
      ...buildDshTuiProfileUpdatePlans({
        aiHomeDir: options.aiHomeDir,
        dshPath: options.installedPath || options.cliPath,
        hostHomeDir: options.hostHomeDir,
        env: options.env,
        fs: options.fs,
        path: options.path,
        nodePath: options.processObj && options.processObj.execPath
      })
    ].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan(PACKAGE_NAME, options)].filter(Boolean),
    binaryNames: ['dsh']
  }
});
