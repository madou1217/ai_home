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
  assert.match(firstConfig, /X-Account-Ref = "acct_one"/);
  assert.doesNotMatch(firstConfig, /acct_two|host-secret|other-secret|gateway-secret/);
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
    .runtimeFingerprint, 'native-v1:chat-model-metadata-stream-v3');
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
