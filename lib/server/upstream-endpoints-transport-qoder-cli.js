'use strict';

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { attemptAnnotations, withAttemptAnnotations, annotateAttempt } = require('./attempt-annotations');
const { writeUpstreamSseHeaders } = require('./upstream-endpoints-headers');
const {
  createBoundedTailCapture,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const {
  recordSuccessfulModelUsage,
  extractModelUsageInputFromRaw
} = require('./upstream-endpoints-usage');
const { recordTransportAttempt } = require('./transport-attempts');
const { qoderEstimatedSourceKind, summarizeQoderUsage } = require('../usage/qoder-usage');
const {
  supportsQoderCliTransport,
  fetchQoderCliChatCompletion,
  fetchQoderCliChatCompletionStream
} = require('./qoder-cli-transport');

function qoderUsageSourceKind(estimated) {
  return estimated
    ? qoderEstimatedSourceKind('server_qoder_cli_proxy')
    : 'server_qoder_cli_proxy';
}

/**
 * Qoder CLI headless transport strategy（与 openCodeGoTransport 同一 Strategy 契约）。
 * qoder/qodercn 没有可直放的 HTTP 上游（凭证 WASM 加密 + Cosy 签名），推理经
 * 原生 CLI headless stream-json 桥接为 OpenAI chat 语义。
 */
const qoderCliTransport = {
  // 原生 CLI headless：--tools "" 关闭全部工具，客户端工具无法执行（见 qoder-cli-transport.js）。
  capabilities: Object.freeze({ clientTools: false }),

  matches(ctx) {
    return supportsQoderCliTransport(ctx && ctx.provider);
  },

  async run(ctx) {
    const {
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
      recordModelUsage,
      appendProxyRequestLog,
      control,
      account,
      attemptUpstreamTimeoutMs,
      attemptMutable
    } = ctx;
    // 代理请求日志的**唯一出口**：注解袋子在这里自动并入条目（见 attempt-annotations）。
    const logRequest = (entry) => {
      if (!options.logRequests) return;
      appendProxyRequestLog(withAttemptAnnotations(entry, attemptMutable));
    };

    // 与 qoderHttpTransport 共用同一个 transportAttempts 模型：CLI 也有独立的
    // duration / upstream / outcome / usage，不再只从最终 route 日志反推延迟。
    const attemptStartedAt = Date.now();
    let attemptRecorded = false;
    let cliTransportMeta = { warm: false, reused: false };
    const recordQoderCliAttempt = (outcome, extra = {}) => {
      if (attemptRecorded) return;
      attemptRecorded = true;
      recordTransportAttempt(attemptMutable, {
        transport: 'qoder_cli',
        outcome,
        durationMs: Date.now() - attemptStartedAt,
        upstream: 'qoder-cli',
        provider,
        accountRef: account && account.accountRef,
        model: extra.model || String(requestJson && requestJson.model || '').trim(),
        stream: Boolean(streamRequested),
        errorCode: extra.errorCode,
        usage: extra.usage,
        details: {
          warm: cliTransportMeta.warm,
          warmReused: cliTransportMeta.reused,
          streamTransport: attemptMutable && attemptMutable.streamTransport,
          responseModel: extra.responseModel,
          sessionId: extra.sessionId,
          statusCode: extra.statusCode,
          ...extra.details
        }
      });
    };

    const cliFetch = typeof deps.fetchQoderCliChatCompletion === 'function'
      ? deps.fetchQoderCliChatCompletion
      : fetchQoderCliChatCompletion;
    const cliStreamFetch = typeof deps.fetchQoderCliChatCompletionStream === 'function'
      ? deps.fetchQoderCliChatCompletionStream
      : fetchQoderCliChatCompletionStream;
    // 用量幂等键与会话 JSONL 扫描器完全一致（`<provider>:message:<message.id>`）：
    // 代理实时通道先行记账，扫描器稍后读到同一条 message 时 INSERT OR IGNORE 跳过，
    // 避免同一轮翻倍。message id 由 transport 从上游 assistant 事件透出。
    const qoderUsageEventKey = (messageId) => {
      const id = String(messageId || '').trim();
      return id ? `${provider}:message:${id}` : undefined;
    };
    // warm 会话复用与 sessionKey 绑定：只有同一段对话才允许复用同一个 CLI 进程。
    const cliDeps = {
      aiHomeDir: options && options.aiHomeDir,
      signal: requestMeta && requestMeta.signal,
      sessionKey: requestMeta && requestMeta.sessionKey,
      requestMeta,
      onQoderCliTransport: (meta) => {
        cliTransportMeta = {
          warm: Boolean(meta && meta.warm),
          reused: Boolean(meta && meta.reused)
        };
        if (streamRequested) {
          attemptMutable.streamTransport = meta.warm
            ? 'qoder_cli_stream_json_warm'
            : 'qoder_cli_stream_json';
        } else {
          attemptMutable.streamTransport = meta.warm
            ? 'qoder_cli_non_stream_warm'
            : 'non_stream';
        }
        // 走 attempt 注解袋，成功/失败/重试日志都能看到 warm 与「真的复用了」两个事实。
        annotateAttempt(attemptMutable, 'qoderCliWarm', Boolean(meta && meta.warm));
        annotateAttempt(attemptMutable, 'qoderCliWarmReused', Boolean(meta && meta.reused));
      }
    };

    try {
      if (streamRequested) {
        const upstreamRes = await cliStreamFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, cliDeps);
        attemptMutable.streamTransport = attemptMutable.streamTransport || 'qoder_cli_stream_json';
        writeUpstreamSseHeaders(res, account);
        const usageTail = createBoundedTailCapture();
        let streamWriteError = null;
        try {
          await pipeReadableBodyToResponse(upstreamRes && upstreamRes.body, res, {
            onChunk: (chunk) => usageTail.append(chunk)
          });
        } catch (error) {
          if (!res.headersSent && !res.writableEnded) throw error;
          streamWriteError = error;
        }
        try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }

        if (streamWriteError) {
          attemptMutable.streamTransport = 'qoder_cli_stream_json_error';
          const policy = classifyUpstreamFailure({
            provider,
            error: streamWriteError,
            defaultCooldownMs: cooldownMs
          });
          // 失败流里已收到的 usage 仍然保留（与 HTTP 失败流同一口径）。
          const failedUsageInput = extractModelUsageInputFromRaw(usageTail.toBuffer());
          recordQoderCliAttempt('failure', {
            errorCode: String((streamWriteError && streamWriteError.code) || policy.kind || 'qoder_cli_stream_failed'),
            statusCode: 200,
            responseModel: failedUsageInput && failedUsageInput.model,
            usage: summarizeQoderUsage(failedUsageInput && failedUsageInput.usage, {
              estimated: Boolean(upstreamRes && upstreamRes.usageEstimated)
            }),
            details: { policyKind: policy.kind }
          });
          if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
          recordAccountFailure(account, policy);
          state.metrics.totalFailures += 1;
          state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
          logRequest({
            at: new Date().toISOString(),
            requestId: requestMeta && requestMeta.requestId,
            route: routeKey,
            provider,
            accountRef: account.accountRef,
            status: 200,
            error: policy.detail,
            streamRequested,
            streamTransport: attemptMutable.streamTransport,
            durationMs: Date.now() - requestStartedAt
          });
          return { action: 'return' };
        }

        const streamUsageInput = extractModelUsageInputFromRaw(usageTail.toBuffer());
        recordSuccessfulModelUsage(recordModelUsage, {
          provider,
          account,
          requestMeta,
          requestJson,
          raw: usageTail.toBuffer(),
          eventKey: qoderUsageEventKey(upstreamRes && upstreamRes.usageMessageId),
          sourceKind: qoderUsageSourceKind(upstreamRes && upstreamRes.usageEstimated)
        });
        recordAccountSuccess(account);
        recordQoderCliAttempt('success', {
          statusCode: 200,
          responseModel: streamUsageInput && streamUsageInput.model,
          sessionId: upstreamRes && upstreamRes.sessionId,
          usage: summarizeQoderUsage(streamUsageInput && streamUsageInput.usage, {
            estimated: Boolean(upstreamRes && upstreamRes.usageEstimated)
          })
        });
        logRequest({
          at: new Date().toISOString(),
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          accountRef: account.accountRef,
          status: 200,
          streamRequested,
          streamTransport: attemptMutable.streamTransport,
          durationMs: Date.now() - requestStartedAt
        });
        return { action: 'return' };
      }

      const payload = await cliFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, cliDeps);
      attemptMutable.streamTransport = attemptMutable.streamTransport || 'non_stream';
      const raw = Buffer.from(JSON.stringify(payload));
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('x-aih-server-account-ref', account.accountRef);
      if (account.email) res.setHeader('x-aih-server-account-email', account.email);
      res.setHeader('content-length', raw.length);
      res.end(raw);
      recordSuccessfulModelUsage(recordModelUsage, {
        provider,
        account,
        requestMeta,
        requestJson,
        payload,
        eventKey: qoderUsageEventKey(payload && payload.usageMessageId),
        sourceKind: qoderUsageSourceKind(payload && payload.usageEstimated)
      });
      recordAccountSuccess(account);
      recordQoderCliAttempt('success', {
        statusCode: 200,
        responseModel: payload && payload.model,
        sessionId: payload && (payload.session_id || payload.sessionId),
        usage: summarizeQoderUsage(payload && payload.usage, {
          estimated: payload && payload.usageEstimated === true
        })
      });
      logRequest({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider,
        accountRef: account.accountRef,
        status: 200,
        streamRequested,
        streamTransport: attemptMutable.streamTransport,
        durationMs: Date.now() - requestStartedAt
      });
      return { action: 'return' };
    } catch (qoderError) {
      const policy = classifyUpstreamFailure({
        provider,
        statusCode: 0,
        error: qoderError,
        defaultCooldownMs: cooldownMs
      });
      if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
      recordAccountFailure(account, policy);
      recordQoderCliAttempt('failure', {
        errorCode: String((qoderError && qoderError.code) || policy.kind || 'qoder_cli_upstream_error'),
        statusCode: policy.clientStatusCode || 502,
        details: { policyKind: policy.kind }
      });
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
        upstreamUrl: 'qoder-cli://headless',
        upstreamError: qoderError,
        status: policy.clientStatusCode || 502,
        durationMs: Date.now() - requestStartedAt,
        policy
      });
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = policy.clientStatusCode || 502;
      control.setLastError(attemptMutable.lastError);
      return policy.shouldRetryAnotherAccount ? { action: 'retry_next' } : { action: 'break' };
    }
  }
};

module.exports = { qoderCliTransport };
