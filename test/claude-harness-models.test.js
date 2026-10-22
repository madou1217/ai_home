'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildClaudeHarnessModelLaunch,
  readClaudeHarnessModelCatalog,
  readModelFlagValue,
  resolveHarnessModelContextTokens
} = require('../lib/cli/services/ai-cli/claude-harness-models');
const { claudeRelayProfile } = require('../lib/cli/services/ai-cli/relay/claude-relay-profile');
const { buildClaudeAccountRelayEnv } = require('../lib/cli/services/ai-cli/claude-account-relay');
const { writePersistedWebUiModelsCache } = require('../lib/server/webui-model-cache');
const { CLAUDE_MODEL_PICKER_ROW_LIMIT } = require('../lib/cli/config/constants');

const ACCOUNT_REF = 'acct_2b2f6702db12593c19cf';
const GATEWAY_ENV = {
  ANTHROPIC_API_KEY: 'gateway-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9527'
};

function createTempAiHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-harness-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, '.ai_home');
}

test('readModelFlagValue reads --model in both spellings and stops at the passthrough escape hatch', () => {
  assert.equal(readModelFlagValue(['--model', 'gpt-5.6-luna', '-p', 'hi']), 'gpt-5.6-luna');
  assert.equal(readModelFlagValue(['--model=gpt-6-astra']), 'gpt-6-astra');
  assert.equal(readModelFlagValue(['-p', 'hi']), '');
  assert.equal(readModelFlagValue(['--', '--model', 'gpt-5.6-luna']), '', '`--` 之后是原生透传，不解析');
});

test('harness model catalog reads the pinned account rows and its display labels only', () => {
  const cache = {
    byAccount: { [ACCOUNT_REF]: ['gpt-5.6-luna', 'gpt-6-astra'], acct_other: ['x'] },
    contextLimits: { [ACCOUNT_REF]: { 'gpt-5.6-luna': 400000 } },
    labels: { codex: { 'gpt-5.6-luna': 'GPT 5.6 Luna' }, agy: { 'gpt-6-astra': 'wrong provider' } }
  };
  const catalog = readClaudeHarnessModelCatalog({
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    readModelsCache: () => cache
  });
  assert.deepEqual(catalog.models, ['gpt-5.6-luna', 'gpt-6-astra']);
  assert.deepEqual(catalog.contextLimits, { 'gpt-5.6-luna': 400000 });
  assert.deepEqual(catalog.labels, { 'gpt-5.6-luna': 'GPT 5.6 Luna' }, '标签只取本 Provider 的目录');
});

test('harness model catalog degrades to empty on missing account, broken snapshot or throwing reader', () => {
  assert.deepEqual(readClaudeHarnessModelCatalog({}), { models: [], contextLimits: {}, labels: {} });
  assert.deepEqual(readClaudeHarnessModelCatalog({
    accountRef: ACCOUNT_REF,
    readModelsCache: () => ({ byAccount: {} })
  }), { models: [], contextLimits: {}, labels: {} });
  assert.deepEqual(readClaudeHarnessModelCatalog({
    accountRef: ACCOUNT_REF,
    readModelsCache: () => { throw new Error('db locked'); }
  }), { models: [], contextLimits: {}, labels: {} });
});

test('context window comes from the probed snapshot first and models.dev second', () => {
  const readModelMetadata = () => ({ limits: { input: 922000, context: 1050000 } });
  assert.equal(resolveHarnessModelContextTokens({
    model: 'gpt-5.6-luna',
    contextLimits: { 'gpt-5.6-luna': 400000 },
    readModelMetadata
  }), 400000, '账号探测到的窗口优先于离线目录');
  assert.equal(resolveHarnessModelContextTokens({ model: 'gpt-5.6-luna', readModelMetadata }), 922000);
  assert.equal(resolveHarnessModelContextTokens({
    model: 'claude-opus-4-5',
    readModelMetadata
  }), null, 'Claude Code 自己认识的 claude-* 不被覆盖');
  assert.equal(resolveHarnessModelContextTokens({ model: 'unknown-model', readModelMetadata: () => null }), null);
  assert.equal(resolveHarnessModelContextTokens({ model: '', readModelMetadata }), null);
});

