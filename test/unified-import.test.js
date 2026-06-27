const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUnifiedImportService } = require('../lib/cli/services/import/unified-import');
const { createCodexBulkImportService } = require('../lib/cli/services/ai-cli/codex-bulk-import');
const { runGlobalAccountImport } = require('../lib/cli/services/ai-cli/account-import-orchestrator');

function parseCodexArgsForTest(args) {
  const items = Array.isArray(args) ? args : [];
  return {
    sourceDir: items[0],
    parallel: Number(items[2] || 1),
    dryRun: items.includes('--dry-run')
  };
}

function createCodexBulkImportDeps(aiHomeDir) {
  const profilesDir = path.join(aiHomeDir, 'profiles');
  const getToolAccountIds = (provider) => {
    const providerDir = path.join(profilesDir, provider);
    try {
      return fs.readdirSync(providerDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => entry.name);
    } catch (_error) {
      return [];
    }
  };
  const getProfileDir = (provider, id) => path.join(profilesDir, provider, String(id));
  const getToolConfigDir = (provider, id) => {
    if (provider === 'agy') return path.join(profilesDir, provider, String(id), '.gemini', 'antigravity-cli');
    return path.join(profilesDir, provider, String(id), `.${provider}`);
  };
  const codexService = createCodexBulkImportService({
    path,
    fs,
    profilesDir,
    getDefaultParallelism: () => 4,
    getToolAccountIds,
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    getProfileDir,
    getToolConfigDir
  });
  return {
    getToolAccountIds,
    getProfileDir,
    getToolConfigDir,
    parseCodexBulkImportArgs: codexService.parseCodexBulkImportArgs,
    importCodexTokensFromOutput: codexService.importCodexTokensFromOutput
  };
}

