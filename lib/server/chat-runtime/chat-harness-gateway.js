'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stripAccountScopedEnv } = require('../../cli/services/ai-cli/provider-runtime-env');
const { readAccountCredentialRecord } = require('../account-credential-store');
const { createModelsDevReader } = require('../models-dev-metadata');
const { resolveProbedContextLength } = require('../probed-model-limits');
const { writeModelCatalogAtomically } = require('../codex-cli-startup-policy');
const { projectHarnessModelMetadata } = require('./chat-harness-model-metadata');
const { ChatRuntimeError } = require('./contracts');
const { isGatewayRuntimeScope } = require('../../account/runtime-target');

function usesChatGateway(session, options) {
  // 网关作用域（aih-server）没有账号凭据可查，但它必须走网关 harness —— 判断要在读凭据之前。
  if (isGatewayRuntimeScope(session && session.executionAccountRef)) return true;
  if (session.provider !== 'codex') return true;
  const readCredential = options.readAccountCredentialRecord || readAccountCredentialRecord;
  const credential = readCredential(options.fs || fs, options.credentialAiHomeDir || options.aiHomeDir, session.executionAccountRef);
  const native = credential && credential.nativeAuth || {};
  const auth = native.auth || native;
  return Boolean(credential && credential.env && credential.env.OPENAI_API_KEY || auth.OPENAI_API_KEY);
}

// 网关作用域的 harness home：必须按 provider 分开，否则不同 provider 的网关档 config.toml 会互踩。
// 作用域字符串可能带 provider 后缀（gateway:opencode），冒号在 Windows 路径里非法，统一压成 '-'。
function harnessScopeDir(session) {
  const scope = String(session && session.executionAccountRef || '').trim();
  return isGatewayRuntimeScope(scope)
    ? `gateway-${String(session.provider || '').trim()}`
    : scope.replace(/[^a-zA-Z0-9._-]/g, '-');
}

