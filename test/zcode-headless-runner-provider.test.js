'use strict';

// 回归守卫（2026-11-04 账号 1 真机）：`aih zcode 1 -p` 在官方 runtime（Desktop 3.17.2 /
// CLI 0.17.1）下先报 "Select a model before sending a message"（standalone 对只有
// auth-source 键的账号解析不出 provider），显式 app-server 通路又把请求发到
// `account:bigmodel-start-plan` 端点被上游 1005 exceed quota limit 拒掉 —— 而账号
// 实际额度 90%。根因：runner 的 providerId 推导
//   1) 只认 `:identity` 键，不认 `:auth-source` 键（账号 1 只有后者）；
//   2) 凭据里没有声明键时回落到 start-plan$ 规则（对 coding-plan 账号是错路由）。
// 修复后的优先级：凭据声明键（多声明时 start-plan 优先，保住账号 11 的桌面端行为）
// → 套餐名命中 → 家族回落（无声明键账号沿用旧行为）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  pickDeclaredProviderRule,
  readDeclaredProviderIds,
  readPersonalModelId,
  resolveProviderRule
} = require('../lib/cli/services/ai-cli/headless-runners/zcode-app-server-runner');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');

function seedCredentials(aiHomeDir, provider, credentials) {
  const registered = registerAccountIdentity(fs, aiHomeDir, {
    provider,
    identitySeed: `oauth:${provider}:test:${credentials['oauth:active_provider'] || Object.keys(credentials)[0]}`
  });
  writeAccountNativeAuth(fs, aiHomeDir, registered.accountRef, { credentials });
  return registered.accountRef;
}

// 内置规则的极简形态（真实 zcode-builtin.json 的 providerRules 子集，字段形状一致）。
function builtinConfig() {
  const rule = (providerId, models) => ({
    providerId,
    config: { group: providerId.includes('bigmodel') ? 'bigmodel-family' : 'zai-family', builtinModelIds: models }
  });
  return {
    config: {
      providerConfigRules: {
        providerRules: [
          rule('account:zai-individual-coding-plan', ['GLM-5.3', 'GLM-5.3-Flash']),
          rule('account:zai-start-plan', ['GLM-5.3-Flash', 'GLM-5.2']),
          rule('account:bigmodel-individual-coding-plan', ['GLM-5.3', 'GLM-5.3-Flash']),
          rule('account:bigmodel-start-plan', ['GLM-5.3-Flash', 'GLM-5.2'])
        ]
      }
    }
  };
}

test('只有 auth-source 键的账号（账号 1 形态）按声明键选出 individual-coding-plan 规则', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-runner-'));
  const ref = seedCredentials(root, 'zcode', {
    'account-provider:account:bigmodel-individual-coding-plan:auth-source': 'x',
    'oauth:bigmodel:access_token': 'tok'
  });
  const ids = readDeclaredProviderIds(fs, root, ref);
  assert.deepEqual(ids, ['account:bigmodel-individual-coding-plan']);
  const rule = pickDeclaredProviderRule(builtinConfig(), ids);
  assert.equal(rule.providerId, 'account:bigmodel-individual-coding-plan');
});

test('同账号声明了 coding-plan 与 start-plan 两组键（账号 11 形态）时 start-plan 优先', () => {
  const ids = [
    'account:zai-individual-coding-plan',
    'account:zai-start-plan'
  ];
  const rule = pickDeclaredProviderRule(builtinConfig(), ids);
  assert.equal(rule.providerId, 'account:zai-start-plan');
});

test('声明键不在内置配置里时返回 null，交给套餐名/家族回落', () => {
  const ids = ['account:zai-gold-plan'];
  assert.equal(pickDeclaredProviderRule(builtinConfig(), ids), null);
  // 家族回落保底（旧行为保留）：zai 区域、无套餐名 → start-plan 规则。
  const fallback = resolveProviderRule(builtinConfig(), { region: 'zai', planLabel: '' });
  assert.equal(fallback.providerId, 'account:zai-start-plan');
});

test('identity 与 auth-source 键指向同一 provider 时去重', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-runner-'));
  const ref = seedCredentials(root, 'zcode', {
    'account-provider:account:zai-individual-coding-plan:identity': 'x',
    'account-provider:account:zai-individual-coding-plan:auth-source': 'x'
  });
  assert.deepEqual(readDeclaredProviderIds(fs, root, ref), ['account:zai-individual-coding-plan']);
});

test('模型挑选：已启用模型优先于 defaultModelSelection（账号 1 形态）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-runner-'));
  const personal = path.join(root, 'provider_config.json');
  fs.writeFileSync(personal, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: {
        providerModelRules: [
          { modelId: 'GLM-5.3-Flash', config: { enabled: true }, providerId: 'account:bigmodel-individual-coding-plan' }
        ],
        manualProviderModelRules: []
      },
      defaultModelSelection: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3' }
    }
  }), 'utf8');
  // CLI 默认指向旗舰 GLM-5.3（真机 turn failed: model_request_failed），
  // 但该账号唯一启用的是 GLM-5.3-Flash —— 已启用集优先。
  assert.equal(
    readPersonalModelId(fs, personal, 'account:bigmodel-individual-coding-plan'),
    'GLM-5.3-Flash'
  );
});

test('模型挑选：无启用规则时用 defaultModelSelection（providerId 命中才认）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-runner-'));
  const personal = path.join(root, 'provider_config.json');
  fs.writeFileSync(personal, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [],
        defaultModelSelection: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' }
      }
    }
  }), 'utf8');
  assert.equal(readPersonalModelId(fs, personal, 'account:zai-start-plan'), 'GLM-5.3-Flash');
  assert.equal(readPersonalModelId(fs, personal, 'account:zai-individual-coding-plan'), '');
  // 配置缺失/损坏时不抛错，交给调用方的内置规则回落。
  assert.equal(readPersonalModelId(fs, path.join(root, 'missing.json'), 'account:zai-start-plan'), '');
});
