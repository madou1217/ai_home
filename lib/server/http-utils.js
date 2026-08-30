'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { normalizeToolSchemaForCodeAssist } = require('./code-assist-tool-schema');
const { resolveOpenAIChatFinishReason } = require('./protocol-finish-reason');
const {
  CODE_ASSIST_SKIP_THOUGHT_SIGNATURE,
  applyCodeAssistGenerationConfigStrategy,
  isClaudeFamilyModel,
  listCodeAssistGenerationConfigCapabilityRules,
  listCodeAssistUnsupportedGenerationConfigKeys,
  reserveAnswerBudgetForCodeAssistThinking,
  resolveCodeAssistAdaptiveThinkingConfig,
  resolveCodeAssistProviderStrategy
} = require('./code-assist-provider-strategy');
const {
  extractCodeAssistModelDescriptors,
  resolveCodeAssistModelDescriptor,
  resolveCodeAssistWireModelId
} = require('./code-assist-model-registry');
const {
  isImageGenerationModel,
  applyImageGenerationGenerationConfig,
  extractInlineImageMarkdown
} = require('./code-assist-image-generation');
const {
  detectAntigravityClientVersion
} = require('./antigravity-version');
const { fetchOpenCodeModels } = require('./opencode-server-client');
const { isClaudeAuthTokenAccount } = require('../account/claude-credential');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
const {
  ZCODE_PLAN_BALANCE_URL,
  ZCODE_OAUTH_MODELS_BASE_URL,
  resolveProviderApiBaseUrl
} = require('../account/provider-api-base-url');
const { buildKimiRequestHeaders } = require('./kimi-request-headers');
const { registerProbedModelModalities } = require('./model-modality-index');
const { fetchCodexModelsForAccount } = require('./codex-model-client');
const { discoverNativeCliModels } = require('./native-cli-model-discovery');
const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('./account-egress-request-options');
const {
  readResponseJson,
  readResponseText,
  sanitizeResponseText
} = require('./response-body');

