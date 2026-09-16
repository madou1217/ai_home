'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getProviderCLIConfig } = require('../provider-catalog');
const HOST_IDS = Object.freeze({ workbuddy: 'workbuddy-desktop-ai', workbuddycn: 'workbuddy-desktop' });

// WorkBuddy has no separately distributed CLI. Use only the runtime from the
// selected desktop edition; a generic `codebuddy` on PATH is not equivalent.
function resolveWorkbuddyNativeCli(provider, options = {}) {
  if (!HOST_IDS[provider]) return null;
  const fsImpl = options.fs || fs;
  const platform = options.platform || process.platform;
  const config = (options.getProviderCLIConfig || getProviderCLIConfig)(provider);
  const home = String(options.hostHomeDir || options.env?.AIH_HOST_HOME || '').trim();
  const roots = platform === 'darwin' ? config?.desktopClient?.macos?.installPaths || [] : [];
  for (const token of roots) {
    if (token.includes('{hostHomeDir}') && !home) continue;
    const root = String(token).replace('{hostHomeDir}', home);
    const cli = path.join(root, 'Contents', 'Resources', 'app.asar.unpacked', 'cli');
    const entry = path.join(cli, 'bin', 'codebuddy');
    try {
      if (!fsImpl.statSync(entry).isFile()) continue;
      const product = JSON.parse(fsImpl.readFileSync(path.join(cli, 'product.json'), 'utf8'));
      if (product?.authentication?.id !== HOST_IDS[provider]) continue;
      return { command: options.nodeExecPath || process.execPath, prefixArgs: [entry] };
    } catch (_) { /* Try the other declared installation root. */ }
  }
  const error = new Error(`未找到 ${provider === 'workbuddy' ? 'WorkBuddy AI' : 'WorkBuddy'} 对应发行版的内嵌运行时；请安装或修复该桌面应用后重试。`);
  error.code = 'workbuddy_native_runtime_missing';
  throw error;
}

module.exports = { resolveWorkbuddyNativeCli, HOST_IDS };
