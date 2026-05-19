const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const fse = require('fs-extra');
const { __private, runBackupCommand } = require('../lib/cli/commands/backup/router');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload));
}

function createSpawnStub(handler) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => handler({ command, args, child }));
    return child;
  };
}

test('resolveImportSourceRoot prefers accounts/ root when present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-router-'));
  try {
    writeJson(path.join(root, 'accounts', 'codex', '1', '.codex', 'auth.json'), { ok: true });
    const resolved = __private.resolveImportSourceRoot({
      fs,
      path,
      fse,
      extractDir: root,
      provider: '',
      folderHint: ''
    });
    assert.equal(resolved.sourceRoot, path.join(root, 'accounts'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveImportSourceRoot supports direct provider root without accounts/', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-router-'));
  try {
    writeJson(path.join(root, 'codex', '1', '.codex', 'auth.json'), { ok: true });
    const resolved = __private.resolveImportSourceRoot({
      fs,
      path,
      fse,
      extractDir: root,
      provider: '',
      folderHint: ''
    });
    assert.equal(resolved.sourceRoot, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveImportSourceRoot maps custom folder to provider root when provider is explicit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-router-'));
  try {
    writeJson(path.join(root, 'abc', '10001', 'auth.json'), { refresh_token: 'rt_x' });
    const resolved = __private.resolveImportSourceRoot({
      fs,
      path,
      fse,
      extractDir: root,
      provider: 'codex',
      folderHint: 'abc'
    });
    assert.equal(resolved.sourceRoot, path.join(root, 'abc.__aih_import_root'));
    assert.equal(fs.existsSync(path.join(resolved.sourceRoot, 'codex')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureArchiveExtractedByHash reuses cached extraction for same archive hash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-router-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    fs.mkdirSync(aiHomeDir, { recursive: true });
    const zipPath = path.join(root, 'sample.zip');
    fs.writeFileSync(zipPath, 'fake-zip-content');

    let unzipCalls = 0;
    const execSync = (cmd) => {
      const text = String(cmd || '');
      if (text.startsWith('7z ') || text.startsWith('7za ')) {
        throw new Error('7z unavailable in test');
      }
      const m = text.match(/-d "([^"]+)"/);
      if (!m) throw new Error(`unexpected command: ${text}`);
      const outDir = m[1];
      fs.mkdirSync(path.join(outDir, 'accounts', 'codex', '1', '.codex'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'accounts', 'codex', '1', '.codex', 'auth.json'), '{"ok":true}');
      unzipCalls += 1;
    };

    const first = await __private.ensureArchiveExtractedByHash({
      fs,
      path,
      os,
      fse,
      execSync,
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      zipPath,
      aiHomeDir,
      spawnImpl: createSpawnStub(({ child }) => child.emit('close', 1))
    });
    const second = await __private.ensureArchiveExtractedByHash({
      fs,
      path,
      os,
      fse,
      execSync,
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      zipPath,
      aiHomeDir,
      spawnImpl: createSpawnStub(({ child }) => child.emit('close', 1))
    });

    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(second.hash, first.hash);
    assert.equal(second.extractDir, first.extractDir);
    assert.equal(unzipCalls, 1);
    assert.equal(fs.existsSync(path.join(second.extractDir, 'accounts', 'codex', '1', '.codex', 'auth.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureArchiveExtractedByHash falls back to copy when moveSync hits EPERM on windows-like filesystems', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-router-eperm-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    fs.mkdirSync(aiHomeDir, { recursive: true });
    const zipPath = path.join(root, '中文.zip');
    fs.writeFileSync(zipPath, 'fake-zip-content');

    let copyFallbacks = 0;
    const fseWithEpermMove = {
      ensureDirSync: (...args) => fse.ensureDirSync(...args),
      removeSync: (...args) => fse.removeSync(...args),
      moveSync: () => {
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
      copySync: (...args) => {
        copyFallbacks += 1;
        return fse.copySync(...args);
      }
    };

    const execSync = (cmd) => {
      const text = String(cmd || '');
      if (text.startsWith('7z ') || text.startsWith('7za ')) {
        throw new Error('7z unavailable in test');
      }
      const m = text.match(/-d "([^"]+)"/);
      if (!m) throw new Error(`unexpected command: ${text}`);
      const outDir = m[1];
      fs.mkdirSync(path.join(outDir, 'accounts', 'codex', '1', '.codex'), { recursive: true });
      fs.writeFileSync(path.join(outDir, 'accounts', 'codex', '1', '.codex', 'auth.json'), '{"ok":true}');
    };

    const extracted = await __private.ensureArchiveExtractedByHash({
      fs,
      path,
      os,
      fse: fseWithEpermMove,
      execSync,
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      zipPath,
      aiHomeDir,
      spawnImpl: createSpawnStub(({ child }) => child.emit('close', 1))
    });

    assert.equal(copyFallbacks, 1);
    assert.equal(extracted.cacheHit, false);
    assert.equal(fs.existsSync(path.join(extracted.extractDir, 'accounts', 'codex', '1', '.codex', 'auth.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveBundled7zipPath picks first existing bundled binary candidate', () => {
  const fakeFs = {
    existsSync: (candidate) => String(candidate).includes('/ok/7za')
  };
  const resolved = __private.resolveBundled7zipPath({
    fs: fakeFs,
    sevenZipBin: {
      path7za: '/ok/7za',
      path7x: '/nope/7x.sh'
    }
  });
  assert.equal(resolved, '/ok/7za');
});

test('tryExtractZipWith7z falls back to bundled binary after system commands fail', async () => {
  const commands = [];
  const ok = await __private.tryExtractZipWith7z({
    zipPath: 'C:\\tmp\\a.zip',
    extractDir: 'C:\\tmp\\out',
    processImpl: { platform: 'win32' },
    bundled7zPath: 'C:\\bundle\\7za.exe',
    spawnImpl: createSpawnStub(({ command, child }) => {
      commands.push(String(command || ''));
      if (String(command || '').includes('bundle\\7za.exe')) {
        child.stdout.emit('data', '17%');
        child.stdout.emit('data', '100%');
        child.emit('close', 0);
        return;
      }
      child.emit('close', 1);
    })
  });

  assert.equal(ok, true);
  assert.equal(commands.length, 4);
  assert.equal(commands[0], '7z');
  assert.equal(commands[1], '7za');
  assert.equal(commands[2], 'C:\\Program Files\\7-Zip\\7z.exe');
  assert.equal(commands[3], 'C:\\bundle\\7za.exe');
});

test('runBackupCommand routes export cliproxyapi codex to filesystem exporter', async () => {
  const events = [];
  const progressEvents = [];
  let exitCode = null;

  const handled = await runBackupCommand('export', ['export', 'cliproxyapi', 'codex'], {
    fs,
    path,
    os,
    fse,
    execSync: () => {},
    readline: {},
    consoleImpl: {
      log: (msg) => events.push(`log:${msg}`),
      error: (msg) => events.push(`error:${msg}`)
    },
    processImpl: {
      exit: (code) => { exitCode = code; }
    },
    ensureAesSuffix: (value) => value,
    defaultExportName: () => 'x.zip',
    parseExportArgs: () => ({ targetFile: 'ignored.zip', selectors: [] }),
    parseImportArgs: () => ({}),
    expandSelectorsToPaths: () => [],
    renderStageProgress: (...args) => { progressEvents.push(args); },
    exportCliproxyapiCodexAuths: ({ onProgress }) => {
      onProgress({
        total: 3,
        scanned: 1,
        exported: 1,
        skippedMissing: 0,
        skippedInvalid: 0,
        status: 'exported',
        email: 'worker@example.com'
      });
      onProgress({
        total: 3,
        scanned: 3,
        exported: 2,
        skippedMissing: 1,
        skippedInvalid: 0,
        status: 'done'
      });
      return ({
      authDir: '/tmp/cliproxyapi-auths',
      configPath: '/tmp/cliproxyapi-config.yaml',
      scanned: 3,
      exported: 2,
      skippedMissing: 1,
      skippedInvalid: 0,
      dedupedSource: 4,
      dedupedTarget: 5
      });
    }
  });

  assert.equal(handled, true);
  assert.equal(exitCode, 0);
  assert.equal(progressEvents.length >= 2, true);
  assert.equal(events.some((entry) => entry.includes('Exported codex OAuth auth files for CLIProxyAPI')), true);
  assert.equal(events.some((entry) => entry.includes('auth-dir=/tmp/cliproxyapi-auths')), true);
  assert.equal(events.some((entry) => entry.includes('scanned=3 exported=2 missing=1 invalid=0 deduped_source=4 deduped_target=5')), true);
});

test('runBackupCommand rejects extra args after export cliproxyapi codex', async () => {
  const events = [];
  let exitCode = null;
  let called = false;

  const handled = await runBackupCommand('export', ['export', 'cliproxyapi', 'codex', 'extra'], {
    fs,
    path,
    os,
    fse,
    execSync: () => {},
    readline: {},
    consoleImpl: {
      log: (msg) => events.push(`log:${msg}`),
      error: (msg) => events.push(`error:${msg}`)
    },
    processImpl: {
      exit: (code) => { exitCode = code; }
    },
    ensureAesSuffix: (value) => value,
    defaultExportName: () => 'x.zip',
    parseExportArgs: () => ({ targetFile: 'ignored.zip', selectors: [] }),
    parseImportArgs: () => ({}),
    expandSelectorsToPaths: () => [],
    renderStageProgress: () => {},
    exportCliproxyapiCodexAuths: () => {
      called = true;
      return {};
    }
  });

  assert.equal(handled, true);
  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.equal(events.some((entry) => entry.includes('Invalid CLIProxyAPI export syntax')), true);
});

test('runBackupCommand generic export reports collecting progress while staging credential files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-export-'));
  const progressEvents = [];
  let exitCode = null;
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '1', '.codex', 'auth.json'), { refresh_token: 'rt_1' });
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '2', '.codex', 'auth.json'), { refresh_token: 'rt_2' });

    const handled = await runBackupCommand('export', ['export', path.join(root, 'backup.zip')], {
      fs,
      path,
      os,
      fse,
      execSync: () => {},
      readline: {},
      consoleImpl: {
        log: () => {},
        error: () => {}
      },
    processImpl: {
      exit: (code) => { exitCode = code; },
      platform: 'linux'
    },
    getDefaultParallelism: () => 8,
    ensureAesSuffix: (value) => value,
    defaultExportName: () => path.join(root, 'backup.zip'),
      parseExportArgs: () => ({ targetFile: path.join(root, 'backup.zip'), selectors: [] }),
      parseImportArgs: () => ({}),
      expandSelectorsToPaths: () => ['profiles'],
      renderStageProgress: (...args) => { progressEvents.push(args); },
      aiHomeDir
    });

    assert.equal(handled, true);
    assert.equal(exitCode, 0);
    assert.equal(
      progressEvents.some((entry) => String(entry[3] || '').includes('Collecting credential files 2/2 accounts=2 files=2 workers=2')),
      true
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runBackupCommand provider-scoped codex export writes flat email json files under accounts/codex', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-provider-export-'));
  let exitCode = null;
  try {
    const outZip = path.join(root, 'codex-flat.zip');
    const aiHomeDir = path.join(root, '.ai_home');
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '7', '.codex', 'auth.json'), {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'header.payload.sig',
        access_token: 'header.payload.sig',
        refresh_token: 'rt_one',
        account_id: 'acct-one'
      },
      last_refresh: '2026-03-10T10:00:00.000Z'
    });

    const handled = await runBackupCommand('export', ['export', '__provider__', 'codex', outZip], {
      fs,
      path,
      os,
      fse,
      execSync: (cmd) => {
        const text = String(cmd || '');
        const cdMatch = text.match(/^cd "([^"]+)" && zip -rq "([^"]+)"/);
        if (!cdMatch) throw new Error(`unexpected command: ${text}`);
        const stageDir = cdMatch[1];
        const flattened = path.join(stageDir, 'accounts', 'codex');
        const fileNames = fs.readdirSync(flattened).filter((name) => name.endsWith('.json')).sort();
        assert.deepEqual(fileNames, ['worker@example.com.json']);
        const payload = JSON.parse(fs.readFileSync(path.join(flattened, fileNames[0]), 'utf8'));
        assert.equal(payload.type, 'codex');
        assert.equal(payload.email, 'worker@example.com');
      },
      readline: {},
      consoleImpl: {
        log: () => {},
        error: () => {}
      },
      processImpl: {
        exit: (code) => { exitCode = code; },
        platform: 'linux'
      },
      ensureAesSuffix: (value) => value,
      defaultExportName: () => outZip,
      parseExportArgs: () => ({ targetFile: outZip, selectors: [] }),
      parseImportArgs: () => ({}),
      expandSelectorsToPaths: () => [],
      renderStageProgress: () => {},
      exportCliproxyapiCodexAuths: ({ authDirOverride }) => {
        fs.mkdirSync(authDirOverride, { recursive: true });
        fs.writeFileSync(path.join(authDirOverride, 'worker@example.com.json'), JSON.stringify({
          type: 'codex',
          email: 'worker@example.com',
          refresh_token: 'rt_one'
        }));
        return { exported: 1 };
      },
      aiHomeDir
    });

    assert.equal(handled, true);
    assert.equal(exitCode, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runBackupCommand routes import sources to unified import executor', async () => {
  const progressEvents = [];
  let exitCode = null;
  const calls = [];

  const handled = await runBackupCommand('import', ['import', 'cliproxyapi', '/tmp/a.zip'], {
    fs,
    path,
    os,
    fse,
    execSync: () => {},
    readline: {},
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    processImpl: {
      exit: (code) => { exitCode = code; }
    },
    renderStageProgress: (...args) => { progressEvents.push(args); },
    runUnifiedImport: async (args, opts) => {
      calls.push({ args, opts });
      return {
        providers: ['codex'],
        failedSources: []
      };
    }
  });

  assert.equal(handled, true);
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['cliproxyapi', '/tmp/a.zip']);
  assert.equal(typeof calls[0].opts.renderStageProgress, 'function');
  assert.equal(progressEvents.length, 0);
});