function makeSub2ApiCodexOauthBundle({ email, refreshToken, accountId }) {
  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: '2026-06-09T00:00:00Z',
    proxies: [],
    accounts: [{
      name: email,
      platform: 'openai',
      type: 'oauth',
      credentials: {
        email,
        refresh_token: refreshToken,
        chatgpt_account_id: accountId
      }
    }]
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

test('runUnifiedImport passes provider scoped CLIProxyAPI imports through service', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-cliproxyapi-provider-'));
  try {
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
      cliConfigs: { codex: {}, gemini: {}, claude: {} },
      runGlobalAccountImport: async () => ({}),
      importCliproxyapiCodexAuths: async (options) => {
        calls.push(options);
        return {
          imported: 1,
          duplicates: 0,
          invalid: 0,
          failed: 0,
          providers: ['gemini']
        };
      }
    });

    const result = await service.runUnifiedImport(['gemini', 'cliproxyapi'], {
      log: () => {},
      error: () => {}
    });

    assert.deepEqual(calls.map((item) => item.apiKeyProviders), [['gemini']]);
    assert.deepEqual(result.providers, ['gemini']);
    assert.equal(result.sourceResults[0].imported, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport imports standard JSON files such as sub2api-data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-json-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const sourceFile = path.join(root, 'sub2api.json');
    fs.writeFileSync(sourceFile, JSON.stringify({
      type: 'sub2api-data',
      version: 1,
      proxies: [
        {
          proxy_key: 'json-proxy',
          name: 'JSON proxy',
          protocol: 'http',
          host: 'json-proxy.local',
          port: 8080,
          status: 'active',
          fallback_mode: false,
          expiry_warn_days: 0
        }
      ],
      accounts: [
        {
          name: 'codex key',
          notes: 'from json import',
          platform: 'openai',
          type: 'apikey',
          credentials: {
            api_key: 'sk-json',
            base_url: 'https://json.example.com/v1/'
          },
          extra: {
            owner: 'json'
          },
          proxy_key: 'json-proxy',
          concurrency: 0,
          priority: 5,
          auto_pause_on_expired: false
        },
        {
          name: 'agy oauth',
          platform: 'antigravity',
          type: 'oauth',
          credentials: {
            email: 'agy-json@example.com',
            refresh_token: 'rt_agy_json'
          }
        }
      ]
    }));
    const hookEvents = [];
    const getProfileDir = (provider, id) => path.join(aiHomeDir, 'profiles', provider, String(id));
    const getToolConfigDir = (provider, id) => {
      if (provider === 'agy') return path.join(getProfileDir(provider, id), '.gemini', 'antigravity-cli');
      return path.join(getProfileDir(provider, id), `.${provider}`);
    };
    const getToolAccountIds = (provider) => {
      const providerDir = path.join(aiHomeDir, 'profiles', provider);
      try {
        return fs.readdirSync(providerDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
          .map((entry) => entry.name);
      } catch (_error) {
        return [];
      }
    };

    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: { codex: { globalDir: '.codex' }, agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' } },
      runGlobalAccountImport: async () => ({}),
      importCliproxyapiCodexAuths: async () => ({}),
      getToolAccountIds,
      getProfileDir,
      getToolConfigDir,
      accountArtifactHooks: {
        snapshotAccountAuthArtifacts: (provider, accountId) => ({ provider, accountId, before: true }),
        notifyDefaultAccountAuthUpdatedIfChanged: (event) => hookEvents.push(event)
      }
    });

    const result = await service.runUnifiedImport([sourceFile], {
      log: () => {},
      error: () => {}
    });

    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 2);
    assert.deepEqual(result.providers, ['agy', 'codex']);
    const codexEnv = JSON.parse(fs.readFileSync(path.join(getProfileDir('codex', '1'), '.aih_env.json'), 'utf8'));
    const codexAuth = JSON.parse(fs.readFileSync(path.join(getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    const agyAuth = JSON.parse(fs.readFileSync(path.join(getToolConfigDir('agy', '1'), 'antigravity-oauth-token'), 'utf8'));
    const agyEmail = fs.readFileSync(path.join(getToolConfigDir('agy', '1'), 'email.cache'), 'utf8');
    assert.deepEqual(codexEnv, {
      OPENAI_API_KEY: 'sk-json',
      OPENAI_BASE_URL: 'https://json.example.com/v1'
    });
    assert.deepEqual(codexAuth, { OPENAI_API_KEY: 'sk-json' });
    assert.equal(agyAuth.token.refresh_token, 'rt_agy_json');
    assert.equal(agyEmail, 'agy-json@example.com');
    assert.equal(hookEvents.length, 2);
    const codexMetadata = JSON.parse(fs.readFileSync(path.join(getProfileDir('codex', '1'), '.aih_transfer.json'), 'utf8')).formats.sub2api;
    assert.equal(codexMetadata.name, 'codex key');
    assert.equal(codexMetadata.notes, 'from json import');
    assert.deepEqual(codexMetadata.extra, { owner: 'json' });
    assert.equal(codexMetadata.proxy_key, 'json-proxy');
    assert.equal(codexMetadata.concurrency, 0);
    assert.equal(codexMetadata.priority, 5);
    assert.equal(codexMetadata.auto_pause_on_expired, false);
    assert.equal(codexMetadata.proxies[0].fallback_mode, false);
    assert.equal(codexMetadata.proxies[0].expiry_warn_days, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport imports current sub2api JSON without type and version header', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-json-import-no-header-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const sourceFile = path.join(root, 'sub2api-current.json');
    fs.writeFileSync(sourceFile, JSON.stringify({
      exported_at: '2026-06-08T00:00:00Z',
      proxies: [],
      accounts: [
        {
          name: 'codex current key',
          platform: 'openai',
          type: 'apikey',
          credentials: {
            api_key: 'sk-current-json',
            base_url: 'https://current.example.com/v1/'
          },
          concurrency: 0,
          priority: 0
        },
        {
          name: 'unsupported account',
          platform: 'unknown-platform',
          type: 'apikey',
          credentials: {
            api_key: 'sk-ignored'
          },
          concurrency: 0,
          priority: 0
        }
      ]
    }));
    const getProfileDir = (provider, id) => path.join(aiHomeDir, 'profiles', provider, String(id));
    const getToolConfigDir = (provider, id) => path.join(getProfileDir(provider, id), `.${provider}`);
    const getToolAccountIds = (provider) => {
      const providerDir = path.join(aiHomeDir, 'profiles', provider);
      try {
        return fs.readdirSync(providerDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
          .map((entry) => entry.name);
      } catch (_error) {
        return [];
      }
    };

    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: { codex: { globalDir: '.codex' } },
      runGlobalAccountImport: async () => ({}),
      importCliproxyapiCodexAuths: async () => ({}),
      getToolAccountIds,
      getProfileDir,
      getToolConfigDir
    });

    const result = await service.runUnifiedImport([sourceFile], {
      log: () => {},
      error: () => {}
    });

    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 1);
    assert.equal(result.sourceResults[0].invalid, 0);
    assert.deepEqual(result.providers, ['codex']);
    const codexEnv = JSON.parse(fs.readFileSync(path.join(getProfileDir('codex', '1'), '.aih_env.json'), 'utf8'));
    assert.deepEqual(codexEnv, {
      OPENAI_API_KEY: 'sk-current-json',
      OPENAI_BASE_URL: 'https://current.example.com/v1'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport imports sub2api account TXT files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-txt-import-'));
  try {
    const aiHomeDir = path.join(root, '.ai_home');
    const sourceFile = path.join(root, 'sub2api-account.txt');
    fs.writeFileSync(sourceFile, JSON.stringify({
      type: 'sub2api-data',
      version: 1,
      proxies: [],
      accounts: [
        {
          name: 'codex txt oauth',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            email: 'txt-codex@example.com',
            refresh_token: 'rt_txt_codex',
            chatgpt_account_id: 'acc_txt_codex'
          }
        },
        {
          name: 'claude txt key',
          platform: 'anthropic',
          type: 'apikey',
          credentials: {
            api_key: 'sk-txt-claude',
            base_url: 'https://txt-claude.example.com/'
          }
        }
      ]
    }));
    const deps = createCodexBulkImportDeps(aiHomeDir);
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: { codex: { globalDir: '.codex' }, claude: { globalDir: '.claude' } },
      runGlobalAccountImport: async () => ({}),
      importCliproxyapiCodexAuths: async () => ({}),
      getToolAccountIds: deps.getToolAccountIds,
      getProfileDir: deps.getProfileDir,
      getToolConfigDir: deps.getToolConfigDir
    });

    const result = await service.runUnifiedImport([sourceFile], {
      log: () => {},
      error: () => {}
    });

    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].type, 'text');
    assert.equal(result.sourceResults[0].imported, 2);
    assert.deepEqual(result.providers, ['claude', 'codex']);
    const codexAuth = JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    const claudeEnv = JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('claude', '1'), '.aih_env.json'), 'utf8'));
    assert.equal(codexAuth.email, 'txt-codex@example.com');
    assert.equal(codexAuth.tokens.refresh_token, 'rt_txt_codex');
    assert.deepEqual(claudeEnv, {
      ANTHROPIC_API_KEY: 'sk-txt-claude',
      ANTHROPIC_BASE_URL: 'https://txt-claude.example.com'
    });
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

