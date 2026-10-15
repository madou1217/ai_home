#!/usr/bin/env node
'use strict';

// 一次性迁移入口：清掉官方上游 / OAuth 账号上的账号级调度规则（死配置）。
//
//   node scripts/cleanup-official-account-error-rules.js            # 演练（默认，只读）
//   node scripts/cleanup-official-account-error-rules.js --apply    # 执行（先写备份再删键）
//   node scripts/cleanup-official-account-error-rules.js --json     # 机器可读输出
//
// 选项：--aih-home <dir>（默认 AIH_HOME 或 ~/.ai_home）
//
// 改哪些数据、为什么改、边界在哪：见 lib/account/official-account-rules-cleanup.js 文件头。
// 备份：<AIH_HOME>/run/migrations/<时间戳>-official-account-error-rules.json（0600，含被删规则全文）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyOfficialAccountRulesCleanup,
  planOfficialAccountRulesCleanup
} = require('../lib/account/official-account-rules-cleanup');
const { createAccountStateIndex } = require('../lib/account/state-index');

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function resolveAiHome(argv) {
  const explicit = readFlag(argv, '--aih-home') || process.env.AIH_HOME || process.env.AIH_HOME_DIR;
  return path.resolve(explicit || path.join(os.homedir(), '.ai_home'));
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/cleanup-official-account-error-rules.js [options]',
    '',
    'Options:',
    '  --apply            删除官方上游 / OAuth 账号上的调度规则（默认只演练）。',
    '  --aih-home PATH    数据目录，默认 AIH_HOME 或 ~/.ai_home。',
    '  --json             输出完整 JSON 报告。',
    '  --help             显示本帮助。',
    ''
  ].join('\n'));
}

function formatAccount(entry) {
  const groups = entry.groupIds && entry.groupIds.length ? ` groups=${entry.groupIds.join(',')}` : '';
  const host = entry.baseUrlHost ? ` host=${entry.baseUrlHost}` : '';
  const reason = entry.reason ? ` (${entry.reason})` : '';
  return `  ${entry.provider} ${entry.accountRef} rules=${entry.ruleCount}${groups}${host}${reason}`;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  const apply = argv.includes('--apply');
  const asJson = argv.includes('--json');
  const aiHomeDir = resolveAiHome(argv);
  const accountStateIndex = createAccountStateIndex({ aiHomeDir, fs });
  const plan = planOfficialAccountRulesCleanup({ fs, aiHomeDir, accountStateIndex });
  const result = apply
    ? applyOfficialAccountRulesCleanup({ fs, aiHomeDir, accountStateIndex, plan })
    : plan;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ applied: apply, ...result }, null, 2)}\n`);
    return result.failed && result.failed.length ? 1 : 0;
  }
  process.stdout.write(`[aih] 数据目录 ${aiHomeDir}\n`);
  process.stdout.write(`[aih] 扫描账号 ${result.scannedAccounts}，其中带调度规则 ${result.accountsWithRules}\n`);
  process.stdout.write(`[aih] ${apply ? '已清理' : '待清理'} ${result.planned.length} 个账号：\n`);
  result.planned.forEach((entry) => process.stdout.write(`${formatAccount(entry)}\n`));
  process.stdout.write(`[aih] 保留（第三方/自建上游）${result.kept.length} 个账号：\n`);
  result.kept.forEach((entry) => process.stdout.write(`${formatAccount(entry)}\n`));
  if (apply) {
    process.stdout.write(`[aih] 备份：${result.backupFile || '(无写入)'}\n`);
    if (result.failed.length) {
      process.stdout.write(`[aih] 失败 ${result.failed.length} 个：\n`);
      result.failed.forEach((entry) => process.stdout.write(`  ${entry.provider} ${entry.accountRef}: ${entry.error}\n`));
    }
    process.stdout.write('[aih] 常驻 server 需重启（或触发一次账号编辑）后才会把规则投影重新推给 Go Core。\n');
  } else {
    process.stdout.write('[aih] 这是演练；加 --apply 才会写库（写前会先落备份）。\n');
  }
  return result.failed && result.failed.length ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[aih] 清理失败：${String((error && error.message) || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, resolveAiHome };
