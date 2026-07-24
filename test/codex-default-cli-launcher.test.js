'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const {
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  buildCodexDefaultCliEnv,
  runCodexDefaultCli
} = require('../lib/server/codex-default-cli-launcher');
const {
  CODEX_MANAGED_LAUNCH_ENV
} = require('../lib/runtime/codex-launch-context');
const {
  buildCodexDefaultCliArgs,
  buildModelCatalogProjectionArgs
} = require('../lib/server/codex-cli-startup-policy');

function registerCodexAccount(aiHomeDir, cliAccountId, identitySeed) {
  return registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId,
    identitySeed
  }).accountRef;
}

test('default Codex CLI switches API key and OAuth environments without credential residue', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-default-cli-'));
  const aiHomeDir = path.join(homeDir, '.ai_home');
  const codexHome = path.join(homeDir, '.codex');
  const apiKey = 'sk-test-default-account-secret';
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const apiKeyAccountRef = registerCodexAccount(
    aiHomeDir,
    '1',
    'api-key:codex:default-launcher-test'
  );
  writeAccountCredentials(fs, aiHomeDir, apiKeyAccountRef, {
    OPENAI_API_KEY: apiKey,
    OPENAI_BASE_URL: 'https://api.example.test/v1'
  });

  const oauthAccountRef = registerCodexAccount(
    aiHomeDir,
    '2',
    'oauth:codex:default-launcher@example.test'
  );
  writeAccountNativeAuth(fs, aiHomeDir, oauthAccountRef, {
    auth: {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'oauth-access-token',
        refresh_token: 'oauth-refresh-token'
      }
    }
  });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }), 'utf8');

  const processObj = {
    platform: 'darwin',
    env: {
      HOME: homeDir,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: 'stale-shell-key'
    }
  };

  writeDefaultAccountRef(fs, aiHomeDir, 'codex', apiKeyAccountRef);
  const apiKeyRuntime = buildCodexDefaultCliEnv(fs, { aiHomeDir, processObj });
  assert.equal(apiKeyRuntime.authMode, 'apikey');
  assert.equal(apiKeyRuntime.accountRef, apiKeyAccountRef);
  assert.equal(apiKeyRuntime.env.OPENAI_API_KEY, apiKey);
  assert.equal(apiKeyRuntime.env.CODEX_HOME, codexHome);

  writeDefaultAccountRef(fs, aiHomeDir, 'codex', oauthAccountRef);
  const oauthRuntime = buildCodexDefaultCliEnv(fs, { aiHomeDir, processObj });
  assert.equal(oauthRuntime.authMode, 'oauth');
  assert.equal(oauthRuntime.accountRef, oauthAccountRef);
  assert.equal(oauthRuntime.env.OPENAI_API_KEY, undefined);
  assert.equal(oauthRuntime.env.CODEX_HOME, codexHome);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')),
    { auth_mode: 'chatgpt' }
  );

  writeDefaultAccountRef(fs, aiHomeDir, 'codex', apiKeyAccountRef);
  const restoredApiKeyRuntime = buildCodexDefaultCliEnv(fs, { aiHomeDir, processObj });
  assert.equal(restoredApiKeyRuntime.authMode, 'apikey');
  assert.equal(restoredApiKeyRuntime.env.OPENAI_API_KEY, apiKey);
  assert.equal(processObj.env.OPENAI_API_KEY, 'stale-shell-key');
});

test('AIH-managed Codex launches preserve the authentication selected by the caller', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-managed-cli-'));
  const aiHomeDir = path.join(homeDir, '.ai_home');
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const defaultAccountRef = registerCodexAccount(
    aiHomeDir,
    '1',
    'api-key:codex:managed-launch-default-test'
  );
  writeAccountCredentials(fs, aiHomeDir, defaultAccountRef, {
    OPENAI_API_KEY: 'sk-default-must-not-replace-managed-auth'
  });
  writeDefaultAccountRef(fs, aiHomeDir, 'codex', defaultAccountRef);

  const cases = [
    {
      name: 'gateway API key',
      env: {
        OPENAI_API_KEY: 'aih-gateway-key',
        OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1'
      },
      authMode: 'apikey'
    },
    {
      name: 'explicit API key account',
      env: {
        OPENAI_API_KEY: 'sk-explicit-account-key',
        OPENAI_BASE_URL: 'https://relay.example.test/v1'
      },
      authMode: 'apikey'
    },
    {
      name: 'explicit OAuth account',
      env: {},
      authMode: 'oauth'
    }
  ];

  for (const scenario of cases) {
    const processObj = {
      platform: 'darwin',
      env: {
        HOME: homeDir,
        [CODEX_MANAGED_LAUNCH_ENV]: '1',
        ...scenario.env
      }
    };
    const runtime = buildCodexDefaultCliEnv(fs, { aiHomeDir, processObj });
    assert.equal(runtime.authMode, scenario.authMode, scenario.name);
    assert.equal(runtime.accountRef, '', scenario.name);
    assert.equal(runtime.env.OPENAI_API_KEY, scenario.env.OPENAI_API_KEY, scenario.name);
    assert.equal(runtime.env.OPENAI_BASE_URL, scenario.env.OPENAI_BASE_URL, scenario.name);
    assert.equal(runtime.env[CODEX_MANAGED_LAUNCH_ENV], undefined, scenario.name);
  }
});

