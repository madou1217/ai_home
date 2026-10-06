'use strict';

// CodeBuddy / WorkBuddy 家族账号模型探测:个人账号没有模型接口,CLI 只在 --help 的 --model 说明里给出
// 按当前登录合并过滤后的「当前支持」列表;会话 --model 校验的也是这份列表。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { credential } = require('./helpers/codebuddy-credential');
const { parseCodebuddyHelpModels } = require('../lib/server/workbuddy-model-discovery');
const { discoverNativeCliModels, supportsNativeCliModelDiscovery } = require('../lib/server/native-cli-model-discovery');
const { listModelDiscoveryAccounts, listModelDiscoveryProviders } = require('../lib/server/model-discovery-accounts');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const FAMILY_PROVIDERS = ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn'];

// 真实 CLI 输出里的那一行(WorkBuddy.app 内嵌 CLI,2026-09-30)。
const REAL_HELP_LINE = '  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (auto, glm-5v-turbo, glm-5.1, glm-5.0-turbo, glm-5.0, glm-4.7, kimi-k2.5, minimax-m2.7, deepseek-v3-2-volc, custom-local:gpt-6-astra)';

test('parses the supported models and drops host-local custom models', () => {
  assert.deepEqual(parseCodebuddyHelpModels(`Options:\n${REAL_HELP_LINE}\n  --effort <level>`), [
    'auto', 'glm-5v-turbo', 'glm-5.1', 'glm-5.0-turbo', 'glm-5.0', 'glm-4.7', 'kimi-k2.5', 'minimax-m2.7', 'deepseek-v3-2-volc'
  ]);
});

test('an unrecognised help output is an error, not an empty list', () => {
  assert.throws(() => parseCodebuddyHelpModels('Usage: codebuddy [options]'), /codebuddy_model_list_unparsable/);
});

for (const provider of FAMILY_PROVIDERS) {
  test(`${provider}: runs the session CLI with that account's isolated environment`, async () => {
    const calls = [];
    const models = await discoverNativeCliModels({
      aiHomeDir: '/tmp/aih',
      hostHomeDir: '/home/u',
      env: { PATH: '/bin' },
      resolveNativeCliLaunch: (resolvedProvider, options) => {
        assert.equal(resolvedProvider, provider);
        assert.equal(options.hostHomeDir, '/home/u');
        assert.deepEqual(options.env, { PATH: '/bin' });
        return { command: '/node', prefixArgs: [`/apps/${provider}/cli/bin/codebuddy`] };
      },
      buildProviderEnv: (provider, runtimeDir, baseEnv, options) => ({ HOME: runtimeDir, PROVIDER: provider, ACCOUNT: options.accountRef }),
      execFile: async (command, args, execOptions) => {
        calls.push({ command, args, ...execOptions });
        return { stdout: REAL_HELP_LINE };
      }
    }, { provider, accountRef: 'acct_0123456789abcdef0123' });

    assert.equal(supportsNativeCliModelDiscovery(provider), true);
    assert.equal(models.length, 9);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, '/node');
    assert.deepEqual(calls[0].args, [`/apps/${provider}/cli/bin/codebuddy`, '--help']);
    assert.equal(calls[0].env.ACCOUNT, 'acct_0123456789abcdef0123');
    assert.equal(calls[0].env.HOME, `/tmp/aih/run/auth-projections/${provider}/acct_0123456789abcdef0123`);
    assert.equal(calls[0].timeout, 60000);
  });

  test(`${provider}: signed-in accounts join discovery without joining the runtime pool`, (t) => {
    const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-discovery-'));
    t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, { provider, identitySeed: `oauth:${provider}:fixture-user` });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential(provider) });
    registerAccountIdentity(fs, aiHomeDir, { provider, identitySeed: `oauth:${provider}:unsigned-user` });

    const state = { accounts: { codex: [{ provider: 'codex', accountRef: 'acct_codex' }] } };
    const accounts = listModelDiscoveryAccounts(state, provider, { fs, aiHomeDir });
    assert.deepEqual(accounts.map((account) => account.accountRef), [accountRef]);
    assert.ok(listModelDiscoveryProviders(state, { fs, aiHomeDir }).includes(provider));
    assert.equal(state.accounts[provider], undefined);
    assert.equal(listModelDiscoveryAccounts(state, provider, null).length, 0);
    assert.deepEqual(listModelDiscoveryAccounts(state, 'codex', { fs, aiHomeDir }).map((a) => a.accountRef), ['acct_codex']);
    state.accounts[provider] = [accounts[0]];
    assert.equal(listModelDiscoveryAccounts(state, provider, { fs, aiHomeDir }).length, 1);
  });

  test(`${provider}: background refresh schedules signed-in accounts`, (t) => {
    const { listProbeCandidates } = require('../lib/server/webui-model-refresh-scheduler');
    const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-schedule-'));
    t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, { provider, identitySeed: `oauth:${provider}:fixture-user` });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential(provider) });

    const candidates = listProbeCandidates({ accounts: {} }, Date.now(), { fs, aiHomeDir });
    assert.deepEqual(candidates.map((item) => `${item.provider}:${item.account.accountRef}`), [`${provider}:${accountRef}`]);
  });

  test(`${provider}: account projection returns the probed models`, (t) => {
    const { buildModelAccountRefProjection } = require('../lib/server/webui-model-account-ref-projection');
    const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-projection-'));
    t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, { provider, identitySeed: `oauth:${provider}:fixture-user` });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential(provider) });

    const projection = buildModelAccountRefProjection({ fs, aiHomeDir }, { accounts: {} }, {
      byAccount: { [accountRef]: ['fast-model', 'deep-model'] },
      errorsByAccount: {}
    });
    assert.deepEqual(projection.byAccountRef[accountRef], ['deep-model', 'fast-model']);
  });
}