const { ProxyAgentClass, proxyAgentResolved, undiciInstallAttempted, undiciRequireFn, undiciInstallerFn, proxyDispatcherCache, DEFAULT_GEMINI_OPENAI_BASE_URL, DEFAULT_GEMINI_CODE_ASSIST_BASE_URL, DEFAULT_AGY_CODE_ASSIST_BASE_URL, GEMINI_CODE_ASSIST_AUTH_TYPE, GEMINI_CODE_ASSIST_SESSION_ID_RE, DEFAULT_GEMINI_SESSION_ID_MAP_TTL_MS, DEFAULT_GEMINI_SESSION_ID_MAP_MAX, GEMINI_CODE_ASSIST_G1_CREDIT_TYPE, GEMINI_CODE_ASSIST_MIN_CREDIT_BALANCE, DEFAULT_GEMINI_CODE_ASSIST_CLIENT_VERSION, DEFAULT_AGY_CODE_ASSIST_CLIENT_VERSION, DEFAULT_AGY_CODE_ASSIST_CHROME_VERSION, DEFAULT_AGY_CODE_ASSIST_ELECTRON_VERSION, CODE_ASSIST_CLIENT_SESSION_ID, GEMINI_CODE_ASSIST_QUOTA_PROJECT_PLACEHOLDER, pickFirstNonEmpty, parseNoProxyList, isLoopbackHost, matchesNoProxyRule, shouldBypassProxy, resolveProxyConfig, tryRequireProxyAgent, defaultInstallUndiciPackage, tryInstallUndiciPackage, getProxyDispatcher, getErrorCode, shouldRetryWithoutProxy, parseAuthorizationBearer, readRequestBody, JSON_COMPRESS_MIN_BYTES, writeJson, withTimeout, fetchWithTimeout, toGeminiTextPart, buildChatCompletionPayload, writeSseChatCompletion, setUndiciHooksForTest } = require('./http-utils-utils');
const { isGeminiCodeAssistBaseUrl, isCodeAssistProvider, getCodeAssistBaseUrlOption, getDefaultCodeAssistBaseUrl, shouldUseGeminiCodeAssist, normalizeGeminiBaseUrl, normalizeCodeAssistProviderBaseUrl, resolveProviderBaseUrl, buildGeminiCodeAssistMethodUrl, buildGeminiCodeAssistUserAgent, buildAgyCodeAssistClientVersion, buildAgyCodeAssistPlatformInfo, buildAgyCodeAssistUserAgent, isSafeHeaderValue, setHeaderIfSafe, resolveCodeAssistProviderKey, isAntigravityProviderKey, shouldNormalizeAntigravityGenerateContentEnvelope, buildCodeAssistHeaderOptions, buildCodeAssistInferenceHeaderOptions, buildCodeAssistProjectMetadata, shouldUseAgyCodeAssistClientProfile, createGeminiCodeAssistHeaders, applyGeminiCodeAssistProjectResponse, clearGeminiCodeAssistProjectCache, shouldRetryGeminiCodeAssistProjectWithoutCache, loadGeminiCodeAssistProject, fetchGeminiCodeAssistProject, getCachedCodeAssistModelDescriptors, listCodeAssistDescriptorIds, createCodeAssistModelRequiredError, isCodeAssistPermissionError, shouldUseQuotaCatalogFallback, cacheCodeAssistModelDescriptors, createCodeAssistModelRequestId, fetchGeminiCodeAssistAvailableModelDescriptors, fetchGeminiCodeAssistQuotaModelDescriptors, fetchGeminiCodeAssistModelDescriptors, fetchGeminiCodeAssistModels, resolveCodeAssistDefaultModel, resolveCodeAssistRequestModel, isLoopbackUrl } = require('./http-utils-code-assist');
const { parseJsonObject, parseOpenAIToolArguments, resolveCodeAssistToolStrategy, normalizeOpenAIToolCallsForGeminiParts, normalizeCodeAssistFunctionResponseContent, normalizeOpenAIToolResultForGeminiPart, summarizeToolDeclarations, summarizeGeminiOpenAIMessageNormalization, summarizeGeminiToolCalls, summarizeGeminiToolCallsByCandidate, normalizeOpenAIMessagesForGemini, mapGeminiFinishReason, extractGeminiCandidateText, extractGeminiCandidateThoughtText, stringifyGeminiFunctionArgs, extractGeminiCandidateToolCalls, normalizeOpenAIToolsForGemini, normalizeOpenAIToolChoiceForGemini, extractGeminiCandidates, extractGeminiUsageMetadata, extractGeminiModelVersion, normalizeGeminiGenerateContentEnvelope } = require('./http-utils-normalize');
const { normalizeGeminiExternalSessionKey, isGeminiCodeAssistSessionId, createGeminiCodeAssistSessionId, buildGeminiCodeAssistMessageSessionKey, buildGeminiCodeAssistExternalSessionKey, normalizeGeminiSessionMapEntry, pruneGeminiSessionIdMap, buildGeminiGlobalSessionMapKey, readGeminiSessionMapEntry, writeGeminiSessionMapEntry, findGeminiSessionMapEntry, hashGeminiDiagnosticValue, createGeminiCodeAssistSessionState, buildGeminiCodeAssistSessionState } = require('./http-utils-session');
const { createCodeAssistAgentRequestId, resolveCodeAssistCreditFields, buildCodeAssistGeneratePayload, getGeminiCodeAssistG1CreditBalance, normalizeGeminiCodeAssistOverageStrategy, parseConfiguredModelList, readCodeAssistCreditEligibleModels, readBooleanField, isCodeAssistCreditEligibleModel, shouldEnableGeminiCodeAssistCredits, appendGeminiCodeAssistDiagnostic } = require('./http-utils-credits');
const { buildDefaultGeminiCodeAssistGenerationConfig, resolveCodeAssistRequestSessionIdField, createNativeGeminiRequestSummary, readNativeGeminiFunctionCall, readNativeGeminiFunctionResponse, readNativeFunctionCallRef, readNativeFunctionResponseId, cloneNativeGeminiFunctionPart, addNativeGeminiFunctionResponseName, isPlainObject, shouldWrapAgyFunctionResponse, wrapAgyFunctionResponsePart, addNativeGeminiToolCallThoughtSignature, resolveNativeFunctionResponseName, repairNativeGeminiCodeAssistContents, buildNativeGeminiCodeAssistRequest } = require('./http-utils-native');
const { iterateStreamChunks, parseSseJsonStream } = require('./http-utils-sse');
const { createZcodeJwtMissingError, fetchZcodePlanBalanceModels, fetchZcodePaasModels, isZcodeRoutableModelId } = require('./http-utils-zcode');
const { toKimiProbedModelDescriptor, attachKimiProbedModelDescriptors } = require('./http-utils-kimi');
async function buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs) {
  const project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  if (!project) {
    throw new Error('gemini_code_assist_project_unavailable');
  }
  const originalModel = String(requestJson && requestJson.model || '').trim()
    || await resolveCodeAssistDefaultModel(options || {}, account, timeoutMs);
  let model = originalModel;
  let modelResolution = { publicModel: originalModel, wireModel: originalModel, descriptor: null };
  const provider = String(account && account.provider || '').trim().toLowerCase();
  const providerStrategy = resolveCodeAssistProviderStrategy(provider);
  if (isCodeAssistProvider(provider)) {
    modelResolution = await resolveCodeAssistRequestModel(options || {}, account, originalModel, timeoutMs);
    model = modelResolution.wireModel || originalModel;
  }
  const normalized = normalizeOpenAIMessagesForGemini(requestJson && requestJson.messages, {
    providerStrategy
  });
  let generationConfig = buildDefaultGeminiCodeAssistGenerationConfig(model, providerStrategy);
  const sessionState = buildGeminiCodeAssistSessionState(options || {}, account, requestJson || {});
  const creditDecision = shouldEnableGeminiCodeAssistCredits(model, account, options || {});
  const maxTokens = Number(requestJson && requestJson.max_tokens);
  const temperature = Number(requestJson && requestJson.temperature);
  const topP = Number(requestJson && requestJson.top_p);
  const topK = Number(requestJson && requestJson.top_k);
  if (Number.isFinite(maxTokens) && maxTokens > 0) generationConfig.maxOutputTokens = Math.round(maxTokens);
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  if (Number.isFinite(topP)) generationConfig.topP = topP;
  if (Number.isFinite(topK)) generationConfig.topK = topK;
  if (Array.isArray(requestJson && requestJson.stop) && requestJson.stop.length > 0) {
    generationConfig.stopSequences = requestJson.stop.map((x) => String(x || '').trim()).filter(Boolean);
  } else if (typeof (requestJson && requestJson.stop) === 'string') {
    generationConfig.stopSequences = [String(requestJson.stop).trim()].filter(Boolean);
  }
  generationConfig = applyCodeAssistGenerationConfigStrategy(
    generationConfig,
    providerStrategy,
    { model, originalModel }
  );
  // 注入思考后给答案预留预算,避免思考吃光 maxOutputTokens → 只有思考没有回答。
  reserveAnswerBudgetForCodeAssistThinking(generationConfig);
  // 图像生成模型(如 gemini-3.1-flash-image)必须显式开启 IMAGE 响应模态,否则只叙述不画图。
  applyImageGenerationGenerationConfig(generationConfig, originalModel);
  const omittedGenerationConfigKeys = listCodeAssistUnsupportedGenerationConfigKeys(
    providerStrategy,
    { model, originalModel }
  );
  const generationConfigCapabilityRules = listCodeAssistGenerationConfigCapabilityRules(
    providerStrategy,
    { model, originalModel }
  );
  const toolDeclarationSchemaKey = providerStrategy.toolDeclarationSchemaKey;
  const functionDeclarations = normalizeOpenAIToolsForGemini(requestJson && requestJson.tools, {
    schemaKey: toolDeclarationSchemaKey,
    // 与 Anthropic 协议线同理：目标是 Claude 家族时，联合类型要在发出前折叠。
    flattenSchemaUnions: isClaudeFamilyModel(model)
  });
  const toolConfig = functionDeclarations.length > 0
    ? normalizeOpenAIToolChoiceForGemini(requestJson && requestJson.tool_choice)
    : undefined;
  const sessionIdField = resolveCodeAssistRequestSessionIdField(providerStrategy);
  const requestSummary = summarizeGeminiOpenAIMessageNormalization(
    requestJson && requestJson.messages,
    normalized,
    functionDeclarations,
    {
      toolDeclarationSchemaKey,
      generationConfigKeys: Object.keys(generationConfig).sort(),
      omittedGenerationConfigKeys
    }
  );
  const request = {
    contents: normalized.contents,
    systemInstruction: normalized.systemInstruction,
    generationConfig,
    tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
    toolConfig,
    [sessionIdField]: sessionState.sessionId
  };
  const creditFields = resolveCodeAssistCreditFields(providerStrategy, creditDecision);
  const payload = buildCodeAssistGeneratePayload(providerStrategy, model, project, request, sessionState, creditFields);
  const diagnostic = {
    model,
    project,
    requestId: payload.requestId || '',
    requestType: payload.requestType || '',
    requestEnvelope: providerStrategy.requestEnvelope || 'gemini_cli',
    sessionId: sessionState.sessionId,
    userPromptId: sessionState.userPromptId,
    sessionSource: sessionState.source,
    sessionReused: sessionState.reused,
    promptCount: sessionState.promptCount,
    externalSessionKeyHash: sessionState.externalKeyHash,
    creditsEnabled: creditDecision.enabled,
    creditBalance: creditDecision.balance,
    creditDecisionReason: creditDecision.reason,
    creditTypesIncluded: creditFields.values.length > 0,
    creditTypesField: creditFields.field,
    creditTypesForced: creditFields.forced,
    provider,
    publicModel: modelResolution.publicModel,
    wireModel: model,
    requestProtocol: 'openai_chat_normalized',
    upstreamProtocol: 'gemini_code_assist_generate_content',
    ...(omittedGenerationConfigKeys.length > 0 ? { omittedGenerationConfigKeys } : {}),
    ...(generationConfigCapabilityRules.length > 0 ? { generationConfigCapabilityRules } : {}),
    requestSummary
  };
  return {
    model,
    originalModel,
    project,
    payload,
    diagnostic
  };
}

