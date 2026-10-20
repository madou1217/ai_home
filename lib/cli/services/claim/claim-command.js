'use strict';

// `aih claim` — 账号福利/活动领取的统一入口。
//
// 设计上它是一个「策略表 + 执行器」：provider → 领取策略在
// lib/account/activity-claim/index.js 注册，这里只负责解析参数、枚举账号、
// 逐个调用策略并渲染结果。新增 provider 不需要改本文件的派发逻辑。
//
// 为什么放在顶层命令而不是 `aih <cli> claim`：zcode 是桌面端 provider
// （contract 里 clients.cli=false），没有 `aih zcode` 入口，但它的周末套餐
// 领取同样需要自动化；顶层命令让 qoder 家族与 zcode 共用同一套调度方式。

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const {
  listAccountCredentialRecords: defaultListCredentialRecords
} = require('../../../server/account-credential-store');
const {
  listCliAccountRefRecords: defaultListCliAccountRefRecords
} = require('../../../server/account-ref-store');
const { fetchWithTimeout: defaultFetchWithTimeout } = require('../../../server/http-utils');
const {
  resolveAccountEgressRequestOptions: defaultResolveAccountEgressRequestOptions
} = require('../../../server/account-egress-request-options');
const {
  listClaimProviders,
  runActivityClaim
} = require('../../../account/activity-claim');

const PROVIDER_LABELS = Object.freeze({
  qoder: 'Qoder',
  qodercn: 'Qoder CN',
  zcode: 'ZCode'
});

const STATUS_LABELS = Object.freeze({
  claimed: 'claimed',
  already_claimed: 'already claimed',
  nothing_claimable: 'nothing claimable',
  dry_run: 'dry run',
  not_applicable: 'not applicable',
  no_accounts: 'no accounts',
  error: 'failed'
});

function writeUsage(log) {
  log('\x1b[36mAIH Claim\x1b[0m - claim daily / campaign benefits for provider accounts');
  log('');
  log('\x1b[90mUsage:\x1b[0m aih claim [provider ...] [options]');
  log('');
  log('  qoder        Qoder daily check-in (100 Credits, resets 10:00 UTC+8)');
  log('  qodercn      Qoder CN daily check-in');
  log('  zcode        ZCode weekend / trial plan (needs captcha, uses local Chrome)');
  log('  all          every provider above (default)');
  log('');
  log('\x1b[90mOptions:\x1b[0m');
  log('  --dry-run                 Preview claimable items without claiming');
  log('  --account <ref|id>        Only this account (ref = acct_..., or CLI id)');
  log('  --json                    Machine-readable output');
  log('  --quiet                   Only errors');
  log('  --app-version <v>         ZCode app_version override');
  log('  --captcha-browser <path>  Chrome/Chromium binary for ZCode captcha');
  log('  --timeout-ms <n>          Per-request timeout (default 15000/20000)');
  log('  --help                    Show this help');
  log('');
  log('\x1b[90mExamples:\x1b[0m');
  log('  aih claim --dry-run');
  log('  aih claim qoder');
  log('  aih claim zcode --json');
  log('  # cron: 30 10 * * *  aih claim --quiet');
}

function parseArgs(argv = []) {
  const options = {
    providers: [],
    account: '',
    json: false,
    quiet: false,
    dryRun: false,
    help: false,
    appVersion: '',
    captchaBrowser: '',
    timeoutMs: null
  };
  const numeric = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] === undefined || argv[index] === null ? '' : argv[index]).trim();
    if (!token) continue;
    if (token === '--help' || token === '-h' || token === 'help') {
      options.help = true;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      continue;
    }
    if (token === '--quiet' || token === '-q') {
      options.quiet = true;
      continue;
    }
    if (token === '--dry-run' || token === '--dryrun') {
      options.dryRun = true;
      continue;
    }
    if (token === '--account' || token === '--account-ref' || token === '--id') {
      options.account = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--app-version') {
      options.appVersion = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--captcha-browser') {
      options.captchaBrowser = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--timeout-ms') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value > 0) options.timeoutMs = value;
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      return { error: `unknown_option:${token}` };
    }
    if (/^\d+$/.test(token)) {
      numeric.push(token);
      continue;
    }
    options.providers.push(token.toLowerCase());
  }
  if (numeric.length > 0) {
    if (options.providers.length !== 1 || numeric.length > 1) {
      return { error: 'ambiguous_account_id: pass exactly one provider and one id' };
    }
    options.account = numeric[0];
  }
  return options;
}

