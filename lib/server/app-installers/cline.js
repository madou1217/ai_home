'use strict';

const { createProviderInstaller } = require('./provider-factory');
const { buildNpmPlan, buildNpmUpdatePlan, buildNpmUninstallPlan } = require('./official-install');

// Cline CLI 只有一条官方分发通道：npm 包 `cline`（官方 README 的 Install 一节：
// `npm install -g cline`，nightly 为 `cline@nightly`）。平台二进制由 optional
// dependencies 解析，安装期不需要 Node/Bun/Zig 运行时，因此没有 curl 安装脚本、
// 没有 Homebrew formula，也没有落在家目录里的安装产物。
const CLINE_NPM_PACKAGE = 'cline';

// 不声明 cleanupHomeFiles / cleanupHomeTrees：`~/.cline` 是用户数据根
// （`data/settings/providers.json` 存着登录态、sessions/、db/），不是安装产物。
// 卸载只该摘掉 npm 全局包，绝不清账号配置。
module.exports = createProviderInstaller({
  provider: 'cline',
  cli: {
    resolveInstallPlans: (options = {}) => [buildNpmPlan(CLINE_NPM_PACKAGE, options)].filter(Boolean),
    resolveUpdatePlans: (options = {}) => [buildNpmUpdatePlan(CLINE_NPM_PACKAGE, options)].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan(CLINE_NPM_PACKAGE, options)].filter(Boolean),
    binaryNames: ['cline']
  }
});
