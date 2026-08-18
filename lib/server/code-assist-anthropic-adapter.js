'use strict';

const crypto = require('node:crypto');
const { normalizeToolSchemaForCodeAssist } = require('./code-assist-tool-schema');
const { fetchWithTimeout, __private: httpUtilsPrivate } = require('./http-utils');
const {
  CODE_ASSIST_SKIP_THOUGHT_SIGNATURE,
  applyCodeAssistGenerationConfigStrategy,
  isClaudeFamilyModel: isClaudeModel,
  listCodeAssistGenerationConfigCapabilityRules,
  listCodeAssistUnsupportedGenerationConfigKeys,
  resolveCodeAssistAdaptiveThinkingConfig,
  resolveCodeAssistProviderStrategy
} = require('./code-assist-provider-strategy');
const {
  toPlainText,
  normalizeCanonicalUsage
} = require('./protocol-canonical');
const { resolveAnthropicStopReason } = require('./protocol-finish-reason');
const {
  createRequiredToolLookup,
  formatInvalidToolCallText,
  getFunctionCallArgsDiagnostic,
  hasOwnProperty,
  parseFunctionCallInput,
  parseJsonObject,
  readRequiredToolInputs
} = require('../protocol/tool-call-validation');
const {
  createToolSchemaLookup,
  evaluateFunctionCallInput
} = require('../protocol/tool-call-normalization');
const {
  createAnthropicOrphanToolResultTextPart,
  sanitizeAnthropicToolHistoryWithStats
} = require('../protocol/anthropic-tool-history');
const {
  mapAnthropicToolChoiceToGemini
} = require('../protocol/gemini-tools');
const { normalizeModelVersionSeparators } = require('./model-id');
const {
  appendToolProtocolDiagnostic
} = require('./tool-protocol-diagnostics');

const {
  resolveProviderBaseUrl,
  buildGeminiCodeAssistMethodUrl,
  createGeminiCodeAssistHeaders,
  fetchGeminiCodeAssistProject,
  resolveCodeAssistDefaultModel,
  resolveCodeAssistRequestModel,
  buildGeminiCodeAssistSessionState,
  buildDefaultGeminiCodeAssistGenerationConfig,
  shouldEnableGeminiCodeAssistCredits,
  appendGeminiCodeAssistDiagnostic,
  parseSseJsonStream,
  extractGeminiCandidates,
  extractGeminiUsageMetadata,
  extractGeminiModelVersion
} = httpUtilsPrivate;

