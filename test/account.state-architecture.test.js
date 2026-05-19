const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) out.push(fullPath);
  }
  return out;
}

test('account state mutations are centralized behind accountStateService', () => {
  const allowedFiles = new Set([
    path.join(repoRoot, 'lib/account/state-service.js')
  ]);
  const mutationPatterns = [
    /\.upsertAccountState\(/,
    /\.upsertRuntimeState\(/,
    /\.setStatus\(/,
    /\.deleteAccountState\(/,
    /\.removeAccount\(/,
    /stateIndexClient\.upsert\(/,
    /stateIndexClient\.prune/
  ];

  const violations = [];
  for (const file of listJsFiles(path.join(repoRoot, 'lib'))) {
    if (allowedFiles.has(file)) continue;
    const rel = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (mutationPatterns.some((pattern) => pattern.test(line))) {
        violations.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, []);
});

test('account selection does not bypass accountQueryService candidate policy', () => {
  const selectionPath = path.join(repoRoot, 'lib/cli/services/account/selection.js');
  const source = fs.readFileSync(selectionPath, 'utf8');
  assert.equal(source.includes('getNextCandidateId('), false);
});
