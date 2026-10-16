'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createChatGatewayOptions, ChatGatewayModelCatalog, usesChatGateway } = require('../lib/server/chat-runtime/chat-harness-gateway');
const { sessionDocumentPrompt } = require('../lib/server/chat-runtime/chat-harness-policy');

test('two gateway accounts keep distinct homes, fixed routing headers and model catalogs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-harness-accounts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = {
    aiHomeDir: root,
    env: { HOME: '/host', CODEX_HOME: '/host/.codex', OPENAI_API_KEY: 'host-secret', ANTHROPIC_API_KEY: 'other-secret' },
    readAccountCredentialRecord: (_fs, _root, accountRef) => ({ provider: 'claude', accountRef }),
    chatGateway: { port: 9999, clientKey: 'gateway-secret', readModels: async (_provider, accountRef) => (
      accountRef === 'acct_one' ? ['claude-sonnet-4-5'] : ['claude-haiku-4-5']
    ) }
  };
  const one = createChatGatewayOptions({ provider: 'claude', executionAccountRef: 'acct_one' }, options);
  const two = createChatGatewayOptions({ provider: 'claude', executionAccountRef: 'acct_two' }, options);
  const firstEnv = await one.buildProviderEnvImpl();
  const secondEnv = await two.buildProviderEnvImpl();
  assert.notEqual(firstEnv.CODEX_HOME, secondEnv.CODEX_HOME);
  assert.equal(firstEnv.OPENAI_API_KEY, 'gateway-secret');
  assert.equal(firstEnv.ANTHROPIC_API_KEY, undefined);
  const firstConfig = fs.readFileSync(path.join(firstEnv.CODEX_HOME, 'config.toml'), 'utf8');
  // 账号作用域是双头钉选（X-Account-Ref + X-Provider）；网关作用域两个头都不写（另一条用例覆盖）。
  assert.match(firstConfig, /X-Account-Ref = "acct_one"/);
  assert.match(firstConfig, /X-Provider = "claude"/);
  assert.doesNotMatch(firstConfig, /acct_two|host-secret|other-secret|gateway-secret/);
  // 聊天请求只带对话本身（v7，2026-10-16）：codex 的宿主提示词注入面全部显式关闭，
  // 否则全局 AGENTS.md / skills 清单 / 环境块 / 权限块会被注入每一次模型请求。
  for (const line of [
    'skills.include_instructions = false',
    'include_environment_context = false',
    'include_permissions_instructions = false',
    'include_apps_instructions = false',
    'include_collaboration_mode_instructions = false'
  ]) {
    assert.ok(firstConfig.includes(`${line}\n`), `harness config must pin "${line}"`);
  }
  const catalogPath = JSON.parse(firstConfig.match(/^model_catalog_json = (.+)$/m)[1]);
  const nativeCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  assert.deepEqual(nativeCatalog.models.map((model) => model.slug), ['claude-sonnet-4-5']);
  assert.doesNotMatch(JSON.stringify(nativeCatalog), /acct_two|host-secret|other-secret|gateway-secret/);
  await assert.rejects(one.accountIdentityValidator({ initializeResult: { codexHome: secondEnv.CODEX_HOME } }),
    /chat_harness_execution_identity_mismatch/);
  assert.equal((await one.modelCatalog.resolveTurnSettings({ model: 'claude-sonnet-4-5' })).model, 'claude-sonnet-4-5');
  await assert.rejects(two.modelCatalog.resolveTurnSettings({ model: 'claude-sonnet-4-5' }),
    /chat_harness_account_model_unavailable/);
  assert.throws(() => createChatGatewayOptions({ provider: 'gemini', executionAccountRef: 'acct_one' }, options),
    /chat_session_account_mismatch/);
});

test('Kimi native metadata preserves its context, reasoning and supported input modalities', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-harness-kimi-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = createChatGatewayOptions({ provider: 'kimi', executionAccountRef: 'acct_kimi' }, {
    aiHomeDir: root, env: {}, readAccountCredentialRecord: () => ({ provider: 'kimi' }),
    chatGateway: { port: 9999, readModels: async () => ['k3'] }
  });
  const env = await options.buildProviderEnvImpl();
  const config = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  const file = JSON.parse(config.match(/^model_catalog_json = (.+)$/m)[1]);
  const { models: [model] } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(model.slug, 'k3');
  assert.equal(model.context_window, 1048576);
  assert.deepEqual(model.supported_reasoning_levels.map((entry) => entry.effort), ['low', 'high', 'max']);
  assert.deepEqual(model.input_modalities, ['text', 'image']);
  assert.equal(model.shell_type, 'disabled');
  const { clientOptions } = require('../lib/server/chat-runtime/codex-session-driver-support');
  assert.equal(clientOptions(options, { executionAccountRef: 'acct_kimi' }, { fingerprint: 'native-v1' })
    .runtimeFingerprint, 'native-v1:chat-model-metadata-stream-v7');
});

