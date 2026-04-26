const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUnifiedImportService } = require('../lib/cli/services/import/unified-import');

function parseCodexArgsForTest(args) {
  const items = Array.isArray(args) ? args : [];
  return {
    sourceDir: items[0],
    parallel: Number(items[2] || 1),
    dryRun: items.includes('--dry-run')
  };
}

test('parseUnifiedImportArgs supports mixed sources and provider prefix', () => {
  const service = createUnifiedImportService({
    fs,
    path,
    os,
    fse: require('fs-extra'),
    execSync: () => {},
    spawnImpl: () => {},
    processImpl: { platform: 'linux' },
    cryptoImpl: require('node:crypto'),
    aiHomeDir: '/tmp/.ai_home',
    cliConfigs: { codex: {}, gemini: {} },
    runGlobalAccountImport: async () => ({}),
    importCliproxyapiCodexAuths: async () => ({})
  });

  const parsed = service.parseUnifiedImportArgs(['codex', 'folder1', 'backup.zip', 'cliproxyapi', '--dry-run', '-f', 'inside', '-j', '16'], '');
  assert.deepEqual(parsed, {
    provider: 'codex',
    dryRun: true,
    folder: 'inside',
    jobs: 16,
    sources: ['folder1', 'backup.zip', 'cliproxyapi']
  });
});

