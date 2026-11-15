'use strict';

// Compatibility owner: membership and output only. Queue I/O, rotation, partial
// records, debounce and capacity are native. Never revive the old Node poller.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');

const MAX_THREADS = 2048;
const MAX_CONTROL_LINE_BYTES = 128 * 1024;

function resolveBinary(options, env) {
  const standard = resolveGoServerBinary({ binaryPath: options.goServerBinary || env.AIH_GO_CORE_BINARY });
  const explicit = Boolean(options.goServerBinary || env.AIH_GO_CORE_BINARY);
  const companion = path.join(path.dirname(standard), process.platform === 'win32' ? 'aih-codex-notifications.exe' : 'aih-codex-notifications');
  for (const file of explicit ? [standard] : [standard, companion]) {
    if (!fs.existsSync(file)) continue;
    const probe = spawnSync(file, ['__codex-notifications', '--capabilities'], withHiddenWindowsConsole({ env, encoding: 'utf8', timeout: 5000, maxBuffer: 16384 }));
    if (probe.status === 0 && probe.stdout.trim() === 'aih-codex-notifications-v1') return file;
  }
  throw new Error('codex_notifications_native_missing_or_outdated');
}

function createNativeNotificationPoller(options = {}) {
  const live = options.liveThreadIds;
  const write = options.writeNotification;
  if (!options.queueFile || typeof write !== 'function') return { poll() {}, addThread() {}, removeThread() {}, stop() {}, ready: Promise.resolve() };
  const env = options.env || process.env;
  const binary = resolveBinary(options, env);
  const initial = Array.from(live || []);
  if (initial.length > MAX_THREADS) throw new Error('notification_thread_capacity_exceeded');
  const child = spawn(binary, ['__codex-notifications', '--parent-pid', String(process.pid)], withHiddenWindowsConsole({ env, stdio: ['pipe', 'pipe', 'pipe'] }));
  const trace = typeof options.writeTrace === 'function' ? options.writeTrace : () => {};
  let stopped = false;
  let exited = false;
  let failed = false;
  let outputPaused = false;
  let drainHandler = null;
  let output = '';
  let dirtyMembership = false;
  let writable = true;
  let finishReady, failReady;
  const ready = new Promise((resolve, reject) => { finishReady = resolve; failReady = reject; });
  // The original factory is synchronous; expose readiness for callers without
  // introducing an unhandled rejection when an existing caller does not await.
  ready.catch(() => {});
  const readyTimeout = setTimeout(() => fail(new Error('notification_ready_timeout')), 5000);
  readyTimeout.unref();
  let finishEnded;
  const ended = new Promise((resolve) => { finishEnded = resolve; });
  let force;
  function stop() {
    if (!stopped) {
      stopped = true;
      if (drainHandler && options.output && typeof options.output.off === 'function') options.output.off('drain', drainHandler);
      drainHandler = null;
      if (exited) { clearTimeout(readyTimeout); return ended; }
      clearTimeout(readyTimeout);
      failReady(new Error('notification_stopped_before_ready'));
      try { child.stdin.end(); } catch (_error) {}
      try { child.kill('SIGTERM'); } catch (_error) {}
      force = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_error) {} }, 4000);
      force.unref();
    }
    return ended;
  }
  function fail(error) {
    if (failed || stopped) return;
    failed = true;
    clearTimeout(readyTimeout);
    failReady(error);
    trace({ direction: 'proxy_internal', action: 'codex_session_notification_failed', error: error.code || error.message, native: true });
    try {
      if (typeof options.onError === 'function') options.onError(error);
      else { try { process.stderr.write(`[aih] ${error.message}\n`); } catch (_error) {} }
    } finally { void stop(); }
  }
  function send(command) {
    if (stopped) return;
    const raw = JSON.stringify(command) + '\n';
    if (Buffer.byteLength(raw) > MAX_CONTROL_LINE_BYTES) { fail(new Error('notification_control_capacity_exceeded')); return; }
    writable = child.stdin.write(raw);
  }
  function synchronize() {
    if (!dirtyMembership || !writable || stopped) return;
    dirtyMembership = false;
    const ids = Array.from(live || []);
    if (ids.length > MAX_THREADS) { fail(new Error('notification_thread_capacity_exceeded')); return; }
    send({ operation: 'replace', threadIds: ids });
  }
  function membership(operation, threadId) {
    if (stopped) return;
    const id = String(threadId || '').trim();
    if (!id) return;
    if (Buffer.byteLength(id) > 4096 || (live && live.size > MAX_THREADS)) { fail(new Error('notification_thread_capacity_exceeded')); return; }
    if (!writable) { dirtyMembership = true; return; }
    send({ operation, threadId: id });
  }
  child.stdin.on('drain', () => { writable = true; synchronize(); });
  child.stdin.on('error', () => { if (!stopped) fail(new Error('notification_control_pipe_failed')); });
  child.once('error', () => { exited = true; finishEnded(); fail(new Error('notification_spawn_failed')); });
  child.once('exit', (code) => {
    exited = true;
    finishEnded(code);
    clearTimeout(readyTimeout);
    clearTimeout(force);
    if (!stopped) fail(new Error(`notification_native_exited:${code}`));
  });
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  function consumeOutput() {
    if (stopped || outputPaused) return;
    if (Buffer.byteLength(output) > MAX_CONTROL_LINE_BYTES * 2) { fail(new Error('notification_output_capacity_exceeded')); return; }
    let boundary;
    while ((boundary = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, boundary); output = output.slice(boundary + 1);
      let message;
      try { message = JSON.parse(line); } catch (_error) { fail(new Error('notification_native_protocol_invalid')); return; }
      if (message.type === 'ready') { clearTimeout(readyTimeout); finishReady(); continue; }
      if (message.type === 'diagnostic') { trace({ direction: 'proxy_internal', action: 'codex_session_notification_diagnostic', ...message, native: true }); continue; }
      const id = String(message.params && message.params.threadId || '');
      if (message.method !== 'thread/status/changed' || !live || !live.has(id)) continue;
      let accepted;
      try { accepted = write(message); } catch (_error) { fail(new Error('notification_output_failed')); return; }
      if (accepted === false && options.output && typeof options.output.once === 'function') {
        child.stdout.pause();
        outputPaused = true;
        drainHandler = () => {
          drainHandler = null;
          outputPaused = false;
          consumeOutput();
          if (!stopped && !outputPaused) child.stdout.resume();
        };
        options.output.once('drain', drainHandler);
        return;
      }
    }
  }
  child.stdout.on('data', (chunk) => { if (!stopped) { output += chunk; consumeOutput(); } });
  const config = { queueFile: options.queueFile, threadIds: initial, startAtEnd: options.startAtEnd !== false, pollIntervalMs: Math.max(100, Number(options.pollIntervalMs) || 500), debounceMs: options.debounceMs === undefined ? 500 : Math.max(0, Number(options.debounceMs) || 0) };
  const raw = JSON.stringify(config) + '\n';
  if (Buffer.byteLength(raw) > MAX_CONTROL_LINE_BYTES) fail(new Error('notification_config_capacity_exceeded'));
  else writable = child.stdin.write(raw);
  return { ready, child, addThread: (id) => membership('add', id), removeThread: (id) => membership('remove', id), poll() { dirtyMembership = true; synchronize(); if (writable) send({ operation: 'poll' }); }, stop };
}

module.exports = { createNativeNotificationPoller };
