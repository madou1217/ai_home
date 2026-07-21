#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const {
  alignCodexSessionProviders
} = require('../lib/cli/services/ai-cli/codex-session-provider-alignment');

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/align-codex-session-providers.js [options]',
    '',
    'Options:',
    '  --apply             Update state DB rows and rollout session_meta records.',
    '  --db-only           Skip rollout JSONL metadata alignment.',
    '  --codex-home PATH   Codex home. Defaults to CODEX_SQLITE_HOME, CODEX_HOME, or ~/.codex.',
    '  --json              Print the full machine-readable report.',
    '  --help              Show this help.',
    ''
  ].join('\n'));
}

function readOptionValue(argv, index, name) {
  const token = String(argv[index] || '');
  if (token.startsWith(`${name}=`)) return { value: token.slice(name.length + 1), consumed: 0 };
  return { value: String(argv[index + 1] || ''), consumed: 1 };
}

function parseArgs(argv) {
  const options = { apply: false, includeRollouts: true, json: false, codexHome: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--apply') options.apply = true;
    else if (token === '--db-only') options.includeRollouts = false;
    else if (token === '--json') options.json = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--codex-home' || token.startsWith('--codex-home=')) {
      const read = readOptionValue(argv, index, '--codex-home');
      if (!read.value || (read.consumed > 0 && read.value.startsWith('-'))) {
        throw new Error('missing_option_value:--codex-home');
      }
      options.codexHome = read.value;
      index += read.consumed;
    } else {
      throw new Error(`unknown_option:${token}`);
    }
  }
  return options;
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function printSummary(report) {
  const lines = [
    `[codex-session-provider-align] mode=${report.mode}`,
    `  codex_home: ${report.codexHome}`,
    `  canonical_provider: ${report.canonicalProvider}`,
    `  databases: ${report.databases.length}`,
    `  database_rows: matched=${report.databaseRowsMatched} changed=${report.databaseRowsChanged}`,
    `  rollout_files: matched=${report.rolloutFilesMatched} changed=${report.rolloutFilesChanged}`,
    `  rollout_bytes: ${formatBytes(report.rolloutBytesMatched)}`,
    `  rollout_providers: ${JSON.stringify(report.rolloutProviders)}`,
    `  rollout_errors: ${report.rolloutErrors.length}`
  ];
  if (report.mode === 'dry-run' && (report.databaseRowsMatched > 0 || report.rolloutFilesMatched > 0)) {
    lines.push('  apply: rerun with --apply after reviewing this report');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const codexHome = path.resolve(
    String(
      options.codexHome
      || process.env.CODEX_SQLITE_HOME
      || process.env.CODEX_HOME
      || path.join(os.homedir(), '.codex')
    ).trim()
  );
  const report = alignCodexSessionProviders(codexHome, options);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printSummary(report);
  if (report.rolloutErrors.length > 0) process.exitCode = 2;
}

try {
  main();
} catch (error) {
  process.stderr.write(`[codex-session-provider-align] ${String((error && error.message) || error)}\n`);
  process.exitCode = 1;
}
