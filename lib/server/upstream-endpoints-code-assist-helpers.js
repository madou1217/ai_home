'use strict';

const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { isUnrecoverableTokenRefreshFailure } = require('./token-refresh-result');
const { createTokenRefreshUnavailablePolicy } = require('./upstream-endpoints-failure');

/**
 * Shared helper set for the Code Assist (AGY) transports.
 *
 * The inline attempt body used to duplicate these four helpers per transport.
 * They are consolidated here so every code-assist transport observes the same
 * diagnostic accumulation, retry logging and auth-recovery semantics.
 *
 * Mutable attempt state (streamTransport/lastError/finalStatusCode) is read
 * and written through ctx.attemptMutable, so the attempt handler sees the same
 * values it syncs in/out around each attempt. The gemini code-assist
 * diagnostic accumulator is returned as a mutable holder (`diagnostic.value`)
 * so the transport can sync it to attemptMutable.geminiCodeAssistDiagnostic on
 * every exit path (including the escape path where this helper set itself
 * throws into the outer attempt catch).
 *
 * ctx fields consumed:
 *   codeAssistProvider, geminiRequestOptions, options, appendProxyRequestLog,
 *   requestMeta, routeKey, provider, account, control, diagnosticMaxAttempts,
 *   requestJson, streamRequested, upstreamUrl, requestStartedAt, cooldownMs,
 *   refreshCodeAssistAfterAuthFailure, recordAccountFailure, requestedAccountRef,
 *   attemptMutable
 */
