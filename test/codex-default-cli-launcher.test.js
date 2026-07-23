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
  assert.deepEqual(spawns[0].args, ['exec', 'Reply with OK only.']);
  assert.equal(spawns[0].options.env.OPENAI_API_KEY, apiKey);
  assert.equal(JSON.stringify(spawns[0].args).includes(apiKey), false);
});
