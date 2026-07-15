#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { output: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output' && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function findLatestHealthcheckLog(logsDir) {
  if (!fs.existsSync(logsDir)) return null;
  const candidates = fs.readdirSync(logsDir)
    .filter((name) => name.startsWith('healthcheck-sweep') && name.endsWith('.json'))
    .map((name) => path.join(logsDir, name))
    .map((filePath) => ({ filePath, stat: fs.statSync(filePath) }))
    .filter((item) => item.stat.isFile())
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return candidates.length > 0 ? candidates[0].filePath : null;
}

function safeReadJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function buildChecks(repoRoot) {
  const logsDir = path.join(repoRoot, 'logs');
  const latestHealthcheck = findLatestHealthcheckLog(logsDir);
  const healthPayload = latestHealthcheck ? safeReadJson(latestHealthcheck) : null;
  const healthStatus = healthPayload && healthPayload.overall_status === 'pass' ? 'pass' : 'warn';

  const requiredDocs = [
    'docs/release/linux-validation-matrix.md',
    'docs/release/macos-validation-matrix.md',
    'docs/release/windows-validation-matrix.md',
    'docs/release/signing-notarization-checklist.md'
  ];
  const missingDocs = requiredDocs.filter((p) => !fs.existsSync(path.join(repoRoot, p)));

  const checks = [
    {
      name: 'runtime_healthcheck',
      status: healthStatus,
      detail: latestHealthcheck
        ? `latest=${path.relative(repoRoot, latestHealthcheck)} overall=${healthPayload ? healthPayload.overall_status : 'invalid-json'}`
        : 'no healthcheck log found'
    },
    {
      name: 'release_docs_presence',
      status: missingDocs.length === 0 ? 'pass' : 'warn',
      detail: missingDocs.length === 0 ? 'all required docs present' : `missing=${missingDocs.join(', ')}`
    }
  ];
  const overall = checks.every((item) => item.status === 'pass') ? 'pass' : 'warn';
  return { overall, checks, latestHealthcheck };
}

function renderReport(payload) {
  const lines = [];
  lines.push('# Release Gate Report');
  lines.push('');
  lines.push(`- generated_at: ${payload.generated_at}`);
  lines.push(`- overall_status: ${payload.overall_status}`);
  lines.push('');
  lines.push('## Checks');
  for (const item of payload.checks) {
    lines.push(`- ${item.name}: ${item.status} (${item.detail})`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/ops/release-gate-report.js [--output <path>]');
    process.exit(0);
  }

  const repoRoot = path.resolve(__dirname, '..', '..');
  const report = buildChecks(repoRoot);
  const payload = {
    tool: 'release-gate-report',
    version: 1,
    generated_at: new Date().toISOString(),
    overall_status: report.overall,
    checks: report.checks
  };
  const outputPath = args.output || path.join(repoRoot, 'logs', `release-gate-report-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const content = renderReport(payload);
  fs.writeFileSync(outputPath, content, 'utf8');
  console.log(`release-gate-report: ${payload.overall_status} -> ${path.relative(repoRoot, outputPath)}`);
}

main();