const { G1_CREDIT_TYPE, CODE_ASSIST_TOOL_NAME_SANITIZER, ANTHROPIC_TOOL_USE_ID_SANITIZER, ANTHROPIC_TOOL_USE_ID_CODEC_PREFIX, ANTHROPIC_TOOL_USE_ID_CODEC_PATTERN, AGY_CLAUDE_INTERLEAVED_THINKING_HINT, CLAUDE_GOAL_EVALUATOR_PREFIX, CLAUDE_GOAL_EVALUATOR_JSON_HINT, CLAUDE_GOAL_EVALUATOR_FALLBACK_REASON, CLAUDE_TO_AGY_ADAPTER, AGY_TO_CLAUDE_ADAPTER, sanitizeCodeAssistToolName, makeUniqueCodeAssistToolName, createToolNameCodec, readObject, readAnthropicToolDescriptor, sanitizeAnthropicToolUseId, isSafeAnthropicToolUseId, encodeBase64Url, decodeBase64Url, encodeAnthropicToolUseId, decodeAnthropicToolUseId, createFallbackToolUseId, createAnthropicToolUseIdCodec, containsClaudeGoalEvaluatorPrompt, isClaudeStopHookJsonResponsePolicy, extractBalancedJsonObjectText, normalizeClaudeStopHookJsonObject, repairClaudeStopHookJsonResponseText, normalizeAnthropicContentList, decodeCodeAssistThoughtSignature, encodeCodeAssistThoughtSignature, parseToolInput, mapGeminiFinishReasonToAnthropic, stringifyFunctionCallArgs, appendToolProtocolInputDiagnostic, joinToolContextText, readThoughtSignature, extractUsage, applyClaudeStopHookJsonResponsePolicyToMessage } = require('./code-assist-anthropic-adapter-utils');
const { readAnthropicTextPart, normalizeAnthropicSystem, isClaudeThinkingModel, hasAnthropicThinkingEnabled, isAgyCodeAssistProvider, normalizeAnthropicCodeAssistModelId, shouldInjectAgyClaudeInterleavedThinkingHint, appendAgyClaudeInterleavedThinkingHint, readAnthropicContentText, readLatestAnthropicUserText, hasAnthropicTools, resolveClaudeStopHookJsonResponsePolicy, collectAnthropicToolUseIds, normalizeAnthropicImagePart, normalizeToolResultValue, createOrphanToolResultTextPart, takePendingToolCallRef, createFunctionResponsePart, collectPendingToolCallRefs, removeUnconsumedPendingFunctionCalls, createToolCallRef, createFunctionCallPart, createNormalizedMessageState, normalizeAnthropicMessageParts, reorderModelParts, hasCodeAssistFunctionCallPart, removeTrailingUnansweredCodeAssistFunctionCallTurn, normalizeAnthropicMessagesForCodeAssist } = require('./code-assist-anthropic-adapter-normalize');
const { createToolNameSet, normalizeAnthropicToolsForCodeAssist, resolveAnthropicToolDeclarationSchemaKey, normalizeAnthropicToolChoiceForCodeAssist, filterToolConfigAllowedNames, readToolConfigMode, shouldUseValidatedClaudeToolMode, readAnthropicToolModeOverride, applyToolModeOverride, applyCodeAssistToolConfigStrategy, summarizeToolConfig, readAnthropicThinkingEffort, applyAnthropicThinkingConfig, applyAnthropicGenerationConfig, summarizeAnthropicToolHistory, summarizeThinkingConfig, summarizeAnthropicRequest } = require('./code-assist-anthropic-adapter-tools');
const { normalizeProviderProtocolRoute, normalizeProtocolAdapterPath, createCodeAssistAgentRequestId, resolveCodeAssistCreditFields, buildCodeAssistAnthropicInnerRequest, buildCodeAssistAnthropicPayload, buildCodeAssistAnthropicHeaderOptions, summarizeCodeAssistHeaders, fetchCodeAssistAnthropicUpstream, shouldForceStreamForBufferedAnthropic, createToolProtocolDiagnosticContext } = require('./code-assist-anthropic-adapter-request');
const { appendToolProtocolRejectedDiagnostic, isCompleteJsonObjectText, appendCodeAssistStreamDiagnostic, flushCodeAssistStreamDiagnostics, readStreamFunctionCallArgs, ensureCodeAssistStreamToolState, shouldApplyStreamResponsePolicy, appendCodeAssistStreamTextEvent, appendPendingToolContextText, takePendingToolContextText, suppressStreamResponsePolicyPart, appendStreamResponsePolicyFinalText, countOpenStreamToolCalls, findOpenStreamToolCall, createStreamToolCallKey, appendStreamToolCallDelta, resolveAppendOnlyArgumentDelta, appendStreamToolCallArgs, appendInvalidStreamToolCallDiagnostic, startStreamToolCall, closeStreamToolCall, closeOpenStreamToolCalls, ensureStreamToolCall, appendCodeAssistStreamFunctionCallEvents, finalizeCodeAssistStreamState, summarizeCodeAssistFunctionCalls, summarizeCodeAssistFunctionCallArgumentDiagnostics, summarizeCodeAssistFunctionCallValidationDiagnostics, appendCodeAssistResponseDiagnostic, anthropicMessageToCanonicalEvents, createCodeAssistAnthropicStreamState, streamCodeAssistAnthropicCanonicalEvents, flushCanonicalTextContent, parseToolCallInputText, collectCodeAssistAnthropicMessage, codeAssistStreamPieceToCanonicalEvents } = require('./code-assist-anthropic-adapter-stream');
const { renderCodeAssistAnthropicMessage, logCodeAssist400Diagnostic } = require('./code-assist-anthropic-adapter-render');
async function buildCodeAssistAnthropicGenerateContext(options, account, requestJson, timeoutMs = 8000) {
  const project = await fetchGeminiCodeAssistProject(options, account, timeoutMs);
  if (!project) throw new Error('gemini_code_assist_project_unavailable');

  const provider = String(account && account.provider || options && options.provider || '').trim().toLowerCase();
  const routeProtocol = normalizeProviderProtocolRoute(options && options.providerProtocolRoute);
  const providerStrategy = resolveCodeAssistProviderStrategy(provider);
  const toolNameCodec = createToolNameCodec(requestJson && requestJson.tools);
  const responsePolicy = resolveClaudeStopHookJsonResponsePolicy(requestJson || {});
  const originalModel = toPlainText(requestJson && requestJson.model).trim()
    || await resolveCodeAssistDefaultModel(options || {}, account, timeoutMs);
  const responseModel = toPlainText(options && options.responseModel).trim() || originalModel;
  const reservedClientToolUseIds = collectAnthropicToolUseIds(requestJson && requestJson.messages);
  const modelResolution = await resolveCodeAssistRequestModel(
    options || {},
    account,
    originalModel,
    timeoutMs
  );
  const model = normalizeAnthropicCodeAssistModelId(modelResolution.wireModel || originalModel);
  const publicModel = normalizeAnthropicCodeAssistModelId(modelResolution.publicModel || model);
  const schemaKey = resolveAnthropicToolDeclarationSchemaKey(providerStrategy);
  const omittedToolNames = [];
  const excludedToolNames = isClaudeModel(model)
    ? providerStrategy && providerStrategy.anthropicExcludedToolNames
    : [];
  const functionDeclarations = normalizeAnthropicToolsForCodeAssist(
    requestJson && requestJson.tools,
    schemaKey,
    toolNameCodec,
    { excludedToolNames, omittedToolNames, flattenSchemaUnions: isClaudeModel(model) }
  );
  const systemText = appendAgyClaudeInterleavedThinkingHint(
    normalizeAnthropicSystem(requestJson && requestJson.system),
    requestJson || {},
    provider,
    originalModel,
    functionDeclarations.length
  );
  const normalized = normalizeAnthropicMessagesForCodeAssist(
    requestJson && requestJson.messages,
    systemText,
    providerStrategy,
    toolNameCodec,
    { dropTrailingUnansweredFunctionCalls: true }
  );
  const generationConfig = applyCodeAssistGenerationConfigStrategy(
    applyAnthropicGenerationConfig(
      buildDefaultGeminiCodeAssistGenerationConfig(model),
      requestJson || {},
      {
        disableThinkingConfig: normalized.droppedUnsignedThinkingCount > 0,
        providerStrategy
      }
    ),
    providerStrategy,
    { model, originalModel }
  );
  const omittedGenerationConfigKeys = listCodeAssistUnsupportedGenerationConfigKeys(
    providerStrategy,
    { model, originalModel }
  );
  const generationConfigCapabilityRules = listCodeAssistGenerationConfigCapabilityRules(
    providerStrategy,
    { model, originalModel }
  );
  const rawToolConfig = functionDeclarations.length > 0
    ? filterToolConfigAllowedNames(
      normalizeAnthropicToolChoiceForCodeAssist(requestJson && requestJson.tool_choice, toolNameCodec),
      functionDeclarations.map((item) => item.name)
    )
    : undefined;
  const toolConfig = functionDeclarations.length > 0
    ? applyCodeAssistToolConfigStrategy(rawToolConfig, providerStrategy, originalModel)
    : undefined;
  const sessionState = buildGeminiCodeAssistSessionState(options || {}, account, requestJson || {});
  const creditDecision = shouldEnableGeminiCodeAssistCredits(model, account, options || {});
  const request = buildCodeAssistAnthropicInnerRequest(
    normalized,
    generationConfig,
    functionDeclarations,
    toolConfig,
    sessionState,
    providerStrategy
  );
  const creditFields = resolveCodeAssistCreditFields(providerStrategy, creditDecision);
  const payload = buildCodeAssistAnthropicPayload(providerStrategy, model, project, request, sessionState, creditFields);
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
    forceStreamForBuffered: shouldForceStreamForBufferedAnthropic(providerStrategy, model, originalModel, options || {}),
    publicModel,
    responseModel,
    wireModel: model,
    clientProtocol: routeProtocol.clientProtocol || 'anthropic_messages',
    sourceClientProtocol: toPlainText(
      options && options.sourceClientProtocol
      || routeProtocol.clientProtocol
      || 'anthropic_messages'
    ).trim(),
    protocolAdapterPath: normalizeProtocolAdapterPath(options && options.protocolAdapterPath),
    ...(options && options.providerProtocolPlan ? { providerProtocolPlan: options.providerProtocolPlan } : {}),
    requestProtocol: `${routeProtocol.clientProtocol || 'anthropic_messages'}_direct`,
    upstreamProtocol: routeProtocol.upstreamProtocol || 'gemini_code_assist_generate_content',
    requestAdapter: routeProtocol.requestAdapter || CLAUDE_TO_AGY_ADAPTER,
    responseAdapter: routeProtocol.responseAdapter || AGY_TO_CLAUDE_ADAPTER,
    ...(omittedGenerationConfigKeys.length > 0 ? { omittedGenerationConfigKeys } : {}),
    ...(generationConfigCapabilityRules.length > 0 ? { generationConfigCapabilityRules } : {}),
    ...(responsePolicy ? { responsePolicy: { kind: responsePolicy.kind, output: responsePolicy.output } } : {}),
    requestSummary: summarizeAnthropicRequest(
      requestJson || {},
      normalized,
      functionDeclarations,
      schemaKey,
      toolNameCodec,
      generationConfig,
      { omittedGenerationConfigKeys, omittedToolNames, toolConfig }
    )
  };
  const toolProtocolDiagnosticContext = createToolProtocolDiagnosticContext(options || {}, account, diagnostic);
  return { model, originalModel, responseModel, project, payload, diagnostic, providerStrategy, toolNameCodec, functionDeclarations, schemaKey, reservedClientToolUseIds, responsePolicy, toolProtocolDiagnosticContext };
}