async function buildGeminiCodeAssistNativeGenerateContext(options, account, requestJson, timeoutMs) {
  const project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  if (!project) {
    throw new Error('gemini_code_assist_project_unavailable');
  }
  const source = requestJson && typeof requestJson === 'object' ? requestJson : {};
  const originalModel = String(source.model || '').trim()
    || await resolveCodeAssistDefaultModel(options || {}, account, timeoutMs);
  const provider = String(account && account.provider || '').trim().toLowerCase();
  const modelResolution = isCodeAssistProvider(provider)
    ? await resolveCodeAssistRequestModel(options || {}, account, originalModel, timeoutMs)
    : { publicModel: originalModel, wireModel: originalModel, descriptor: null };
  const model = modelResolution.wireModel || originalModel;
  const providerStrategy = resolveCodeAssistProviderStrategy(provider);
  const sessionState = buildGeminiCodeAssistSessionState(options || {}, account, source);
  const creditDecision = shouldEnableGeminiCodeAssistCredits(model, account, options || {});
  const omittedGenerationConfigKeys = listCodeAssistUnsupportedGenerationConfigKeys(
    providerStrategy,
    { model, originalModel }
  );
  const generationConfigCapabilityRules = listCodeAssistGenerationConfigCapabilityRules(
    providerStrategy,
    { model, originalModel }
  );
  const request = buildNativeGeminiCodeAssistRequest(model, sessionState, source, providerStrategy, { originalModel });
  const requestSummarySource = {
    ...source,
    contents: request.contents,
    __nativeRepairSummary: request.__nativeRepairSummary
  };
  delete request.__nativeRepairSummary;
  const creditFields = resolveCodeAssistCreditFields(providerStrategy, creditDecision);
  const payload = buildCodeAssistGeneratePayload(providerStrategy, model, project, request, sessionState, creditFields);
  const diagnostic = {
    model,
    project,
    requestId: payload.requestId || '',
    requestType: payload.requestType || '',
    requestEnvelope: providerStrategy.requestEnvelope || 'gemini_cli',
    sessionId: sessionState.sessionId,
    userPromptId: sessionState.userPromptId,
    sessionSource: sessionState.source,
    sessionReused: sessionState.reused,
    promptCount: sessionState.promptCount,
    externalSessionKeyHash: sessionState.externalKeyHash,
    creditsEnabled: creditDecision.enabled,
    creditBalance: creditDecision.balance,
    creditDecisionReason: creditDecision.reason,
    creditTypesIncluded: creditFields.values.length > 0,
    creditTypesField: creditFields.field,
    creditTypesForced: creditFields.forced,
    provider,
    publicModel: modelResolution.publicModel,
    wireModel: model,
    requestProtocol: String(options && options.clientProtocol || 'gemini_generate_content').trim() || 'gemini_generate_content',
    upstreamProtocol: 'gemini_code_assist_generate_content',
    ...(omittedGenerationConfigKeys.length > 0 ? { omittedGenerationConfigKeys } : {}),
    ...(generationConfigCapabilityRules.length > 0 ? { generationConfigCapabilityRules } : {}),
    requestSummary: createNativeGeminiRequestSummary(requestSummarySource, request.generationConfig, {
      omittedGenerationConfigKeys
    })
  };
  return {
    model,
    originalModel,
    project,
    payload,
    diagnostic
  };
}