function resolveProviders(requested) {
  const all = listClaimProviders();
  if (requested.length === 0) return { providers: all };
  const expanded = [];
  for (const item of requested) {
    if (item === 'all') {
      for (const provider of all) expanded.push(provider);
      continue;
    }
    if (!all.includes(item)) {
      return { error: `unknown_provider:${item}: expected ${all.join(', ')} or all` };
    }
    expanded.push(item);
  }
  return { providers: [...new Set(expanded)] };
}

function resolveAccountSelection(input = {}) {
  const provider = String(input.provider || '').trim();
  const account = String(input.account || '').trim();
  const records = input.records || [];
  if (!account) return { records };
  const aliases = input.listCliAccountRefRecords(input.fs, input.aiHomeDir, provider, { bestEffort: true });
  const aliasById = new Map(aliases.map((entry) => [String(entry.cliAccountId), entry.accountRef]));
  const targetRef = /^\d+$/.test(account) ? String(aliasById.get(account) || '') : account;
  if (!targetRef) return { records: [], unknownAccount: account };
  return { records: records.filter((record) => String(record.accountRef) === targetRef), unknownAccount: '' };
}

function formatResultLine(result, alias) {
  const provider = String(result.provider || '').trim();
  const label = (PROVIDER_LABELS[provider] || provider).padEnd(8);
  const accountId = alias && alias.cliAccountId ? `#${alias.cliAccountId}` : '-';
  const ref = String(result.accountRef || '').trim();
  const statusText = STATUS_LABELS[result.status] || result.status || 'unknown';
  let detail = '';
  if (result.status === 'claimed') {
    if (provider === 'zcode') {
      detail = result.plan && result.plan.name ? result.plan.name : 'plan claimed';
    } else if (Number.isFinite(Number(result.credits)) && Number(result.credits) > 0) {
      detail = `+${result.credits} Credits`;
    } else {
      detail = 'benefit claimed';
    }
  } else if (result.status === 'dry_run') {
    const items = Array.isArray(result.claimable) && result.claimable.length > 0
      ? result.claimable
      : (Array.isArray(result.plans) ? result.plans : []);
    detail = items.length > 0
      ? items.map((item) => item.name || item.campaignKey || item.planId || 'claimable').join(', ')
      : 'nothing claimable';
  } else if (result.status === 'error') {
    detail = [result.error, result.message].filter(Boolean).join(': ');
  } else if (result.status === 'already_claimed') {
    detail = 'nothing to do';
  } else if (result.status === 'nothing_claimable') {
    detail = 'no active activity';
  } else if (result.status === 'not_applicable') {
    detail = 'API key account';
  }
  return `  ${label}  ${accountId.padEnd(4)}  ${ref.padEnd(30)}  ${statusText.padEnd(17)}  ${detail}`.trimEnd();
}

function summarize(results) {
  const summary = {
    accounts: results.filter((result) => result.status !== 'no_accounts').length,
    claimed: 0,
    alreadyClaimed: 0,
    nothingClaimable: 0,
    dryRun: 0,
    notApplicable: 0,
    failed: 0
  };
  for (const result of results) {
    if (result.status === 'claimed') summary.claimed += 1;
    else if (result.status === 'already_claimed') summary.alreadyClaimed += 1;
    else if (result.status === 'nothing_claimable') summary.nothingClaimable += 1;
    else if (result.status === 'dry_run') summary.dryRun += 1;
    else if (result.status === 'not_applicable') summary.notApplicable += 1;
    else if (result.status === 'error') summary.failed += 1;
  }
  return summary;
}

/**
 * `aih claim` 执行器。返回进程退出码（0 = 没有账号级失败）。
 * deps 允许测试注入 listAccountCredentialRecords / runActivityClaim。
 */
