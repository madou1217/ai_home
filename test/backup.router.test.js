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

test('runBackupCommand routes export cliproxyapi codex to data exporter', async () => {
  const events = [];
  let exitCode = null;
  let received = null;

  const handled = await runBackupCommand('export', ['export', 'cliproxyapi', 'codex', '/tmp/cliproxyapi-data.json'], {
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
    exportCliproxyapiData: (arg) => {
      received = arg;
      return {
        outPath: arg.outPath,
        accounts: 2,
        oauthAccounts: 1,
        apiKeys: 1
      };
    }
  });

  assert.equal(handled, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(received, {
    outPath: path.resolve('/tmp/cliproxyapi-data.json'),
    apiKeyProviders: ['codex']
  });
  assert.equal(events.some((entry) => entry.includes('Exported codex CLIProxyAPI account data')), true);
  assert.equal(events.some((entry) => entry.includes('accounts=2 oauth=1 api_keys=1')), true);
});

test('runBackupCommand routes export sub2api to standard JSON exporter', async () => {
  const events = [];
  let exitCode = null;
  let received = null;

  const handled = await runBackupCommand('export', ['export', 'sub2api', 'codex', '/tmp/sub2api.json'], {
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
    exportSub2ApiData: (arg) => {
      received = arg;
      return { outPath: arg.outPath, accounts: 2, proxies: 0 };
    }
  });

  assert.equal(handled, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(received, { outPath: path.resolve('/tmp/sub2api.json'), providers: ['codex'] });
  assert.equal(events.some((entry) => entry.includes('Exported sub2api account data')), true);
  assert.equal(events.some((entry) => entry.includes('accounts=2 proxies=0')), true);
});

test('runBackupCommand rejects sub2api opencode export because the format cannot represent it', async () => {
  const events = [];
  let exitCode = null;
  let called = false;

  const handled = await runBackupCommand('export', ['export', 'sub2api', 'opencode', '/tmp/opencode.json'], {
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
    exportSub2ApiData: () => {
      called = true;
      return { outPath: '/tmp/opencode.json', accounts: 0, proxies: 0 };
    }
  });

  assert.equal(handled, true);
  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.equal(events.some((entry) => entry.includes('sub2api export does not support opencode accounts')), true);
});

test('runBackupCommand routes export antigravity to Antigravity Manager JSON exporter', async () => {
  const events = [];
  let exitCode = null;
  let received = null;

  const handled = await runBackupCommand('export', ['export', 'antigravity', '/tmp/agy.json'], {
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
    exportAntigravityManagerAccounts: (arg) => {
      received = arg;
      return { outPath: arg.outPath, accounts: 1 };
    }
  });

  assert.equal(handled, true);
  assert.equal(exitCode, 0);
  assert.deepEqual(received, { outPath: path.resolve('/tmp/agy.json') });
  assert.equal(events.some((entry) => entry.includes('Exported antigravity account data')), true);
  assert.equal(events.some((entry) => entry.includes('accounts=1')), true);
});

test('runBackupCommand rejects removed antigravity plugin export syntax', async () => {
  const events = [];
  let exitCode = null;
  let called = false;

  const handled = await runBackupCommand('export', ['export', 'antigravity', 'plugin', '/tmp/antigravity-accounts.json'], {
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
    exportAntigravityManagerAccounts: () => {
      called = true;
      return { outPath: '/tmp/antigravity-accounts.json', accounts: 1 };
    }
  });

  assert.equal(handled, true);
  assert.equal(exitCode, 1);
  assert.equal(called, false);
  assert.equal(events.some((entry) => entry.includes('Antigravity export supports Manager JSON only')), true);
});

test('runBackupCommand generic export reports progress while writing flat account JSON files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-export-'));
  const progressEvents = [];
  let exitCode = null;
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '1', '.codex', 'auth.json'), {
      email: 'one@example.com',
      tokens: { refresh_token: 'rt_1' }
    });
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '2', '.codex', 'auth.json'), {
      email: 'two@example.com',
      tokens: { refresh_token: 'rt_2' }
    });

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
      progressEvents.some((entry) => String(entry[3] || '').includes('Writing account JSON files 2/2 accounts=2 files=2')),
      true
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runBackupCommand generic export writes agy oauth account as flat JSON', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-export-agy-'));
  const events = [];
  let exitCode = null;
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const agyConfigDir = path.join(aiHomeDir, 'profiles', 'agy', '6', '.gemini', 'antigravity-cli');
    writeJson(path.join(agyConfigDir, 'antigravity-oauth-token'), {
      auth_method: 'oauth-personal',
      token: {
        access_token: 'agy-access-token',
        refresh_token: 'agy-refresh-token'
      }
    });
    fs.writeFileSync(path.join(agyConfigDir, 'email.cache'), 'agy@example.com', 'utf8');

    const handled = await runBackupCommand('export', ['export', path.join(root, 'backup.zip')], {
      fs,
      path,
      os,
      fse,
      execSync: (cmd) => {
        const text = String(cmd || '');
        const cdMatch = text.match(/^cd "([^"]+)" && zip -rq "([^"]+)"/);
        if (!cdMatch) throw new Error(`unexpected command: ${text}`);
        const stageDir = cdMatch[1];
        const exportFile = path.join(stageDir, 'agy_agy@example.com.json');
        assert.equal(fs.existsSync(exportFile), true);
        const payload = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
        assert.equal(payload.platform, 'antigravity');
        assert.equal(payload.type, 'oauth');
        assert.equal(payload.credentials.email, 'agy@example.com');
        assert.equal(payload.credentials.refresh_token, 'agy-refresh-token');
        assert.equal(fs.existsSync(path.join(stageDir, 'accounts')), false);
      },
      readline: {},
      consoleImpl: {
        log: (line) => events.push(String(line)),
        error: (line) => events.push(String(line))
      },
      processImpl: {
        exit: (code) => { exitCode = code; },
        platform: 'linux'
      },
      getDefaultParallelism: () => 4,
      ensureAesSuffix: (value) => value,
      defaultExportName: () => path.join(root, 'backup.zip'),
      parseExportArgs: () => ({ targetFile: path.join(root, 'backup.zip'), selectors: [] }),
      parseImportArgs: () => ({}),
      expandSelectorsToPaths: () => ['profiles'],
      renderStageProgress: () => {},
      aiHomeDir
    });

    assert.equal(handled, true);
    assert.equal(exitCode, 0);
    assert.equal(events.some((entry) => entry.includes('providers=agy accounts=1 files=1')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runBackupCommand provider-scoped codex export writes api-key account as flat JSON', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-provider-export-'));
  const events = [];
  let exitCode = null;
  try {
    const outZip = path.join(root, 'codex-accounts.zip');
    const aiHomeDir = path.join(root, '.ai_home');
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '7', '.aih_env.json'), {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://api.example.com/v1'
    });
    writeJson(path.join(aiHomeDir, 'profiles', 'codex', '7', '.codex', 'auth.json'), {
      OPENAI_API_KEY: 'sk-test'
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
        const fileNames = fs.readdirSync(stageDir).filter((name) => name.endsWith('.json'));
        assert.equal(fileNames.length, 1);
        assert.match(fileNames[0], /^codex_api\.example\.com_v1_[a-f0-9]{20}\.json$/);
        const payload = JSON.parse(fs.readFileSync(path.join(stageDir, fileNames[0]), 'utf8'));
        assert.equal(payload.platform, 'openai');
        assert.equal(payload.type, 'apikey');
        assert.equal(payload.credentials.api_key, 'sk-test');
        assert.equal(payload.credentials.base_url, 'https://api.example.com/v1');
        assert.equal(fs.existsSync(path.join(stageDir, 'accounts')), false);
      },
      readline: {},
      consoleImpl: {
        log: (line) => events.push(String(line)),
        error: (line) => events.push(String(line))
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
      getDefaultParallelism: () => 4,
      aiHomeDir
    });

    assert.equal(handled, true);
    assert.equal(exitCode, 0);
    assert.equal(events.some((entry) => entry.includes('providers=codex accounts=1 files=1')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runBackupCommand provider-scoped opencode export reports unsupported standard JSON', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-provider-export-opencode-'));
  const events = [];
  let exitCode = null;
  try {
    const outZip = path.join(root, 'opencode-accounts.zip');
    const aiHomeDir = path.join(root, '.ai_home');
    writeJson(path.join(aiHomeDir, 'profiles', 'opencode', '1', '.local', 'share', 'opencode', 'auth.json'), {
      openai: { type: 'api', key: 'sk-openai' }
    });

    const handled = await runBackupCommand('export', ['export', '__provider__', 'opencode', outZip], {
      fs,
      path,
      os,
      fse,
      execSync: (cmd) => {
        const text = String(cmd || '');
        throw new Error(`unexpected command: ${text}`);
      },
      readline: {},
      consoleImpl: {
        log: (line) => events.push(String(line)),
        error: (line) => events.push(String(line))
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
      getDefaultParallelism: () => 4,
      aiHomeDir
    });

    assert.equal(handled, true);
    assert.equal(exitCode, 1);
    assert.equal(events.some((entry) => entry.includes('No standard account JSON files found for opencode')), true);
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