test('Windows CodeBuddy model probing unwraps the installed npm shim before execFile', async () => {
  const shimPath = 'C:\\apps\\codebuddy.cmd';
  const nodePath = 'C:\\apps\\node.exe';
  const models = await discoverNativeCliModels({
    aiHomeDir: '/tmp/aih',
    platform: 'win32',
    fs: {
      existsSync: (file) => file === shimPath || file === nodePath,
      readFileSync: () => '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\codebuddy\\bin\\codebuddy.js" %*'
    },
    resolveNativeCliLaunch: () => ({ command: shimPath, prefixArgs: [] }),
    buildProviderEnv: () => ({ HOME: '/tmp/isolated-account' }),
    execFile: async (command, args, options) => {
      assert.equal(command, nodePath);
      assert.deepEqual(args, ['C:\\apps\\node_modules\\codebuddy\\bin\\codebuddy.js', '--help']);
      assert.equal(options.env.HOME, '/tmp/isolated-account');
      assert.equal(options.windowsVerbatimArguments, false);
      return { stdout: REAL_HELP_LINE };
    }
  }, { provider: 'codebuddy', accountRef: 'acct_0123456789abcdef0123' });
  assert.equal(models.length, 9);
});

test('Windows non-node CodeBuddy batch launch uses the shared verbatim cmd adapter', async () => {
  await discoverNativeCliModels({
    aiHomeDir: '/tmp/aih',
    platform: 'win32',
    fs: { existsSync: () => false },
    resolveNativeCliLaunch: () => ({ command: 'C:\\apps\\codebuddy.cmd', prefixArgs: [] }),
    buildProviderEnv: () => ({ HOME: '/tmp/isolated-account' }),
    execFile: async (command, args, options) => {
      assert.equal(command, 'cmd.exe');
      assert.ok(args.at(-1).includes('--help'));
      assert.equal(options.windowsVerbatimArguments, true);
      assert.equal(options.env.HOME, '/tmp/isolated-account');
      return { stdout: REAL_HELP_LINE };
    }
  }, { provider: 'codebuddycn', accountRef: 'acct_0123456789abcdef0123' });
});
