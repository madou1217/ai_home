'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stripAccountScopedEnv } = require('../../cli/services/ai-cli/provider-runtime-env');
const { readAccountCredentialRecord } = require('../account-credential-store');
const { createModelsDevReader } = require('../models-dev-metadata');
const { writeModelCatalogAtomically } = require('../codex-cli-startup-policy');
const { projectHarnessModelMetadata } = require('./chat-harness-model-metadata');
const { ChatRuntimeError } = require('./contracts');

function usesChatGateway(session, options) {
  if (session.provider !== 'codex') return true;
  const readCredential = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const credential = readCredential(options.fs || fs, options.credentialAiHomeDir || options.aiHomeDir, session.executionAccountRef);
  const native = credential && credential.nativeAuth || {};
  const auth = native.auth || native;
  return Boolean(credential && credential.env && credential.env.OPENAI_API_KEY || auth.OPENAI_API_KEY);
}

// Harness 与推理 provider 分离；凭据仍由网关按唯一 accountRef 选择。
function createChatGatewayOptions(session, options) {
  const gateway = options.chatGateway;
  if (!gateway || typeof gateway.readModels !== 'function') {
    throw new ChatRuntimeError('chat_harness_gateway_unavailable', 503);
  }
  const fsImpl = options.fs || fs;
  const readCredential = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const credential = readCredential(fsImpl, options.credentialAiHomeDir || options.aiHomeDir, session.executionAccountRef);
  if (!credential || credential.provider !== session.provider) {
    throw new ChatRuntimeError('chat_session_account_mismatch', 409);
  }
  const home = path.join(options.aiHomeDir, 'run', 'chat-harness', session.executionAccountRef);
  const codexHome = path.join(home, '.codex');
  const modelCatalog = new ChatGatewayModelCatalog(session, gateway);
  const baseUrl = `http://127.0.0.1:${gateway.port}/v1`;
  const config = [
    'model_provider = "aih_server"',
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    'project_doc_max_bytes = 0',
    '[model_providers.aih_server]',
    'name = "AIH Chat"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'requires_openai_auth = false',
    // 限制嵌套 HTTP/stream 重试，避免本机网关故障触发数十次静默请求。
    'request_max_retries = 1',
    'stream_max_retries = 1',
    '[model_providers.aih_server.http_headers]',
    `X-Account-Ref = ${JSON.stringify(session.executionAccountRef)}`,
    `X-Provider = ${JSON.stringify(session.provider)}`,
    ''
  ].join('\n');
  return {
    // v4：模型目录投影修复（后缀变体解析 + 未知模型 fail-open 放行 image），
    // 需刷新常驻 harness 的 model-catalog，否则旧目录继续禁用图像输入。
    runtimeConfigRevision: 'chat-model-metadata-stream-v4',
    getProfileDir: () => home,
    buildProviderEnvImpl: async () => {
      const models = await modelCatalog.list();
      fsImpl.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      const catalogDir = path.join(codexHome, 'model-catalogs');
      fsImpl.mkdirSync(catalogDir, { recursive: true, mode: 0o700 });
      const catalogPath = writeModelCatalogAtomically(fsImpl, catalogDir, JSON.stringify({
        models: models.map((model) => projectHarnessModelMetadata(model,
          modelCatalog.metadata.resolveEntry({ id: model.model, provider: session.provider }) || {}))
      }));
      fsImpl.writeFileSync(path.join(codexHome, 'config.toml'),
        `model_catalog_json = ${JSON.stringify(catalogPath)}\n${config}`, { mode: 0o600 });
      const env = stripAccountScopedEnv(options.env || process.env);
      return {
        ...env,
        HOME: home, USERPROFILE: home, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome,
        OPENAI_API_KEY: gateway.clientKey || 'aih-local', OPENAI_BASE_URL: baseUrl,
        AIH_CODEX_GATEWAY_ACCOUNT_REF: session.executionAccountRef
      };
    },
    accountIdentityValidator: async ({ initializeResult, accountResult }) => {
      if (fsImpl.realpathSync(String(initializeResult && initializeResult.codexHome || '')) !== fsImpl.realpathSync(codexHome)
        || accountResult && accountResult.requiresOpenaiAuth === true) {
        throw new ChatRuntimeError('chat_harness_execution_identity_mismatch', 409);
      }
      return { verified: true, kind: 'api-key', assurance: 'execution-credential',
        runtimeHomeHash: crypto.createHash('sha256').update(fsImpl.realpathSync(codexHome)).digest('hex'),
        executionAccountHash: crypto.createHash('sha256').update(session.executionAccountRef).digest('hex') };
    },
    modelCatalog
  };
}

class ChatGatewayModelCatalog {
  constructor(session, gateway) {
    this.session = session;
    this.gateway = gateway;
    this.metadata = createModelsDevReader();
  }

  async prewarm() { await this.list(); }

  async list() {
    const ids = await this.gateway.readModels(this.session.provider, this.session.executionAccountRef);
    const models = [...new Set(ids)].map((model) => {
      const metadata = this.metadata.resolveEntry({ id: model, provider: this.session.provider });
      const options = metadata && metadata.capabilities && metadata.capabilities.reasoningOptions || [];
      const efforts = options.filter((entry) => entry.type === 'effort').flatMap((entry) => entry.values || []);
      return { model, displayName: model, isDefault: false, supportedReasoningEfforts: efforts,
        defaultReasoningEffort: efforts.includes('medium') ? 'medium' : efforts[0] || '',
        contextWindow: metadata && metadata.limits && (metadata.limits.input || metadata.limits.context) };
    });
    if (!models.length) throw new ChatRuntimeError('chat_harness_account_models_unavailable', 422);
    return models;
  }

  async resolveTurnSettings(request) {
    const models = await this.list();
    const model = request.model ? models.find((entry) => entry.model === request.model) : models[0];
    if (!model) throw new ChatRuntimeError('chat_harness_account_model_unavailable', 422);
    if (request.reasoningEffort && !model.supportedReasoningEfforts.includes(request.reasoningEffort)) {
      throw new ChatRuntimeError('chat_harness_reasoning_effort_unsupported', 422);
    }
    return { model: model.model, reasoningEffort: request.reasoningEffort || model.defaultReasoningEffort,
      ...(model.contextWindow ? { threadConfig: { model_context_window: model.contextWindow } } : {}) };
  }
}

module.exports = { createChatGatewayOptions, ChatGatewayModelCatalog, usesChatGateway };
