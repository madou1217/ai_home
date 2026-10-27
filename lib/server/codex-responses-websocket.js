'use strict';

const WebSocket = require('ws');
const { bridgeResponsesSession } = require('./codex-responses-session');
const { inferProviderFromModel } = require('./providers');
const { resolveModelAliasCandidates } = require('./model-alias-resolver');
const {
  GATEWAY_HTTP_ACCOUNT,
  createGatewayHttpResponsesConnection,
  isGatewayHttpAccount,
  resolveLoopbackBaseUrl
} = require('./codex-responses-ws-http-bridge');
const { getCodexQuotaFailure } = require('./codex-response-recovery');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { applyAccountFailurePolicy } = require('./account-runtime-state');
const { selectPoolAccountsForModel } = require('./model-account-pool-selector');
const { createResponsesWebSocketPlugins } = require('./codex-responses-ws-plugins');
const {
  remotePoolKey,
  beginRemotePoolRecovery,
  completeRemotePoolRecovery,
  waitForRemotePoolRecovery
} = require('./remote-pool-recovery');

const PROTOCOL_HEADERS = [
  'user-agent', 'openai-beta', 'originator', 'version', 'session_id', 'session-id', 'thread-id',
  'x-codex-turn-state', 'x-codex-turn-metadata', 'x-client-request-id',
  'x-agent-context-session-id'
];

function buildResponsesWebSocketHeaders(headers, account) {
  const result = {};
  for (const name of PROTOCOL_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value && !/[\r\n]/.test(value)) result[name] = value;
  }
  result.authorization = `Bearer ${account.accessToken}`;
  result['user-agent'] ||= 'aih-proxy';
  if (account.upstreamAccountId) result['chatgpt-account-id'] = account.upstreamAccountId;
  return result;
}

function classifyResponseFailure(event, account) {
  if (!event || !['error', 'response.failed'].includes(event.type)) return null;
  const rawError = event.error || event.response?.error;
  const error = typeof rawError === 'string'
    ? { code: rawError, message: rawError }
    : rawError;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const quota = getCodexQuotaFailure(event);
  const policy = classifyUpstreamFailure({
    provider: 'codex', statusCode: event.status || event.status_code
      || (error.type === 'invalid_request_error' ? 400 : 0),
    body: event, detail: error.message || error.code || error.type,
    error: new Error(error.message || error.code || error.type || 'upstream_error'), account
  });
  // The shared policy owns retryability. A transport-local quota allowlist
  // silently dropped model-capacity failures before accounting and failover.
  return { policy, code: quota ? quota.code : policy.kind };
}