test('runUnifiedImport infers cpa zip folders with flat codex token JSON files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-cpa-zip-'));
  try {
    const zipPath = path.join(root, 'cpa.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    const aiHomeDir = path.join(root, '.ai_home');
    fs.writeFileSync(zipPath, 'fake-zip');
    fs.mkdirSync(path.join(zipExtractDir, 'cpa'), { recursive: true });
    fs.writeFileSync(path.join(zipExtractDir, 'cpa', 'token_worker.json'), JSON.stringify({
      type: 'codex',
      email: 'cpa@example.com',
      access_token: '',
      refresh_token: 'rt_cpa_worker',
      account_id: 'acc_cpa_worker'
    }));

    const codexDeps = createCodexBulkImportDeps(aiHomeDir);
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: { codex: { globalDir: '.codex' } },
      ...codexDeps,
      ensureArchiveExtractedByHashImpl: async () => ({
        extractDir: zipExtractDir,
        cacheHit: false
      }),
      runGlobalAccountImport,
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([zipPath], {
      log: () => {},
      error: () => {}
    });

    const importedAuth = JSON.parse(fs.readFileSync(path.join(codexDeps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 1);
    assert.deepEqual(result.providers, ['codex']);
    assert.equal(importedAuth.email, 'cpa@example.com');
    assert.equal(importedAuth.tokens.refresh_token, 'rt_cpa_worker');
    assert.equal(importedAuth.tokens.account_id, 'acc_cpa_worker');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport infers zip roots with flat sub2api codex account bundle JSON files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-sub2api-root-zip-'));
  try {
    const zipPath = path.join(root, 'codex_tokens_part_01.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    const aiHomeDir = path.join(root, '.ai_home');
    fs.writeFileSync(zipPath, 'fake-zip');
    fs.mkdirSync(zipExtractDir, { recursive: true });
    fs.writeFileSync(path.join(zipExtractDir, 'root-bundle@example.com.json'), JSON.stringify(makeSub2ApiCodexOauthBundle({
      email: 'root-bundle@example.com',
      refreshToken: 'rt_root_bundle',
      accountId: 'acc_root_bundle'
    })));

    const codexDeps = createCodexBulkImportDeps(aiHomeDir);
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: { codex: { globalDir: '.codex' } },
      ...codexDeps,
      ensureArchiveExtractedByHashImpl: async () => ({
        extractDir: zipExtractDir,
        cacheHit: false
      }),
      runGlobalAccountImport,
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([zipPath], {
      log: () => {},
      error: () => {}
    });

    const importedAuth = JSON.parse(fs.readFileSync(path.join(codexDeps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 1);
    assert.deepEqual(result.providers, ['codex']);
    assert.equal(importedAuth.email, 'root-bundle@example.com');
    assert.equal(importedAuth.tokens.refresh_token, 'rt_root_bundle');
    assert.equal(importedAuth.tokens.account_id, 'acc_root_bundle');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport imports mixed flat sub2api zip roots through standard JSON importer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-mixed-root-zip-'));
  try {
    const zipPath = path.join(root, 'mixed.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    const aiHomeDir = path.join(root, '.ai_home');
    fs.writeFileSync(zipPath, 'fake-zip');
    fs.mkdirSync(zipExtractDir, { recursive: true });
    fs.writeFileSync(path.join(zipExtractDir, 'mixed.json'), JSON.stringify({
      type: 'sub2api-data',
      version: 1,
      proxies: [],
      accounts: [
        makeSub2ApiCodexOauthBundle({
          email: 'mixed-codex@example.com',
          refreshToken: 'rt_mixed_codex',
          accountId: 'acc_mixed_codex'
        }).accounts[0],
        {
          name: 'mixed claude key',
          platform: 'anthropic',
          type: 'apikey',
          credentials: {
            api_key: 'sk-mixed-claude'
          }
        }
      ]
    }));

    const deps = createCodexBulkImportDeps(aiHomeDir);
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: { codex: { globalDir: '.codex' }, claude: { globalDir: '.claude' } },
      ...deps,
      ensureArchiveExtractedByHashImpl: async () => ({
        extractDir: zipExtractDir,
        cacheHit: false
      }),
      runGlobalAccountImport,
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([zipPath], {
      log: () => {},
      error: () => {}
    });

    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 2);
    assert.deepEqual(result.providers, ['claude', 'codex']);
    assert.equal(fs.existsSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json')), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('claude', '1'), '.aih_env.json'), 'utf8')), {
      ANTHROPIC_API_KEY: 'sk-mixed-claude'
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport imports mixed flat single-account JSON zip roots through standard JSON importer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-mixed-flat-files-'));
  try {
    const zipPath = path.join(root, 'mixed-flat.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    const aiHomeDir = path.join(root, '.ai_home');
    fs.writeFileSync(zipPath, 'fake-zip');
    fs.mkdirSync(zipExtractDir, { recursive: true });
    fs.writeFileSync(path.join(zipExtractDir, 'codex_worker@example.com.json'), JSON.stringify({
      platform: 'openai',
      type: 'oauth',
      credentials: {
        email: 'worker@example.com',
        refresh_token: 'rt_worker',
        chatgpt_account_id: 'acc_worker'
      }
    }));
    fs.writeFileSync(path.join(zipExtractDir, 'claude_api.anthropic.com_v1_0123456789abcdefabcd.json'), JSON.stringify({
      platform: 'anthropic',
      type: 'apikey',
      credentials: {
        api_key: 'sk-claude-flat',
        base_url: 'https://api.anthropic.com/v1'
      }
    }));
    fs.writeFileSync(path.join(zipExtractDir, 'gemini_flat@example.com.json'), JSON.stringify({
      platform: 'gemini',
      type: 'oauth',
      credentials: {
        email: 'gemini-flat@example.com',
        access_token: 'gemini-access-flat',
        refresh_token: 'gemini-refresh-flat',
        client_id: 'gemini-client-flat'
      }
    }));
    fs.writeFileSync(path.join(zipExtractDir, 'agy_flat@example.com.json'), JSON.stringify({
      platform: 'antigravity',
      type: 'oauth',
      credentials: {
        email: 'agy-flat@example.com',
        access_token: 'agy-access-flat',
        refresh_token: 'agy-refresh-flat',
        expires_at: '2030-01-01T00:00:00.000Z'
      }
    }));

    const deps = createCodexBulkImportDeps(aiHomeDir);
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: {
        codex: { globalDir: '.codex' },
        claude: { globalDir: '.claude' },
        gemini: { globalDir: '.gemini' },
        agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
      },
      ...deps,
      ensureArchiveExtractedByHashImpl: async () => ({
        extractDir: zipExtractDir,
        cacheHit: false
      }),
      runGlobalAccountImport,
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([zipPath], {
      log: () => {},
      error: () => {}
    });

    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 4);
    assert.deepEqual(result.providers, ['agy', 'claude', 'codex', 'gemini']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8')).email, 'worker@example.com');
    assert.equal(JSON.parse(fs.readFileSync(path.join(deps.getProfileDir('claude', '1'), '.aih_env.json'), 'utf8')).ANTHROPIC_API_KEY, 'sk-claude-flat');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('gemini', '1'), 'oauth_creds.json'), 'utf8')).access_token,
      'gemini-access-flat'
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(deps.getToolConfigDir('agy', '1'), 'antigravity-oauth-token'), 'utf8')).token.access_token,
      'agy-access-flat'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runUnifiedImport infers nested cliproxy zip roots with codex token JSON files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-cliproxy-nested-zip-'));
  try {
    const zipPath = path.join(root, 'cliproxy-export.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    const aiHomeDir = path.join(root, '.ai_home');
    fs.writeFileSync(zipPath, 'fake-zip');
    fs.mkdirSync(path.join(zipExtractDir, 'cliproxy-export', 'cpa'), { recursive: true });
    fs.writeFileSync(path.join(zipExtractDir, 'cliproxy-export', 'cpa', 'token_nested.json'), JSON.stringify({
      type: 'codex',
      email: 'nested-cpa@example.com',
      access_token: '',
      refresh_token: 'rt_nested_cpa_worker',
      account_id: 'acc_nested_cpa_worker'
    }));

    const codexDeps = createCodexBulkImportDeps(aiHomeDir);
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: { codex: { globalDir: '.codex' } },
      ...codexDeps,
      ensureArchiveExtractedByHashImpl: async () => ({
        extractDir: zipExtractDir,
        cacheHit: false
      }),
      runGlobalAccountImport,
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([zipPath], {
      log: () => {},
      error: () => {}
    });

    const importedAuth = JSON.parse(fs.readFileSync(path.join(codexDeps.getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
    assert.equal(result.failedSources.length, 0);
    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 1);
    assert.deepEqual(result.providers, ['codex']);
    assert.equal(importedAuth.email, 'nested-cpa@example.com');
    assert.equal(importedAuth.tokens.refresh_token, 'rt_nested_cpa_worker');
    assert.equal(importedAuth.tokens.account_id, 'acc_nested_cpa_worker');
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

test('runUnifiedImport imports agy credential layout from exported zip', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-unified-import-agy-'));
  try {
    const zipPath = path.join(root, 'accounts.zip');
    const zipExtractDir = path.join(root, 'zip-extract');
    const aiHomeDir = path.join(root, '.ai_home');
    const sourceConfigDir = path.join(zipExtractDir, 'accounts', 'agy', '6', '.gemini', 'antigravity-cli');
    fs.writeFileSync(zipPath, 'fake-zip');
    fs.mkdirSync(sourceConfigDir, { recursive: true });
    fs.writeFileSync(path.join(sourceConfigDir, 'antigravity-oauth-token'), JSON.stringify({
      auth_method: 'oauth-personal',
      token: {
        access_token: 'agy-access-token',
        refresh_token: 'agy-refresh-token'
      }
    }));
    fs.writeFileSync(path.join(sourceConfigDir, 'email.cache'), 'agy@example.com', 'utf8');

    let globalImporterCalled = false;
    const service = createUnifiedImportService({
      fs,
      path,
      os,
      fse: require('fs-extra'),
      execSync: () => {},
      spawnImpl: () => {},
      processImpl: { platform: 'linux' },
      cryptoImpl: require('node:crypto'),
      aiHomeDir,
      cliConfigs: { agy: { globalDir: '.gemini' } },
      ensureArchiveExtractedByHashImpl: async () => ({
        extractDir: zipExtractDir,
        cacheHit: false
      }),
      runGlobalAccountImport: async () => {
        globalImporterCalled = true;
        return { providers: [], failedProviders: [], providerResults: [] };
      },
      importCliproxyapiCodexAuths: async () => ({
        imported: 0,
        duplicates: 0,
        invalid: 0,
        failed: 0
      })
    });

    const result = await service.runUnifiedImport([zipPath], {
      log: () => {},
      error: () => {}
    });

    const targetConfigDir = path.join(aiHomeDir, 'profiles', 'agy', '6', '.gemini', 'antigravity-cli');
    assert.equal(globalImporterCalled, false);
    assert.deepEqual(result.providers, ['agy']);
    assert.equal(result.sourceResults.length, 1);
    assert.equal(result.sourceResults[0].imported, 1);
    assert.equal(fs.existsSync(path.join(targetConfigDir, 'antigravity-oauth-token')), true);
    assert.equal(fs.readFileSync(path.join(targetConfigDir, 'email.cache'), 'utf8'), 'agy@example.com');
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