test('cross-provider launch adds the pinned account models to the picker and declares the window', () => {
  const launch = buildClaudeHarnessModelLaunch({
    args: ['--model', 'gpt-5.6-luna', '-p', 'hi'],
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    readModelsCache: () => ({
      byAccount: { [ACCOUNT_REF]: ['gpt-5.6-luna', 'gpt-6-astra'] },
      labels: { codex: { 'gpt-6-astra': 'GPT 6 Astra' } }
    }),
    readModelMetadata: () => ({ limits: { input: 922000 } })
  });
  assert.deepEqual(launch.env, { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '922000' });
  assert.deepEqual(launch.settings.modelPicker, {
    replaceBuiltInOptions: false,
    options: [{ model: 'gpt-5.6-luna' }, { model: 'gpt-6-astra', label: 'GPT 6 Astra' }]
  });
});

test('cross-provider launch without a readable catalog and window still returns nothing to inject', () => {
  assert.equal(buildClaudeHarnessModelLaunch({
    args: ['--model', 'gpt-5.6-luna'],
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    readModelsCache: () => ({ byAccount: {} }),
    readModelMetadata: () => null
  }), null);
  // 目录读得到、窗口读不到时只给选择器，不猜窗口。
  const pickerOnly = buildClaudeHarnessModelLaunch({
    args: ['--model', 'gpt-5.6-luna'],
    accountRef: ACCOUNT_REF,
    readModelsCache: () => ({ byAccount: { [ACCOUNT_REF]: ['gpt-5.6-luna'] } }),
    readModelMetadata: () => null
  });
  assert.deepEqual(pickerOnly.env, {});
  assert.equal(pickerOnly.settings.modelPicker.options.length, 1);
});

test('picker rows are capped so a pathological catalog cannot bloat the settings file', () => {
  const models = Array.from({ length: CLAUDE_MODEL_PICKER_ROW_LIMIT + 20 }, (_, index) => `m-${index}`);
  const launch = buildClaudeHarnessModelLaunch({
    args: [],
    accountRef: ACCOUNT_REF,
    readModelsCache: () => ({ byAccount: { [ACCOUNT_REF]: models } }),
    readModelMetadata: () => null
  });
  assert.equal(launch.settings.modelPicker.options.length, CLAUDE_MODEL_PICKER_ROW_LIMIT);
});

test('the Claude relay profile writes the picker into --settings only for cross-provider launches', (t) => {
  const aiHomeDir = createTempAiHome(t);
  writePersistedWebUiModelsCache({ fs, aiHomeDir }, {
    updatedAt: Date.now(),
    byAccount: { [ACCOUNT_REF]: ['gpt-5.6-luna', 'gpt-6-astra'] },
    contextLimits: { [ACCOUNT_REF]: { 'gpt-5.6-luna': 400000 } }
  });

  const crossEnv = buildClaudeAccountRelayEnv(GATEWAY_ENV, ACCOUNT_REF, { crossProvider: true });
  const crossLaunch = claudeRelayProfile.buildRelayLaunch({
    args: ['--model', 'gpt-5.6-luna'],
    accountEnv: crossEnv,
    isLogin: false,
    crossProvider: true,
    accountRef: ACCOUNT_REF,
    identityProvider: 'codex',
    launchStorage: { fs, aiHomeDir }
  });
  const crossSettings = JSON.parse(fs.readFileSync(crossLaunch.args[1], 'utf8'));
  assert.deepEqual(crossSettings.modelPicker.options.map((row) => row.model), ['gpt-5.6-luna', 'gpt-6-astra']);
  assert.equal(crossSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '400000');
  assert.equal(crossSettings.env.ANTHROPIC_CUSTOM_HEADERS,
    `x-account-ref: ${ACCOUNT_REF}\nx-aih-route-owner: node`);

  // 同 Provider 启动（原生 claude 账号）不加选择器：内置 Claude 条目本来就是对的。
  const nativeLaunch = claudeRelayProfile.buildRelayLaunch({
    args: ['--model', 'claude-opus-4-5'],
    accountEnv: buildClaudeAccountRelayEnv(GATEWAY_ENV, ACCOUNT_REF),
    isLogin: false,
    crossProvider: false,
    accountRef: ACCOUNT_REF,
    identityProvider: 'claude',
    launchStorage: { fs, aiHomeDir }
  });
  const nativeSettings = JSON.parse(fs.readFileSync(nativeLaunch.args[1], 'utf8'));
  assert.equal(nativeSettings.modelPicker, undefined);
  assert.equal(nativeSettings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
});
