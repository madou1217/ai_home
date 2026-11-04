'use strict';

// `aih ls` / `aih <provider> ls` 的轻量入口。
//
// 完整 CLI 组合根要装配所有命令（server / webui / chat-runtime / backup …），
// 一次 `require('../lib/cli/app')` 在建机上实测 1.3s、机器繁忙时能到好几秒——用户
// 敲 `aih ls` 看到的是几秒白屏。补全（__complete）和 `aih ss` 早已出于同样理由走
// 轻量路径（见 bin/ai-home.js 注释），列表也照这个办法处理：
//
//   - 启动只装配「账号索引 + 账号引用」这两件事，毫秒级出第一帧；
//   - 读凭据 / 用量标签 / 套餐徽章 / 刷新索引态这些重活，等第一帧之后由
//     profile/list.js 的补算队列逐个触发，第一次用到时才 require 对应服务。
//
// 任何意外（解析失败、未预期的参数形状）都返回 false，交回完整 CLI 处理，
// 保证行为兜底；AIH_DISABLE_LS_FASTPATH=1 用于对照测试与排障。

const { exitAfterFlush } = require('../../../runtime/exit-after-flush');
const {
  AIH_SERVER_LAUNCHD_LABEL,
  LIST_PAGE_SIZE
} = require('../../config/constants');

/**
 * 解析 argv。返回 null 表示"不是 ls 命令"，交回完整 CLI。
 * { provider, rest } —— provider 为 null 时是全局 `aih ls`。
 */
function parseLsInvocation(argv, isSupportedCli) {
  const first = String(argv[2] || '').trim();
  if (!first) return null;
  if (first === 'ls') {
    return { provider: null, rest: argv.slice(3) };
  }
  if (String(argv[3] || '').trim() === 'ls' && isSupportedCli(first)) {
    return { provider: first, rest: argv.slice(4) };
  }
  return null;
}

function createLsFastPathContext({ fs, path, processObj, aiHomeDir, hostHomeDir, getProfileDir, cliConfigs }) {
  const { createProfileListService } = require('./list');
  const { createAccountStateRegistryService } = require('../account/state-registry');
  const { createAccountEnricher } = require('./account-enricher');

  const registry = createAccountStateRegistryService({
    fs,
    aiHomeDir,
    getProfileDir,
    stateIndexClient: null
  });
  const getAccountStateIndex = registry.getAccountStateIndex;

  // 兜底用的重服务：只在 worker 起不来时才在主线程加载（第一帧永远不碰）。
  let heavy = null;
  function heavyDeps() {
    if (heavy) return heavy;
    const { createHeavyProfileDeps } = require('./heavy-profile-deps');
    heavy = createHeavyProfileDeps({ fs, path, processObj, aiHomeDir, getProfileDir, cliConfigs });
    return heavy;
  }

  // 补算默认丢给 worker：主线程只画，不读凭据、不写索引。worker 失败时 list.js
  // 会自动退回上面的主线程兜底，列表不会少任何一列。
  const accountEnricher = createAccountEnricher({ aiHomeDir, hostHomeDir });

  const service = createProfileListService({
    fs,
    path,
    processObj,
    aiHomeDir,
    cliConfigs,
    listPageSize: LIST_PAGE_SIZE,
    getAccountStateIndex,
    checkStatus: (...args) => heavyDeps().checkStatus(...args),
    formatAccountPlanBadge: (...args) => heavyDeps().formatAccountPlanBadge(...args),
    formatUsageLabel: (...args) => heavyDeps().formatUsageLabel(...args),
    refreshIndexedStateForAccount: (...args) => heavyDeps().refreshIndexedStateForAccount(...args),
    accountEnricher
  });
  return service;
}

/**
 * 尝试用轻量路径执行 `aih ls`。返回 true 表示已接管（调用方不要再 require 完整 CLI）。
 */
function tryRunLsFastPath(options = {}) {
  const processObj = options.processObj || process;
  const argv = options.argv || processObj.argv || [];
  const env = options.env || processObj.env || {};
  if (String(env.AIH_DISABLE_LS_FASTPATH || '').trim() === '1') return false;

  let providerRegistry = null;
  try {
    providerRegistry = require('../ai-cli/provider-registry');
  } catch (_error) {
    return false;
  }

  const invocation = parseLsInvocation(argv, (name) => providerRegistry.isSupportedAiCli(name));
  if (!invocation) return false;

  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const { createStartupWiring } = require('../../bootstrap/startup-wiring');
    const startup = createStartupWiring({
      path,
      fs,
      env,
      platform: processObj.platform || process.platform,
      os,
      launchdLabel: AIH_SERVER_LAUNCHD_LABEL
    });
    const aiHomeDir = startup.aiHomeDir;
    if (!aiHomeDir) return false;

    const service = createLsFastPathContext({
      fs,
      path,
      processObj,
      aiHomeDir,
      hostHomeDir: startup.hostHomeDir,
      getProfileDir: startup.getProfileDir,
      cliConfigs: providerRegistry.AI_CLI_CONFIGS
    });

    const args = invocation.rest;
    const helpArg = String(args[0] || '').trim();
    if (helpArg === '--help' || helpArg === '-h' || helpArg === 'help') {
      service.showLsHelp(invocation.provider);
      exitAfterFlush(processObj, 0);
      return true;
    }

    let filterId = null;
    if (invocation.provider) {
      const idArg = String(args[0] || '').trim();
      if (idArg && !/^\d+$/.test(idArg)) {
        processObj.stderr.write(`\x1b[31m[aih] Invalid ID. Usage: aih ${invocation.provider} ls [id]\x1b[0m\n`);
        exitAfterFlush(processObj, 1);
        return true;
      }
      filterId = idArg || null;
    }

    const result = service.listProfiles(invocation.provider, filterId);
    if (result && result.interactive) return true;
    if (result && result.done && typeof result.done.then === 'function') {
      result.done.then(() => exitAfterFlush(processObj, 0), () => exitAfterFlush(processObj, 0));
    } else {
      exitAfterFlush(processObj, 0);
    }
    return true;
  } catch (_error) {
    // 轻量路径内部出错就交回完整 CLI —— 列表必须永远能出来。
    return false;
  }
}

module.exports = {
  parseLsInvocation,
  createLsFastPathContext,
  tryRunLsFastPath
};
