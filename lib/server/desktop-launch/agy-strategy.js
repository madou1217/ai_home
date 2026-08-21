'use strict';

const { createDesktopLaunchStrategy, resolveElectronSpawnPlan } = require('./default-strategy');

// AGY 在 macOS 上必须经 `open -n` 从 .app bundle 起新实例：直接执行 bundle 内的
// 主程序会被 LaunchServices 归并到已有实例，多账号并行随即失效。
// 其余平台沿用通用 Electron 启动形态。
//
// 单实例身份刻意不特殊化：AGY 的原生 Keychain 是全局共享的，账号隔离靠启动
// env 强制走 provider 的按账号文件回退，身份仍是 --user-data-dir。
function resolveSpawnPlan(resolved, ctx) {
  if (ctx.platformKey !== 'macos' || !resolved.bundlePath) {
    return resolveElectronSpawnPlan(resolved, ctx);
  }
  return {
    file: '/usr/bin/open',
    args: ['-n', '-a', resolved.bundlePath, '--args', `--user-data-dir=${ctx.userDataDir}`]
  };
}

const agyDesktopLaunchStrategy = createDesktopLaunchStrategy({
  name: 'agy',
  resolveSpawnPlan
});

module.exports = { agyDesktopLaunchStrategy };