function createCodeAssistHelpers(ctx) {
  const {
    codeAssistProvider,
    geminiRequestOptions,
    options,
    appendProxyRequestLog,
    requestMeta,
    routeKey,
    provider,
    account,
    control,
    diagnosticMaxAttempts,
    requestJson,
    streamRequested,
    upstreamUrl,
    requestStartedAt,
    cooldownMs,
    refreshCodeAssistAfterAuthFailure,
    recordAccountFailure,
    requestedAccountRef,
    attemptMutable
  } = ctx;

  const diagnostic = { value: null };

  const accountGeminiRequestOptions = codeAssistProvider
    ? {
        ...geminiRequestOptions,
        appendGeminiCodeAssistDiagnostic: (diag) => {
          if (!diag || typeof diag !== 'object') return;
          const previousStreamToolDiagnostics = Array.isArray(
            diagnostic.value && diagnostic.value.streamToolDiagnostics
          )
            ? diagnostic.value.streamToolDiagnostics
            : [];
          const nextStreamToolDiagnostics = Array.isArray(diag.streamToolDiagnostics)
            ? [...previousStreamToolDiagnostics, ...diag.streamToolDiagnostics].slice(-20)
            : previousStreamToolDiagnostics;
          diagnostic.value = {
            ...(diagnostic.value || {}),
            ...diag,
            ...(nextStreamToolDiagnostics.length > 0 ? { streamToolDiagnostics: nextStreamToolDiagnostics } : {})
          };
        }
      }
    : geminiRequestOptions;

  const geminiDiagnosticLogFields = () => diagnostic.value ? {
    geminiCodeAssistSessionId: diagnostic.value.sessionId,
    geminiCodeAssistUserPromptId: diagnostic.value.userPromptId,
    geminiCodeAssistRequestId: diagnostic.value.requestId,
    geminiCodeAssistRequestType: diagnostic.value.requestType,
    geminiCodeAssistRequestEnvelope: diagnostic.value.requestEnvelope,
    geminiCodeAssistSessionSource: diagnostic.value.sessionSource,
    geminiCodeAssistSessionReused: diagnostic.value.sessionReused,
    geminiCodeAssistExternalSessionKeyHash: diagnostic.value.externalSessionKeyHash,
    geminiCodeAssistCreditsEnabled: diagnostic.value.creditsEnabled,
    geminiCodeAssistCreditBalance: diagnostic.value.creditBalance,
    geminiCodeAssistCreditDecisionReason: diagnostic.value.creditDecisionReason,
    geminiCodeAssistCreditTypesIncluded: diagnostic.value.creditTypesIncluded,
    geminiCodeAssistCreditTypesField: diagnostic.value.creditTypesField,
    geminiCodeAssistCreditTypesForced: diagnostic.value.creditTypesForced,
    geminiCodeAssistPublicModel: diagnostic.value.publicModel,
    geminiCodeAssistWireModel: diagnostic.value.wireModel,
    geminiCodeAssistUpstreamUrl: diagnostic.value.upstreamUrl,
    geminiCodeAssistMethod: diagnostic.value.method,
    geminiCodeAssistUserAgent: diagnostic.value.userAgent,
    geminiCodeAssistClientName: diagnostic.value.clientName,
    geminiCodeAssistClientVersion: diagnostic.value.clientVersion,
    geminiCodeAssistProjectHeader: diagnostic.value.projectHeader,
    geminiCodeAssistProjectHeaderRetry: diagnostic.value.projectHeaderRetry,
    geminiCodeAssistProjectHeaderRetryReason: diagnostic.value.projectHeaderRetryReason,
    geminiCodeAssistAnthropicBetaHeader: diagnostic.value.anthropicBetaHeader,
    geminiCodeAssistForceStreamForBuffered: diagnostic.value.forceStreamForBuffered,
    geminiCodeAssistClientProtocol: diagnostic.value.clientProtocol,
    geminiCodeAssistSourceClientProtocol: diagnostic.value.sourceClientProtocol,
    geminiCodeAssistRequestProtocol: diagnostic.value.requestProtocol,
    geminiCodeAssistUpstreamProtocol: diagnostic.value.upstreamProtocol,
    geminiCodeAssistRequestAdapter: diagnostic.value.requestAdapter,
    geminiCodeAssistResponseAdapter: diagnostic.value.responseAdapter,
    geminiCodeAssistProtocolAdapterPath: diagnostic.value.protocolAdapterPath,
    geminiCodeAssistProviderProtocolPlan: diagnostic.value.providerProtocolPlan,
    geminiCodeAssistResponsePolicy: diagnostic.value.responsePolicy,
    geminiCodeAssistRequestSummary: diagnostic.value.requestSummary,
    geminiCodeAssistResponseToolCalls: diagnostic.value.responseToolCalls,
    geminiCodeAssistResponseFinishReasons: diagnostic.value.responseFinishReasons,
    geminiCodeAssistStreamToolDiagnostics: diagnostic.value.streamToolDiagnostics
  } : {};

  const logRetryFailure = (policy, data = {}) => {
    appendUpstreamFailureDiagnosticLog({
      options,
      appendProxyRequestLog,
      requestId: requestMeta && requestMeta.requestId,
      route: routeKey,
      provider,
      account,
      attempt: control.attempt + 1,
      maxAttempts: diagnosticMaxAttempts(),
      requestedModel: String(requestJson && requestJson.model || '').trim(),
      effectiveModel: String(requestJson && requestJson.model || '').trim(),
      streamRequested,
      streamTransport: attemptMutable.streamTransport,
      upstreamUrl,
      durationMs: Date.now() - requestStartedAt,
      geminiCodeAssist: diagnostic.value || undefined,
      policy,
      ...data
    });
  };

  const handleCodeAssistAuthFailure = async (error) => {
    const recovery = await refreshCodeAssistAfterAuthFailure(error, account);
    if (!recovery) return null;
    if (recovery.retrySameAccount) return { action: 'retry_same' };
    if (isUnrecoverableTokenRefreshFailure(recovery.refreshResult)) return null;

    const policy = createTokenRefreshUnavailablePolicy(
      provider,
      recovery.refreshResult,
      cooldownMs
    );
    recordAccountFailure(account, policy);
    logRetryFailure(policy, {
      status: 503,
      upstreamStatus: 401,
      upstreamError: error
    });
    attemptMutable.lastError = policy.detail;
    attemptMutable.finalStatusCode = 503;
    control.setLastError(attemptMutable.lastError);
    return { action: requestedAccountRef ? 'break' : 'retry_next' };
  };

  return {
    diagnostic,
    accountGeminiRequestOptions,
    geminiDiagnosticLogFields,
    logRetryFailure,
    handleCodeAssistAuthFailure
  };
}

module.exports = { createCodeAssistHelpers };