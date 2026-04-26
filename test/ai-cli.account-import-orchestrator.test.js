const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseGlobalAccountImportArgs,
  runGlobalAccountImport
} = require('../lib/cli/services/ai-cli/account-import-orchestrator');

test('parseGlobalAccountImportArgs supports compact options', () => {
  const parsedDefault = parseGlobalAccountImportArgs(['--dry-run']);
  assert.equal(parsedDefault.sourceRoot, 'accounts');
  assert.equal(parsedDefault.dryRun, true);

  const parsedCustom = parseGlobalAccountImportArgs(['/tmp/accounts']);
  assert.equal(parsedCustom.sourceRoot, '/tmp/accounts');
  assert.equal(parsedCustom.dryRun, false);
});

test('runGlobalAccountImport scans accounts/<provider> and invokes supported importers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-import-'));
  const accountsRoot = path.join(root, 'accounts');
  const codexDir = path.join(accountsRoot, 'codex');
  const geminiDir = path.join(accountsRoot, 'gemini');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(geminiDir, { recursive: true });

  let seenSourceDir = '';
  const result = await runGlobalAccountImport([accountsRoot, '--dry-run'], {
    fs,
    log: () => {},
    error: () => {},
    parseCodexBulkImportArgs: (args) => {
      seenSourceDir = String(args[0] || '');
      return { sourceDir: seenSourceDir, dryRun: true, parallel: 1, limit: 0 };
    },
    importCodexTokensFromOutput: async () => ({
      dryRun: true,
      sourceDir: seenSourceDir,
      scannedFiles: 0,
      parsedLines: 0,
      imported: 0,
      duplicates: 0,
      invalid: 0
    })
  });

  assert.equal(seenSourceDir, codexDir);
  assert.deepEqual(result.providers, ['codex']);
  assert.deepEqual(result.failedProviders, []);
});

test('runGlobalAccountImport reports provider progress callback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-global-import-'));
  const accountsRoot = path.join(root, 'accounts');
  const codexDir = path.join(accountsRoot, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const progressEvents = [];
  await runGlobalAccountImport([accountsRoot, '--dry-run'], {
    fs,
    log: () => {},
    error: () => {},
    onProviderProgress: (processed, total, provider) => {
      progressEvents.push({ processed, total, provider });
    },
    parseCodexBulkImportArgs: (args) => ({
      sourceDir: String(args[0] || ''),
      dryRun: true,
      parallel: 1,
      limit: 0
    }),
    importCodexTokensFromOutput: async () => ({
      dryRun: true,
      scannedFiles: 0,
      parsedLines: 0,
      imported: 0,
      duplicates: 0,
      invalid: 0
    })
  });

  assert.deepEqual(progressEvents, [
    { processed: 1, total: 1, provider: 'codex' }
  ]);
});
