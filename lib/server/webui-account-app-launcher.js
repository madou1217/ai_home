'use strict';

// WebUI 账号应用启动器工厂。
//
// open-app 路由与 ZCode 出口首次接管都必须经过完全相同的账号资格、沙箱、
// Provider 路径和原生设置准备链。把组合逻辑集中在这里，避免两个 HTTP 路由
// 各自拼一套 launcher 后逐渐产生行为差异。

const { resolveProviderCliPath } = require('../cli/services/ai-cli/ensure-native-cli');
const { createAccountAppLauncher } = require('./account-app-launcher');
const { resolveAccountAppEligibility } = require('./webui-account-routes-desktop');
const { resolveAiHomeDir } = require('./webui-account-routes-utils');

function createWebUiAccountAppLauncher(ctx, provider, accountRef, action) {
  const deps = ctx.deps || {};
  return createAccountAppLauncher({
    fs: ctx.fs,
    path: ctx.path || deps.path,
    aiHomeDir: resolveAiHomeDir(ctx),
    hostHomeDir: String(deps.hostHomeDir || '').trim(),
    processObj: ctx.processObj || deps.processObj,
    env: ctx.env || deps.env,
    execFileSync: ctx.execFileSync || deps.execFileSync,
    spawn: ctx.spawn || deps.spawn,
    getProfileDir: ctx.getProfileDir,
    prepareZcodeNativeProxySettings: ctx.prepareZcodeNativeProxySettings
      || deps.prepareZcodeNativeProxySettings,
    resolveAccountEligibility: () => resolveAccountAppEligibility(ctx, provider, accountRef),
    enforceCliInstallation: action === 'open',
    resolveCliPath: (cliProvider, account) => resolveProviderCliPath(cliProvider, {
      fs: ctx.fs,
      path: ctx.path || deps.path,
      processObj: ctx.processObj || deps.processObj || process,
      env: ctx.env || deps.env,
      resolveNativeCliPath: deps.resolveNativeCliPath,
      hostHomeDir: deps.hostHomeDir,
      accountRef: account && account.accountRef
    })
  });
}

module.exports = {
  createWebUiAccountAppLauncher
};
