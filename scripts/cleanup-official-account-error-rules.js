#!/usr/bin/env node
'use strict';

const { resolveAiHomeDir } = require('../lib/runtime/aih-home');

// 一次性迁移入口：清掉官方上游 / OAuth 账号上的账号级调度规则（死配置）。
//
//   node scripts/cleanup-official-account-error-rules.js            # 演练（默认，只读）
//   node scripts/cleanup-official-account-error-rules.js --apply    # 执行（先写备份再删键）
//   node scripts/cleanup-official-account-error-rules.js --json     # 机器可读输出
//
// 选项：--aih-home <dir>（默认 AIH_HOME_DIR 或 ~/.ai_home）
//
// 改哪些数据、为什么改、边界在哪：见 lib/account/official-account-rules-cleanup.js 文件头。
// 备份：<AIH_HOME_DIR>/run/migrations/<时间戳>-official-account-error-rules.json（0600，含被删规则全文）。

const fs = require('node:fs');
const http = require('node:http');
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
  const explicit = readFlag(argv, '--aih-home') || resolveAiHomeDir({ env: process.env });
  return path.resolve(explicit || path.join(os.homedir(), '.ai_home'));
}

// 迁移写的是库，常驻 server 的内存池还拿着旧规则；顺手让它重载一次（需要管理密钥）。
// 只做 best-effort：拿不到密钥 / 连不上都不算失败，只提示。
function tryReloadRunningServer() {
  return new Promise((resolve) => {
    const key = String(process.env.AIH_SERVER_MANAGEMENT_KEY || '').trim();
    if (!key) return resolve({ reloaded: false, reason: 'no_management_key' });
    const host = String(process.env.AIH_SERVER_HOST || '127.0.0.1').trim() || '127.0.0.1';
    const port = Number(process.env.AIH_SERVER_PORT) || 9527;
    const req = http.request({
      host,
      port,
      method: 'POST',
      path: '/v0/management/reload',
      headers: { authorization: `Bearer ${key}`, 'content-length': 0 },
      timeout: 5000
    }, (res) => {
      res.resume();
      resolve({ reloaded: res.statusCode === 200, reason: `http_${res.statusCode}` });
    });
    req.on('error', (error) => resolve({ reloaded: false, reason: String((error && error.code) || error) }));
    req.on('timeout', () => { req.destroy(); resolve({ reloaded: false, reason: 'timeout' }); });
    req.end();
  });
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/cleanup-official-account-error-rules.js [options]',
    '',
    'Options:',
    '  --apply            删除官方上游 / OAuth 账号上的调度规则（默认只演练）。',
    '  --aih-home PATH    数据目录，默认 AIH_HOME_DIR 或 ~/.ai_home。',
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

async function main(argv = process.argv.slice(2)) {
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

  if (apply && result.applied && result.applied.length > 0) {
    return tryReloadRunningServer().then((reload) => {
      printReport({ apply, asJson, aiHomeDir, result, reload });
      return result.failed && result.failed.length ? 1 : 0;
    });
  }
  printReport({ apply, asJson, aiHomeDir, result, reload: null });
  return result.failed && result.failed.length ? 1 : 0;
}

function printReport(input) {
  const { apply, asJson, aiHomeDir, result, reload } = input;
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ applied: apply, ...result, reload }, null, 2)}\n`);
    return;
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
    if (reload && reload.reloaded) {
      process.stdout.write('[aih] 已让常驻 server 重载运行池，规则投影已重推给 Go Core。\n');
    } else {
      process.stdout.write(`[aih] 未能自动重载常驻 server（${reload ? reload.reason : 'skipped'}）：`
        + '设 AIH_SERVER_MANAGEMENT_KEY 后可自动重载，或重启 server / 触发一次账号编辑。\n');
    }
  } else {
    process.stdout.write('[aih] 这是演练；加 --apply 才会写库（写前会先落备份）。\n');
  }
}

if (require.main === module) {
  try {
    Promise.resolve(main()).then((code) => { process.exitCode = code; }).catch((error) => {
      process.stderr.write(`[aih] 清理失败：${String((error && error.message) || error)}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`[aih] 清理失败：${String((error && error.message) || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, resolveAiHome };