test('default Codex CLI passes the API key only through the child environment', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-default-spawn-'));
  const aiHomeDir = path.join(homeDir, '.ai_home');
  const apiKey = 'sk-test-child-env-only';
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const accountRef = registerCodexAccount(
    aiHomeDir,
    '1',
    'api-key:codex:default-spawn-test'
  );
  writeAccountCredentials(fs, aiHomeDir, accountRef, { OPENAI_API_KEY: apiKey });
  writeDefaultAccountRef(fs, aiHomeDir, 'codex', accountRef);

  const spawns = [];
  const child = new EventEmitter();
  runCodexDefaultCli('/tmp/codex.aih-original', ['exec', 'Reply with OK only.'], {
    fs,
    aiHomeDir,
    spawn(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
    processObj: {
      platform: 'darwin',
      env: { HOME: homeDir },
      stderr: { write() {} },
      exit() {},
      kill() {},
      pid: 123
    }
  });

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, '/tmp/codex.aih-original');
  assert.deepEqual(spawns[0].args, [
    'exec',
    '-c', 'suppress_unstable_features_warning=true',
    'Reply with OK only.'
  ]);
  assert.equal(spawns[0].options.env.OPENAI_API_KEY, apiKey);
  assert.equal(JSON.stringify(spawns[0].args).includes(apiKey), false);
});

test('default Codex CLI omits an unsupported configured service tier without hiding supported tiers', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-default-policy-'));
  const codexHome = path.join(homeDir, '.codex');
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model = "gpt-5.6-sol"',
    'service_tier = "fast"',
    '',
    '[features]',
    'chronicle = true'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [{ slug: 'gpt-5.6-sol', service_tiers: [] }]
  }), 'utf8');

  const unsupportedArgs = buildCodexDefaultCliArgs(
    fs,
    { HOME: homeDir, CODEX_HOME: codexHome },
    ['exec', '--json'],
    'apikey'
  );
  assert.deepEqual(unsupportedArgs, [
    'exec',
    '-c', 'suppress_unstable_features_warning=true',
    '-c', 'service_tier="default"',
    '--json'
  ]);

  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-5.6-sol',
      service_tiers: [{ id: 'priority' }]
    }]
  }), 'utf8');
  assert.deepEqual(
    buildCodexDefaultCliArgs(fs, { CODEX_HOME: codexHome }, ['exec'], 'apikey'),
    ['exec', '-c', 'suppress_unstable_features_warning=true']
  );
  assert.deepEqual(
    buildCodexDefaultCliArgs(fs, { CODEX_HOME: codexHome }, ['exec'], 'oauth'),
    ['exec', '-c', 'suppress_unstable_features_warning=true']
  );
});

test('default Codex CLI projects missing same-family metadata from the installed Codex cache', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-model-projection-'));
  const aiHomeDir = path.join(homeDir, '.ai_home');
  const codexHome = path.join(homeDir, '.codex');
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n', 'utf8');
  fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-5.6-terra',
      display_name: 'GPT-5.6-Terra',
      description: 'Template',
      base_instructions: 'Version-matched instructions',
      service_tiers: []
    }]
  }), 'utf8');

  const args = buildCodexDefaultCliArgs(
    fs,
    { HOME: homeDir, CODEX_HOME: codexHome },
    ['exec'],
    'apikey',
    { aiHomeDir }
  );
  const catalogArg = args.find((arg) => String(arg).startsWith('model_catalog_json='));
  assert.ok(catalogArg);
  const catalogPath = catalogArg.match(/^model_catalog_json="(.+)"$/)[1];
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.deepEqual(catalog.models.map((model) => model.slug), [
    'gpt-5.6-terra',
    'gpt-5.6-sol'
  ]);
  assert.equal(catalog.models[1].base_instructions, 'Version-matched instructions');
  assert.equal(catalog.models[1].availability_nux, null);
  assert.equal(catalog.models[1].upgrade, null);
  assert.deepEqual(
    fs.readdirSync(path.dirname(catalogPath)).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('Codex model catalog projection escapes native Windows paths for TOML', () => {
  const writes = [];
  const files = new Map();
  const fsStub = {
    mkdirSync() {},
    readFileSync(filePath) {
      if (!files.has(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(filePath);
    },
    writeFileSync(filePath, content) {
      files.set(filePath, content);
      writes.push({ filePath, content });
    },
    renameSync(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync(filePath) {
      if (!files.delete(filePath)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
  };
  const args = buildModelCatalogProjectionArgs(fsStub, {
    modelId: 'gpt-5.6-sol',
    models: [{
      slug: 'gpt-5.6-terra',
      base_instructions: 'Windows-compatible instructions'
    }]
  }, {
    aiHomeDir: 'C:\\Users\\model\\.ai_home',
    path: path.win32
  });

  assert.equal(writes.length, 1);
  assert.match(writes[0].filePath, /^C:\\Users\\model\\\.ai_home\\run\\codex\\model-catalogs\\[a-f0-9]+\.json\.[^.]+\.tmp$/);
  const catalogPath = Array.from(files.keys()).find((filePath) => filePath.endsWith('.json'));
  assert.match(catalogPath, /^C:\\Users\\model\\\.ai_home\\run\\codex\\model-catalogs\\[a-f0-9]+\.json$/);
  assert.deepEqual(args, [
    '-c',
    `model_catalog_json="${catalogPath.replace(/\\/g, '\\\\')}"`
  ]);
  assert.deepEqual(buildModelCatalogProjectionArgs(fsStub, {
    modelId: 'gpt-5.6-sol',
    models: [{
      slug: 'gpt-5.6-terra',
      base_instructions: 'Windows-compatible instructions'
    }]
  }, {
    aiHomeDir: 'C:\\Users\\model\\.ai_home',
    path: path.win32
  }), args);
  assert.equal(writes.length, 1);
});