async function fetchGeminiCodeAssistChatCompletion(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs);
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'generateContent');
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistInferenceHeaderOptions(options, account, model, { project })
  );
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'generateContent'
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  const candidates = extractGeminiCandidates(json);
  const first = candidates[0] || {};
  const firstParts = Array.isArray(first && first.content && first.content.parts)
    ? first.content.parts
    : [];
  const text = extractGeminiCandidateText(first);
  const imageMarkdown = isImageGenerationModel(originalModel)
    ? extractInlineImageMarkdown(firstParts)
    : '';
  const combinedContent = [text, imageMarkdown].filter(Boolean).join('\n\n');
  const thoughtText = extractGeminiCandidateThoughtText(first);
  const toolCalls = extractGeminiCandidateToolCalls(first);
  const responseToolCalls = summarizeGeminiToolCalls(toolCalls);
  if (responseToolCalls.length > 0) {
    appendGeminiCodeAssistDiagnostic(options || {}, {
      responseToolCalls,
      responseFinishReasons: [String(first && first.finishReason || '').trim()].filter(Boolean)
    });
  }
  const usageMetadata = extractGeminiUsageMetadata(json);
  const finishReason = resolveOpenAIChatFinishReason(
    mapGeminiFinishReason(first && first.finishReason),
    { hasToolCalls: toolCalls.length > 0 }
  );
  return {
    id: `chatcmpl-${String(json && json.traceId || Date.now())}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: originalModel || extractGeminiModelVersion(json, model),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls.length > 0 ? null : combinedContent,
          ...(thoughtText ? { reasoning_content: thoughtText } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        },
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: Number(usageMetadata.promptTokenCount || 0),
      completion_tokens: Number(usageMetadata.candidatesTokenCount || 0),
      total_tokens: Number(usageMetadata.totalTokenCount || 0)
    }
  };
}

async function fetchGeminiCodeAssistGenerateContent(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistNativeGenerateContext(
    options,
    account,
    requestJson,
    timeoutMs
  );
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = buildGeminiCodeAssistMethodUrl(baseUrl, 'generateContent');
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistInferenceHeaderOptions(options, account, model, { project })
  );
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'generateContent'
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (json && typeof json === 'object' && !json.modelVersion && originalModel) {
    json.modelVersion = originalModel;
  }
  const candidates = extractGeminiCandidates(json);
  const toolCalls = candidates.flatMap((candidate) => extractGeminiCandidateToolCalls(candidate));
  if (toolCalls.length > 0) {
    appendGeminiCodeAssistDiagnostic(options || {}, {
      responseToolCalls: summarizeGeminiToolCalls(toolCalls),
      responseFinishReasons: candidates
        .map((candidate) => String(candidate && candidate.finishReason || '').trim())
        .filter(Boolean)
    });
  }
  return json;
}

async function fetchGeminiCodeAssistChatCompletionStream(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs);
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = `${buildGeminiCodeAssistMethodUrl(baseUrl, 'streamGenerateContent')}?alt=sse`;
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistInferenceHeaderOptions(options, account, model, { project })
  );
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'streamGenerateContent'
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }

  return (async function* streamGeminiChunks() {
    const rawStream = parseSseJsonStream(res.body);
    for await (const envelope of rawStream) {
      const candidates = extractGeminiCandidates(envelope);
      if (!Array.isArray(candidates) || candidates.length === 0) continue;
      const toolCallsByCandidate = candidates.map((candidate) => extractGeminiCandidateToolCalls(candidate));
      const responseToolCalls = summarizeGeminiToolCallsByCandidate(toolCallsByCandidate);
      if (responseToolCalls.length > 0) {
        appendGeminiCodeAssistDiagnostic(options || {}, {
          responseToolCalls,
          responseFinishReasons: candidates
            .map((candidate) => String(candidate && candidate.finishReason || '').trim())
            .filter(Boolean)
        });
      }
      yield {
        model: originalModel || extractGeminiModelVersion(envelope, model),
        candidates,
        toolCallsByCandidate,
        usageMetadata: extractGeminiUsageMetadata(envelope)
      };
    }
  })();
}

async function fetchGeminiCodeAssistGenerateContentStream(options, account, requestJson, timeoutMs = 8000) {
  if (!shouldUseGeminiCodeAssist(options, account)) {
    const err = new Error('gemini_code_assist_not_applicable');
    err.code = 'GEMINI_CODE_ASSIST_NOT_APPLICABLE';
    throw err;
  }
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistNativeGenerateContext(
    options,
    account,
    requestJson,
    timeoutMs
  );
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = `${buildGeminiCodeAssistMethodUrl(baseUrl, 'streamGenerateContent')}?alt=sse`;
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistInferenceHeaderOptions(options, account, model, { project })
  );
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'streamGenerateContent'
  });
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }

  const normalizeAntigravityEnvelope = shouldNormalizeAntigravityGenerateContentEnvelope(options, account, diagnostic);
  return (async function* streamGeminiGenerateContent() {
    for await (const envelope of parseSseJsonStream(res.body)) {
      const piece = normalizeAntigravityEnvelope
        ? normalizeGeminiGenerateContentEnvelope(envelope, originalModel)
        : envelope;
      if (piece && typeof piece === 'object' && !piece.modelVersion && originalModel) {
        piece.modelVersion = originalModel;
      }
      const candidates = extractGeminiCandidates(piece);
      const toolCallsByCandidate = candidates.map((candidate) => extractGeminiCandidateToolCalls(candidate));
      const responseToolCalls = summarizeGeminiToolCallsByCandidate(toolCallsByCandidate);
      if (responseToolCalls.length > 0) {
        appendGeminiCodeAssistDiagnostic(options || {}, {
          responseToolCalls,
          responseFinishReasons: candidates
            .map((candidate) => String(candidate && candidate.finishReason || '').trim())
            .filter(Boolean)
        });
      }
      yield piece;
    }
  })();
}

// zcode OAuth 计划账号的模型目录以桌面端同款接口为准：
// GET ZCODE_PLAN_BALANCE_URL（lib/account/provider-api-base-url.js），
// Authorization: Bearer zcodeJwtToken，
// 从 data.balances[*].capabilities 的 "model:<id>" 提取（回退 show_name），大小写去重。
// 不能用 zai accessToken 探 api.z.ai paas/v4/models：该 token 会过期且 OAuth 计划账号
// 没有 refresh token，过期后实测 401；而 zcodeJwtToken 是长期凭据（app.asar 取证 +
// 2026-08 真机验证：accessToken 已过期的账号 balance 接口仍 200）。

async function fetchModelsForAccount(options, account, timeoutMs = 8000) {
  const provider = String(account && account.provider || 'codex').trim().toLowerCase();
  const inputOptions = options && typeof options === 'object' ? options : {};
  const resolveRequestOptions = typeof inputOptions.resolveAccountEgressRequestOptions === 'function'
    ? inputOptions.resolveAccountEgressRequestOptions
    : resolveAccountEgressRequestOptionsDefault;
  let resolved;
  try {
    resolved = await resolveRequestOptions({
      fs: inputOptions.fs,
      aiHomeDir: inputOptions.aiHomeDir,
      processObj: inputOptions.processObj,
      provider,
      accountRef: account && account.accountRef,
      options: inputOptions,
      deps: inputOptions.accountEgressDeps || {}
    });
  } catch (error) {
    const failure = new Error(`account_egress_unavailable:${String(error?.message || error || 'unknown')}`);
    failure.code = 'account_egress_unavailable';
    throw failure;
  }
  if (!resolved?.ok || !resolved.options) {
    const detail = [
      String(resolved?.error || 'account_egress_unavailable'),
      String(resolved?.egressError || '')
    ].filter(Boolean).join(':');
    const failure = new Error(detail);
    failure.code = 'account_egress_unavailable';
    throw failure;
  }
  const requestOptions = resolved.options;
  const nativeCliModels = await discoverNativeCliModels(requestOptions, account, timeoutMs);
  if (nativeCliModels) return nativeCliModels;
  if (provider === 'opencode') {
    return fetchOpenCodeModels(requestOptions, account, timeoutMs, { fetchWithTimeout });
  }
  if (
    provider === 'zcode'
    && !(account && account.apiKeyMode === true)
    && String(account && account.authType || '').trim().toLowerCase() !== 'api-key'
  ) {
    const planModels = await fetchZcodePlanBalanceModels(requestOptions, account, timeoutMs);
    if (planModels) return planModels;
    // zcodeJwtToken 缺失或失效时不回退 paas 探测：回退凭据 accessToken 必然已过期且无
    // refresh，探测只会把原始 HTTP 401 抛给 WebUI；改为抛出可识别的
    // zcode_jwt_missing_relogin，由 accounts 视图提示「需要重新登录」。
    // 不再 fall through 到通用探测：OAuth 账号的 openaiBaseUrl 是推理端点
    //（…/zcode-plan/anthropic），通用探测会拼出错误的 /models URL。
    throw createZcodeJwtMissingError();
  }
  // claude auth-token 账号是第三方 Anthropic 协议代理(GLM/DeepSeek/JD…)。支持 /v1/models 的代理
  // (如 GLM)可直接探测拿真实模型;不支持的(如 DeepSeek/anthropic 返 404)会抛错被上层捕获、退回
  // 手动注册。此前一律 return [] 导致这些账号在会话里「无可用模型」——现放开走下方通用探测。
  const claudeAuthTokenProxy = provider === 'claude' && isClaudeAuthTokenAccount(account);
  if (
    provider === 'codex'
    && !(account && account.apiKeyMode === true)
    && String(account && account.authType || '').trim().toLowerCase() !== 'api-key'
  ) {
    return fetchCodexModelsForAccount({
      options: requestOptions,
      account,
      fetchWithTimeout,
      timeoutMs
    });
  }
  if (isCodeAssistProvider(provider) && shouldUseGeminiCodeAssist(requestOptions, account)) {
    return fetchGeminiCodeAssistModels(requestOptions, account, timeoutMs);
  }
  const baseUrl = resolveProviderBaseUrl(requestOptions, account);
  const baseUrlHasVersion = /\/v[0-9][^/]*$/i.test(baseUrl);
  // 不同第三方代理的模型列表路径不一致:GLM(base=.../anthropic 不带 /vN)在 <base>/v1/models,
  // DeepSeek(base=https://api.deepseek.com)在 <base>/models。单一硬编码 path 会让其中一家 404
  // →「无可用模型」。策略:先按下方主 path 探,失败(404 等)再回退另一个 path。
  const primaryPath = (claudeAuthTokenProxy && !baseUrlHasVersion)
    ? '/v1/models'
    : ((provider === 'gemini' || provider === 'agy' || provider === 'claude' || baseUrlHasVersion) ? '/models' : '/v1/models');
  const altPath = primaryPath === '/models' ? '/v1/models' : '/models';
  // Anthropic authenticates API keys via x-api-key and OAuth tokens via
  // Authorization: Bearer — never the reverse. The probe must mirror the real
  // request path (upstream-endpoints.js / webui-chat-routes.js both send
  // x-api-key for claude API-key accounts), otherwise a working account fails
  // the probe with a spurious 401 authentication_error.
  const claudeApiKey = provider === 'claude' && isApiCredentialAccount(account);
  const headers = {};
  if (claudeApiKey) {
    headers['x-api-key'] = account.accessToken;
  } else {
    headers.authorization = `${String(account && account.tokenType || 'Bearer').trim() || 'Bearer'} ${account.accessToken}`;
  }
  if (provider === 'kimi' && !isApiCredentialAccount(account)) {
    Object.assign(headers, buildKimiRequestHeaders(account));
  }
  // Anthropic's API rejects requests without anthropic-version; OAuth tokens
  // additionally need the oauth beta header. (OpenAI-compatible providers
  // ignore these extra headers, so it's safe to always send them for claude.)
  if (provider === 'claude') {
    headers['anthropic-version'] = '2023-06-01';
    // oauth-beta 仅真 OAuth 账号需要;auth-token(第三方代理)不是 OAuth,发了可能被代理拒。
    if (!isApiCredentialAccount(account) && !claudeAuthTokenProxy) {
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    }
  }
  const tryFetchModels = async (url) => {
    const res = await fetchWithTimeout(url, { method: 'GET', headers }, timeoutMs, {
      proxyUrl: requestOptions.proxyUrl,
      noProxy: requestOptions.noProxy
    });
    if (!res.ok) {
      const text = await readResponseText(res).catch(() => '');
      const err = new Error(`HTTP ${res.status} ${sanitizeResponseText(text, 160)}`.trim());
      err.status = res.status;
      throw err;
    }
    const json = await readResponseJson(res);
    // 有些第三方代理(如 bigmodel)对【错误路径】返回 HTTP 200 + 错误体
    // {code,msg:"404 NOT_FOUND",success:false}——res.ok 为真但没有 data 数组。必须视为失败
    // 以触发下方另一路径回退,否则会静默返回空列表 → 账号「无可用模型」。
    if (json && json.success === false) {
      throw new Error(String(`${json.code ? json.code + ' ' : ''}${json.msg || 'models_error'}`).trim());
    }
    if (!Array.isArray(json && json.data)) {
      throw new Error('models_response_missing_data');
    }
    if (provider === 'kimi') attachKimiProbedModelDescriptors(account, json.data);
    return json.data
      .map((x) => String((x && x.id) || '').trim())
      .filter(Boolean)
      // zcode API-key 账号直探 bigmodel anthropic /v1/models，返回的 coding 目录含
      // opencode-go/*、cline-free/* 伙伴命名空间（推理端点不认，且网关会把它们路由
      // 到 opencode 造成误计费）——与 OAuth 探测同规则，只留可路由回 zcode 的 ID。
      .filter((id) => provider !== 'zcode' || isZcodeRoutableModelId(id));
  };

  // 候选 URL,按序试、返回第一个拿到 data 数组的:
  //  1) base 相对(GLM:模型在 <base=.../anthropic>/v1/models);
  //  2) host 根(DeepSeek:base=.../anthropic 但模型在 host 根 api.deepseek.com/models,不在 /anthropic 下)。
  // 覆盖"路径不在 base 之下"和"200+错误体"两种坑,不再因单一路径 404/空而「无可用模型」。
  const rel = String(baseUrl || '').replace(/\/+$/, '');
  let origin = '';
  try { origin = new URL(baseUrl).origin; } catch (_error) { origin = ''; }
  const candidates = [];
  const addUrl = (u) => { if (u && !candidates.includes(u)) candidates.push(u); };
  addUrl(`${rel}${primaryPath}`);
  addUrl(`${rel}${altPath}`);
  if (origin && origin !== rel) {
    addUrl(`${origin}/v1/models`);
    addUrl(`${origin}/models`);
  }

  let firstError = null;
  for (const url of candidates) {
    try {
      return await tryFetchModels(url);
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }
  throw firstError || new Error('models_response_missing_data');
}

// kimi /models 探测响应(OAuth coding 端点与 moonshot 平台)除了 id 还携带
// display_name / context_length / supports_image_in 等真实能力字段。写成与
// gemini codeAssistModelDescriptors 相同的 account.modelDescriptors 契约,
// WebUI labels、能力索引等既有消费方自动生效;modalities 同时注册为
// model-modality-index 的探测覆盖,解决 models.dev 快照同步前的元数据空窗。
module.exports = {
  parseAuthorizationBearer,
  readRequestBody,
  writeJson,
  withTimeout,
  fetchWithTimeout,
  fetchModelsForAccount,
  fetchGeminiCodeAssistChatCompletion,
  fetchGeminiCodeAssistChatCompletionStream,
  fetchGeminiCodeAssistGenerateContent,
  fetchGeminiCodeAssistGenerateContentStream,
  buildChatCompletionPayload,
  writeSseChatCompletion,
  isLoopbackUrl,
  __private: {
    DEFAULT_AGY_CODE_ASSIST_BASE_URL,
    resolveProxyConfig,
    shouldBypassProxy,
    isCodeAssistProvider,
    shouldUseGeminiCodeAssist,
    fetchGeminiCodeAssistAvailableModelDescriptors,
    fetchGeminiCodeAssistModelDescriptors,
    fetchGeminiCodeAssistQuotaModelDescriptors,
    resolveCodeAssistDefaultModel,
    resolveCodeAssistRequestModel,
    resolveProviderBaseUrl,
    buildGeminiCodeAssistMethodUrl,
    buildAgyCodeAssistClientVersion,
    buildAgyCodeAssistUserAgent,
    createGeminiCodeAssistHeaders,
    buildCodeAssistHeaderOptions,
    buildCodeAssistInferenceHeaderOptions,
    resolveCodeAssistProviderKey,
    fetchGeminiCodeAssistProject,
    buildGeminiCodeAssistSessionState,
    buildDefaultGeminiCodeAssistGenerationConfig,
    buildGeminiCodeAssistNativeGenerateContext,
    repairNativeGeminiCodeAssistContents,
    getGeminiCodeAssistG1CreditBalance,
    shouldEnableGeminiCodeAssistCredits,
    appendGeminiCodeAssistDiagnostic,
    parseJsonObject,
    parseSseJsonStream,
    extractGeminiCandidates,
    extractGeminiUsageMetadata,
    extractGeminiModelVersion,
    getProxyDispatcher,
    setUndiciHooksForTest
  }
};
