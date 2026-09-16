'use strict';

const WebSocket = require('ws');
const {
  getCodexQuotaFailure, createResponseCommitGate, createResponseReplayLedger
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
  let queued = [];
  let queuedBytes = 0;

  function notify(name, ...args) {
    try { deps[name]?.(...args); } catch (_) { /* Diagnostics must not break transport. */ }
  }

  function dispose(connection) {
    if (!connection) return;
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
    client.pause();
    current.ws.send(data, { binary }, error => {
      if (error) failConnection('forward_failed');
      else if (!closed) client.resume();
    });
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
    if (client.readyState === WebSocket.OPEN) client.close(1000, 'quota_exhausted');
    stop();
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
      const next = deps.chooseNext(job.attempted, job.model);
      if (!next || job.attempted.has(next.accountRef)) { stopReason = 'no_eligible_account'; break; }
      job.attempted.add(next.accountRef);
      let connection;
      try { connection = await deps.connect(next, remainingMs); }
      catch (_) { continue; }
      if (closed || pending !== job) { dispose(connection); return; }
      if (connection.ws.readyState !== WebSocket.OPEN) { dispose(connection); continue; }
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
      const backlog = queued;
      queued = [];
      queuedBytes = 0;
      for (const frame of backlog) acceptClientFrame(frame.data, frame.binary);
      return;
    }
    finishFailedRetry(job, failureFrame, stopReason);
  }

  function acceptClientFrame(data, binary) {
    if (closed) return;
    const payload = parseFrame(data, binary);
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
      const job = pending;
      const quota = getCodexQuotaFailure(event);
      if (quota) {
        const matches = !job || !job.responseId || !event.response?.id || job.responseId === event.response.id;
        if (job && matches && job.model) notify('onQuota', connection.account, event, job.model);
        if (job && matches && !job.gate.committed && job.replayEligible && job.model) {
          // Normalize the full public transcript only on actual quota failure.
          job.replay ||= ledger.replay(job.payload, job.input);
          if (job.replay) {
            job.failureCode = quota.code;
            recover(job, connection, data).catch(() => finishFailedRetry(job, data));
            return;
          }
        }
        reportUnavailable(job, job?.gate.committed ? 'output_already_committed' : 'replay_context_unavailable');
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
        } else if (quota || event?.type === 'error' || event?.type === 'response.failed' || event?.type === 'response.incomplete') {
          pending = null;
        }
      } else toClient(data, binary, connection.ws);
    });
    connection.ws.once('close', (code, reason) => {
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
