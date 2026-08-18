'use strict';

const { isLoopbackUrl } = require('./http-utils');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { scheduleAgyUsageRefreshAfterFailure } = require('./agy-usage-snapshot');
const { MIN_RETRY_ATTEMPT_BUDGET_MS } = require('./request-pool-retry-policy');
const {
  resolveProviderUpstream,
  resolveProviderPath,
  isAnthropicCompatibleBaseUrl,
  isOpenAIChatCompletionsPath,
} = require('./upstream-endpoints-path');
const { sanitizeAccessToken } = require('./upstream-endpoints-headers');
const {
  isGlobalNetworkFailure,
  withNetworkHint
} = require('./upstream-endpoints-failure');
const { runTransportChain } = require('./upstream-endpoints-transport-chain');
const { openCodeGoTransport } = require('./upstream-endpoints-transport-opencode-go');
const { codeAssistAnthropicTransport } = require('./upstream-endpoints-transport-code-assist-anthropic');
const { codeAssistGeminiTransport } = require('./upstream-endpoints-transport-code-assist-gemini');
const { generalPassthroughTransport } = require('./upstream-endpoints-transport-general');

/**
 * Creates the onAttempt handler for handleUpstreamPassthrough's
 * runWithAccountAttempts orchestration. All request-scoped dependencies flow
 * in through `shared`; mutable attempt state (streamTransport/lastError/
 * finalStatusCode/transientPoolRetry*) lives on shared.attemptMutable so the
 * caller observes the same values after each attempt and between rounds.
 *
 * The handler keeps behavior identical to the original inline onAttempt:
 * every transport branch is attempted in order until one returns a terminal
 * action, failures classify through upstream-failure-policy, and the mutable
 * state is synced back to attemptMutable on every exit.
 */
