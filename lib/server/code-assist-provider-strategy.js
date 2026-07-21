'use strict';

const {
  applyGenerationConfigCapabilityStrategy,
  listAppliedGenerationConfigCapabilityRules,
  listOmittedGenerationConfigKeys
} = require('./provider-model-capability-registry');

const CODE_ASSIST_SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
const CODE_ASSIST_UPSTREAM_PROTOCOL = 'gemini_code_assist_generate_content';

const GEMINI_CODE_ASSIST_STRATEGY = Object.freeze({
  provider: 'gemini',
  toolDeclarationSchemaKey: 'parameters',
  preserveToolCallId: false,
  addToolCallThoughtSignature: false,
  toolResultResponseKey: 'output',
  validateClaudeToolCalls: false,
  requestEnvelope: 'gemini_cli',
  requestSessionIdField: 'session_id',
  creditTypesField: 'enabled_credit_types',
  forceStreamForBufferedAnthropic: false,
  injectProjectHeader: false,
  clientProfile: Object.freeze({
    name: '',
    userAgent: 'gemini_cli'
  }),
  projectMetadata: Object.freeze({
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
  }),
  anthropicBetaHeader: '',
  adaptiveThinkingConfig: Object.freeze({
    mode: 'level',
    defaultLevel: 'high'
  })
});

const AGY_CODE_ASSIST_STRATEGY = Object.freeze({
  provider: 'agy',
  toolDeclarationSchemaKey: 'parametersJsonSchema',
  anthropicToolDeclarationSchemaKey: 'parameters',
  preserveToolCallId: true,
  addToolCallThoughtSignature: true,
  toolResultResponseKey: 'result',
  validateClaudeToolCalls: false,
  anthropicToolModeOverride: 'AUTO',
  anthropicExcludedToolNames: Object.freeze(['TaskUpdate']),
  requestEnvelope: 'antigravity_agent',
  requestSessionIdField: 'sessionId',
  creditTypesField: 'enabledCreditTypes',
  alwaysSendAgentCreditTypes: true,
  forceStreamForBufferedAnthropic: true,
  injectProjectHeader: false,
  clientProfile: Object.freeze({
    name: 'antigravity',
    userAgent: 'antigravity'
  }),
  projectMetadata: Object.freeze({
    ideType: 'ANTIGRAVITY',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI'
  }),
  anthropicBetaHeader: 'claude-code-20250219',
  adaptiveThinkingConfig: Object.freeze({
    mode: 'budget',
    defaultBudget: -1
  })
});

function buildCodeAssistCapabilityContext(providerStrategy, options = {}) {
  return {
    provider: providerStrategy && providerStrategy.provider,
    protocol: options.upstreamProtocol || CODE_ASSIST_UPSTREAM_PROTOCOL,
    model: options.model,
    originalModel: options.originalModel
  };
}

function listCodeAssistUnsupportedGenerationConfigKeys(providerStrategy, options = {}) {
  return listOmittedGenerationConfigKeys(buildCodeAssistCapabilityContext(providerStrategy, options));
}

function listCodeAssistGenerationConfigCapabilityRules(providerStrategy, options = {}) {
  return listAppliedGenerationConfigCapabilityRules(buildCodeAssistCapabilityContext(providerStrategy, options));
}

function applyCodeAssistGenerationConfigStrategy(generationConfig, providerStrategy, options = {}) {
  return applyGenerationConfigCapabilityStrategy(
    generationConfig,
    buildCodeAssistCapabilityContext(providerStrategy, options)
  );
}

function resolveCodeAssistProviderStrategy(provider) {
  const key = String(provider || '').trim().toLowerCase();
  if (key === 'agy' || key === 'antigravity') return AGY_CODE_ASSIST_STRATEGY;
  return GEMINI_CODE_ASSIST_STRATEGY;
}

function resolveCodeAssistAdaptiveThinkingConfig(providerStrategy, options = {}) {
  const policy = providerStrategy && providerStrategy.adaptiveThinkingConfig;
  if (policy && policy.mode === 'budget') {
    const budget = Number(policy.defaultBudget);
    return {
      includeThoughts: true,
      thinkingBudget: Number.isFinite(budget) ? Math.round(budget) : -1
    };
  }

  const effort = String(options.effort || '').trim().toLowerCase();
  const defaultLevel = String(policy && policy.defaultLevel || 'high').trim().toLowerCase() || 'high';
  return {
    includeThoughts: true,
    thinkingLevel: effort || defaultLevel
  };
}

// 网关向 code-assist(agy/antigravity）注入思考(thinkingBudget:-1 无限 / thinkingLevel:high），
// 而 antigravity gemini 系模型的思考 token 计入 maxOutputTokens。客户端的 max_tokens 只为【答案】
// 预算、并不知道我们额外塞了思考 → 思考把整个预算吃光,只剩思考没有回答（WebUI 表现为只有
// "Thought process" 没有正文）。这里给思考单独预留空间:把 maxOutputTokens 抬到 答案预算 + 思考余量,
// 保证答案至少仍有客户端请求的 max_tokens。不重写 thinkingBudget（避免上游对正预算的兼容性问题）。
const CODE_ASSIST_THINKING_RESERVE_MIN_TOKENS = 8192;
const CODE_ASSIST_THINKING_RESERVE_MAX_TOKENS = 32768;

function isCodeAssistThinkingEnabled(thinkingConfig) {
  if (!thinkingConfig || typeof thinkingConfig !== 'object') return false;
  if (thinkingConfig.includeThoughts === true) return true;
  const budget = Number(thinkingConfig.thinkingBudget);
  if (budget === -1 || budget > 0) return true;
  return String(thinkingConfig.thinkingLevel || '').trim() !== '';
}

function reserveAnswerBudgetForCodeAssistThinking(generationConfig) {
  if (!generationConfig || typeof generationConfig !== 'object') return generationConfig;
  const thinking = generationConfig.thinkingConfig;
  if (!isCodeAssistThinkingEnabled(thinking)) return generationConfig;
  const clientMax = Number(generationConfig.maxOutputTokens);
  if (!Number.isFinite(clientMax) || clientMax <= 0) return generationConfig;
  const budget = Number(thinking.thinkingBudget);
  const reserve = budget > 0
    ? Math.round(budget)
    : Math.min(Math.max(clientMax, CODE_ASSIST_THINKING_RESERVE_MIN_TOKENS), CODE_ASSIST_THINKING_RESERVE_MAX_TOKENS);
  generationConfig.maxOutputTokens = clientMax + reserve;
  return generationConfig;
}

module.exports = {
  CODE_ASSIST_SKIP_THOUGHT_SIGNATURE,
  CODE_ASSIST_UPSTREAM_PROTOCOL,
  applyCodeAssistGenerationConfigStrategy,
  listCodeAssistGenerationConfigCapabilityRules,
  listCodeAssistUnsupportedGenerationConfigKeys,
  reserveAnswerBudgetForCodeAssistThinking,
  resolveCodeAssistAdaptiveThinkingConfig,
  resolveCodeAssistProviderStrategy
};
