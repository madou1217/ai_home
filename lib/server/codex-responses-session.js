'use strict';

const WebSocket = require('ws');
const {
  createResponseCommitGate, createResponseReplayLedger
} = require('./codex-response-recovery');

function parseFrame(data, binary) {
  if (binary) return null;
  try { return JSON.parse(data.toString()); } catch (_) { return null; }
}

// Keep the native agent/client alive while replacing only the failed upstream.
// Retry the rejected inference, never send a new prompt or execute a local tool.
function bridgeResponsesSession(client, initial, deps, options = {}) {
  const ledger = createResponseReplayLedger(options.maxReplayBytes);
  const maxAttempts = Math.max(1, Math.min(16, Number(options.maxAttempts) || 3));
  let current = initial;
  let pending = null;
  let recovering = false;
  let closed = false;
  let pipelined = false;
  let receivedClientFrame = false;
  let queued = [];
  let queuedBytes = 0;
  // Codex binds a Responses WebSocket to the model from its first turn, but
  // later response.create frames may omit model. Keep that connection-level
  // binding for the Node fallback path as well; the upstream HTTP/WS endpoint
  // still requires the concrete model on every request body.
  let boundModel = '';

  function normalizeClientFrame(data, payload) {
    if (!payload || payload.type !== 'response.create') return { data, payload };
    const explicit = String(payload.model || '').trim();
    if (explicit) {
      if (!boundModel) boundModel = explicit;
      return { data, payload };
    }
    if (!boundModel) return { data, payload };
    const normalized = { ...payload, model: boundModel };
    return { data: Buffer.from(JSON.stringify(normalized)), payload: normalized };
  }

  function notify(name, ...args) {
    try { deps[name]?.(...args); } catch (_) { /* Diagnostics must not break transport. */ }
  }

  function dispose(connection) {
    if (!connection) return;
    releaseAttempts(connection, true);
    connection.finish();
    connection.ws.terminate();
  }

  function stop() {
    if (closed) return;
    closed = true;
    pending = null;
    queued = [];
    queuedBytes = 0;
    ledger.clear();
    dispose(current);
    current = null;
  }

  function failConnection(reason) {
    if (client.readyState === WebSocket.OPEN) client.close(1011, reason);
    stop();
  }

  function toClient(data, binary = false, source = null) {
    if (closed || client.readyState !== WebSocket.OPEN) return;
    if (source) source.pause();
    client.send(data, { binary }, error => {
      if (error) failConnection('forward_failed');
      else if (source && current && source === current.ws && !recovering) source.resume();
    });
  }

  function flushPreamble(job) {
    for (const frame of job ? job.gate.flush() : []) toClient(frame);
  }

  function toUpstream(data, binary) {
    if (!current || current.ws.readyState !== WebSocket.OPEN) return failConnection('upstream_closed');
    const payload = parseFrame(data, binary);
    if (payload?.type === 'response.create') {
      if (current.reservedAttempt) current.reservedAttempt = false;
      else reserveAttempt(current, String(payload.model || boundModel));
    }
    client.pause();
    current.ws.send(data, { binary }, error => {
      if (error) failConnection('forward_failed');
      else if (!closed) client.resume();
    });
  }

  function reserveAttempt(connection, model) {
    connection.activeAttempts ||= [];
    connection.activeAttempts.push(model);
    notify('onAttemptStart', connection.account, model);
  }

  async function connectForAttempt(account, budgetMs, model) {
    const reservation = { account };
    reserveAttempt(reservation, model);
    try {
      const connection = await deps.connect(account, budgetMs);
      connection.activeAttempts = reservation.activeAttempts;
      connection.reservedAttempt = true;
      return connection;
    } catch (error) {
      releaseAttempts(reservation, true);
      throw error;
    }
  }

  function releaseAttempts(connection, all = false) {
    if (!connection?.activeAttempts) return;
    do {
      const model = connection.activeAttempts.shift();
      if (model !== undefined) notify('onAttemptEnd', connection.account, model);
    } while (all && connection.activeAttempts.length);
  }

  function reportUnavailable(job, reason) {
    notify('onRetryUnavailable', { model: job && job.model || '', reason });
  }

  function finishFailedRetry(job, failureFrame, reason = 'recovery_failed') {
    if (closed || pending !== job) return;
    reportUnavailable(job, reason);
    recovering = false;
    flushPreamble(job);
    toClient(failureFrame);
    pending = null;
    // Preserve the real terminal error, not a fabricated successful completion.
    if (client.readyState === WebSocket.OPEN) client.close(1000, 'upstream_rejected');
    stop();
  }

  function flushQueuedFrames() {
    const backlog = queued;
    queued = [];
    queuedBytes = 0;
    for (const frame of backlog) acceptClientFrame(frame.data, frame.binary);
  }

  function rejectInitialRequest(status, code, message) {
    toClient(JSON.stringify({ type: 'error', status, error: { type: code, code, message } }));
    if (client.readyState === WebSocket.OPEN) client.close(1000, code);
    stop();
  }

  async function routeInitialRequest(next, data, binary, nextModel = '') {
    if (nextModel) {
      // Publish the new binding before the asynchronous dial so queued
      // response.create frames that omit model inherit the target model.
      boundModel = nextModel;
    }
    recovering = true;
    const previous = current;
    current = null;
    dispose(previous);
    let connection;
    try { connection = await connectForAttempt(next, 30_000, nextModel || boundModel); }
    catch (_) {
      rejectInitialRequest(502, 'upstream_unavailable', 'Codex WebSocket upstream connection failed');
      return;
    }
    if (closed) { dispose(connection); return; }
    if (connection.ws.readyState !== WebSocket.OPEN) {
      dispose(connection);
      rejectInitialRequest(502, 'upstream_unavailable', 'Codex WebSocket upstream connection failed');
      return;
    }
    current = connection;
    if (nextModel) {
      // A model switch starts a new connection-local upstream cache. Keep the
      // client socket and its session alive, but bind subsequent omitted-model
      // frames to the newly selected model.
      ledger.clear();
      pipelined = false;
      pending = null;
    }
    recovering = false;
    attach(connection);
    acceptClientFrame(data, binary, true);
    flushQueuedFrames();
  }

  async function recover(job, failed, failureFrame) {
    recovering = true;
    current = null; // Late events from the old peer cannot close the new peer.
    dispose(failed);
    job.deadline ||= Date.now() + 30_000;
    let stopReason = 'attempt_budget_exhausted';
    while (!closed && pending === job && job.attempted.size < maxAttempts) {
      const remainingMs = job.deadline - Date.now();
      if (remainingMs <= 0) { stopReason = 'retry_deadline_exceeded'; break; }
      // 插件钩子（可选）：上一次尝试以未提交失败结束——等插件中间件决定是否停止换号，并刷新账号偏好。
      if (deps.beforeRecover) {
        const verdict = await deps.beforeRecover(job);
        if (closed || pending !== job) return;
        if (verdict === 'stop') { stopReason = 'plugin_stopped'; break; }
      }
      const next = deps.chooseNext(job.attempted, job.model);
      if (!next || job.attempted.has(next.accountRef)) { stopReason = 'no_eligible_account'; break; }
      job.attempted.add(next.accountRef);
      let connection;
      try { connection = await connectForAttempt(next, remainingMs, job.model); }
      catch (_) { continue; }
      if (closed || pending !== job) { dispose(connection); return; }
      if (connection.ws.readyState !== WebSocket.OPEN) { dispose(connection); continue; }
      // 插件钩子（可选）：新尝试的中间件在重放前运行；拒绝则不重放，客户端收到插件的错误事件。
      if (deps.beforeReplay) {
        const verdict = await deps.beforeReplay(job, next);
        if (closed || pending !== job) { dispose(connection); return; }
        if (verdict && verdict.reject) { dispose(connection); finishFailedRetry(job, verdict.reject, 'plugin_rejected'); return; }
        if (connection.ws.readyState !== WebSocket.OPEN) { dispose(connection); continue; }
      }
      current = connection;
      job.gate = createResponseCommitGate();
      job.responseId = '';
      job.input = job.replay.input;
      recovering = false;
      attach(connection);
      notify('onRetry', {
        fromAccountRef: failed.account.accountRef, toAccountRef: next.accountRef,
        model: job.model, attempt: job.attempted.size, maxAttempts, reason: job.failureCode
      });
      toUpstream(JSON.stringify(job.replay), false);
      flushQueuedFrames();
      return;
    }
    finishFailedRetry(job, failureFrame, stopReason);
  }

  function acceptClientFrame(data, binary, routed = false) {
    if (closed) return;
    const parsedPayload = parseFrame(data, binary);
    if (parsedPayload && parsedPayload.type === 'response.create' && !recovering) {
      const explicitModel = String(parsedPayload.model || '').trim();
      if (boundModel && explicitModel && explicitModel !== boundModel) {
        // Codex deliberately reuses a WebSocket while changing models. The
        // upstream connection is model-bound, so rotate only that peer and
        // keep the client connection alive. A switch while a turn is pending
        // remains a real concurrent request and is rejected below.
        if (pending || pipelined) {
          rejectInitialRequest(400, 'concurrent_response_create', '同一 WebSocket 连接只允许串行请求');
          return;
        }
        const next = deps.chooseNext(new Set(), explicitModel);
        if (!next) {
          rejectInitialRequest(503, 'no_available_account', 'No available Codex account supports the requested model');
          return;
        }
        routeInitialRequest(next, Buffer.from(data), binary, explicitModel)
          .catch(() => failConnection('model_switch_failed'));
        return;
      }
    }
    const normalized = normalizeClientFrame(data, parsedPayload);
    data = normalized.data;
    const payload = normalized.payload;
    if (recovering) {
      if (payload && payload.type === 'response.cancel') {
        if (client.readyState === WebSocket.OPEN) client.close(1000, 'cancelled');
        stop();
        return;
      }
      queuedBytes += data.length;
      if (queued.length >= 16 || queuedBytes > 32 * 1024 * 1024) return failConnection('recovery_queue_limit');
      queued.push({ data: Buffer.from(data), binary });
      return;
    }
    const initialFrame = !receivedClientFrame;
    receivedClientFrame = true;
    if (!routed && !pending && !pipelined && payload?.type === 'response.create' && typeof payload.model === 'string' && payload.model.trim()
        && (initialFrame || deps.chooseForTurn)) {
      const next = deps.chooseForTurn
        ? deps.chooseForTurn(payload.model, current.account.accountRef)
        : deps.chooseInitial(payload.model);
      if (!next) {
        rejectInitialRequest(503, 'no_available_account', 'No available Codex account supports the requested model');
        return;
      }
      if (next.accountRef !== current.account.accountRef) {
        // Before the first inference there is no connection-owned history to
        // migrate. Preserve arbitrary native input (including file references).
        if (initialFrame) {
          routeInitialRequest(next, Buffer.from(data), binary).catch(() => failConnection('initial_routing_failed'));
          return;
        }
        const replay = ledger.replay(payload, ledger.expand(payload));
        if (replay) {
          ledger.clear();
          routeInitialRequest(next, Buffer.from(JSON.stringify(replay)), binary).catch(() => failConnection('initial_routing_failed'));
          return;
        }
        if (!deps.canContinue?.(payload.model, current.account.accountRef)) {
          rejectInitialRequest(409, 'replay_context_unavailable', 'Account unavailable and conversation context cannot be replayed on another account');
          return;
        }
      }
    }
    if (payload && payload.type === 'response.create') {
      if (pending) {
        // Pipelining remains transparent: an uncorrelated error cannot be
        // safely attributed to one of multiple concurrent response.create's.
        flushPreamble(pending);
        pipelined = true;
        pending = null;
        ledger.clear();
      } else if (!pipelined) {
        const input = ledger.expand(payload);
        pending = {
          model: String(payload.model || ''), input,
          payload, replay: null, replayEligible: true, gate: createResponseCommitGate(),
          attempted: new Set([current.account.accountRef]), responseId: '', deadline: 0
        };
      }
    } else if (pending) {
      // Cancellation, binary frames and unknown extensions are not replayable.
      pending.replayEligible = false;
      pending.input = null;
      flushPreamble(pending);
    }
    toUpstream(data, binary);
  }

  function attach(connection) {
    connection.ws.on('message', (data, binary) => {
      if (closed || current !== connection || recovering) return;
      const event = parseFrame(data, binary);
      if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event?.type)) {
        releaseAttempts(connection);
      }
      const job = pending;
      const failure = deps.classifyFailure(event, connection.account);
      if (failure) {
        const matches = !job || !job.responseId || !event.response?.id || job.responseId === event.response.id;
        if (job && matches && job.model) notify('onFailure', connection.account, failure, job.model);
        if (failure.policy.shouldRetryAnotherAccount && job && matches
            && !job.gate.committed && job.replayEligible && job.model) {
          job.replay ||= ledger.replay(job.payload, job.input);
          if (job.replay) {
            job.failureCode = failure.code;
            recover(job, connection, data).catch(() => finishFailedRetry(job, data));
            return;
          }
        }
        reportUnavailable(job, !failure.policy.shouldRetryAnotherAccount ? 'policy_not_retryable'
          : job?.gate.committed ? 'output_already_committed' : 'replay_context_unavailable');
      }
      if (job) {
        if (event?.type === 'response.created') job.responseId = event.response?.id || '';
        if (binary) {
          job.replayEligible = false;
          job.input = null;
          flushPreamble(job);
        }
        for (const frame of job.gate.push(event, data)) toClient(frame, binary, connection.ws);
        if (event?.type === 'response.completed') {
          ledger.complete(event.response, job.input);
          if (job.payload.generate !== false) notify('onSuccess', connection.account, job.model);
          pending = null;
        } else if (failure || event?.type === 'error' || event?.type === 'response.failed' || event?.type === 'response.incomplete') {
          pending = null;
        }
      } else toClient(data, binary, connection.ws);
    });
    connection.ws.once('close', (code, reason) => {
      releaseAttempts(connection, true);
      connection.finish();
      if (closed || current !== connection || recovering) return;
      flushPreamble(pending);
      if (client.readyState === WebSocket.OPEN) {
        const valid = code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
        client.close(valid ? code : 1011, reason);
      }
      stop();
    });
    connection.ws.on('error', () => {
      if (!closed && current === connection && !recovering) failConnection('upstream_error');
    });
  }

  attach(initial);
  client.on('message', acceptClientFrame);
  client.once('close', stop);
  client.on('error', stop);
  return { stop };
}

module.exports = { bridgeResponsesSession };
