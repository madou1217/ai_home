'use strict';

// WorkBuddy 账号模型探测:个人账号没有模型接口,CLI 只在 --help 的 --model 说明里给出
// 按当前登录合并过滤后的「当前支持」列表;会话 --model 校验的也是这份列表。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { credential } = require('./helpers/codebuddy-credential');
const { parseWorkbuddyHelpModels, discoverWorkbuddyCliModels } = require('../lib/server/workbuddy-model-discovery');
const { listModelDiscoveryAccounts } = require('../lib/server/model-discovery-accounts');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');

// 真实 CLI 输出里的那一行(WorkBuddy.app 内嵌 CLI,2026-09-30)。
const REAL_HELP_LINE = '  --model <model>                                  Model for the current session. Please provide the model ID. Currently supported: (auto, glm-5v-turbo, glm-5.1, glm-5.0-turbo, glm-5.0, glm-4.7, kimi-k2.5, minimax-m2.7, deepseek-v3-2-volc, custom-local:gpt-6-astra)';

test('parses the supported models and drops host-local custom models', () => {
  assert.deepEqual(parseWorkbuddyHelpModels(`Options:\n${REAL_HELP_LINE}\n  --effort <level>`), [
    'auto', 'glm-5v-turbo', 'glm-5.1', 'glm-5.0-turbo', 'glm-5.0', 'glm-4.7', 'kimi-k2.5', 'minimax-m2.7', 'deepseek-v3-2-volc'
  ]);
});

test('an unrecognised help output is an error, not an empty list', () => {
  assert.throws(() => parseWorkbuddyHelpModels('Usage: codebuddy [options]'), /codebuddy_model_list_unparsable/);
});

test('runs the edition CLI with the session environment of that account', async () => {
  const calls = [];
  const models = await discoverWorkbuddyCliModels({
    aiHomeDir: '/tmp/aih',
    hostHomeDir: '/home/u',
    env: { PATH: '/bin' },
    resolveWorkbuddyNativeCli: (provider) => ({ command: '/node', prefixArgs: [`/apps/${provider}/cli/bin/codebuddy`] }),
    buildProviderEnv: (provider, runtimeDir, baseEnv, options) => ({ HOME: runtimeDir, PROVIDER: provider, ACCOUNT: options.accountRef }),
    execFile: async (command, args, execOptions) => {
      calls.push({ command, args, env: execOptions.env });
      return { stdout: REAL_HELP_LINE };
    }
  }, { provider: 'workbuddycn', accountRef: 'acct_0123456789abcdef0123' });

  assert.equal(models.length, 9);
  assert.equal(calls[0].command, '/node');
  assert.deepEqual(calls[0].args, ['/apps/workbuddycn/cli/bin/codebuddy', '--help']);
  assert.equal(calls[0].env.ACCOUNT, 'acct_0123456789abcdef0123');
  assert.match(calls[0].env.HOME, /workbuddycn/);
});

test('signed-in WorkBuddy accounts join model discovery although they are not in the runtime pool', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-discovery-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, { provider: 'workbuddy', identitySeed: 'oauth:workbuddy:fixture-user' });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential('workbuddy') });

  const state = { accounts: { codex: [{ provider: 'codex', accountRef: 'acct_codex' }] } };
  const accounts = listModelDiscoveryAccounts(state, 'workbuddy', { fs, aiHomeDir });
  assert.deepEqual(accounts.map((account) => account.accountRef), [accountRef]);
  assert.equal(listModelDiscoveryAccounts(state, 'workbuddy', null).length, 0);
  assert.deepEqual(listModelDiscoveryAccounts(state, 'codex', { fs, aiHomeDir }).map((a) => a.accountRef), ['acct_codex']);
});

test('the background model refresh schedules signed-in WorkBuddy accounts', (t) => {
  const { listProbeCandidates } = require('../lib/server/webui-model-refresh-scheduler');
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-schedule-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, { provider: 'workbuddycn', identitySeed: 'oauth:workbuddycn:fixture-user' });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { credentials: credential('workbuddycn') });

  const candidates = listProbeCandidates({ accounts: {} }, Date.now(), { fs, aiHomeDir });
  assert.deepEqual(candidates.map((item) => `${item.provider}:${item.account.accountRef}`), [`workbuddycn:${accountRef}`]);
});
