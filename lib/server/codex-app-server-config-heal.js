'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { healCodexConfigFile } = require('../cli/services/pty/codex-config-heal');
const { getManagedAihProviderBlock } = require('../cli/services/pty/codex-config-sync');

// app-server 通过 `-c model_providers.aih_server.*` 把流量钉在本地网关，但显示名
// (name) 只能留在 config.toml —— Windows 上该命令经 cmd.exe 包装，argv 里的引号会被
// 毁掉（见 codex-provider-args.js）。codex 0.154 起收紧校验，provider 表缺 name 直接
// 拒绝加载配置，app-server 在 spawn 瞬间退出：
//   error loading default config after config error:
//   model_providers.aih_server: provider name must not be empty
// PTY（pty-runtime-spawn）与默认 CLI（codex-default-cli-launcher）两条路径早已在启动前
// 自愈，native app-server 这条是遗漏的缺口；此模块补齐同一语义。
function resolveAppServerCodexHome(env, runtimeDir, path) {
  const explicit = String(env && env.CODEX_HOME || '').trim();
  if (explicit) return explicit;
  const dir = String(runtimeDir || '').trim();
  return dir ? path.join(dir, '.codex') : '';
}

// API-key 账号的 CODEX_HOME 会被 codex-strategy 指到宿主 <hostHome>/.codex（共享
// SQLite 会话库），那份配置由 codex-config-sync / host-sync 维护且已带 name。
// 整段补写只允许发生在账号自己的沙箱里，绝不往宿主配置追加内容。
function isAccountSandboxHome(codexHome, runtimeDir, path) {
  const dir = String(runtimeDir || '').trim();
  return Boolean(dir) && codexHome === path.join(dir, '.codex');
}

/**
 * 在 spawn codex app-server 前修复沙箱 config.toml 中的受管 provider 段。
 * 仅在本次启动确实注入了 `-c model_providers.*` 时才动文件：没有注入就没有裸表，
 * 用户自己的配置不该被我们追加内容。
 *
 * @param {{env?: object, providerArgs?: string[], runtimeDir?: string,
 *   fs?: object, path?: object, platform?: string, log?: Function}} options
 * @returns {{healed: boolean, configPath: string, insertedBlock: boolean}}
 */
function healAppServerProviderConfig(options = {}) {
  const path = options.path || nodePath;
  const env = options.env || {};
  const providerArgs = options.providerArgs;
  const result = { healed: false, configPath: '', insertedBlock: false };
  if (!Array.isArray(providerArgs) || providerArgs.length === 0) return result;

  const codexHome = resolveAppServerCodexHome(env, options.runtimeDir, path);
  if (!codexHome) return result;

  const configPath = path.join(codexHome, 'config.toml');
  result.configPath = configPath;
  result.insertedBlock = isAccountSandboxHome(codexHome, options.runtimeDir, path);
  const healed = healCodexConfigFile(configPath, {
    fs: options.fs || nodeFs,
    platform: options.platform,
    // base_url / wire_api 稍后仍被 `-c` 覆盖成本次运行时的真实值；这里写入受管段
    // 只为把 name 这类无法经 argv 传递的键落到文件里。
    missingProviderBlock: result.insertedBlock
      ? getManagedAihProviderBlock({
        openaiApiKey: env.OPENAI_API_KEY,
        openaiBaseUrl: env.OPENAI_BASE_URL
      })
      : '',
    log: options.log
  });
  result.healed = Boolean(healed && healed.provider && healed.provider.changed);
  return result;
}

module.exports = { healAppServerProviderConfig, resolveAppServerCodexHome };
