'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { resolveHostHomeDir } = require('./host-home');
const {
  resolveZcodeBundledCli,
  resolveZcodeCliRuntimeCandidates,
  ensureZcodeCliLauncher,
  ensureZcodeGenericLauncher
} = require('./zcode-cli-launcher');

// 宿主 HOME：CLI 解析链只传 fs/path/platform，`~/Applications` 这个安装位置要靠
// 唯一解析处补出来（与安装器的 collectCliPathEntries 同源）。
function resolveAdapterHostHome(options = {}) {
  const explicit = String(options.hostHomeDir || '').trim();
  if (explicit) return explicit;
  try {
    return String(resolveHostHomeDir({ processObj: options.processObj || process }) || '').trim();
  } catch (_error) {
    return '';
  }
}

function resolveKiroChatExecutable(cliPath, options) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const platform = options.platform || process.platform;
  const input = String(cliPath || '').trim();
  if (!['kiro-cli', 'kiro-cli.exe'].includes(path.basename(input).toLowerCase())) return input;
  let resolved = input;
  try { resolved = fs.realpathSync(input); } catch (_) {}
  const chat = path.join(path.dirname(resolved), platform === 'win32' ? 'kiro-cli-chat.exe' : 'kiro-cli-chat');
  try {
    const stat = fs.statSync(chat);
    if (!stat.isFile() || stat.size <= 0) return input;
    if (platform !== 'win32') fs.accessSync(chat, nodeFs.constants.X_OK);
    return chat;
  } catch (_) {
    return input;
  }
}

// ZCode CLI 随 Desktop 以 **node bundle** 分发（`<ZCode.app>/Contents/Resources/glm/zcode.cjs`），
// 不能直接 exec。这里把它换成 aih 生成的启动垫片（补 provider 配置环境变量 + exec node），
// 见 lib/runtime/zcode-cli-launcher.js。已经是可执行文件时（未来若独立分发原生 CLI）
// 原样返回，零行为差异。
function resolveZcodeCliExecutable(cliPath, options = {}) {
  const path = options.path || nodePath;
  const fs = options.fs || nodeFs;
  const input = String(cliPath || '').trim();
  if (!input) return input;
  const hostHomeDir = resolveAdapterHostHome(options);
  // 运行时候选优先：官方 CLI/TUI 发行包 → PATH → 本地托管工具（**自带 @zcode/tui**）
  // → 桌面 bundle 兜底（不带 TUI，真机 `Cannot find package '@zcode/tui'`）。
  // 非 bundle 的候选自己处理配置，用通用垫片 exec；bundle 走下面原有的 provider 配置垫片。
  const preferred = resolveZcodeCliRuntimeCandidates({
    fs,
    path,
    hostHomeDir,
    aiHomeDir: options.aiHomeDir,
    platform: options.platform,
    env: options.env
  }).find((candidate) => candidate.kind !== 'desktop-bundle');
  if (preferred) {
    const generic = ensureZcodeGenericLauncher({
      fs,
      path,
      command: preferred.command,
      args: preferred.args,
      aiHomeDir: options.aiHomeDir,
      platform: options.platform
    });
    if (generic) return generic;
  }
  if (!path.basename(input).toLowerCase().endsWith('.cjs')) return input;
  const bundled = resolveZcodeBundledCli({ fs, path, hostHomeDir });
  const resolvedCliPath = bundled && bundled.cliPath ? bundled.cliPath : input;
  const launcher = ensureZcodeCliLauncher({
    fs,
    path,
    cliPath: resolvedCliPath,
    configPath: bundled ? bundled.configPath : '',
    nodeExecutable: options.nodeExecutable || process.execPath,
    aiHomeDir: options.aiHomeDir,
    platform: options.platform
  });
  return launcher || input;
}

// Executable adaptation is shared by CLI launches, WebUI login and discovery.
// Keep this registry independent of launch profiles and installer wiring to
// avoid importing their dependency graph during native executable resolution.
const EXECUTABLE_ADAPTERS = Object.freeze({
  kiro: resolveKiroChatExecutable,
  zcode: resolveZcodeCliExecutable
});

function resolveProviderCliExecutable(provider, cliPath, options = {}) {
  const adapter = EXECUTABLE_ADAPTERS[String(provider || '').trim().toLowerCase()];
  return adapter ? adapter(cliPath, options) : cliPath;
}

module.exports = { resolveProviderCliExecutable };
