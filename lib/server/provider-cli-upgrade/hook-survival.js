'use strict';

// 升级之后的会话 Hook 存活检查。
//
// 背景：官方安装脚本会覆盖 aih 的接管，而两种 Hook 的暴露面完全不同：
//
//   - **二进制垫片**（codex 的 `~/.local/bin/codex` → aih wrapper）：standalone
//     安装器的 update_visible_command 每次都把它替换成指向 current 的符号链接。
//     这是真实会被拆掉的一类，所以它的 plan 自带 postInstall 动作（见
//     upgrade-plan-builder.js），装完立刻补回。
//   - **配置文件条目**（claude/agy/gemini/opencode/grok 的 settings.json / hooks.json）：
//     升级只换二进制，配置文件不在安装器的写路径上，正常不会被动。
//
// 但「正常不会」不等于「不会」——用户手工改配置、CLI 自己重写 settings、换版本后
// 配置格式变了，都可能让 Hook 静默消失。而升级验证只看「CLI 能不能跑」，看不见
// Hook 的死活，于是就会留下「版本升上去了、但 aih 对该 provider 的接管没了」这种
// 半吊子状态。
//
// 这里补的就是那一条断言：升级后确认 Hook 仍然装着，掉了就装回去。
//
// **只恢复，不新装**：判定依据是「升级前它是装着的」。用户没启用过的 Hook 不该被
// 自动升级顺手装上——那等于绕过用户的选择，而安装 Hook 会改用户的全局 CLI 配置
// （见「启动权限」那套手动开关的同一原则）。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const {
  diagnoseProviderSessionHookConfig,
  installProviderSessionHookConfig,
  getProviderHookConfigTarget,
  getCodexConfigTomlTarget
} = require('../provider-session-hook-config');

function readJsonFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return {};
  }
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

/**
 * 装配 deps 上的两个 Hook 钩子：诊断（只读）与安装（写入策略）。
 *
 * 安装走 provider-session-hook-config 的既有写入策略——它做的是合并而非覆盖，
 * 不会动用户在同一个配置文件里写的其它条目。
 */
function createHookGuardDeps(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const homeDir = String(options.hostHomeDir || options.homeDir || '');

  function context() {
    return {
      fs: fsImpl,
      path: options.path || nodePath,
      hostHomeDir: homeDir,
      homeDir,
      receiverUrl: options.providerHookReceiverUrl,
      senderScriptPath: options.providerHookSenderScriptPath,
      codexVersion: options.codexClientVersion
    };
  }

  function diagnose(provider) {
    const targetPath = getProviderHookConfigTarget(provider, { homeDir });
    const config = readJsonFileSafe(fsImpl, targetPath);
    return diagnoseProviderSessionHookConfig(provider, config, {
      ...context(),
      codexConfigText: provider === 'codex'
        ? readTextFileSafe(fsImpl, getCodexConfigTomlTarget({ homeDir }))
        : ''
    });
  }

  function install(provider) {
    return installProviderSessionHookConfig(provider, context());
  }

  // 开关的读取入口：和 WebUI 设置面板同一份记录（tool-app-settings 的 sessionHook）。
  function readSettings(provider) {
    try {
      const { getToolPermissionSettings } = require('../../cli/services/toolkit/tool-app-settings');
      return getToolPermissionSettings(provider, fsImpl, options.aiHomeDir, context());
    } catch (_error) {
      return null;
    }
  }

  return { diagnose, install, readSettings };
}

/**
 * 用户是否为这个 provider 打开了「让 aih 接管会话 Hook」。
 *
 * 这份设置是开关的唯一真相（见 tool-app-settings 的 sessionHook）：关着的时候
 * 升级不做任何 Hook 恢复——连检查都不做，那才叫「别再动我的东西」。
 */
function isSessionHookEnabled(provider, options = {}) {
  const read = options.readSettings;
  if (typeof read !== 'function') return false;
  try {
    const settings = read(provider);
    return Boolean(settings && settings.sessionHook);
  } catch (_error) {
    // 读不出来按「没开」处理：不要在没有用户明确同意的情况下改用户配置。
    return false;
  }
}

/**
 * 升级前这个 provider 的 Hook 是不是装着的。
 *
 * 判定不出来（读不到配置、不支持 Hook、provider 不在清单里）一律算「没装」：
 * 宁可不恢复，也不要在证据不足时去改用户的全局配置。
 */
function wasHookInstalled(provider, options = {}) {
  // 开关关着 = 不接管，也就不用记「升级前装着没装着」。
  if (!isSessionHookEnabled(provider, options)) return false;
  const { diagnose } = options;
  if (typeof diagnose !== 'function') return false;
  try {
    const status = diagnose(provider);
    return Boolean(status && status.installed);
  } catch (_error) {
    return false;
  }
}

/**
 * 升级后核对 Hook 是否还在；掉了就装回去。
 *
 * @returns {{checked: boolean, restored: boolean, ok: boolean, detail: string}}
 *   checked  —— 这次是否真的做了核对（没启用过 / 不支持时是 false，什么都不做）
 *   restored —— 是否执行了恢复写入
 *   ok       —— 是否处于「Hook 装着的」终态（没核对时视为 ok）
 */
function ensureHookSurvived(provider, options = {}) {
  const { diagnose, install } = options;
  const notChecked = (detail) => ({ checked: false, restored: false, ok: true, detail });

  if (typeof diagnose !== 'function' || typeof install !== 'function') {
    return notChecked('hook_deps_unavailable');
  }
  if (!options.upgradeBefore) return notChecked('hook_not_enabled_before');

  const after = diagnose(provider);
  if (after && after.installed) return { checked: true, restored: false, ok: true, detail: 'hook_alive' };
  if (after && !after.supported) return notChecked('hook_unsupported');

  // 掉了：装回去。这一步失败必须让整次 apply 判失败——和 postInstall 同一个理由，
  // 「接管没了」比「升级失败」更糟，后者至少停在已知可用的版本上。
  try {
    const result = install(provider);
    if (result && result.ok) return { checked: true, restored: true, ok: true, detail: 'hook_restored' };
    return {
      checked: true,
      restored: false,
      ok: false,
      detail: `hook_restore_failed:${(result && (result.error || result.reason)) || 'unknown'}`
    };
  } catch (error) {
    return {
      checked: true,
      restored: false,
      ok: false,
      detail: `hook_restore_error:${String((error && error.message) || error)}`
    };
  }
}

module.exports = {
  createHookGuardDeps,
  isSessionHookEnabled,
  wasHookInstalled,
  ensureHookSurvived
};
