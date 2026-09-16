#!/usr/bin/env node
'use strict';

// Codex OAuth identity rekey driver.
//
// The vector moved from `oauth:codex:<email>` to `oauth:codex:<user_id>`
// (docs/architecture/codex-oauth-identity-vector-adr.md). Existing accounts still
// carry the email-derived accountRef, and §8.1 of the Node/Go product direction
// forbids rewriting those silently: it requires an explicit mapping ledger
// (`old_account_ref -> account_ref + resolution`) with conflicts adjudicated one
// by one.
//
// So this tool is dry-run by default. It writes the ledger next to the user's
// data (never into the repo) and changes nothing. `--apply` needs the reviewed
// ledger path plus an explicit `--confirm-apply`, and still refuses while the
// ledger carries any unresolved conflict.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveCliPaths } = require('../lib/cli/config/paths');
const {
  applyCodexIdentityRekey,
  ledgerIsApplicable,
  planCodexIdentityRekey
} = require('../lib/cli/services/account/codex-identity-rekey');

const LEDGER_RELATIVE_PATH = path.join('migration', 'codex-identity-ledger.json');

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/codex-identity-rekey.js [options]',
    '',
    'Default is a dry run: it writes the mapping ledger and changes nothing.',
    '',
    'Options:',
    '  --provider NAME      codex (default) or grok; identity migrations never cross Providers.',
    '  --ai-home PATH       AIH data root. Defaults to AIH_HOME_DIR/AIH_HOME/AI_HOME or ~/.ai_home.',
    '  --ledger PATH        Ledger path. Defaults to <ai-home>/migration/codex-identity-ledger.json.',
    '  --apply              Rewrite stored accountRefs from a previously reviewed ledger.',
    '  --confirm-apply      Required together with --apply; states that the ledger was reviewed.',
    '  --json               Print the machine-readable ledger.',
    '  --help               Show this help.',
    '',
    'Refuses to --apply while the ledger has conflicts, unverifiable accounts, or',
    'accountRefs that belong to no known vector. A partial rewrite would leave the',
    'account system split across two vectors, which is worse than not migrating.',
    ''
  ].join('\n'));
}

function readOptionValue(argv, index, name) {
  const token = String(argv[index] || '');
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), consumed: 0 };
  return { value: String(argv[index + 1] || ''), consumed: 1 };
}

function parseArgs(argv) {
  const options = { apply: false, confirmApply: false, json: false, aiHome: '', ledger: '', help: false, provider: 'codex' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--apply') options.apply = true;
    else if (token === '--confirm-apply') options.confirmApply = true;
    else if (token === '--json') options.json = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--provider' || token.startsWith('--provider=')) {
      const read = readOptionValue(argv, index, '--provider');
      if (!['codex', 'grok'].includes(read.value)) throw new Error('unsupported_identity_rekey_provider');
      options.provider = read.value; index += read.consumed;
    }
    else if (token === '--ai-home' || token.startsWith('--ai-home=')) {
      const read = readOptionValue(argv, index, '--ai-home');
      options.aiHome = read.value;
      index += read.consumed;
    } else if (token === '--ledger' || token.startsWith('--ledger=')) {
      const read = readOptionValue(argv, index, '--ledger');
      options.ledger = read.value;
      index += read.consumed;
    } else {
      throw new Error(`unknown_argument:${token}`);
    }
  }
  return options;
}

function resolveAiHomeDir(explicit) {
  const fromFlag = String(explicit || '').trim();
  if (fromFlag) return fromFlag;
  const { aiHomeDir } = resolveCliPaths({ path, env: process.env, platform: process.platform, os });
  return aiHomeDir;
}

function formatSummary(summary, provider = 'codex') {
  return [
    `${provider} 账号总数            ${summary.total}`,
    `已在 user_id 向量（不动） ${summary.already_current}`,
    `API-key（不适用，不动）   ${summary.not_applicable || 0}`,
    `可迁移                    ${summary.migrate}`,
    `冲突（需人工裁决）        ${summary.conflict}`,
    `缺稳定 user_id（不可迁移）${summary.unverifiable}`,
    `不属于已知向量            ${summary.unrecognized}`
  ].join('\n');
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const aiHomeDir = resolveAiHomeDir(options.aiHome);
  const ledgerPath = String(options.ledger || '').trim() || path.join(aiHomeDir, 'migration', `${options.provider}-identity-ledger.json`);

  if (options.apply) {
    if (!options.confirmApply) {
      process.stderr.write(
        '拒绝执行：--apply 必须同时传 --confirm-apply，以确认账本已人工复核。\n'
      );
      return 2;
    }
    let ledger;
    try {
      ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    } catch (error) {
      process.stderr.write(`拒绝执行：读取账本失败 ${ledgerPath}: ${error.message}\n`);
      return 2;
    }
    if (ledger.provider !== options.provider) throw new Error('ledger_provider_mismatch');
    const result = applyCodexIdentityRekey({ fs, aiHomeDir, ledger });
    if (!result.applied) {
      process.stderr.write(`rekey 未执行：${result.reason}\n`);
      if (result.blockers) process.stderr.write(`${result.blockers.join('\n')}\n`);
      if (result.error) process.stderr.write(`${result.error}\n`);
      return 1;
    }
    process.stdout.write(
      `rekey 完成：改写 ${result.rewritten} 处引用（${result.reason}）。\n`
    );
    return 0;
  }

  const { ledger, summary } = planCodexIdentityRekey({ fs, aiHomeDir, provider: options.provider });
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  // The ledger carries account identifiers/email; do not create world-readable diagnostics.
  const tempPath = `${ledgerPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try { fs.renameSync(tempPath, ledgerPath); } finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`账本已写入 ${ledgerPath}（本次未改动任何账号）。\n\n`);
  process.stdout.write(`${formatSummary(summary, options.provider)}\n`);
  const applicability = ledgerIsApplicable(ledger);
  if (!applicability.applicable) {
    process.stdout.write(`\n执行前必须先解决：\n- ${applicability.blockers.join('\n- ')}\n`);
  } else if (summary.migrate > 0) {
    process.stdout.write(
      '\n账本无阻塞。复核后执行：\n'
      + `  node scripts/codex-identity-rekey.js --provider ${options.provider} --apply --confirm-apply --ledger ${ledgerPath}\n`
    );
  } else {
    process.stdout.write('\n没有需要迁移的账号。\n');
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { LEDGER_RELATIVE_PATH, formatSummary, main, parseArgs, resolveAiHomeDir };