test('self-hosted models unknown to models.dev use the context window their /models probe declared', async (t) => {
  const { registerProbedModelLimits, resetProbedModelLimits } = require('../lib/server/probed-model-limits');
  resetProbedModelLimits();
  t.after(() => resetProbedModelLimits());
  registerProbedModelLimits('acct_local_lab', [{ id: 'local-lab-model-27b', context_length: 131072 }], ['local-lab-model-27b']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-harness-probed-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = createChatGatewayOptions({ provider: 'claude', executionAccountRef: 'acct_local_lab' }, {
    aiHomeDir: root, env: {}, readAccountCredentialRecord: () => ({ provider: 'claude' }),
    chatGateway: { port: 9999, readModels: async () => ['local-lab-model-27b'] }
  });

  const env = await options.buildProviderEnvImpl();
  const config = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  const file = JSON.parse(config.match(/^model_catalog_json = (.+)$/m)[1]);
  const { models: [model] } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(model.context_window, 131072);
  assert.equal(model.max_context_window, 131072);
  const settings = await options.modelCatalog.resolveTurnSettings({ model: 'local-lab-model-27b' });
  assert.deepEqual(settings.threadConfig, { model_context_window: 131072 });
});

test('empty account catalogs fail explicitly instead of using another account or provider model', async () => {
  const catalog = new ChatGatewayModelCatalog({ provider: 'claude', executionAccountRef: 'acct_empty' },
    { readModels: async () => [] });
  await assert.rejects(catalog.list(), /chat_harness_account_models_unavailable/);
});

test('Codex API keys use their gateway catalog while Codex OAuth keeps the native catalog', () => {
  const session = { provider: 'codex', executionAccountRef: 'acct_codex' };
  const options = { aiHomeDir: '/isolated', readAccountCredentialRecord: () => ({ env: { OPENAI_API_KEY: 'key' } }) };
  assert.equal(usesChatGateway(session, options), true);
  assert.equal(usesChatGateway(session, { ...options, readAccountCredentialRecord: () => ({ env: {}, nativeAuth: { auth: { email: 'native@example.com' } } }) }), false);
});

test('Chat supplies document text to Harness while Work retains local file access', () => {
  const file = '/owned-attachments/notes.md';
  const chat = { policy: { workspaceMode: 'chat' } };
  assert.match(sessionDocumentPrompt(chat, 'Read this', [file], { readFileSync: () => 'document-marker-73' }),
    /document-marker-73/);
  assert.doesNotMatch(sessionDocumentPrompt(chat, 'Read this', [file], { readFileSync: () => 'text' }),
    /Read these local document files/);
  assert.match(sessionDocumentPrompt({ policy: {} }, 'Read this', [file]), /\/owned-attachments\/notes.md/);
});

test('gateway-scoped harness drops the account pin, keeps one home per provider and reads the pooled catalog', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-harness-gateway-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const readModelsCalls = [];
  const options = {
    aiHomeDir: root,
    env: { HOME: '/host', OPENAI_API_KEY: 'host-secret' },
    // 网关作用域刻意不读账号凭据：这里读到就说明实现回退了。
    readAccountCredentialRecord: () => { throw new Error('gateway scope must not read account credentials'); },
    chatGateway: {
      port: 9999,
      clientKey: 'gateway-secret',
      readModels: async (provider, accountRef) => {
        readModelsCalls.push([provider, accountRef]);
        return ['opencode/deepseek-v4.1-flash-free', 'opencode/kimi-k3'];
      }
    }
  };
  const gateway = createChatGatewayOptions({ provider: 'opencode', executionAccountRef: 'gateway:opencode' }, options);
  const env = await gateway.buildProviderEnvImpl();
  // home 按 provider 分开（不同 provider 的网关档 config.toml 不能互踩），且不带账号 pin。
  assert.ok(env.CODEX_HOME.includes(path.join('chat-harness', 'gateway-opencode')));
  assert.equal(env.AIH_CODEX_GATEWAY_ACCOUNT_REF, undefined);
  assert.equal(env.OPENAI_API_KEY, 'gateway-secret');
  const config = fs.readFileSync(path.join(env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.doesNotMatch(config, /X-Account-Ref/);
  // v6（0572d9e0，2026-10-15）：网关作用域两个钉选头都不写 —— 账号由网关在模型可用池里挑、
  // provider 按模型 id 解析，否则「aih-server 会话里换到别家模型」做不到；账号作用域仍双头钉选。
  assert.doesNotMatch(config, /http_headers/);
  assert.doesNotMatch(config, /X-Provider/);
  assert.doesNotMatch(config, /host-secret|gateway-secret/);
  // 模型目录走 provider 全池：readModels 收到的是网关作用域，而不是某个账号。
  assert.deepEqual(readModelsCalls[0], ['opencode', 'gateway:opencode']);
  assert.deepEqual((await gateway.modelCatalog.list()).map((entry) => entry.model),
    ['opencode/deepseek-v4.1-flash-free', 'opencode/kimi-k3']);
  // 身份校验只认 harness home，不再比对账号 hash。
  assert.equal((await gateway.accountIdentityValidator({ initializeResult: { codexHome: env.CODEX_HOME } })).verified, true);
  const otherHome = path.join(root, 'other-home');
  fs.mkdirSync(otherHome, { recursive: true });
  await assert.rejects(
    gateway.accountIdentityValidator({ initializeResult: { codexHome: otherHome } }),
    /chat_harness_execution_identity_mismatch/
  );
});

test('gateway-scoped codex sessions use the gateway harness without an account credential', () => {
  const noCredentials = { readAccountCredentialRecord: () => null };
  assert.equal(usesChatGateway({ provider: 'codex', executionAccountRef: 'gateway:codex' }, noCredentials), true);
  assert.equal(usesChatGateway({ provider: 'codex', executionAccountRef: 'acct_11111111111111111111' }, noCredentials), false);
  assert.equal(usesChatGateway({ provider: 'opencode', executionAccountRef: 'gateway:opencode' }, noCredentials), true);
});

