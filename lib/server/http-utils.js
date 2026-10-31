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
const { registerProbedModelLimits } = require('./probed-model-limits');
const { fetchCodexModelsForAccount } = require('./codex-model-client');
const { discoverNativeCliModels } = require('./native-cli-model-discovery');
const { fetchGenericModelsProbe } = require('./model-discovery/generic-models-probe');
const { registerBuiltinModelDiscoveryHandlers } = require('./model-discovery/http-handlers');
const { discoverProviderModelsViaStrategies, summarizeModelStrategyAttempts } = require('./model-discovery');
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
const { KNOWN_CLINE_MODELS } = require('./cline-models');
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
  const requestedReasoningEffort = String(requestJson && requestJson.reasoning_effort || '').trim().toLowerCase();
  const requestedThinking = requestJson && requestJson.thinking && typeof requestJson.thinking === 'object'
    ? requestJson.thinking
    : null;
  const disableThinking = Boolean(
    requestedThinking
    && String(requestedThinking.type || '').trim().toLowerCase() === 'disabled'
  );
  let generationConfig = buildDefaultGeminiCodeAssistGenerationConfig(model, providerStrategy, {
    effort: requestedReasoningEffort,
    disableThinking
  });
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
    Object.defineProperty(err, 'upstreamBody', { value: text, enumerable: false });
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
    Object.defineProperty(err, 'upstreamBody', { value: text, enumerable: false });
    throw err;
  }
  // Code Assist can return gzip image payloads without content-encoding.
  // Reuse the shared decoder so a valid image is not silently lost to JSON parsing.
  const json = await readResponseJson(res).catch(() => ({}));
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
  // 分段计时写进 attempt 诊断：首字慢时能直接看出是「推理前置」「上游响应头」还是
  // 「上游首个内容块」慢，不用再临时打补丁复现。
  const stageStartedAt = Date.now();
  const { model, originalModel, project, payload, diagnostic } = await buildGeminiCodeAssistGenerateContext(options, account, requestJson, timeoutMs);
  const preflightMs = Date.now() - stageStartedAt;
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
  const fetchStartedAt = Date.now();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, timeoutMs, {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
  const upstreamHeadersMs = Date.now() - fetchStartedAt;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    Object.defineProperty(err, 'upstreamBody', { value: text, enumerable: false });
    throw err;
  }

  return (async function* streamGeminiChunks() {
    const rawStream = parseSseJsonStream(res.body);
    let firstChunkRecorded = false;
    for await (const envelope of rawStream) {
      const candidates = extractGeminiCandidates(envelope);
      if (!Array.isArray(candidates) || candidates.length === 0) continue;
      if (!firstChunkRecorded) {
        firstChunkRecorded = true;
        appendGeminiCodeAssistDiagnostic(options || {}, {
          stageTimings: {
            preflightMs,
            upstreamHeadersMs,
            upstreamFirstChunkMs: Date.now() - fetchStartedAt
          }
        });
      }
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
    Object.defineProperty(err, 'upstreamBody', { value: text, enumerable: false });
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

// CLI 兜底失败时的错误选择：策略链 attempts 里存在「非跳过类」失败时，那个失败才是模型
// 发现失败的直接证据；CLI 兜底自己的错误（例如没装 CLI 的 native_cli_model_discovery_cli_not_found）
// 只是「兜底不可用」，拿它替换真实原因会让界面永远指向错误的方向。
// 2026-10-16 kiro 事故：显式刷新误用后台 2.5s 探测预算 → 冷启动 ListAvailableModels 超时被吞 →
// 界面只显示 native_cli_model_discovery_cli_not_found，看起来像「模型清单只有装 CLI 一条路」。
function describeNativeCliFallbackFailure(httpModels, cliError) {
  const failures = (Array.isArray(httpModels && httpModels.attempts) ? httpModels.attempts : [])
    .filter((attempt) => {
      const error = String((attempt && attempt.error) || '');
      if (!error) return false;
      // 链内正常噪声：transport / account-mode 过滤；以及「CLI 规格声明在链里、执行在链外」
      // 的占位工厂（kiro/qoder/qodercn 的 discover: () => null 会记录 strategy_factory_invalid）。
      if (error.startsWith('skipped_transport:') || error.startsWith('not_applicable_mode:')) return false;
      if (error === 'strategy_factory_invalid') return false;
      return true;
    });
  if (failures.length < 1) return cliError;
  const failure = new Error(summarizeModelStrategyAttempts(failures));
  failure.code = String(failures[0].error || 'model_discovery_failed');
  failure.strategyId = String(failures[0].strategyId || '');
  failure.chainAttempts = failures;
  failure.cliFallbackError = String((cliError && cliError.message) || cliError || '');
  return failure;
}

/**
 * 给探测结果打上「目录是否完整」的标记（非枚举属性，数组的所有既有用法不变）。
 *
 * 为什么要带出去：目录残缺时，「模型不在列表里」只说明这条腿没探到，**不说明账号
 * 不支持它**。下游（model-pool-narrowing 的强证据排除、倒排索引的目录完整性判定）
 * 必须能区分这两种情况，否则一次超时就会把一个健康账号判成「不支持该模型」。
 */
function markCatalogCompleteness(models, incomplete, reason) {
  if (!Array.isArray(models)) return models;
  try {
    Object.defineProperty(models, 'catalogIncomplete', {
      value: incomplete === true,
      enumerable: false,
      configurable: true
    });
    if (incomplete === true) {
      Object.defineProperty(models, 'catalogIncompleteReason', {
        value: String(reason || ''),
        enumerable: false,
        configurable: true
      });
    }
  } catch (_error) { /* 冻结数组：放弃标记，按完整目录处理 */ }
  return models;
}

async function fetchModelsForAccount(options, account, timeoutMs = 8000) {
  const provider = String(account && account.provider || 'codex').trim().toLowerCase();
  // cline 的对外目录是静态规范清单（见 cline-models.js 的模块说明）：上游
  // GET /api/v1/models 返回 462 条 OpenRouter 伙伴命名空间 ID，原样透出会被
  // inferProviderFromModel 判给 claude 等 provider，造成跨 provider 误路由。
  // 短路放在出网解析之前：这份目录不依赖任何网络探测，因此也不该因为出网配置
  // 异常而报错，更不该回退到别家端点去探测。
  // **不依赖出网的策略先跑**（transport: local，例如 cline 的静态规范清单）：这类目录不该因为
  // 出网配置异常而报错，也不该回退到别家端点探测。provider 名不再出现在这里。
  const localModels = await discoverProviderModelsViaStrategies(provider, account, {
    deps: { provider },
    transports: ['local'],
    timeoutMs
  });
  if (localModels.models && localModels.models.length > 0) return localModels.models;
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
  // **策略链：HTTP 优先，CLI 兜底**（provider 描述符声明 models.strategies）。
  // 以前这里只有本地 CLI 一条路：没装 CLI 就抛 native_cli_model_discovery_cli_not_found，
  // 账号直接「无可用模型」；现在纯 HTTP 策略能列就先列。
  const httpModels = await discoverProviderModelsViaStrategies(provider, account, {
    deps: {
      provider,
      requestOptions,
      fs: inputOptions.fs,
      aiHomeDir: inputOptions.aiHomeDir,
      path: inputOptions.path,
      // 注意签名：fetchWithTimeout(url, init, timeoutMs, egressOptions) —— 参数顺序写错会让 HTTP 策略
      // 静默失败并掉回 CLI（实测就是 native_cli_model_discovery_cli_not_found 的来源）。
      // 原始签名 (url, init, timeoutMs, egressOptions)：供各 provider 客户端内部使用；
      fetchWithTimeout,
      // 已绑定本账号 egress 的版本：供通用探测 handler 使用（参数顺序写错会静默掉回 CLI）。
      egressFetchWithTimeout: (url, init, timeout) => fetchWithTimeout(url, init, timeout, requestOptions),
      accountEgressDeps: inputOptions.accountEgressDeps || {},
      resolveAccountEgressRequestOptions: resolveRequestOptions
    },
    transports: ['http', 'cli'],
    timeoutMs
  });
  if (httpModels.models && httpModels.models.length > 0) {
    // 策略可以标记这份目录**不完整**（例如 opencode 的 Go/Zen 两条腿只回来一条）。
    // 返回值必须是数组（大量调用方按数组消费），所以残缺信息挂在数组的**非枚举**属性上：
    // 序列化/展开/断言都不受影响，只有模型发现层显式读取它。
    // 语义见 model-discovery/index.js 与 model-pool-narrowing.js：残缺目录不能当否定证据。
    return markCatalogCompleteness(httpModels.models, httpModels.incomplete, httpModels.incompleteReason);
  }
  // CLI 兜底（本地 CLI 执行器）：失败时它的错误不得掩盖策略链里 HTTP 策略的真实失败
  // （见 describeNativeCliFallbackFailure）。options.discoverNativeCliModels 仅为测试注入点。
  const runNativeCliDiscovery = typeof inputOptions.discoverNativeCliModels === 'function'
    ? inputOptions.discoverNativeCliModels
    : discoverNativeCliModels;
  let nativeCliModels = null;
  try {
    nativeCliModels = await runNativeCliDiscovery(requestOptions, account, timeoutMs);
  } catch (cliError) {
    throw describeNativeCliFallbackFailure(httpModels, cliError);
  }
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
  // 通用探测搬到 lib/server/model-discovery/generic-models-probe.js（handler 化）；
  // 这里保留为「未声明策略 / 策略全失败」的兜底，行为与历史一致。
  return fetchGenericModelsProbe({ requestOptions, provider, account, timeoutMs, fetchWithTimeout });
}

// kimi /models 探测响应(OAuth coding 端点与 moonshot 平台)除了 id 还携带
// display_name / context_length / supports_image_in 等真实能力字段。写成与
// gemini codeAssistModelDescriptors 相同的 account.modelDescriptors 契约,
// WebUI labels、能力索引等既有消费方自动生效;modalities 同时注册为
// model-modality-index 的探测覆盖,解决 models.dev 快照同步前的元数据空窗。
registerBuiltinModelDiscoveryHandlers();

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
    describeNativeCliFallbackFailure,
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