async function fetchCodeAssistAnthropicMessage(options, account, requestJson, timeoutMs = 8000) {
  const context = await buildCodeAssistAnthropicGenerateContext(
    options,
    account,
    requestJson,
    timeoutMs
  );
  const { model, originalModel, responseModel, project, payload, diagnostic, providerStrategy, toolNameCodec, functionDeclarations, schemaKey, reservedClientToolUseIds, responsePolicy } = context;
  const baseUrl = resolveProviderBaseUrl(options, account);
  const forceStreamForBuffered = shouldForceStreamForBufferedAnthropic(providerStrategy, model, originalModel, options || {});
  const method = forceStreamForBuffered ? 'streamGenerateContent' : 'generateContent';
  const url = forceStreamForBuffered
    ? `${buildGeminiCodeAssistMethodUrl(baseUrl, method)}?alt=sse`
    : buildGeminiCodeAssistMethodUrl(baseUrl, method);
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistAnthropicHeaderOptions(providerStrategy, project, model, originalModel)
  );
  const headerSummary = summarizeCodeAssistHeaders(headers);
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method,
    forceStreamForBuffered,
    ...headerSummary
  });
  const { res, retriedWithoutProjectHeader } = await fetchCodeAssistAnthropicUpstream(
    url,
    headers,
    payload,
    timeoutMs,
    options || {}
  );
  if (retriedWithoutProjectHeader) {
    appendGeminiCodeAssistDiagnostic(options || {}, {
      projectHeader: false,
      projectHeaderRetry: true,
      projectHeaderRetryReason: 'http_403'
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400) logCodeAssist400Diagnostic(payload, model, text, originalModel);
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }
  if (forceStreamForBuffered) {
    return collectCodeAssistAnthropicMessage(
      streamCodeAssistAnthropicCanonicalEvents(res, context, options || {}),
      responseModel,
      responsePolicy
    );
  }
  const json = await res.json().catch(() => ({}));
  appendCodeAssistResponseDiagnostic(options || {}, extractGeminiCandidates(json), functionDeclarations, schemaKey);
  return renderCodeAssistAnthropicMessage(json, responseModel, toolNameCodec, {
    requiredByName: createRequiredToolLookup(functionDeclarations, schemaKey),
    schemaByName: createToolSchemaLookup(functionDeclarations, schemaKey),
    reservedClientToolUseIds,
    responsePolicy,
    toolProtocolDiagnosticContext: context.toolProtocolDiagnosticContext
  });
}

