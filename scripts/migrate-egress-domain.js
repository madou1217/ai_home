#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveAiHomeDir } = require('../lib/runtime/aih-home');
const {
  applyEgressMigration,
  planEgressMigration,
  rollbackEgressMigration
} = require('../lib/server/egress-domain-migration');

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || '') : '';
}

function help() {
  process.stdout.write([
    'Usage: node scripts/migrate-egress-domain.js [plan|apply|rollback] [options]',
    '',
    '  plan                  Inspect legacy records without writing entities.',
    '  apply                 Write the scoped domain and an atomic rollback journal.',
    '  rollback              Restore the domain records from --migration-id.',
    '  --ai-home PATH        AIH data root (defaults to AIH_HOME_DIR or ~/.ai_home).',
    '  --migration-id ID     Journal id for rollback.',
    '  --dry-run             Plan and print without writing (apply only).',
    '  --json                Print machine-readable output.',
    '  --help                Show this help.'
  ].join('\n') + '\n');
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { help(); return 0; }
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan';
  const aiHomeDir = path.resolve(valueAfter(argv, '--ai-home') || resolveAiHomeDir({ env: process.env }) || path.join(os.homedir(), '.ai_home'));
  const asJson = argv.includes('--json');
  let result;
  if (command === 'plan') result = planEgressMigration({ fs, aiHomeDir });
  else if (command === 'apply') result = applyEgressMigration({ fs, aiHomeDir, dryRun: argv.includes('--dry-run') });
  else if (command === 'rollback') result = rollbackEgressMigration({ fs, aiHomeDir, migrationId: valueAfter(argv, '--migration-id') });
  else { process.stderr.write(`Unknown command: ${command}\n`); return 2; }
  if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (command === 'apply' && result && result.applied === false && !result.dryRun) return 1;
  if (command === 'rollback' && result && result.rolledBack === false) return 1;
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`${String(error && error.message || error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, help };