// Harness 与推理 provider 分离；凭据仍由网关按唯一 accountRef 选择。
function createChatGatewayOptions(session, options) {
  const gateway = options.chatGateway;
  if (!gateway || typeof gateway.readModels !== 'function') {
    throw new ChatRuntimeError('chat_harness_gateway_unavailable', 503);
  }
  const gatewayScope = isGatewayRuntimeScope(session.executionAccountRef);
  const fsImpl = options.fs || fs;
  const readCredential = options.readAccountCredentialRecord || readAccountCredentialRecord;
  // 网关作用域没有账号凭据：身份来自网关 client key，账号由网关在该 provider 池内挑。
  const credential = gatewayScope
    ? null
    : readCredential(fsImpl, options.credentialAiHomeDir || options.aiHomeDir, session.executionAccountRef);
  if (!gatewayScope && (!credential || credential.provider !== session.provider)) {
    throw new ChatRuntimeError('chat_session_account_mismatch', 409);
  }
  const home = path.join(options.aiHomeDir, 'run', 'chat-harness', harnessScopeDir(session));
  const codexHome = path.join(home, '.codex');
  const modelCatalog = new ChatGatewayModelCatalog(session, gateway);
  const baseUrl = `http://127.0.0.1:${gateway.port}/v1`;
  // 稳定会话头：同一 WebUI 会话的每次 harness 请求都带同一个 id，网关据此做会话亲和、
  // qoder warm CLI 复用与 usage 会话归属。没有会话 id 时不写头，保持旧行为。
  const sessionId = String((session && session.sessionId) || '').trim();
  const sessionHeaders = sessionId ? [`X-Session-Id = ${JSON.stringify(sessionId)}`] : [];
  const config = [
    'model_provider = "aih_server"',
    'cli_auth_credentials_store = "file"',
    'check_for_update_on_startup = false',
    'project_doc_max_bytes = 0',
    // 聊天引擎的模型请求必须只包含对话本身。codex 默认会把宿主资产注入**每一次**模型请求：
    // <skills_instructions> 技能清单、# AGENTS.md instructions 全局指令、<environment_context>
    // 环境块、<permissions instructions> 权限块。对聊天模型这些都是噪声——2026-10-16 探针实测
    // 模型会把全局工程规范当成用户任务回复（"已按工程师专业版样式工作…"），答非所问。
    // AGENTS.md / skills 的**文件级**排除见 codex-app-server-endpoint 的
    // CHAT_HARNESS_SHARED_ENTRY_EXCLUSIONS（共享条目链接不落这两个文件），这里关闭其余注入面。
    'skills.include_instructions = false',
    'include_environment_context = false',
    'include_permissions_instructions = false',
    'include_apps_instructions = false',
    'include_collaboration_mode_instructions = false',
    '[model_providers.aih_server]',
    'name = "AIH Chat"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'env_key = "OPENAI_API_KEY"',
    'requires_openai_auth = false',
    // 限制嵌套 HTTP/stream 重试，避免本机网关故障触发数十次静默请求。
    'request_max_retries = 1',
    'stream_max_retries = 1',
    // 账号作用域：钉住账号与 provider（身份/记账可追溯），并带上稳定的会话 id。
    // 网关作用域（aih-server）：**不写账号/provider 钉选头** —— 账号由网关在该模型可用池里挑
    // （池化选号 + 别名回落 + (账号,模型) 熔断），provider 由网关按模型 id 解析，因此会话内可以
    // 跨 provider 换模型（目录见 ChatGatewayModelCatalog 的全局池分支）；会话 id 仍要写，否则
    // 同一会话在网关侧没有亲和键，warm CLI 与 usage 会话归属都失效。
    ...(gatewayScope ? (sessionHeaders.length > 0 ? [
      '[model_providers.aih_server.http_headers]',
      ...sessionHeaders
    ] : []) : [
      '[model_providers.aih_server.http_headers]',
      `X-Account-Ref = ${JSON.stringify(session.executionAccountRef)}`,
      `X-Provider = ${JSON.stringify(session.provider)}`,
      ...sessionHeaders
    ]),
    ''
  ].join('\n');
  return {
    // v4：模型目录投影修复（后缀变体解析 + 未知模型 fail-open 放行 image），
    // 需刷新常驻 harness 的 model-catalog，否则旧目录继续禁用图像输入。
    // v5：models.dev 不认识的自建模型改用上游 /models 探测到的上下文窗口，
    // 旧目录缺 context_window 会让 skills 预算被压到最小、自动压缩不触发。
    // v6：网关作用域不再写 X-Account-Ref / X-Provider（账号由网关池化、provider 按模型 id 解析），
    // 目录改成全局池 —— 必须 bump 才能让常驻 harness 丢掉旧的钉选头与窄目录。
    // v7：聊天请求注入面清零（skills 清单 / 全局 AGENTS.md / 环境块 / 权限块 / apps /
    // collaboration 全部关闭，且共享链接不再落 AGENTS.md 与 skills）—— 旧 pane 必须重建，
    // 否则旧配置继续把宿主工程规范喂给聊天模型。
    // v8：harness 请求带 X-Session-Id（WebUI 会话 id）—— 网关据此做会话亲和、qoder warm CLI
    // 复用与 usage 会话归属；旧 pane 不带这个头，必须重建。
    runtimeConfigRevision: 'chat-model-metadata-stream-v8',
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
        ...(gatewayScope ? {} : { AIH_CODEX_GATEWAY_ACCOUNT_REF: session.executionAccountRef })
      };
    },
    accountIdentityValidator: async ({ initializeResult, accountResult }) => {
      if (fsImpl.realpathSync(String(initializeResult && initializeResult.codexHome || '')) !== fsImpl.realpathSync(codexHome)
        || accountResult && accountResult.requiresOpenaiAuth === true) {
        throw new ChatRuntimeError('chat_harness_execution_identity_mismatch', 409);
      }
      return { verified: true, kind: 'api-key', assurance: 'execution-credential',
        runtimeHomeHash: crypto.createHash('sha256').update(fsImpl.realpathSync(codexHome)).digest('hex'),
        executionAccountHash: crypto.createHash('sha256').update(
          gatewayScope ? `gateway:${session.provider}` : session.executionAccountRef
        ).digest('hex') };
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
      const catalogWindow = metadata && metadata.limits && (metadata.limits.input || metadata.limits.context);
      return { model, displayName: model, isDefault: false, supportedReasoningEfforts: efforts,
        defaultReasoningEffort: efforts.includes('medium') ? 'medium' : efforts[0] || '',
        contextWindow: catalogWindow || resolveProbedContextLength(this.session.executionAccountRef, model) || undefined };
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
