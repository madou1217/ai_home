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
//
// 刻意不拿 account-maintenance-lock 的进程租约：ls 只读账号索引/凭据记录与用量缓存
// （都是 best-effort 读），不搬动任何原生文件；为它付一次租约代价（繁忙时实测 ~1s）
// 会直接拖慢第一帧。搬运类维护本身有独占锁，不会读到半成品。

const { exitAfterFlush } = require('../../../runtime/exit-after-flush');
const {
  AIH_SERVER_LAUNCHD_LABEL,
  LIST_PAGE_SIZE
} = require('../../config/constants');

// argv → 「列哪些 provider、列哪个账号」的解析统一放在 ls-request.js
// （完整 CLI 的 root router 也走同一份），这里只负责装配轻量服务并执行。
const { resolveLsRequest } = require('./ls-request');

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

  // `aih provider ls` 同样是"目录查询"，没必要为它装配完整 CLI。
  // --help 交回完整 CLI（用法文案只在 provider-resource-command 里写一份）。
  const providerListingArgs = String(argv[2] || '').trim() === 'provider'
    && String(argv[3] || '').trim() === 'ls'
    && !argv.slice(4).some((token) => token === '--help' || token === '-h' || token === 'help')
    ? argv.slice(4)
    : null;

  const providerNames = Object.keys(providerRegistry.AI_CLI_CONFIGS);
  const request = providerListingArgs
    ? { action: 'provider-listing' }
    : resolveLsRequest(argv.slice(2), { providerNames });
  if (request.action === 'none') return false;
  if (request.action === 'error') {
    processObj.stderr.write(`\x1b[31m${request.message}\x1b[0m\n`);
    exitAfterFlush(processObj, 1);
    return true;
  }

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

    if (request.action === 'provider-listing') {
      const { runProviderListCommand } = require('./provider-listing');
      const code = runProviderListCommand(providerListingArgs, {
        aiHomeDir,
        fs,
        output: {
          log: (line) => processObj.stdout.write(`${line}\n`),
          error: (line) => processObj.stderr.write(`${line}\n`)
        }
      });
      exitAfterFlush(processObj, code);
      return true;
    }

    const service = createLsFastPathContext({
      fs,
      path,
      processObj,
      aiHomeDir,
      hostHomeDir: startup.hostHomeDir,
      getProfileDir: startup.getProfileDir,
      cliConfigs: providerRegistry.AI_CLI_CONFIGS
    });

    if (request.action === 'help') {
      service.showLsHelp(request.scope);
      exitAfterFlush(processObj, 0);
      return true;
    }

    const result = service.listProfiles(request.providers, request.filterId);
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
  createLsFastPathContext,
  tryRunLsFastPath
};
