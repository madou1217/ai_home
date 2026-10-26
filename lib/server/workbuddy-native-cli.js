'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getProviderCLIConfig } = require('../provider-catalog');
const { familyMountedVolumeRoots, familyVolumeAppRoots } = require('../runtime/codebuddy-family-layouts');
const HOST_IDS = Object.freeze({ workbuddy: 'workbuddy-desktop-ai', workbuddycn: 'workbuddy-desktop' });

// WorkBuddy has no separately distributed CLI. Use only the runtime from the
// selected desktop edition; a generic `codebuddy` on PATH is not equivalent.
function resolveWorkbuddyNativeCli(provider, options = {}) {
  if (!HOST_IDS[provider]) return null;
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const config = (options.getProviderCLIConfig || getProviderCLIConfig)(provider);
  const home = String(options.hostHomeDir || options.env?.AIH_HOST_HOME || '').trim();
  // 安装位置两处：契约声明的安装路径（可注入，测试用）与挂载卷里的安装镜像
  // —— 用户完全可能直接从 DMG 里打开 App，那时官方内嵌运行时只在镜像卷里。
  const volumeRoots = Array.isArray(options.volumeRoots)
    ? options.volumeRoots
    : familyMountedVolumeRoots(fsImpl, { platform });
  const declared = platform === 'darwin' ? config?.desktopClient?.macos?.installPaths || [] : [];
  const roots = [
    ...declared
      .filter((token) => !String(token).includes('{hostHomeDir}') || home)
      .map((token) => String(token).replace('{hostHomeDir}', home)),
    ...familyVolumeAppRoots(provider, volumeRoots, { platform })
  ];
  for (const root of roots) {
    const cli = path.join(root, 'Contents', 'Resources', 'app.asar.unpacked', 'cli');
    const entry = path.join(cli, 'bin', 'codebuddy');
    try {
      if (!fsImpl.statSync(entry).isFile()) continue;
      const product = JSON.parse(fsImpl.readFileSync(path.join(cli, 'product.json'), 'utf8'));
      if (product?.authentication?.id !== HOST_IDS[provider]) continue;
      return {
        command: options.nodeExecPath || process.execPath,
        prefixArgs: [entry],
        // WorkBuddy 发行版把运行时放在 `dist/codebuddy-lite-wb.mjs`，而 `bin/codebuddy`
        // 默认 require `../dist/codebuddy`（CodeBuddy 那份）—— 不设这个变量会直接
        // `Cannot find module '../dist/codebuddy'`（2026-10-26 实测，装完 App 也起不来）。
        // 该变量是 WorkBuddy 官方入口自带的 bundle 分流通道（见 bin/codebuddy 的
        // forceLiteWb 分支），宿主 spawn 前设置即可，不影响 CodeBuddy 发行版。
        envPatch: { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' }
      };
    } catch (_) { /* Try the other declared installation root. */ }
  }
  const error = new Error(`未找到 ${provider === 'workbuddy' ? 'WorkBuddy AI' : 'WorkBuddy'} 对应发行版的内嵌运行时；请安装或修复该桌面应用后重试。`);
  error.code = 'workbuddy_native_runtime_missing';
  throw error;
}

module.exports = { resolveWorkbuddyNativeCli, HOST_IDS };