function rejectUpgrade(socket, status, error, headers = {}) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ ok: false, error });
  const headerLines = Object.entries(headers)
    .filter(([name, value]) => name && value != null && !/[\r\n]/.test(String(value)))
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join('\r\n');
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${headerLines ? `${headerLines}\r\n` : ''}\r\n${body}`);
}

function openUpstreamWebSocket(target, headers, socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new Error('client_disconnected'));
    const upstream = new WebSocket(target, {
      headers, handshakeTimeout: timeoutMs, followRedirects: false
    });
    // Failed attempts are terminated after rejection; consume their final error.
    upstream.on('error', () => {});
    const deadline = Date.now() + timeoutMs;
    let responseTimer = null;
    let handshakeResponse = null;
    let settled = false;
    const cleanup = () => {
      clearTimeout(responseTimer);
      socket.removeListener('close', cancel);
      socket.removeListener('end', cancel);
      upstream.removeListener('error', fail);
      upstream.removeListener('open', opened);
      upstream.removeListener('unexpected-response', unexpected);
    };
    const fail = error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
      handshakeResponse?.destroy();
      upstream.terminate();
    };
    const cancel = () => {
      fail(new Error('client_disconnected'));
      socket.destroy();
    };
    const opened = () => { settled = true; cleanup(); resolve(upstream); };
    const unexpected = (_request, response) => {
      handshakeResponse = response;
      const error = new Error(`upstream_handshake_status_${response.statusCode}`);
      error.statusCode = response.statusCode;
      error.headers = response.headers;
      const chunks = [];
      let bytes = 0;
      const finish = () => { error.body = Buffer.concat(chunks).toString('utf8'); fail(error); };
      response.on('data', chunk => {
        const buffer = Buffer.from(chunk);
        chunks.push(buffer.subarray(0, Math.max(0, 64 * 1024 - bytes)));
        bytes += buffer.length;
        if (bytes >= 64 * 1024) finish();
      });
      response.once('end', finish);
      response.once('error', () => fail(error));
      response.once('aborted', () => fail(error));
      responseTimer = setTimeout(() => fail(error), Math.max(1, deadline - Date.now()));
    };
    socket.once('close', cancel);
    socket.once('end', cancel);
    upstream.once('open', opened);
    upstream.once('error', fail);
    upstream.once('unexpected-response', unexpected);
  });
}

async function connectUpstreamWebSocket(target, headers, socket, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  try {
    return await openUpstreamWebSocket(target, headers, socket, timeoutMs);
  } catch (error) {
    // Only a missing handshake route permits one same-origin alias attempt.
    // No client frames have been accepted, so no inference request is replayed.
    if (error.statusCode !== 404 || socket.destroyed) throw error;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw error;
    const alias = new URL(target);
    alias.pathname += '/ws';
    return openUpstreamWebSocket(alias, headers, socket, remainingMs);
  }
}

/**
 * 该模型是否由「Codex 以外」的通道服务：用户别名命中，或模型 ID 归属其它 provider。
 * 只有这类模型才交给网关 HTTP 管线；Codex 自己的模型（含暂时无号可用的）保持原语义。
 */
function routesBeyondCodex(model, state) {
  const id = String(model || '').trim();
  if (!id) return false;
  if (inferProviderFromModel(id) !== 'codex') return true;
  const aliases = state && state.modelAliases && Array.isArray(state.modelAliases.aliases) ? state.modelAliases.aliases : [];
  if (!aliases.length) return false;
  try {
    return resolveModelAliasCandidates({ aliases, requestJson: { model: id }, clientProtocol: 'openai_responses', state }).candidates.length > 0;
  } catch (_error) {
    return false;
  }
}

/** 账号池里是否有 Codex 以外的账号（决定无 Codex 号时是否仍接受升级）。 */
function hasNonCodexAccounts(state) {
  const accounts = (state && state.accounts) || {};
  return Object.entries(accounts).some(([provider, pool]) => provider !== 'codex' && Array.isArray(pool) && pool.length > 0);
}

async function handleCodexResponsesWebSocket({ req, socket, head, state, options, requestId }, deps) {
  const routesElsewhere = typeof deps.routesBeyondCodex === 'function'
    ? (model) => deps.routesBeyondCodex(model, state)
    : (model) => routesBeyondCodex(model, state);
  // 网关插件：每个 response.create 固定代次并跑 gateway.request / observe；没有插件时为 null。
  const plugins = createResponsesWebSocketPlugins({ state });
  // gateway.account：选号时带上插件偏好（只排序，候选与可调度规则不变）。
  if (plugins) deps = { ...deps, chooseAccount: plugins.wrapChooser(deps.chooseAccount) };
  const accountRef = String(req.headers['x-account-ref'] || '').trim();
  const sessionKey = String(req.headers['session-id'] || req.headers.session_id || req.headers['x-agent-context-session-id'] || '').trim();
  const logEvent = event => ({ at: new Date().toISOString(), requestId,
    sessionId: sessionKey.slice(0, 256), threadId: String(req.headers['thread-id'] || '').slice(0, 256), ...event });
  const allAccounts = Array.isArray(state.accounts.codex) ? state.accounts.codex : [];
  const pinnedPool = accountRef
    ? allAccounts.filter(account => account.accountRef === accountRef)
    : [];
  const selection = { provider: 'codex', sessionKey, excludeAccountRefs: [] };
  // Match the existing preferred-pin contract, including a present but blocked
  // account: no matching object and no schedulable match are both fallbacks.
  const chosen = (pinnedPool.length && deps.chooseAccount(pinnedPool, state, 'codex', selection))
    || deps.chooseAccount(allAccounts, state, 'codex', selection);
  // 没有可用 Codex 账号、但池里有其它 provider 的账号时不拒绝升级：模型要等首帧才知道，
  // 可能是别名 / 其它 provider，由网关 HTTP 通道服务（见 codex-responses-ws-http-bridge.js）。
  const account = chosen && chosen.accessToken
    ? chosen
    : (hasNonCodexAccounts(state) ? GATEWAY_HTTP_ACCOUNT : null);
  if (!account) {
    rejectUpgrade(socket, '503 Service Unavailable', 'no_available_account');
    return;
  }

  function chooseModelAccount(excluded, model, preferredRef = '') {
    // 别名 / 其它 provider 的模型：直接交给网关 HTTP 管线（它负责别名解析与跨 provider 选号），
    // 同一轮里只给一次机会，避免重试死循环。
    if (routesElsewhere(model)) {
      return excluded.has(GATEWAY_HTTP_ACCOUNT.accountRef) ? null : GATEWAY_HTTP_ACCOUNT;
    }
    const live = Array.isArray(state.accounts.codex) ? state.accounts.codex : [];
    const candidates = selectPoolAccountsForModel({
      pool: live.filter(item => item.accessToken && !excluded.has(item.accountRef)),
      provider: 'codex', model, state, options
    }).pool;
    return deps.chooseAccount(candidates, state, 'codex', {
      provider: 'codex', sessionKey, model, excludeAccountRefs: excluded,
      preferredAccountRef: preferredRef, cursorState: state.cursors
    });
  }

  function recordFailure(failedAccount, policy, model) {
    // HTTP bridge accounts are accounted for by the HTTP pipeline itself.
    if (isGatewayHttpAccount(failedAccount)) return;
    const gate = deps.accountRuntimeGate;
    if (gate && typeof gate.observeFailure === 'function') {
      gate.observeFailure({ account: failedAccount, provider: 'codex', policy,
        model, defaultThreshold: 1, source: 'server.upstream.failure' });
      return;
    }
    applyAccountFailurePolicy(failedAccount, policy, {
      model, markProxyAccountFailure: deps.markProxyAccountFailure, defaultThreshold: 1
    });
  }

  async function connectAccount(next, budgetMs, replacement = false) {
    if (isGatewayHttpAccount(next)) {
      return createGatewayHttpResponsesConnection({
        baseUrl: resolveLoopbackBaseUrl(options),
        clientHeaders: req.headers,
        fetchImpl: deps.fetchImpl,
        maxReplayBytes: options.maxRequestBodyBytes
      });
    }
    const baseUrl = String(next.openaiBaseUrl || options.codexBaseUrl || '').trim().replace(/\/+$/, '');
    if (deps.isLoopbackUrl(baseUrl, options.port)) {
      const error = new Error('infinite_loop_detected');
      error.loopback = true;
      throw error;
    }
    const target = new URL(`${baseUrl}/responses`);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers = buildResponsesWebSocketHeaders(req.headers, next);
    // The previous account's opaque turn-state is not a cross-account resume
    // token. Full public context is reconstructed by the connection ledger.
    if (replacement) delete headers['x-codex-turn-state'];
    // A connected but idle WebSocket consumes no inference capacity. Attempts
    // are tracked at response.create/terminal-event boundaries by the bridge.
    const finish = () => {};
    try {
      const upstream = await connectUpstreamWebSocket(target, headers, socket,
        Math.min(budgetMs, deps.handshakeTimeoutMs || 10000));
      upstream.once('close', finish);
      upstream.on('error', finish);
      plugins?.noteAccount(next);
      return { ws: upstream, account: next, finish };
    } catch (error) {
      finish();
      const policy = classifyUpstreamFailure({ provider: 'codex', account: next,
        statusCode: error.statusCode, headers: error.headers, body: error.body, error });
      recordFailure(next, policy);
      error.retryAnotherAccount = policy.shouldRetryAnotherAccount;
      error.remotePoolUnavailable = policy.kind === 'remote_pool_unavailable';
      error.retryAfterMs = policy.retryHintMs;
      throw error;
    }
  }

  let initial;
  const remotePoolRecoveryOwner = {};
  let remotePoolRecoveryAttempted = false;
  const remotePoolResponseRecoveryUsed = new Set();
  try {
    let candidate = account;
    const attempted = new Set();
    const maxAttempts = Math.max(1, Math.min(16, Number(options.maxAttempts) || 3));
    const deadline = Date.now() + (deps.handshakeTimeoutMs || 10000);
    while (candidate) {
      attempted.add(candidate.accountRef);
      try {
        initial = await connectAccount(candidate, Math.max(1, deadline - Date.now()), attempted.size > 1);
        if (remotePoolRecoveryAttempted) {
          completeRemotePoolRecovery(
            remotePoolKey(candidate, '__websocket_handshake__'),
            { available: true }
          );
        }
        break;
      } catch (error) {
        if (remotePoolRecoveryAttempted) {
          completeRemotePoolRecovery(
            remotePoolKey(candidate, '__websocket_handshake__'),
            { available: false, retryAfterMs: error.retryAfterMs }
          );
        }
        if (error.remotePoolUnavailable && !remotePoolRecoveryAttempted) {
          const key = remotePoolKey(candidate, '__websocket_handshake__');
          const recovery = beginRemotePoolRecovery(key, error.retryAfterMs, Date.now(), remotePoolRecoveryOwner);
          if (recovery.leader) {
            remotePoolRecoveryAttempted = true;
            await waitForRemotePoolRecovery(recovery.waitMs);
            continue;
          }
          rejectUpgrade(socket, '503 Service Unavailable', 'remote_pool_unavailable', {
            'Retry-After': String(Math.max(1, Math.ceil(recovery.retryAfterMs / 1000)))
          });
          return;
        }
        if (error.remotePoolUnavailable) {
          const key = remotePoolKey(candidate, '__websocket_handshake__');
          completeRemotePoolRecovery(key, { available: false, retryAfterMs: error.retryAfterMs });
          rejectUpgrade(socket, '503 Service Unavailable', 'remote_pool_unavailable', {
            'Retry-After': String(Math.max(1, Math.ceil(Number(error.retryAfterMs) / 1000) || 1))
          });
          return;
        }
        if (!error.retryAnotherAccount || attempted.size >= maxAttempts || Date.now() >= deadline || socket.destroyed) throw error;
        candidate = deps.chooseAccount(allAccounts, state, 'codex', { ...selection, excludeAccountRefs: attempted });
        if (!candidate) throw error;
      }
    }
    if (socket.destroyed) { initial.finish(); initial.ws.terminate(); return; }
    const server = new WebSocket.Server({ noServer: true });
    server.handleUpgrade(req, socket, head, client => {
      bridgeResponsesSession(plugins ? plugins.wrapClient(client) : client, initial, {
        classifyFailure: classifyResponseFailure,
        connect: (next, budgetMs) => connectAccount(next, budgetMs, true),
        ...(plugins ? plugins.bridgeHooks() : {}),
        chooseInitial: model => chooseModelAccount(new Set(), model, initial.account.accountRef),
        chooseForTurn: (model, preferredRef) => chooseModelAccount(new Set(), model, preferredRef),
        chooseRetryAccount: (job, failed) => chooseModelAccount(
          new Set(),
          job && job.model,
          failed && failed.account && failed.account.accountRef
        ),
        canContinue: (model, ref) => chooseModelAccount(new Set(
          (state.accounts.codex || []).filter(item => item.accountRef !== ref).map(item => item.accountRef)
        ), model, ref)?.accountRef === ref,
        chooseNext: chooseModelAccount,
        prepareRemotePoolRetry: ({ job, failed, failure, failureFrame }) => {
          const key = remotePoolKey(failed && failed.account, job && job.model);
          if (!key) return { retry: false, failureFrame };
          const retryAfterMs = Number(failure && failure.policy && failure.policy.retryHintMs) || 1000;
          if (remotePoolResponseRecoveryUsed.has(key)) {
            const recoveryState = beginRemotePoolRecovery(key, retryAfterMs, Date.now(), remotePoolRecoveryOwner);
            completeRemotePoolRecovery(key, { available: false, retryAfterMs });
            return {
              retry: false,
              key,
              failureFrame,
              retryAfterMs: recoveryState.retryAfterMs
            };
          }
          const recoveryState = beginRemotePoolRecovery(key, retryAfterMs, Date.now(), remotePoolRecoveryOwner);
          if (!recoveryState.leader) {
            return {
              retry: false,
              key,
              failureFrame,
              retryAfterMs: recoveryState.retryAfterMs
            };
          }
          remotePoolResponseRecoveryUsed.add(key);
          return {
            retry: true,
            key,
            waitMs: recoveryState.waitMs,
            retryAfterMs: recoveryState.retryAfterMs
          };
        },
        chooseRetryAccount: (job, failed) => chooseModelAccount(
          new Set(),
          job && job.model,
          failed && failed.account && failed.account.accountRef
        ),
        waitForRemotePoolRecovery,
        completeRemotePoolRecovery,
        onAttemptStart: (activeAccount, model) => {
          if (!isGatewayHttpAccount(activeAccount)) deps.accountActivity?.begin('codex', activeAccount.accountRef, model);
        },
        onAttemptEnd: (activeAccount, model) => {
          if (!isGatewayHttpAccount(activeAccount)) deps.accountActivity?.end('codex', activeAccount.accountRef, model);
        },
        onFailure: (failedAccount, failure, model) => recordFailure(failedAccount, failure.policy, model),
        onSuccess: (successfulAccount, model) => {
          if (isGatewayHttpAccount(successfulAccount)) return;
          const gate = deps.accountRuntimeGate;
          if (gate && typeof gate.observeSuccess === 'function') {
            gate.observeSuccess({
              account: successfulAccount,
              provider: 'codex',
              model,
              source: 'server.upstream.success'
            });
            return;
          }
          deps.markProxyAccountSuccess?.(successfulAccount, { model });
        },
        onRetry: event => deps.onRetry?.(logEvent(event)),
        onRetryUnavailable: event => deps.onRetryUnavailable?.(logEvent(event))
      }, { maxAttempts: options.maxAttempts, maxReplayBytes: options.maxRequestBodyBytes });
    });
  } catch (error) {
    if (initial) { initial.finish(); initial.ws.terminate(); }
    if (deps.onError) deps.onError(error);
    rejectUpgrade(socket, error.loopback ? '503 Service Unavailable' : '502 Bad Gateway',
      error.loopback ? 'infinite_loop_detected' : 'upstream_failed');
  }
}

module.exports = { buildResponsesWebSocketHeaders, handleCodexResponsesWebSocket };
