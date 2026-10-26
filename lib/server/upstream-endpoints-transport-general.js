'use strict';

const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { annotateAttempt, attemptAnnotations, withAttemptAnnotations } = require('./attempt-annotations');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
// 读该 provider 的 relay.auth 声明（request-verification-provider 需要 planKinds/configUrl）。
// 走能力门面，不持有 provider 名单。
function relayAuthDeclaration(provider) {
  try {
    const relay = getProviderCapability(provider, 'relay');
    return relay && typeof relay === 'object' ? relay.auth || null : null;
  } catch (_error) {
    return null;
  }
}

const {
  applyClaudeCodeIdentityHeaders,
  ensureClaudeCodeSystemBuffer
} = require('./claude-official-client');
const { buildKimiRequestHeaders } = require('./kimi-request-headers');
const { adaptKimiChatRequestBuffer } = require('./kimi-chat-request');
const { applyAccountUpstreamHeaders } = require('./upstream-account-profile');
const { isClaudeMessagesPath } = require('./upstream-endpoints-path');
const { isCodebuddyFamilyProvider } = require('../account/codebuddy-billing');
const {
  CODEBUDDY_FAMILY_CHAT_PATH,
  buildCodebuddyFamilyUpstreamHeaders,
  adaptCodebuddyFamilyChatRequest,
  aggregateCodebuddyFamilySse,
  parseCodebuddyFamilyError,
  resolveCodebuddyFamilyUserId,
  resolveCodebuddyFamilyCliVersion
} = require('../account/codebuddy-family-inference');
// 官方 CLI 版本在进程启动时探测一次（读安装目录，不联网）；写死的版本号会随官方升级变旧。
const codebuddyFamilyCliVersion = resolveCodebuddyFamilyCliVersion();
const { ensureZcodeThinkingBuffer } = require('./zcode-anthropic-thinking');
const { detectUpstreamBusinessFailure } = require('./zcode-business-error');
// 请求验证参数（zcode start-plan 的阿里云无痕验证头）：解算与缓存都在该模块，
// 这里只按描述符声明取头。漏掉这个 import 会让所有需要验证参数的 zcode 请求
// 在发上游之前抛 ReferenceError（表现为 502 resolveRequestVerificationHeaders is not defined）。
const { resolveRequestVerificationHeaders } = require('./request-verification-provider');
// 鉴权头策略表（按描述符 relay.auth.kind 分派，不在本文件写 provider 名）。
const { resolveRelayAuthHeaders } = require('./relay-auth-headers');
const {
  shouldSkipForwardHeader,
  normalizeHeaderValue,
  isSafeHeaderValue,
  sendRawUpstreamResponse,
  writeGeneralUpstreamResponseHeaders
} = require('./upstream-endpoints-headers');
const { STREAM_RESPONSE_OPEN_TIMEOUT_MS } = require('./upstream-endpoints-utils');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { looksLikeEdgeBlockHeaders, isEdgeGatewayFormatRejection } = require('./upstream-edge-block');
const {
  createBoundedTailCapture,
  createDownstreamAbortContext,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const {
  isUnrecoverableTokenRefreshFailure
} = require('./token-refresh-result');
const {
  createTokenRefreshUnavailablePolicy
} = require('./upstream-endpoints-failure');
const { scheduleAgyUsageRefreshAfterFailure } = require('./agy-usage-snapshot');
const {
  recordSuccessfulModelUsage
} = require('./upstream-endpoints-usage');
const { unwrapUpstreamEnvelopeBody } = require('./openai-response-envelope');
const { decodeResponseBuffer } = require('./response-body');
const { createUpstreamErrorStreamObserver, readUpstreamErrorEvent } = require('./upstream-error-stream-observer');
const { inferModelFamilyProvider } = require('./account-capabilities');

/**
 * General passthrough transport strategy (Strategy pattern).
 *
 * Terminal fallback of the attempt transport chain: forwards the request
 * verbatim to the resolved upstream (header normalization, provider-specific
 * identity/body shaping, streaming pipe or buffered body,
 * refresh-on-401/403, usage and failure accounting).
 *
 * matches() always returns true — this transport must be the LAST entry of the
 * chain. Mutable attempt state (streamTransport/lastError/finalStatusCode) is
 * written through ctx.attemptMutable; the attempt handler syncs it back to its
 * own scope around the chain call, including on escape paths into the outer
 * attempt catch. logRetryFailure reads the live attemptMutable values (the
 * factory-scope copy in the attempt module would observe stale pre-chain
 * values, so this module keeps its own reader).
 *
 * ctx fields consumed:
 *   options, state, req, res, method, requestJson, routeKey, requestStartedAt,
 *   cooldownMs, requestMeta, deps, provider, streamRequested,
 *   recordAccountSuccess, recordAccountFailure, upstreamFailureRecorder,
 *   diagnosticMaxAttempts, fetchWithTimeout, writeJson, recordModelUsage,
 *   appendProxyRequestLog, control, account, attemptUpstreamTimeoutMs,
 *   upstreamUrl, attemptMutable, accessToken, upstreamPath, guardedBodyBuffer,
 *   canRefreshAccount, forcedRefreshRetryUsed, modelPoolSelection,
 *   pushMetricError, refreshProviderAccessToken, requestedAccountRef
 */
const generalPassthroughTransport = {
  matches() {
    return true;
  },

  async run(ctx) {
    const {
      options,
      state,
      req,
      res,
      method,
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
      writeJson,
      recordModelUsage,
      appendProxyRequestLog,
      control,
      account,
      attemptUpstreamTimeoutMs,
      upstreamUrl,
      attemptMutable,
      accessToken,
      upstreamPath,
      guardedBodyBuffer,
      canRefreshAccount,
      forcedRefreshRetryUsed,
      modelPoolSelection,
      pushMetricError,
      refreshProviderAccessToken,
      requestedAccountRef
    } = ctx;
    // 代理请求日志的**唯一出口**：注解袋子在这里自动并入条目（见 attempt-annotations）。
    // 任何新的日志字段都不需要再改调用点——产生它的地方用 annotateAttempt 记一次即可。
    const logRequest = (entry) => {
      if (!options.logRequests) return;
      appendProxyRequestLog(withAttemptAnnotations(entry, attemptMutable));
    };
    const logRetryFailure = (policy, data = {}) => {
      appendUpstreamFailureDiagnosticLog({
        options,
        appendProxyRequestLog,
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
        streamTransport: attemptMutable.streamTransport,
        upstreamUrl,
        durationMs: Date.now() - requestStartedAt,
        geminiCodeAssist: attemptMutable.geminiCodeAssistDiagnostic || undefined,
        policy,
        ...data
      });
    };

    // --- general passthrough (verbatim from the inline attempt body) ---
    const headers = {};
    Object.entries(req.headers || {}).forEach(([k, v]) => {
      const key = String(k || '').toLowerCase();
      if (shouldSkipForwardHeader(k)) return;
      const normalized = normalizeHeaderValue(v);
      if (!normalized) return;
      if (!isSafeHeaderValue(normalized)) return;
      headers[key] = normalized;
    });
    headers.authorization = `Bearer ${accessToken}`;
    // A local Codex API-key account can be an OpenAI-compatible relay to a
    // remote AIH Server.  The remote server must route Gemini models through
    // its AGY pool even though this attempt entered the local Codex provider.
    // Carry the family in both header and JSON because intermediary proxies
    // may drop non-standard headers.
    const relayFamily = account.apiKeyMode && inferModelFamilyProvider(requestJson && requestJson.model) === 'agy'
      ? 'agy'
      : '';
    if (relayFamily) headers['x-provider'] = relayFamily;
    if (provider === 'kimi' && !isApiCredentialAccount(account)) {
      Object.assign(headers, buildKimiRequestHeaders(account));
    }
    let forwardBody = guardedBodyBuffer;
    if (relayFamily && requestJson && typeof requestJson === 'object' && !Array.isArray(requestJson)) {
      forwardBody = Buffer.from(JSON.stringify({ ...requestJson, provider: relayFamily }), 'utf8');
    }
    if (provider === 'kimi' && /\/chat\/completions\/?$/.test(upstreamPath)) {
      forwardBody = adaptKimiChatRequestBuffer(forwardBody);
    }
    // CodeBuddy / WorkBuddy 家族：上游有两条硬约束（见 codebuddy-family-inference 的
    // 模块说明）——`stream` 必须为 true、`messages[0].role` 必须是 `system`。两者都不满足
    // 时上游只回一个 400 业务码，客户端完全看不出原因，所以在这里就地补齐。
    // 请求体从解析后的 requestJson 重建而不是改缓冲区：需要增删 messages 元素。
    // 按去掉 query 的路径判定：客户端带 query 时（`/v1/chat/completions?…`）严格等式不成立，
    // 整段适配会被跳过——缺 system 与会话三件套，上游必回 11128。
    if (isCodebuddyFamilyProvider(provider)
      && String(upstreamPath || '').split('?')[0] === CODEBUDDY_FAMILY_CHAT_PATH) {
      // 会话 ID 家族是渠道校验的必需项（缺了 400 code 11128）。同一客户端会话派生同一个
      // conversation id，与官方客户端行为一致；没有会话键时由构造函数新建。
      // uid / version 用于复刻官方身份头（X-User-Id / X-IDE-Version）——实测不参与校验，
      // 发它们只是让请求画像与官方一致。
      Object.assign(headers, buildCodebuddyFamilyUpstreamHeaders(provider, account, {
        sessionKey: requestMeta && (requestMeta.sessionId || requestMeta.sessionKey),
        uid: resolveCodebuddyFamilyUserId(account),
        version: codebuddyFamilyCliVersion
      }));
      const adapted = adaptCodebuddyFamilyChatRequest(requestJson || {});
      // 结论 → 注解键的映射由适配器自己声明（adapted.annotations，唯一一份）。这里整体并入
      // 袋子，所以**新增结论不必回到这个调用点补一行**——「忘了接线」在结构上不可能发生。
      // 所有日志出口（成功/失败/重试失败/下游取消）用 withAttemptAnnotations 自动带上，
      // 见 attempt-annotations。
      for (const [key, value] of Object.entries(adapted.annotations)) {
        annotateAttempt(attemptMutable, key, value);
      }
      // 有损改写还得让**客户端**知道：日志里有注解，但客户端不读日志。
      // 只在真的有损时下发（干净路径不带这个头，避免噪音）。
      //
      // 该头由 Node 产生，而家族推理数据面目前**只有 Node**，所以不存在「Go 承接了家族
      // 请求却不下发降级头」的缺口。两条实测依据（2026-10-15）：
      //   1) Go 侧 internal/adapters 下没有 codebuddy/workbuddy 上游适配器（只有
      //      nativeaccount/codebuddy_policy.go 这类账号级策略）；
      //   2) Go 的账号库（~/.ai_home/aih.db 的 account_models）里家族账号模型数为 0，
      //      因此家族请求必然命中 model_not_routable / pinned_model_not_routable，
      //      一律交还 Node（lib/server/go-core-route-deferral.js）。
      // 若 Go 将来开始同步家族模型并承接家族上游，**这个头必须一起移植**，否则客户端会
      // 重新变回「有损但看不见」。
      if (adapted.degradations.length) {
        res.setHeader('x-aih-degradations', adapted.degradations.join(','));
      }
      forwardBody = Buffer.from(JSON.stringify(adapted.body));
    }
    if (provider === 'claude' && isClaudeMessagesPath(upstreamPath)) {
      if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
      if (isApiCredentialAccount(account)) {
        delete headers.authorization;
        headers['x-api-key'] = accessToken;
      } else {
        delete headers['x-api-key'];
        headers.authorization = `Bearer ${accessToken}`;
        if (!headers['anthropic-beta']) headers['anthropic-beta'] = 'oauth-2025-04-20';
      }
      // 订阅额度按 Claude Code 客户端判定。真实 Claude Code 自带这份身份，
      // 其请求在此保持字节不变；任何缺失它的客户端若不补齐会被上游按限流拒绝。
      applyClaudeCodeIdentityHeaders(headers, account);
      forwardBody = ensureClaudeCodeSystemBuffer(forwardBody, account);
    }
    if (provider === 'zcode' && isClaudeMessagesPath(upstreamPath)) {
      // zcode 上游是 Anthropic 兼容端点。鉴权形态**按账号类型分叉**：
      //   * API Key 账号（直连 open.bigmodel.cn / api.z.ai）→ x-api-key
      //   * OAuth start-plan 账号 → Authorization: Bearer <长期 jwt>
      // 依据（逆向桌面端 3.16.3）：AccountProviderRequestAuthService 对 start-plan
      // 返回 { apiKey: requireApiKey(zcodeJwtToken) }，且该对象**无 accountScope**；
      // agent 侧 withAnthropicAuthorizationHeader 因此走 Authorization 分支。
      // 早先这里一律 delete authorization + 设 x-api-key，对 OAuth 账号是错的
      // （真机：该组合在 start-plan 端点被拒，401/3012）。
      if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
      if (isApiCredentialAccount(account)) {
        delete headers.authorization;
        headers['x-api-key'] = accessToken;
      } else {
        delete headers['x-api-key'];
        // 鉴权头形态**由描述符声明**（relay.auth.kind），按 kind 查策略表 ——
        // 本文件是所有 provider 共用的，因此这里不出现任何 provider 名。
        // 新增形态 = 加一个 kind + 一条策略实现（relay-auth-headers.js），共享文件零改动。
        for (const [key, value] of Object.entries(resolveRelayAuthHeaders({
          account,
          resolvedToken: accessToken,
          auth: relayAuthDeclaration(provider)
        }))) {
          if (value) headers[key] = value;
        }
      }
      // GLM「始终思考」模型（glm-5.3）必须显式 thinking，缺失时上游 400 (1210)。
      // 客户端自带 thinking 或模型不在清单内时缓冲区逐字节不变。
      forwardBody = ensureZcodeThinkingBuffer(forwardBody);
      // start-plan 的模型请求还需**阿里云无痕验证参数**，缺它上游返回 405 code:3012
      // （那是「缺验证参数」而非风控封禁）。参数由 request-verification-provider
      // 按描述符声明（relay.auth.requestVerification）解算并缓存 —— 解算要 spawn
      // Chrome（秒级），因走缓存；解算失败返回 {} 不阻断，由上游自行判断。
      if (!isApiCredentialAccount(account)) {
        const verificationHeaders = await resolveRequestVerificationHeaders(account, relayAuthDeclaration(provider), {
          request: fetchWithTimeout,
          fs: deps && deps.fs,
          hostHomeDir: deps && deps.hostHomeDir,
          timeoutMs: attemptUpstreamTimeoutMs,
          captchaBrowser: deps && deps.captchaBrowser,
          solveCaptcha: deps && deps.solveCaptcha
        });
        for (const [key, value] of Object.entries(verificationHeaders || {})) {
          if (value) headers[key] = value;
        }
      }
    }
    // The local HTTP proxy can return a gzip body while stripping both
    // content-encoding and content-type. Ask for identity on streams so the
    // body can be forwarded incrementally; the pipe still sniffs gzip magic
    // below as a defensive fallback for non-compliant upstreams/proxies.
    //
    // 家族例外：官方 CLI 身份**不发** accept-encoding（2026-10-21 抓包确认的 35 个头里没有它），
    // 而家族上游只回未压缩的 SSE，不需要这层防御。发它等于自报「不是官方客户端」，
    // 与「模拟官方客户端」的目标冲突；gzip 兜底（upstream-stream-forwarder 的 magic 嗅探）
    // 仍然生效，所以剥离不损失鲁棒性。
    if (streamRequested && !isCodebuddyFamilyProvider(provider)) {
      headers['accept-encoding'] = 'identity';
    }
    // Account-configured overrides win over inherited client headers; some
    // relay endpoints reject requests that lack their required markers.
    // Applied before the internal x-aih-* markers so those stay authoritative.
    applyAccountUpstreamHeaders(headers, account);
    headers['x-aih-account-ref'] = account.accountRef;
    headers['x-aih-account-email'] = account.email || '';
    // 家族上游是腾讯官方端点：把本端内部标识留在请求里等于自报「不是官方客户端」，
    // 与「模拟官方客户端」的目标直接冲突。这两个头没有任何上游消费方（本端自己也不读），
    // 账号归属已由响应头 x-aih-server-account-ref 与日志承担，因此只对家族剥离。
    if (isCodebuddyFamilyProvider(provider)) {
      delete headers['x-aih-account-ref'];
      delete headers['x-aih-account-email'];
    }
    // Keep the selected account observable even when the upstream error is
    // normalized locally instead of passed through with response headers.
    if (account.accountRef) res.setHeader('x-aih-server-account-ref', account.accountRef);

    console.log(`[aih] Forwarding general request to upstream: ${method} ${upstreamUrl} (account: ${account.accountRef})`);
    const responseOpenTimeoutMs = streamRequested
      ? Math.max(STREAM_RESPONSE_OPEN_TIMEOUT_MS, Number(attemptUpstreamTimeoutMs) || 0)
      : attemptUpstreamTimeoutMs;
    const downstreamAbort = createDownstreamAbortContext(req, res);
    let upstreamRes;
    try {
      upstreamRes = await fetchWithTimeout(upstreamUrl, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : forwardBody,
        signal: downstreamAbort.signal
      }, responseOpenTimeoutMs, {
        proxyUrl: options.proxyUrl,
        noProxy: options.noProxy
      });
    } catch (error) {
      if (downstreamAbort.isDisconnected()) {
        attemptMutable.streamTransport = 'downstream_cancelled';
        return { action: 'return' };
      }
      throw error;
    } finally {
      downstreamAbort.dispose();
    }

    let upstreamErrorText = '';
    let upstreamErrorRaw = null;
    if (upstreamRes.status >= 400) {
      upstreamErrorRaw = Buffer.from(await upstreamRes.arrayBuffer());
      upstreamErrorText = decodeResponseBuffer(upstreamErrorRaw,
        String(upstreamRes.headers.get('content-encoding') || ''));
      console.error(`[aih] Upstream returned error status ${upstreamRes.status} for ${method} ${upstreamUrl}:`, upstreamErrorText);
    }

    // WAF/CDN 拦截页（HTML / cf-mitigated）与站点边缘网关的**请求格式拒绝**（APISIX
    // `{"message":"invalid_format"}`）：都属于「与账号无关的边缘拒绝」，先于强制刷新识别——
    // 刷新只会白白轮换 OAuth 凭据，换号也是同一张拦截页 / 同一个格式门。两类判定都由 policy 给出。
    const edgeBlockedHeaders = looksLikeEdgeBlockHeaders(upstreamRes.headers);
    const gatewayFormatRejected = !edgeBlockedHeaders
      && isEdgeGatewayFormatRejection({ headers: upstreamRes.headers, body: upstreamErrorText });
    if ((upstreamRes.status === 401 || upstreamRes.status === 403) && (edgeBlockedHeaders || gatewayFormatRejected)) {
      const blockedBody = upstreamErrorText;
      const policy = classifyUpstreamFailure({
        provider,
        account,
        statusCode: upstreamRes.status,
        headers: upstreamRes.headers,
        body: blockedBody,
        detail: edgeBlockedHeaders
          ? `upstream_${upstreamRes.status}_edge_blocked`
          : `upstream_${upstreamRes.status}_gateway_format_rejected`,
        defaultCooldownMs: cooldownMs
      });
      if (policy.kind === 'upstream_edge_blocked' || policy.kind === 'upstream_edge_format_rejected') {
        logRetryFailure(policy, {
          status: upstreamRes.status,
          upstreamStatus: upstreamRes.status,
          upstreamHeaders: upstreamRes.headers,
          upstreamBody: blockedBody
        });
        attemptMutable.lastError = policy.detail;
        attemptMutable.finalStatusCode = policy.clientStatusCode;
        control.setLastError(attemptMutable.lastError);
        return { action: 'break' };
      }
    }
    if (upstreamRes.status === 401 || upstreamRes.status === 403) {
      const authFailureBody = upstreamErrorText;
      const policy = classifyUpstreamFailure({
        provider, account, statusCode: upstreamRes.status, headers: upstreamRes.headers,
        body: authFailureBody, detail: `upstream_${upstreamRes.status}_account_${account.accountRef}`,
        defaultCooldownMs: cooldownMs
      });
      const accountRef = String(account.accountRef || '');
      const allowRefreshRetry = (
        canRefreshAccount
        && policy.kind === 'auth_invalid'
        && !forcedRefreshRetryUsed.has(accountRef)
      );
      if (allowRefreshRetry) {
        let refreshResult = null;
        try {
          refreshResult = await refreshProviderAccessToken(account, {
            force: true,
            timeoutMs: attemptUpstreamTimeoutMs,
            proxyUrl: options.proxyUrl,
            noProxy: options.noProxy
          }, {
            fetchWithTimeout
          });
        } catch (_error) {
          refreshResult = {
            ok: false,
            refreshed: false,
            reason: 'refresh_exception'
          };
        }
        if (refreshResult && refreshResult.ok && refreshResult.refreshed) {
          forcedRefreshRetryUsed.add(accountRef);
          control.retrySameAccount();
          return { action: 'retry_same' };
        }
        if (!isUnrecoverableTokenRefreshFailure(refreshResult)) {
          const policy = createTokenRefreshUnavailablePolicy(provider, refreshResult, cooldownMs);
          recordAccountFailure(account, policy);
          logRetryFailure(policy, {
            status: 503,
            upstreamStatus: upstreamRes.status
          });
          attemptMutable.lastError = policy.detail;
          attemptMutable.finalStatusCode = 503;
          control.setLastError(attemptMutable.lastError);
          return { action: requestedAccountRef ? 'break' : 'retry_next' };
        }
      }
      recordAccountFailure(account, policy);
      logRetryFailure(policy, {
        status: upstreamRes.status,
        upstreamStatus: upstreamRes.status,
        upstreamHeaders: upstreamRes.headers,
        upstreamBody: authFailureBody
      });
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = policy.clientStatusCode || upstreamRes.status || 502;
      control.setLastError(attemptMutable.lastError);
      return { action: 'retry_next' };
    }

    const normalizeClaudeMessagesResponse = provider === 'claude' && isClaudeMessagesPath(upstreamPath);
    const upstreamContentType = String(upstreamRes.headers.get('content-type') || '').toLowerCase();
    if (
      streamRequested
      && upstreamRes.status < 400
      && upstreamRes.body
      && (
        normalizeClaudeMessagesResponse
        || upstreamContentType.includes('text/event-stream')
      )
    ) {
      attemptMutable.streamTransport = 'upstream_sse';
      writeGeneralUpstreamResponseHeaders(res, upstreamRes, account, {
        normalizeClaudeMessagesResponse,
        streamRequested: true
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const usageTail = createBoundedTailCapture();
      let streamFailurePolicy = null;
      const errorObserver = createUpstreamErrorStreamObserver(failure => {
        streamFailurePolicy = classifyUpstreamFailure({
          provider, account, ...failure, defaultCooldownMs: cooldownMs
        });
        recordAccountFailure(account, streamFailurePolicy);
        logRetryFailure(streamFailurePolicy, {
          status: upstreamRes.status,
          upstreamStatus: failure.statusCode,
          upstreamBody: JSON.stringify(failure.body)
        });
      });
      let streamWriteError = null;
      let pipeResult = { downstreamDisconnected: false };
      try {
        pipeResult = await pipeReadableBodyToResponse(upstreamRes.body, res, {
          onChunk: (chunk) => {
            usageTail.append(chunk);
            errorObserver.append(chunk);
          }
        });
      } catch (error) {
        streamWriteError = error;
      }

      if (pipeResult.downstreamDisconnected) {
        attemptMutable.streamTransport = 'downstream_cancelled';
        logRequest({
          at: new Date().toISOString(),
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          accountRef: account.accountRef,
          status: 499,
          streamRequested,
          streamTransport: attemptMutable.streamTransport,
          durationMs: Date.now() - requestStartedAt
        });
        return { action: 'return' };
      }

      try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
      if (streamWriteError || streamFailurePolicy) {
        attemptMutable.streamTransport = 'upstream_sse_error';
        const policy = streamFailurePolicy || classifyUpstreamFailure({
          provider,
          account,
          error: streamWriteError,
          defaultCooldownMs: cooldownMs
        });
        if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
        if (!streamFailurePolicy) recordAccountFailure(account, policy);
        state.metrics.totalFailures += 1;
        state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
        logRequest({
          at: new Date().toISOString(),
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          accountRef: account.accountRef,
          status: upstreamRes.status,
          error: policy.detail,
          streamRequested,
          streamTransport: attemptMutable.streamTransport,
          durationMs: Date.now() - requestStartedAt
        });
        return { action: 'return' };
      }

      recordSuccessfulModelUsage(recordModelUsage, {
        provider,
        account,
        requestMeta,
        requestJson,
        raw: usageTail.toBuffer(),
        sourceKind: 'server_proxy'
      });
      recordAccountSuccess(account);
      logRequest({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider,
        accountRef: account.accountRef,
        status: upstreamRes.status,
        streamRequested,
        streamTransport: attemptMutable.streamTransport,
        durationMs: Date.now() - requestStartedAt
      });
      return { action: 'return' };
    }

    const upstreamRaw = upstreamErrorRaw || Buffer.from(await upstreamRes.arrayBuffer());
    // 家族上游**只支持流式**（非流式实测 400 code 11101），所以客户端要非流式时，
    // 本端向上游要的是流，在这里把 SSE 折叠成一个完整的 chat.completion 再返回。
    // 这是唯一能同时满足「上游只给流」与「客户端要非流式」的做法；不这么做，客户端
    // 会拿到一段 text/event-stream 却被当成 JSON 解析。
    const codebuddyFamilyAggregate = (
      isCodebuddyFamilyProvider(provider)
      && !streamRequested
      && upstreamRes.status < 400
      && upstreamContentType.includes('text/event-stream')
    )
      ? aggregateCodebuddyFamilySse(decodeResponseBuffer(
        upstreamRaw,
        String(upstreamRes.headers.get('content-encoding') || '')
      ))
      : null;
    // Relays that wrap completions in a {"data":...,"success":true} envelope
    // are normalized back to the canonical OpenAI shape; anything else keeps
    // its original bytes.
    const envelopeBody = (streamRequested || upstreamRes.status >= 400)
      ? null
      : unwrapUpstreamEnvelopeBody(
        upstreamRaw,
        String(upstreamRes.headers.get('content-encoding') || '')
      );
    const raw = codebuddyFamilyAggregate
      ? Buffer.from(JSON.stringify(codebuddyFamilyAggregate.payload), 'utf8')
      : envelopeBody || (normalizeClaudeMessagesResponse
        ? Buffer.from(decodeResponseBuffer(
          upstreamRaw,
          String(upstreamRes.headers.get('content-encoding') || '')
        ), 'utf8')
        : upstreamRaw);
    if (streamRequested) {
      attemptMutable.streamTransport = upstreamContentType.includes('text/event-stream')
        ? 'upstream_sse'
        : 'passthrough_raw';
    } else {
      // 家族非流式请求实际走的是「上游 SSE + 本端聚合」，标注出来以便日志区分
      // 「上游真的给了非流式」与「本端把流折叠了」这两种不同来源。
      attemptMutable.streamTransport = codebuddyFamilyAggregate
        ? 'codebuddy_family_sse_aggregated'
        : 'non_stream';
    }
    // zcode 家族把业务失败放在 HTTP 200 的响应体里（详见 zcode-business-error）。
    // 只按状态码判定会把这类拒绝当成功放行：不记失败、不熔断、不换账号，
    // 客户端只拿到一段无法解析的 JSON。识别出来后归一成一次真实失败，
    // 复用下面与 4xx/5xx 完全相同的既有路径，不另起一套并行机制。
    const businessError = detectUpstreamBusinessFailure({
      provider,
      statusCode: upstreamRes.status,
      body: raw
    });
    let explicitError = null;
    if (upstreamRes.status < 400) {
      try { explicitError = readUpstreamErrorEvent(JSON.parse(decodeResponseBuffer(raw,
        String(upstreamRes.headers.get('content-encoding') || '')))); } catch (_error) { /* non-JSON body */ }
    }
    // 业务信封的传输状态是 200，对失败分类毫无意义；传 0 让分类器走结构化
    // 业务码判定，避免把 200 当成「上游成功」的证据。
    const failureStatusCode = explicitError ? explicitError.statusCode : businessError ? 0 : upstreamRes.status;
    if (upstreamRes.status >= 400 || businessError || explicitError) {
      const detail = explicitError ? explicitError.detail : businessError
        ? `upstream_business_${businessError.code}: ${businessError.message}`
        : `upstream_${upstreamRes.status}: ${String(raw).slice(0, 320)}`;
      const policy = classifyUpstreamFailure({
        provider,
        account,
        statusCode: failureStatusCode,
        headers: upstreamRes.headers,
        body: String(raw),
        detail,
        defaultCooldownMs: cooldownMs
      });
      recordAccountFailure(account, policy);
      scheduleAgyUsageRefreshAfterFailure({
        provider,
        account,
        policy,
        options,
        fs: deps.fs,
        fetchWithTimeout
      });
      if (policy.shouldRetryAnotherAccount) {
        logRetryFailure(policy, {
          status: upstreamRes.status,
          upstreamStatus: upstreamRes.status,
          upstreamHeaders: upstreamRes.headers,
          upstreamBody: String(raw)
        });
      }
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = policy.clientStatusCode || failureStatusCode || 502;
      control.setLastError(attemptMutable.lastError);
      // 冷缓存 unchecked 模式：无法按模型过滤账号，当前账号 4xx 尝试下一个
      const uncheckedColdRetry = modelPoolSelection.unchecked && upstreamRes.status >= 400 && upstreamRes.status < 500;
      if (policy.shouldRetryAnotherAccount || uncheckedColdRetry) {
        // 换账号之前留档：如果后面没有账号可续，这就是本次请求唯一的真相，
        // 必须原样还给客户端，而不是把 429 粉饰成「无可调度账号」。
        upstreamFailureRecorder.record({
          statusCode: attemptMutable.finalStatusCode,
          upstreamRes,
          raw,
          account,
          streamRequested,
          passthrough: Boolean(policy.shouldPassthroughToClient && raw.length > 0),
          error: 'upstream_failed',
          detail: attemptMutable.lastError
        });
        return { action: 'retry_next' };
      }
      state.metrics.totalFailures += 1;
      state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
      pushMetricError(state.metrics, routeKey, provider, {
        message: attemptMutable.lastError,
        error: 'upstream_failed',
        accountRef: account.accountRef,
        model: (requestJson && requestJson.model) || (requestMeta && requestMeta.model) || '',
        sessionId: requestMeta && (requestMeta.sessionId || requestMeta.sessionKey),
        projectPath: requestMeta && requestMeta.projectPath,
        projectDirName: requestMeta && requestMeta.projectDirName
      });
      logRequest({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider,
        accountRef: account.accountRef,
        status: upstreamRes.status,
        error: attemptMutable.lastError,
        streamRequested,
        streamTransport: attemptMutable.streamTransport,
        durationMs: Date.now() - requestStartedAt
      });
      if (policy.shouldPassthroughToClient && raw.length > 0) {
        sendRawUpstreamResponse(res, upstreamRes, raw, account, streamRequested);
      } else {
        writeJson(res, attemptMutable.finalStatusCode, { ok: false, error: 'upstream_failed', detail: attemptMutable.lastError });
      }
      return { action: 'return' };
    }

    writeGeneralUpstreamResponseHeaders(res, upstreamRes, account, {
      normalizeClaudeMessagesResponse,
      streamRequested,
      bodyRewritten: Boolean(envelopeBody),
      normalizeJsonBody: Boolean(codebuddyFamilyAggregate)
    });
    res.setHeader('content-length', raw.length);
    res.end(raw);

    recordSuccessfulModelUsage(recordModelUsage, {
      provider,
      account,
      requestMeta,
      requestJson,
      raw,
      sourceKind: 'server_proxy'
    });
    recordAccountSuccess(account);
    logRequest({
      at: new Date().toISOString(),
      requestId: requestMeta && requestMeta.requestId,
      route: routeKey,
      provider,
      accountRef: account.accountRef,
      status: upstreamRes.status,
      streamRequested,
      streamTransport: attemptMutable.streamTransport,
      durationMs: Date.now() - requestStartedAt
    });
    return { action: 'return' };
  }
};

module.exports = { generalPassthroughTransport };