test('runUnifiedImport imports mixed directory and cliproxyapi sources with progress summary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-'));
  try {
    const accountsRoot = path.join(root, 'accounts');
    fs.mkdirSync(path.join(accountsRoot, 'codex', '1001'), { recursive: true });

    const progress = [];
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir: path.join(root, '.ai_home'),
      cliConfigs: { codex: {} },
      parseCodexBulkImportArgs: parseCodexArgsForTest,
      importCodexTokensFromOutput: async () => ({}),
      runGlobalAccountImport: async (args) => ({
        providers: ['codex'],
        failedProviders: [],
        providerResults: [{
          provider: 'codex',
          imported: args[0].includes('__aih_import_root') ? 1 : 2,
          duplicates: 0,
          invalid: 0,
          failed: 0
        }]
      }),
      importCliproxyapiCodexAuths: async () => ({
        imported: 3,
        duplicates: 1,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([accountsRoot, 'cliproxyapi'], {
      log: () => {},
      error: () => {},
      renderStageProgress: (_prefix, current, total, label) => progress.push({ current, total, label })
    });

    assert.deepEqual(result.providers, ['codex']);
    assert.equal(result.sourceResults.length, 2);
    assert.equal(result.sourceResults[0].imported, 2);
    assert.equal(result.sourceResults[1].imported, 3);
    assert.equal(progress.length > 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport auto-discovers nested zip files and provider folders under a container directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-discover-'));
  try {
    const containerDir = path.join(root, 'codexes');
    const folderSource = path.join(containerDir, 'folder1');
    const zipSource = path.join(containerDir, '1001.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    fs.mkdirSync(path.join(folderSource, 'accounts', 'codex', '2001'), { recursive: true });
    fs.mkdirSync(path.join(zipExtractDir, 'accounts', 'codex', '3001'), { recursive: true });
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(zipSource, 'fake-zip');

    const calls = [];
    const progress = [];
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir: path.join(root, '.ai_home'),
      cliConfigs: { codex: {} },
      getDefaultParallelism: () => 4,
      parseCodexBulkImportArgs: parseCodexArgsForTest,
      importCodexTokensFromOutput: async () => ({}),
      ensureArchiveExtractedByHashImpl: async ({ zipPath, onHashProgress, onExtractProgress }) => {
        onHashProgress(10, 10);
        onExtractProgress(100);
        return {
          extractDir: zipPath === zipSource ? zipExtractDir : root,
          cacheHit: false
        };
      },
      runGlobalAccountImport: async (args, opts) => {
        calls.push({ sourceRoot: args[0], parallel: opts.parallel });
        return {
          providers: ['codex'],
          failedProviders: [],
          providerResults: [{
            provider: 'codex',
            imported: args[0] === folderSource ? 2 : 3,
            duplicates: 0,
            invalid: 0,
            failed: 0
          }]
        };
      },
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([containerDir, '-j', '8'], {
      log: () => {},
      error: () => {},
      renderStageProgress: (_prefix, current, total, label) => progress.push({ current, total, label })
    });

    assert.equal(result.sourceCount, 2);
    assert.deepEqual(calls, [
      { sourceRoot: path.join(folderSource, 'accounts'), parallel: 4 },
      { sourceRoot: path.join(zipExtractDir, 'accounts'), parallel: 4 }
    ]);
    assert.equal(result.sourceResults.length, 2);
    assert.equal(progress.some((entry) => String(entry.label).includes('discovering')), true);
    assert.equal(progress.some((entry) => String(entry.label).includes('in_flight=')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport does not mistake a provider-named container directory for an importable provider root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-provider-container-'));
  try {
    const containerDir = path.join(root, 'codex');
    const zipOne = path.join(containerDir, '1001.zip');
    const zipTwo = path.join(containerDir, '1002.zip');
    const extractOne = path.join(root, 'extract-1001');
    const extractTwo = path.join(root, 'extract-1002');
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(zipOne, 'fake-zip-1');
    fs.writeFileSync(zipTwo, 'fake-zip-2');
    fs.mkdirSync(path.join(extractOne, 'accounts', 'codex', '3001', '.codex'), { recursive: true });
    fs.mkdirSync(path.join(extractTwo, 'accounts', 'codex', '3002', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(extractOne, 'accounts', 'codex', '3001', '.codex', 'auth.json'), '{"tokens":{"refresh_token":"rt_one"}}');
    fs.writeFileSync(path.join(extractTwo, 'accounts', 'codex', '3002', '.codex', 'auth.json'), '{"tokens":{"refresh_token":"rt_two"}}');

    const calls = [];
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir: path.join(root, '.ai_home'),
      cliConfigs: { codex: { globalDir: '.codex' } },
      parseCodexBulkImportArgs: parseCodexArgsForTest,
      importCodexTokensFromOutput: async (optionsArg) => {
        calls.push(optionsArg.sourceDir);
        return {
          sourceDir: optionsArg.sourceDir,
          imported: 1,
          duplicates: 0,
          invalid: 0,
          failed: 0,
          dryRun: false
        };
      },
      ensureArchiveExtractedByHashImpl: async ({ zipPath }) => ({
        extractDir: zipPath === zipOne ? extractOne : extractTwo,
        cacheHit: false
      }),
      runGlobalAccountImport: async () => ({ providers: [], failedProviders: [], providerResults: [] }),
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([containerDir], {
      provider: 'codex',
      log: () => {},
      error: () => {}
    });

    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceCount, 2);
    assert.deepEqual(calls, [
      path.join(extractOne, 'accounts', 'codex'),
      path.join(extractTwo, 'accounts', 'codex')
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport imports provider-fixed zip when extracted root is direct account directory layout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-provider-zip-'));
  try {
    const zipPath = path.join(root, '1111.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    fs.writeFileSync(zipPath, 'fake-zip');
    fs.mkdirSync(path.join(zipExtractDir, '10001', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(zipExtractDir, '10001', '.codex', 'auth.json'), '{"refresh_token":"rt_x"}');

    const calls = [];
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir: path.join(root, '.ai_home'),
      cliConfigs: { codex: {} },
      parseCodexBulkImportArgs: parseCodexArgsForTest,
      importCodexTokensFromOutput: async (optionsArg) => {
        calls.push(optionsArg.sourceDir);
        return {
          sourceDir: optionsArg.sourceDir,
          imported: 1,
          duplicates: 0,
          invalid: 0,
          failed: 0,
          dryRun: false
        };
      },
      ensureArchiveExtractedByHashImpl: async () => ({
        extractDir: zipExtractDir,
        cacheHit: false
      }),
      runGlobalAccountImport: async () => ({ providers: [], failedProviders: [], providerResults: [] }),
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([zipPath], {
      provider: 'codex',
      log: () => {},
      error: () => {}
    });

    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0], zipExtractDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport imports provider-fixed directory without requiring nested provider folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-provider-dir-'));
  try {
    const sourceDir = path.join(root, 'plain-folder');
    fs.mkdirSync(path.join(sourceDir, '20001', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '20001', '.codex', 'auth.json'), '{"refresh_token":"rt_dir"}');

    const calls = [];
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir: path.join(root, '.ai_home'),
      cliConfigs: { codex: { globalDir: '.codex' } },
      parseCodexBulkImportArgs: parseCodexArgsForTest,
      importCodexTokensFromOutput: async (optionsArg) => {
        calls.push(optionsArg.sourceDir);
        return {
          sourceDir: optionsArg.sourceDir,
          imported: 1,
          duplicates: 0,
          invalid: 0,
          failed: 0,
          dryRun: false
        };
      },
      runGlobalAccountImport: async () => ({ providers: [], failedProviders: [], providerResults: [] }),
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([sourceDir], {
      provider: 'codex',
      log: () => {},
      error: () => {}
    });

    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceResults.length, 1);
    assert.equal(calls[0], sourceDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport keeps updating progress after cached zip extraction during import stage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-cache-progress-'));
  try {
    const zipPath = path.join(root, '2222.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    fs.writeFileSync(zipPath, 'fake-zip');
    fs.mkdirSync(path.join(zipExtractDir, 'accounts', 'codex', '10001', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(zipExtractDir, 'accounts', 'codex', '10001', '.codex', 'auth.json'), '{"tokens":{"refresh_token":"rt_cached"}}');

    const progress = [];
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir: path.join(root, '.ai_home'),
      cliConfigs: { codex: {} },
      parseCodexBulkImportArgs: parseCodexArgsForTest,
      importCodexTokensFromOutput: async (optionsArg) => {
        if (typeof optionsArg.onProgress === 'function') {
          optionsArg.onProgress({ totalFiles: 20, scannedFiles: 1, status: 'queued' });
          optionsArg.onProgress({ totalFiles: 20, scannedFiles: 10, status: 'imported' });
          optionsArg.onProgress({ totalFiles: 20, scannedFiles: 20, status: 'done' });
        }
        return {
          sourceDir: optionsArg.sourceDir,
          scannedFiles: 20,
          parsedLines: 20,
          imported: 20,
          duplicates: 0,
          invalid: 0,
          failed: 0,
          dryRun: false
        };
      },
      ensureArchiveExtractedByHashImpl: async ({ onHashProgress, onExtractProgress }) => {
        onHashProgress(10, 10);
        onExtractProgress(100);
        return {
          extractDir: zipExtractDir,
          cacheHit: true,
          hash: 'deadbeefdead'
        };
      },
      runGlobalAccountImport: async (args, opts) => {
        if (typeof opts.onImporterProgress === 'function') {
          opts.onImporterProgress('codex', { totalFiles: 20, scannedFiles: 1, status: 'queued' });
          opts.onImporterProgress('codex', { totalFiles: 20, scannedFiles: 10, status: 'imported' });
          opts.onImporterProgress('codex', { totalFiles: 20, scannedFiles: 20, status: 'done' });
        }
        if (typeof opts.onProviderProgress === 'function') {
          opts.onProviderProgress(1, 1, 'codex');
        }
        return {
          providers: ['codex'],
          failedProviders: [],
          providerResults: [{
            provider: 'codex',
            imported: 20,
            duplicates: 0,
            invalid: 0,
            failed: 0
          }]
        };
      },
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    await service.runUnifiedImport([zipPath], {
      provider: 'codex',
      log: () => {},
      error: () => {},
      renderStageProgress: (_prefix, current, total, label) => progress.push({ current, total, label })
    });

    assert.equal(progress.some((entry) => String(entry.label).includes('using cached extraction deadbeefdead')), true);
    assert.equal(progress.some((entry) => String(entry.label).includes('importing codex queued 1/20')), true);
    assert.equal(progress.some((entry) => String(entry.label).includes('importing codex imported 10/20')), true);
    assert.equal(progress.some((entry) => String(entry.label).includes('importing codex done 20/20')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport limits zip prepare concurrency even when jobs is very high', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-zip-limit-'));
  try {
    const containerDir = path.join(root, 'codexes');
    fs.mkdirSync(containerDir, { recursive: true });
    const zipPaths = [];
    for (let i = 0; i < 20; i += 1) {
      const zipPath = path.join(containerDir, `${1000 + i}.zip`);
      zipPaths.push(zipPath);
      fs.writeFileSync(zipPath, `fake-${i}`);
    }

    let activePrepares = 0;
    let peakPrepares = 0;
    const progress = [];
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'win32' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir: path.join(root, '.ai_home'),
      cliConfigs: { codex: { globalDir: '.codex' } },
      parseCodexBulkImportArgs: parseCodexArgsForTest,
      importCodexTokensFromOutput: async (optionsArg) => ({
        sourceDir: optionsArg.sourceDir,
        imported: 1,
        duplicates: 0,
        invalid: 0,
        failed: 0,
        dryRun: false
      }),
      ensureArchiveExtractedByHashImpl: async ({ zipPath }) => {
        activePrepares += 1;
        peakPrepares = Math.max(peakPrepares, activePrepares);
        const extractDir = path.join(root, path.basename(zipPath, '.zip'));
        fs.mkdirSync(path.join(extractDir, '1', '.codex'), { recursive: true });
        fs.writeFileSync(path.join(extractDir, '1', '.codex', 'auth.json'), '{"refresh_token":"rt_limit"}');
        await new Promise((resolve) => setTimeout(resolve, 10));
        activePrepares -= 1;
        return {
          extractDir,
          cacheHit: false
        };
      },
      runGlobalAccountImport: async () => ({ providers: [], failedProviders: [], providerResults: [] }),
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([containerDir, '-j', '1000'], {
      provider: 'codex',
      log: () => {},
      error: () => {},
      renderStageProgress: (_prefix, current, total, label) => progress.push({ current, total, label })
    });

    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceCount, 20);
    assert.equal(peakPrepares <= 8, true);
    assert.equal(progress.some((entry) => String(entry.label).includes('prep=')), true);
    assert.equal(progress.some((entry) => String(entry.label).includes('queued=')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport reuses one fixed-provider import session across multiple zip sources', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-session-'));
  try {
    const containerDir = path.join(root, 'codexes');
    const zipOne = path.join(containerDir, '1001.zip');
    const zipTwo = path.join(containerDir, '1002.zip');
    const extractOne = path.join(root, 'extract-1');
    const extractTwo = path.join(root, 'extract-2');
    fs.mkdirSync(containerDir, { recursive: true });
    fs.writeFileSync(zipOne, 'fake-1');
    fs.writeFileSync(zipTwo, 'fake-2');
    fs.mkdirSync(path.join(extractOne, '1', '.codex'), { recursive: true });
    fs.mkdirSync(path.join(extractTwo, '2', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(extractOne, '1', '.codex', 'auth.json'), '{"refresh_token":"rt_s1"}');
    fs.writeFileSync(path.join(extractTwo, '2', '.codex', 'auth.json'), '{"refresh_token":"rt_s2"}');

    const sessions = [];
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir: path.join(root, '.ai_home'),
      cliConfigs: { codex: { globalDir: '.codex' } },
      parseCodexBulkImportArgs: parseCodexArgsForTest,
      importCodexTokensFromOutput: async (optionsArg) => {
        sessions.push(optionsArg.importSession);
        return {
          sourceDir: optionsArg.sourceDir,
          imported: 1,
          duplicates: 0,
          invalid: 0,
          failed: 0,
          dryRun: false
        };
      },
      ensureArchiveExtractedByHashImpl: async ({ zipPath }) => ({
        extractDir: zipPath === zipOne ? extractOne : extractTwo,
        cacheHit: false
      }),
      runGlobalAccountImport: async () => ({ providers: [], failedProviders: [], providerResults: [] }),
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([containerDir], {
      provider: 'codex',
      log: () => {},
      error: () => {}
    });

    assert.equal(result.failedSources.length, 0);
    assert.equal(sessions.length, 2);
    assert.equal(!!sessions[0], true);
    assert.equal(sessions[0] === sessions[1], true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