async function runClaimCommand(argv = [], deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim() || nodeOs.homedir();
  const consoleImpl = deps.consoleImpl || console;
  const processObj = deps.processObj || process;
  const log = typeof consoleImpl.log === 'function' ? consoleImpl.log.bind(consoleImpl) : () => {};

  const options = parseArgs(argv);
  if (options.error) {
    consoleImpl.error(`\x1b[31m[aih] ${options.error}\x1b[0m`);
    writeUsage(log);
    return 1;
  }
  if (options.help) {
    writeUsage(log);
    return 0;
  }
  if (!aiHomeDir) {
    consoleImpl.error('\x1b[31m[aih] claim requires the AIH home directory.\x1b[0m');
    return 1;
  }
  const providerSelection = resolveProviders(options.providers);
  if (providerSelection.error) {
    consoleImpl.error(`\x1b[31m[aih] ${providerSelection.error}\x1b[0m`);
    writeUsage(log);
    return 1;
  }

  const listRecords = typeof deps.listAccountCredentialRecords === 'function'
    ? deps.listAccountCredentialRecords
    : defaultListCredentialRecords;
  const listAliases = typeof deps.listCliAccountRefRecords === 'function'
    ? deps.listCliAccountRefRecords
    : defaultListCliAccountRefRecords;
  const executeClaim = typeof deps.runActivityClaim === 'function'
    ? deps.runActivityClaim
    : runActivityClaim;
  // 请求与出口解析的默认实现来自 server 侧的同源模块：不注入时命令依然可用，
  // 且签到/领套餐与额度探针走同一条账号出口（绝不静默直连）。
  const fetchImpl = typeof deps.fetchWithTimeout === 'function'
    ? deps.fetchWithTimeout
    : defaultFetchWithTimeout;
  const resolveEgress = typeof deps.resolveAccountEgressRequestOptions === 'function'
    ? deps.resolveAccountEgressRequestOptions
    : defaultResolveAccountEgressRequestOptions;

  const results = [];
  for (const provider of providerSelection.providers) {
    let records = [];
    try {
      records = listRecords(fsImpl, aiHomeDir, provider);
    } catch (error) {
      results.push({
        provider,
        accountRef: '',
        status: 'error',
        error: `account_list_failed:${String(error && error.message || error).trim()}`
      });
      continue;
    }
    const selection = resolveAccountSelection({
      fs: fsImpl,
      aiHomeDir,
      provider,
      account: options.account,
      records,
      listCliAccountRefRecords: listAliases
    });
    if (selection.unknownAccount) {
      results.push({
        provider,
        accountRef: selection.unknownAccount,
        status: 'error',
        error: 'account_not_found'
      });
      continue;
    }
    if (selection.records.length === 0) {
      if (!options.account) results.push({ provider, accountRef: '', status: 'no_accounts' });
      continue;
    }
    for (const record of selection.records) {
      let result = null;
      try {
        result = await executeClaim({
          provider,
          record,
          fs: fsImpl,
          aiHomeDir,
          hostHomeDir,
          processObj,
          dryRun: options.dryRun === true,
          appVersion: options.appVersion,
          captchaBrowser: options.captchaBrowser,
          timeoutMs: options.timeoutMs,
          fetchWithTimeout: fetchImpl,
          resolveAccountEgressRequestOptions: resolveEgress,
          accountEgressDeps: deps.accountEgressDeps,
          solveCaptcha: deps.solveCaptcha
        });
      } catch (error) {
        result = {
          provider,
          accountRef: record.accountRef,
          status: 'error',
          error: `claim_failed:${String(error && error.message || error).trim()}`
        };
      }
      if (!result || typeof result !== 'object') {
        result = { provider, accountRef: record.accountRef, status: 'error', error: 'claim_failed:empty_result' };
      }
      results.push(result);
    }
  }

  const summary = summarize(results);
  const payload = {
    ok: summary.failed === 0,
    capturedAt: new Date().toISOString(),
    dryRun: options.dryRun === true,
    results,
    summary
  };

  if (options.json) {
    log(JSON.stringify(payload, null, 2));
  } else {
    log(`\x1b[36maih claim\x1b[0m ${payload.capturedAt}${options.dryRun ? ' \x1b[90m(dry run)\x1b[0m' : ''}`);
    const aliasesByRef = new Map();
    for (const provider of providerSelection.providers) {
      try {
        for (const entry of listAliases(fsImpl, aiHomeDir, provider, { bestEffort: true })) {
          aliasesByRef.set(entry.accountRef, entry);
        }
      } catch (_error) {
        // 别名只影响展示，读不到就显示 '-'。
      }
    }
    for (const result of results) {
      if (result.status === 'no_accounts') {
        log(`  ${(PROVIDER_LABELS[result.provider] || result.provider).padEnd(8)}  no accounts`);
        continue;
      }
      if (options.quiet && result.status !== 'error') continue;
      log(formatResultLine(result, aliasesByRef.get(result.accountRef)));
    }
    log(`\x1b[90m${summary.claimed} claimed · ${summary.alreadyClaimed} already claimed · ${summary.nothingClaimable} nothing claimable · ${summary.failed} failed\x1b[0m`);
  }

  return summary.failed > 0 ? 1 : 0;
}

module.exports = {
  formatResultLine,
  parseArgs,
  resolveAccountSelection,
  resolveProviders,
  runClaimCommand,
  summarize,
  writeUsage
};