async function fetchCodeAssistAnthropicMessageStream(options, account, requestJson, timeoutMs = 8000) {
  const context = await buildCodeAssistAnthropicGenerateContext(
    options,
    account,
    requestJson,
    timeoutMs
  );
  const { model, originalModel, project, payload, diagnostic, providerStrategy } = context;
  const baseUrl = resolveProviderBaseUrl(options, account);
  const url = `${buildGeminiCodeAssistMethodUrl(baseUrl, 'streamGenerateContent')}?alt=sse`;
  const headers = createGeminiCodeAssistHeaders(
    account.accessToken,
    model,
    buildCodeAssistAnthropicHeaderOptions(providerStrategy, project, model, originalModel)
  );
  const headerSummary = summarizeCodeAssistHeaders(headers);
  appendGeminiCodeAssistDiagnostic(options || {}, {
    ...diagnostic,
    upstreamUrl: url,
    userAgent: headers['user-agent'],
    method: 'streamGenerateContent',
    ...headerSummary
  });
  const { res, retriedWithoutProjectHeader } = await fetchCodeAssistAnthropicUpstream(
    url,
    headers,
    payload,
    timeoutMs,
    options || {}
  );
  if (retriedWithoutProjectHeader) {
    appendGeminiCodeAssistDiagnostic(options || {}, {
      projectHeader: false,
      projectHeaderRetry: true,
      projectHeaderRetryReason: 'http_403'
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 400) logCodeAssist400Diagnostic(payload, model, text, originalModel);
    const err = new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    err.code = `HTTP_${res.status}`;
    throw err;
  }

  return streamCodeAssistAnthropicCanonicalEvents(res, context, options || {});
}

module.exports = {
  fetchCodeAssistAnthropicMessage,
  fetchCodeAssistAnthropicMessageStream,
  anthropicMessageToCanonicalEvents,
  __private: {
    buildCodeAssistAnthropicGenerateContext,
    normalizeAnthropicMessagesForCodeAssist,
    normalizeAnthropicToolsForCodeAssist,
    removeTrailingUnansweredCodeAssistFunctionCallTurn,
    renderCodeAssistAnthropicMessage,
    codeAssistStreamPieceToCanonicalEvents,
    summarizeCodeAssistFunctionCalls,
    summarizeCodeAssistFunctionCallArgumentDiagnostics,
    sanitizeCodeAssistToolName,
    sanitizeAnthropicToolUseId,
    decodeAnthropicToolUseId,
    createAnthropicToolUseIdCodec,
    collectAnthropicToolUseIds,
    createToolNameCodec,
    resolveClaudeStopHookJsonResponsePolicy,
    repairClaudeStopHookJsonResponseText,
    decodeCodeAssistThoughtSignature,
    encodeCodeAssistThoughtSignature,
    finalizeCodeAssistStreamState
  }
};