function createUpstreamAttemptHandler(shared) {
  const {
    options,
    state,
    req,
    res,
    method,
    bodyBuffer,
    requestJson,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestMeta,
    deps,
    provider,
    refreshProviderAccessToken,
    streamRequested,
    guardedBodyBuffer,
    requestedModel,
    requestedAccountRef,
    recordAccountSuccess,
    recordAccountFailure,
    upstreamFailureRecorder,
    refreshCodeAssistAfterAuthFailure,
    codeAssistProvider,
    geminiRequestOptions,
    modelPoolSelection,
    shouldCoverCodeAssistPool,
    diagnosticMaxAttempts,
    requestBudgetMs,
    fetchWithTimeout,
    pushMetricError,
    writeJson,
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    fetchGeminiCodeAssistGenerateContent,
    fetchGeminiCodeAssistGenerateContentStream,
    fetchCodeAssistAnthropicMessage,
    fetchCodeAssistAnthropicMessageStream,
    fetchOpenCodeChatCompletionDep,
    fetchOpenCodeChatCompletionStreamDep,
    markProxyAccountFailure,
    recordModelUsage,
    appendProxyRequestLog,
    forcedRefreshRetryUsed,
    attemptMutable
  } = shared;

  // Mutable attempt state at factory scope: attemptBody closes over these
  // bindings across all retry rounds; the handler re-syncs them from
  // attemptMutable each call (prepareRetryRound flips transientPoolRetry*
  // between rounds) and writes them back on exit.
  let streamTransport = attemptMutable.streamTransport;
  let lastError = attemptMutable.lastError;
  let finalStatusCode = attemptMutable.finalStatusCode;
  let transientPoolRetryUsed = attemptMutable.transientPoolRetryUsed;
  let transientPoolRetryDeadlineAt = attemptMutable.transientPoolRetryDeadlineAt;

  const attemptBody = async (account, control) => {
      let retryAttemptBudgetMs = 0;
      if (transientPoolRetryUsed) {
        retryAttemptBudgetMs = transientPoolRetryDeadlineAt - Date.now();
        if (retryAttemptBudgetMs < MIN_RETRY_ATTEMPT_BUDGET_MS) {
          lastError = 'transient_pool_retry_budget_exhausted';
          control.setLastError(lastError);
          return { action: 'break' };
        }
      }
      const attemptUpstreamTimeoutMs = transientPoolRetryUsed
        ? Math.floor(Math.min(
            Number(options.upstreamTimeoutMs) || requestBudgetMs,
            retryAttemptBudgetMs
          ))
        : options.upstreamTimeoutMs;
      const transportCtx = {
        options,
        state,
        res,
        requestJson,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestMeta,
        deps,
        provider,
        streamRequested,
        recordAccountSuccess,
        recordAccountFailure,
        diagnosticMaxAttempts,
        fetchWithTimeout,
        fetchOpenCodeChatCompletionDep,
        fetchOpenCodeChatCompletionStreamDep,
        recordModelUsage,
        appendProxyRequestLog,
        control,
        account,
        attemptUpstreamTimeoutMs,
        attemptMutable
      };
      const transportAction = await runTransportChain(transportCtx, [openCodeGoTransport]);
      if (transportAction) {
        streamTransport = attemptMutable.streamTransport;
        lastError = attemptMutable.lastError;
        finalStatusCode = attemptMutable.finalStatusCode;
        return transportAction;
      }
      const upstreamBase = resolveProviderUpstream(options, provider, account);
      if (!upstreamBase) {
        lastError = `missing_upstream_for_provider_${provider}`;
        control.setLastError(lastError);
        return { action: 'break' };
      }
      if (isLoopbackUrl(upstreamBase, options.port)) {
        lastError = 'infinite_loop_detected';
        control.setLastError(lastError);
        return { action: 'break' };
      }
      const upstreamPath = resolveProviderPath(provider, req.url || '', upstreamBase);
      const upstreamUrl = `${upstreamBase}${upstreamPath}`;
      let geminiCodeAssistDiagnostic = null;
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
          streamTransport,
          upstreamUrl,
          durationMs: Date.now() - requestStartedAt,
          geminiCodeAssist: geminiCodeAssistDiagnostic || undefined,
          policy,
          ...data
        });
      };
      if (
        provider === 'claude'
        && isAnthropicCompatibleBaseUrl(upstreamBase)
        && isOpenAIChatCompletionsPath(upstreamPath)
      ) {
        lastError = 'configured_claude_base_url_uses_anthropic_compatible_endpoint_but_current_request_is_openai_chat_completions';
        control.setLastError(lastError);
        writeJson(res, 400, {
          ok: false,
          error: 'invalid_request',
          detail: '当前 claude 账号配置的 base URL 是 Anthropic 兼容端点（如 DashScope /apps/anthropic），但 /v0/webui/chat API 代理当前发送的是 OpenAI /chat/completions 协议。该组合暂不兼容；需要改走 Anthropic /v1/messages 适配，或改用 OpenAI 兼容 base URL。'
        });
        return { action: 'return' };
      }
      const canRefreshAccount = typeof refreshProviderAccessToken === 'function'
        && !isApiCredentialAccount(account);
      if (canRefreshAccount) {
        try {
          await refreshProviderAccessToken(account, {
            force: false,
            timeoutMs: attemptUpstreamTimeoutMs,
            proxyUrl: options.proxyUrl,
            noProxy: options.noProxy
          }, {
            fetchWithTimeout
          });
        } catch (_error) {}
      }
      const accessToken = sanitizeAccessToken(account.accessToken);
      if (!accessToken) {
        // If a refresh_token exists the daemon will recover this account soon — skip
        // without marking a failure so the cooldown counter doesn't accumulate.
        if (!sanitizeAccessToken(account.refreshToken)) {
          markProxyAccountFailure(account, 'invalid_access_token', cooldownMs, options.failureThreshold);
        }
        lastError = `invalid_access_token_account_${account.accountRef}`;
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }
      try {
        const codeAssistTransportCtx = {
          options,
          state,
          res,
          requestJson,
          routeKey,
          requestStartedAt,
          cooldownMs,
          requestMeta,
          deps,
          provider,
          streamRequested,
          recordAccountSuccess,
          recordAccountFailure,
          upstreamFailureRecorder,
          codeAssistProvider,
          geminiRequestOptions,
          shouldCoverCodeAssistPool,
          diagnosticMaxAttempts,
          fetchWithTimeout,
          writeJson,
          fetchCodeAssistAnthropicMessage,
          fetchCodeAssistAnthropicMessageStream,
          fetchGeminiCodeAssistGenerateContent,
          fetchGeminiCodeAssistGenerateContentStream,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          refreshCodeAssistAfterAuthFailure,
          requestedAccountRef,
          recordModelUsage,
          appendProxyRequestLog,
          control,
          account,
          attemptUpstreamTimeoutMs,
          upstreamUrl,
          req,
          method,
          attemptMutable,
          accessToken,
          upstreamPath,
          guardedBodyBuffer,
          canRefreshAccount,
          refreshProviderAccessToken,
          forcedRefreshRetryUsed,
          modelPoolSelection,
          pushMetricError
        };
        try {
          const codeAssistAction = await runTransportChain(codeAssistTransportCtx, [codeAssistAnthropicTransport, codeAssistGeminiTransport, generalPassthroughTransport]);
          if (codeAssistAction) return codeAssistAction;
        } finally {
          streamTransport = attemptMutable.streamTransport;
          lastError = attemptMutable.lastError;
          finalStatusCode = attemptMutable.finalStatusCode;
          geminiCodeAssistDiagnostic = attemptMutable.geminiCodeAssistDiagnostic;
        }

    } catch (e) {
      const policy = classifyUpstreamFailure({
        provider,
        error: e,
        defaultCooldownMs: cooldownMs
      });
      if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
      recordAccountFailure(account, policy);
      scheduleAgyUsageRefreshAfterFailure({
        provider,
        account,
        policy,
        options,
        fs: deps.fs,
        fetchWithTimeout
      });
      logRetryFailure(policy, {
        status: policy.clientStatusCode || 502,
        upstreamError: e
      });
      lastError = policy.detail;
      finalStatusCode = policy.clientStatusCode || 502;
      // A transport exception is still a real upstream attempt. The optional
      // auth-refresh budget can leave no selectable sibling after this retry,
      // so preserve the timeout/network verdict before the orchestrator reports
      // `no_account`; otherwise a concrete 504 is rewritten as a false 503.
      upstreamFailureRecorder.record({
        statusCode: finalStatusCode,
        account,
        streamRequested,
        passthrough: false,
        error: 'upstream_failed',
        detail: lastError
      });
      if (isGlobalNetworkFailure(e)) {
        lastError = withNetworkHint(policy.detail, resolveProviderUpstream(options, provider, account));
        control.setLastError(lastError);
        return { action: 'break' };
      }
      control.setLastError(lastError);
      return { action: 'retry_next' };
    }

  };

  return async (account, control) => {
    streamTransport = attemptMutable.streamTransport;
    lastError = attemptMutable.lastError;
    finalStatusCode = attemptMutable.finalStatusCode;
    transientPoolRetryUsed = attemptMutable.transientPoolRetryUsed;
    transientPoolRetryDeadlineAt = attemptMutable.transientPoolRetryDeadlineAt;
    try {
      return await attemptBody(account, control);
    } finally {
      attemptMutable.streamTransport = streamTransport;
      attemptMutable.lastError = lastError;
      attemptMutable.finalStatusCode = finalStatusCode;
      attemptMutable.transientPoolRetryUsed = transientPoolRetryUsed;
      attemptMutable.transientPoolRetryDeadlineAt = transientPoolRetryDeadlineAt;
    }
  };
}

module.exports = {
  createUpstreamAttemptHandler
};
