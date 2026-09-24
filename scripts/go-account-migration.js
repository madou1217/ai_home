#!/usr/bin/env node
'use strict';

// Node -> Go 账号迁移（P1）命令行入口。
//
//   node scripts/go-account-migration.js plan    # 只读演练：临时 Go + 临时 aih.db，写出账本（默认）
//   node scripts/go-account-migration.js apply   # 按账本导入真实 <AIH_HOME>/aih.db（Node 自 plan 后未变才允许）
//   node scripts/go-account-migration.js verify  # 只读核对 aih.db 与 Node 账号逐字段一致
//
// 选项：--aih-home <dir>（默认 AIH_HOME 或 ~/.ai_home） --go-binary <path> --json
// apply 期间不要同时运行开启了 Go Core 的 aih server（两个 Go 进程写同一 aih.db 时
// 常驻进程的路由索引不会刷新）；常驻 server 的持续同步会在下次启动时接管。
// 账本写入 <AIH_HOME>/migration/go-account-ledger.json（0600，只含账号引用与分类，不含凭据）。

const os = require('node:os');
const path = require('node:path');

const {
  applyAccountMigration,
  planAccountMigration,
  verifyAccountMigration
} = require('../lib/account/go-bridge/account-migration');
const { resolveGoServerBinary } = require('../lib/cli/services/server/go-core-supervisor');

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function resolveAiHome(argv) {
  const explicit = readFlag(argv, '--aih-home') || process.env.AIH_HOME || process.env.AIH_HOME_DIR;
  return path.resolve(explicit || path.join(os.homedir(), '.ai_home'));
}

function printSummary(label, value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(`[aih] ${label}`);
  console.log(JSON.stringify(value, null, 2));
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan';
  const asJson = argv.includes('--json');
  const aiHomeDir = resolveAiHome(argv);
  const goBinary = path.resolve(readFlag(argv, '--go-binary') || resolveGoServerBinary({}));

  if (command === 'plan') {
    const { ledger, file } = await planAccountMigration({ aiHomeDir, goBinary });
    printSummary(`dry-run ledger written to ${file}`, { summary: ledger.summary, defaults: ledger.defaults }, asJson);
    const blocked = ledger.entries.filter((entry) => entry.resolution === 'unsupported_in_go' || entry.resolution === 'rejected_by_go');
    if (!asJson && blocked.length > 0) {
      console.log('[aih] accounts that stay Node-only:');
      for (const entry of blocked) console.log(`  ${entry.provider} ${entry.old_account_ref}: ${entry.reason}`);
    }
    return 0;
  }
  if (command === 'apply') {
    const result = await applyAccountMigration({ aiHomeDir, goBinary });
    printSummary('applied', { summary: result.summary, failures: result.failures }, asJson);
    return result.failures.length === 0 ? 0 : 1;
  }
  if (command === 'verify') {
    const result = verifyAccountMigration({ aiHomeDir });
    printSummary(result.ok ? 'verified: Go matches Node' : 'verification FAILED', result, asJson);
    return result.ok ? 0 : 1;
  }
  console.error(`[aih] unknown command: ${command} (expected plan | apply | verify)`);
  return 2;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[aih] go account migration failed: ${error.code || ''} ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
