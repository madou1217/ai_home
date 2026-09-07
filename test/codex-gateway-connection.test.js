'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writeServerConfig } = require('../lib/server/server-config-store');
const { readCodexGatewayConnection } = require('../lib/server/codex-gateway-connection');
const { codexRelayProfile } = require('../lib/cli/services/ai-cli/relay/codex-relay-profile');
const { buildAccountScopedEnv } = require('../lib/cli/services/ai-cli/provider-runtime-env');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');

test('host auth command pairs the gateway endpoint with its current key despite polluted App environment', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-auth-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const hostHomeDir = path.join(root, 'host');
  const script = path.resolve(__dirname, '../scripts/aih-codex-provider-auth.js');
  writeServerConfig({ port: 9723, apiKey: 'gateway-key-one' }, { fs, aiHomeDir });
  const refs = [1, 2].map(id => {
    const ref = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'codex', cliAccountId: String(id), identitySeed: 'fixture-auth-' + id
    }).accountRef;
    writeAccountCredentials(fs, aiHomeDir, ref, {
      OPENAI_API_KEY: 'upstream-key-' + id, OPENAI_BASE_URL: 'https://upstream' + id + '.example/v1'
    });
    return ref;
  });
  const sync = createHostConfigSyncer({ fs, fse: require('fs-extra'), aiHomeDir, hostHomeDir,
    ensureDir: dir => fs.mkdirSync(dir, { recursive: true }), cliConfigs: { codex: { globalDir: '.codex' } },
    processObj: { platform: process.platform, execPath: process.execPath, env: {}, pid: process.pid } });
  for (const ref of refs) {
    assert.equal(sync('codex', ref).ok, true);
    const connection = readCodexGatewayConnection(fs, aiHomeDir, ref);
    const config = fs.readFileSync(path.join(hostHomeDir, '.codex/config.toml'), 'utf8');
    assert.ok(config.includes('base_url = "' + connection.baseUrl + '"'));
    assert.ok(config.includes('"X-Account-Ref" = "' + ref + '"'));
    assert.match(config, /'--gateway', '--ai-home'/);
    assert.doesNotMatch(config, /upstream-key|upstream[12]\.example|env_key/);
    const auth = JSON.parse(fs.readFileSync(path.join(hostHomeDir, '.codex/auth.json')));
    assert.equal(auth.OPENAI_API_KEY, connection.apiKey);
    const actual = execFileSync(process.execPath, [script, '--gateway', '--ai-home', aiHomeDir], {
      encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'wrong-inherited-key',
        OPENAI_BASE_URL: 'https://wrong.example/v1', AIH_HOME: '/nonexistent-projection', HOME: root }
    });
    assert.equal(actual, connection.apiKey);
  }
  writeServerConfig({ apiKey: 'rotated-gateway-key' }, { fs, aiHomeDir });
  assert.equal(execFileSync(process.execPath, [script, '--gateway', '--ai-home', aiHomeDir], {
    encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'gateway-key-one' }
  }), 'rotated-gateway-key');
});

test('Codex account relay preserves explicit account selection and keeps OAuth/login native', () => {
  const refs = ['acct_11111111111111111111', 'acct_22222222222222222222'];
  for (const accountRef of refs) {
    const input = { provider: 'codex', accountRef, accountEnv: { OPENAI_API_KEY: 'upstream' } };
    assert.equal(codexRelayProfile.shouldRelayAccount(input), true);
    for (const extra of [{ isLogin: true }, { gateway: true }, { accountEnv: {} },
      { args: ['-c', 'model_provider=custom-provider'] }]) {
      assert.equal(codexRelayProfile.shouldRelayAccount({ ...input, ...extra }), false);
    }
    const env = codexRelayProfile.buildAccountRelayEnv({ OPENAI_API_KEY: 'gateway', OPENAI_BASE_URL: 'http://127.0.0.1:9527/v1' }, accountRef);
    const launch = codexRelayProfile.buildRelayLaunch({ args: ['exec', 'hello'], accountEnv: env });
    assert.ok(launch.args.includes('model_providers.aih_server.http_headers.X-Account-Ref=' + accountRef));
    assert.equal(launch.args.some(arg => /["\s]/.test(arg)), false);
    assert.equal(JSON.stringify(launch.args).includes('upstream'), false);
    assert.deepEqual(buildAccountScopedEnv(env, {}), {});
  }
  assert.throws(() => codexRelayProfile.buildAccountRelayEnv({}, '1'), /invalid_codex/);
});
