'use strict';

/**
 * `aih provider ls`：provider 目录（一行一个 provider）。
 *
 * 它和账号列表是两条查询：`aih ls` 回答"有哪些账号"，这里回答"有哪些 provider、
 * 各自多少账号、有没有原生 CLI"——是 `aih '*buddy*' ls` 的前置查询。
 *
 * 单独成模块的原因：轻量入口（ls-fastpath）与完整 CLI 都要用它。放在
 * provider-resource-command 里会把 doctor / managed-resource 一起拖进热路径。
 */

const {
  listAccountProviders,
  listSupportedAiClis
} = require('../ai-cli/provider-registry');
const {
  resolveProviderScope,
  parseProviderScopeArgs,
  describeScopeMiss
} = require('./provider-scope');

/** 每个 provider 有多少个账号（只读账号引用记录，不碰凭据）。 */
function countAccountsByProvider(fs, aiHomeDir, providers = listAccountProviders()) {
  const { listCliAccountRefRecords } = require('../../../server/account-ref-store');
  const counts = {};
  providers.forEach((provider) => {
    try {
      counts[provider] = listCliAccountRefRecords(fs, aiHomeDir, provider, { bestEffort: true }).length;
    } catch (_error) {
      counts[provider] = 0;
    }
  });
  return counts;
}

/**
 * @returns {{rows: Array<{provider: string, accounts: number, cli: boolean}>}|{error: string}}
 */
function buildProviderListing(args = [], counts = {}) {
  const { patterns: scopePatterns, rest } = parseProviderScopeArgs(args);
  // 位置参数里的选项（--json 等）不是 provider 名，别当成 pattern 去匹配。
  const patterns = [
    ...rest.map((token) => String(token)).filter((token) => token && !token.startsWith('-')),
    ...scopePatterns
  ];
  const all = listAccountProviders();

  let selected = all;
  if (patterns.length > 0) {
    const resolved = resolveProviderScope(patterns, all);
    if (resolved.unmatched.length > 0) {
      return { error: describeScopeMiss(resolved.unmatched, all) };
    }
    selected = all.filter((provider) => resolved.providers.includes(provider));
  }

  const withCli = new Set(listSupportedAiClis());
  return {
    rows: selected.map((provider) => ({
      provider,
      accounts: Number(counts[provider] || 0),
      cli: withCli.has(provider)
    }))
  };
}

function formatProviderListingRows(rows) {
  const lines = [`\x1b[36m▶ Providers\x1b[0m \x1b[90m(${rows.length})\x1b[0m`, ''];
  rows.forEach((row) => {
    const count = row.accounts > 0
      ? `\x1b[32m${row.accounts} account${row.accounts === 1 ? '' : 's'}\x1b[0m`
      : '\x1b[90m0 accounts\x1b[0m';
    const cli = row.cli ? '' : ' \x1b[90m(no native CLI)\x1b[0m';
    lines.push(`  ${row.provider.padEnd(14)}${count}${cli}`);
  });
  lines.push('');
  return lines;
}

function providerListingJson(rows) {
  return { ok: true, providers: rows };
}

/**
 * 执行 `provider ls`（args 是 `ls` 之后的 token）。
 * 返回退出码；输出走调用方给的 output（完整 CLI 是 console，轻量入口是 stdout）。
 */
function runProviderListCommand(args = [], options = {}) {
  const output = options.output || console;
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const counts = aiHomeDir ? countAccountsByProvider(fs, aiHomeDir) : {};
  const listing = buildProviderListing(args, counts);
  if (listing.error) {
    output.error(listing.error);
    return 1;
  }
  if (args.includes('--json')) {
    output.log(JSON.stringify(providerListingJson(listing.rows)));
    return 0;
  }
  formatProviderListingRows(listing.rows).forEach((line) => output.log(line));
  return 0;
}

module.exports = {
  countAccountsByProvider,
  buildProviderListing,
  formatProviderListingRows,
  providerListingJson,
  runProviderListCommand
};
