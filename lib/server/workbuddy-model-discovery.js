'use strict';

// WorkBuddy（workbuddy / workbuddycn）账号的模型列表。
//
// 个人账号没有模型接口（/console/enterprises/{id}/config/models 只对企业账号开放），CLI 把
// App 自带的 product.json 与云端 /v3/config 按当前登录合并过滤后得到「当前支持」的模型，
// 只在 `--help` 的 `--model` 说明里给出（没有列模型的子命令）。会话用 `--model` 启动时校验的
// 也正是这份列表，所以探测结果与会话可用模型一致。
//
// 必须与会话启动完全同一套运行时：CLI 取对应发行版 App 的内嵌运行时（resolveWorkbuddyNativeCli，
// 国际站 WorkBuddy AI.app / 国内站 WorkBuddy.app），环境取会话的 buildProviderEnv（HOME 指向该
// 账号的凭据投影）。换成宿主 HOME 得到的是宿主登录的列表，不是这个账号的。

const childProcess = require('node:child_process');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { promisify } = require('node:util');
const { resolveWorkbuddyNativeCli } = require('./workbuddy-native-cli');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');

const execFileAsync = promisify(childProcess.execFile);
const MIN_TIMEOUT_MS = 60000;
const SUPPORTED_LINE = /Currently supported:\s*\(([^)]*)\)/;

/**
 * 从 `--help` 输出取 `--model` 的「当前支持」列表。`custom-local:*` 是宿主本机自定义的模型
 * （可能正指向 aih 网关本身），不属于账号，剔除。找不到这一行视为 CLI 输出格式变化，报错而不是返回空。
 */
function parseWorkbuddyHelpModels(output) {
  const match = String(output || '').match(SUPPORTED_LINE);
  if (!match) {
    const error = new Error('codebuddy_model_list_unparsable');
    error.code = 'codebuddy_model_list_unparsable';
    throw error;
  }
  return Array.from(new Set(match[1]
    .split(',')
    .map((model) => model.trim())
    .filter((model) => model && !model.startsWith('custom-local:'))));
}

async function discoverWorkbuddyCliModels(options = {}, account = {}, timeoutMs = 8000) {
  const provider = String(account.provider || '').trim().toLowerCase();
  const accountRef = String(account.accountRef || '').trim();
  if (!accountRef) throw new Error('native_cli_model_discovery_missing_account_ref');
  const aiHomeDir = String(options.aiHomeDir || '').trim() || nodePath.join(nodeOs.homedir(), '.ai_home');
  const baseEnv = options.env || process.env;
  const hostHomeDir = String(options.hostHomeDir || baseEnv.AIH_HOST_HOME || nodeOs.homedir()).trim();
  const launch = (options.resolveWorkbuddyNativeCli || resolveWorkbuddyNativeCli)(provider, {
    env: baseEnv,
    hostHomeDir
  });
  const buildProviderEnv = options.buildProviderEnv || require('./native-session-chat-env').buildProviderEnv;
  const env = buildProviderEnv(provider, resolveAccountRuntimeDir(aiHomeDir, provider, accountRef), baseEnv, {
    aiHomeDir,
    accountRef
  });
  const execFile = options.execFile || execFileAsync;
  const result = await execFile(launch.command, [...(launch.prefixArgs || []), '--help'], {
    timeout: Math.max(MIN_TIMEOUT_MS, Number(timeoutMs) || 0),
    windowsHide: true,
    env
  });
  return parseWorkbuddyHelpModels(result && result.stdout);
}

module.exports = { discoverWorkbuddyCliModels, parseWorkbuddyHelpModels };
