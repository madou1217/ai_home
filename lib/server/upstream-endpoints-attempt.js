'use strict';

const { isLoopbackUrl } = require('./http-utils');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { attemptAnnotations } = require('./attempt-annotations');
const { scheduleAgyUsageRefreshAfterFailure } = require('./agy-usage-snapshot');
const { MIN_RETRY_ATTEMPT_BUDGET_MS } = require('./request-pool-retry-policy');
const {
  resolveProviderUpstream,
  resolveProviderPath,
  isAnthropicCompatibleBaseUrl,
  isOpenAIChatCompletionsPath,
} = require('./upstream-endpoints-path');
const { sanitizeAccessToken } = require('./upstream-endpoints-headers');
const { resolveRelayCredential } = require('./upstream-credential-resolver');
const {
  isGlobalNetworkFailure,
  withNetworkHint
} = require('./upstream-endpoints-failure');
const { runTransportChain } = require('./upstream-endpoints-transport-chain');
const { openCodeGoTransport } = require('./upstream-endpoints-transport-opencode-go');
// 免费模型（`-free`）的两条通道必须都排在 openCodeGoTransport 之前：后者按协议路由计划
// 匹配所有 opencode 请求，落在它后面就永远轮不到（而付费 HTTP 通道对免费模型只会
// 403 FreeTierError）。两条通道内部：HTTP 直连优先（门禁已破解，见
// opencode-zen-free-client.js），它若吃到门禁 403 会返回 null 把同一次尝试交还给
// CLI 桥接兜底 —— 顺序即降级链，不要调换。
const { openCodeFreeHttpTransport } = require('./upstream-endpoints-transport-opencode-free-http');
const { openCodeFreeCliTransport } = require('./upstream-endpoints-transport-opencode-free-cli');
// qoder/qodercn 的降级链：HTTP 直连（复刻客户端 WASM 签名 + zstd，真机已通）优先，
// 失败/不可用时由 CLI headless 兜底。HTTP 在首字节前失败会返回 null 交还同一次尝试，
// 不记账号失败；顺序即降级链，不要把 CLI 放到前面。
const { qoderHttpTransport } = require('./upstream-endpoints-transport-qoder-http');
const { qoderCliTransport } = require('./upstream-endpoints-transport-qoder-cli');
// kiro 的 chat 面是 CodeWhisperer 流式 RPC（x-amz-target + event-stream），不是 OpenAI 兼容
// HTTP：必须排在通用 passthrough 之前，否则通用通道会打 `{base}/chat/completions` 拿到
// UnknownOperationException 并当 200 正文透出（2026-10-16 前的实际行为）。
const { kiroStreamTransport } = require('./upstream-endpoints-transport-kiro');
const { codeAssistAnthropicTransport } = require('./upstream-endpoints-transport-code-assist-anthropic');
const { codeAssistGeminiTransport } = require('./upstream-endpoints-transport-code-assist-gemini');
const { generalPassthroughTransport } = require('./upstream-endpoints-transport-general');
const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('./account-egress-request-options');

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
      const resolveRequestOptions = typeof deps.resolveAccountEgressRequestOptions === 'function'
        ? deps.resolveAccountEgressRequestOptions
        : resolveAccountEgressRequestOptionsDefault;
      let accountRequestOptions;
      try {
        accountRequestOptions = await resolveRequestOptions({
          fs: deps.fs,
          aiHomeDir: deps.aiHomeDir || options.aiHomeDir,
          processObj: deps.processObj,
          provider,
          accountRef: account.accountRef,
          options,
          deps
        });
      } catch (error) {
        accountRequestOptions = {
          ok: false,
          error: 'account_egress_unavailable',
          egressError: String(error?.message || error || 'unknown')
        };
      }
      if (!accountRequestOptions?.ok || !accountRequestOptions.options) {
        lastError = [
          String(accountRequestOptions?.error || 'account_egress_unavailable'),
          String(accountRequestOptions?.egressError || '')
        ].filter(Boolean).join(':');
        finalStatusCode = 503;
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }
      const attemptOptions = accountRequestOptions.options;
      const transportCtx = {
        options: attemptOptions,
        // 本次 attempt 实际使用的账号出口来源（url / system / tun / pool；未绑定为空）。
        // 出口相关的补救动作（例如出口池轮换）只对真正走了该出口的请求生效。
        accountEgressSource: String(accountRequestOptions.egress?.source || ''),
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
      // qoder/qodercn：HTTP 直连（WASM 签名 + zstd）优先，首字节前失败交还 CLI headless 兜底。
      // kiro 走 CodeWhisperer 流式 RPC（HTTP，但非 OpenAI 兼容形状）。
      const transportAction = await runTransportChain(transportCtx, [openCodeFreeHttpTransport, openCodeFreeCliTransport, openCodeGoTransport, qoderHttpTransport, qoderCliTransport, kiroStreamTransport]);
      if (transportAction) {
        streamTransport = attemptMutable.streamTransport;
        lastError = attemptMutable.lastError;
        finalStatusCode = attemptMutable.finalStatusCode;
        return transportAction;
      }
      const upstreamBase = resolveProviderUpstream(attemptOptions, provider, account);
      if (!upstreamBase) {
        lastError = `missing_upstream_for_provider_${provider}`;
        control.setLastError(lastError);
        return { action: 'break' };
      }
      if (isLoopbackUrl(upstreamBase, attemptOptions.port)) {
        lastError = 'infinite_loop_detected';
        control.setLastError(lastError);
        return { action: 'break' };
      }
      const upstreamPath = resolveProviderPath(provider, req.url || '', upstreamBase);
      const upstreamUrl = `${upstreamBase}${upstreamPath}`;
      let geminiCodeAssistDiagnostic = null;
      const logRetryFailure = (policy, data = {}) => {
        appendUpstreamFailureDiagnosticLog({
          options: attemptOptions,
          appendProxyRequestLog,
          // 与 transport 的日志出口共享同一注解袋子（见 attempt-annotations）。
          annotations: attemptAnnotations(attemptMutable),
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
            proxyUrl: attemptOptions.proxyUrl,
            noProxy: attemptOptions.noProxy
          }, {
            fetchWithTimeout
          });
        } catch (_error) {}
      }
      let accessToken = sanitizeAccessToken(account.accessToken);
      // 登录态凭据未必能直接用于推理：需要换取的 provider 由描述符
      // capabilities.relay.auth 声明（zcode 的 access_token → 业务 token）。
      // 未声明者直通，零开销。换取失败 fail-closed —— 绝不用未换取的凭据发出去，
      // 那正是上游返回 3012 unusual activity 的原因。
      if (accessToken && !isApiCredentialAccount(account)) {
        try {
          const resolved = await resolveRelayCredential(
            // 凭据形态按套餐分叉：start-plan 用长期 jwt 直通，coding-plan 才换取。
            // 因此这里必须把 jwt 与套餐文案一起交给 resolver，否则分叉判不出来。
            {
              provider,
              accessToken,
              zcodeJwtToken: account.zcodeJwtToken,
              planType: account.planType || account.plan
            },
            {
              request: fetchWithTimeout,
              timeoutMs: attemptUpstreamTimeoutMs,
              apiKeyMode: false
            }
          );
          if (resolved && resolved.resolved && resolved.accessToken) accessToken = resolved.accessToken;
        } catch (error) {
          lastError = `relay_credential_unavailable:${String((error && error.code) || (error && error.message) || 'unknown').slice(0, 120)}`;
          control.setLastError(lastError);
          markProxyAccountFailure(account, 'invalid_access_token', cooldownMs, options.failureThreshold);
          return { action: 'retry_next' };
        }
      }
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
          options: attemptOptions,
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
          geminiRequestOptions: {
            ...geminiRequestOptions,
            proxyUrl: attemptOptions.proxyUrl,
            noProxy: attemptOptions.noProxy
          },
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
          refreshCodeAssistAfterAuthFailure: (error, selectedAccount) => (
            refreshCodeAssistAfterAuthFailure(error, selectedAccount, attemptOptions)
          ),
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
        options: attemptOptions,
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
        lastError = withNetworkHint(
          policy.detail,
          resolveProviderUpstream(attemptOptions, provider, account)
        );
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
