'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { bridgeError, readPrivateJson, writePrivateJson, ensurePrivateDirectory, processAlive } = require('./native-session-bridge-files');
const { nativeIdentityMatches } = require('./zcode-desktop-bridge-binding');

const RUN_ID = /^[a-f0-9-]{36}$/;
const SESSION_ID = /^sess_[A-Za-z0-9_-]{1,160}$/;
const normalizeModel = value => String(value || '').trim().toLowerCase();

function createZcodeDesktopProtocolBridge({ binding, protocol, cwd, pid = process.pid,
  identityMatches = () => nativeIdentityMatches(binding) }) {
  const mailbox = binding.mailboxDir;
  const statusFile = path.join(mailbox, 'hosts', `${pid}.json`);
  const requests = new Map(), sessions = new Map(), active = new Map();
  let configured = false, disposed = false, polling = false, heartbeatTimer, pollTimer;
  const resultFile = runId => path.join(mailbox, 'results', `${runId}.json`);
  const writerFile = sessionId => path.join(mailbox, `writer-${sessionId}.json`);

  function observeInput(message) {
    if (message.id && message.method === 'provider/updateAccountConfig') requests.set(message.id, { method: message.method });
    if (message.id && message.method === 'v4/conversation/subscribe'
      && typeof message.params?.topic === 'string' && message.params.topic.startsWith('conversation/')) {
      const sessionId = message.params.topic.slice('conversation/'.length);
      if (SESSION_ID.test(sessionId)) requests.set(message.id, { method: message.method, sessionId,
        cwd: message.params.workspace?.workspacePath || cwd });
    }
  }

  function observeMessage(message) {
    const request = requests.get(message.id);
    if (request && !message.method) {
      requests.delete(message.id);
      if (request.method === 'provider/updateAccountConfig') configured = !message.error;
      if (request.method === 'v4/conversation/subscribe' && !message.error) {
        sessions.set(request.sessionId, { sessionId: request.sessionId, cwd: request.cwd });
      }
    }
    const snapshot = message.result?.session ? message.result : message.result?.snapshot || message.params?.snapshot;
    const session = snapshot?.session;
    if (SESSION_ID.test(session?.sessionId) && session.workspace?.workspacePath) {
      sessions.set(session.sessionId, { sessionId: session.sessionId, cwd: session.workspace.workspacePath });
    }
    const event = message.params;
    if (message.method !== 'state.updated' || !SESSION_ID.test(event?.sessionId)) return;
    const run = active.get(event.sessionId);
    if (!run?.dispatched) return;
    if (event.reason === 'prompt_started') run.startedRevision = event.revision;
    if (['prompt_completed', 'prompt_failed'].includes(event.reason)) {
      run.completion = event;
      settleRun(event.sessionId, run);
    }
  }

  function settleRun(sessionId, run) {
    const revision = run.acceptedRevision ?? (run.uncertain ? run.startedRevision : undefined);
    if (!Number.isSafeInteger(revision) || !run.completion || run.completion.revision <= revision) return;
    const error = run.stopping ? 'native_session_aborted'
      : run.completion.reason === 'prompt_failed' ? 'zcode_desktop_turn_failed' : '';
    writePrivateJson(resultFile(run.runId), { runId: run.runId, sessionId,
      ...(error ? { error, message: error === 'native_session_aborted' ? '已停止 ZCode 原生任务。'
        : 'ZCode 原生会话执行失败，请查看 Desktop。' } : { state: 'settled' }) });
    releaseWriter(sessionId, run.runId);
  }

  function releaseWriter(sessionId, runId) {
    if (active.get(sessionId)?.runId === runId) active.delete(sessionId);
    if (readPrivateJson(writerFile(sessionId))?.runId === runId) {
      try { fs.unlinkSync(writerFile(sessionId)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  function heartbeat() {
    writePrivateJson(statusFile, { version: binding.version, provider: 'zcode', accountRef: binding.accountRef,
      identity: binding.identity, pid, at: Date.now(), ready: !disposed && configured && identityMatches(),
      cwd, sessions: [...sessions.values()] });
  }

  function cancelled(request) {
    const cancel = readPrivateJson(path.join(mailbox, 'cancellations', `${request.runId}.json`));
    return cancel?.runId === request.runId && cancel.hostId === String(pid);
  }

  function checkBeforeDispatch(request) {
    if (disposed || !configured || !identityMatches()) throw bridgeError('zcode_desktop_account_mismatch');
    if (cancelled(request)) throw bridgeError('native_session_aborted');
    if (request.expiresAt <= Date.now()) throw bridgeError('zcode_desktop_request_expired');
  }

  function acquireWriter(request) {
    const file = writerFile(request.sessionId);
    const previous = readPrivateJson(file);
    if (previous && !processAlive(previous.pid)) {
      if (!RUN_ID.test(previous.runId)) throw bridgeError('zcode_desktop_writer_invalid');
      writePrivateJson(resultFile(previous.runId), { runId: previous.runId, error: 'zcode_desktop_runtime_restarted' });
      fs.unlinkSync(file);
    }
    try { fs.writeFileSync(file, JSON.stringify({ runId: request.runId, pid }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') throw bridgeError('native_session_busy'); throw error; }
    active.set(request.sessionId, { runId: request.runId, dispatched: false });
  }

  async function execute(request) {
    let ownsWriter = false;
    try {
      if (!RUN_ID.test(request.runId) || request.hostId !== String(pid) || request.accountRef !== binding.accountRef
        || request.identity !== binding.identity || !SESSION_ID.test(request.sessionId)
        || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 1024 * 1024
        || !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()
        || !['bypass', 'plan'].includes(request.approvalMode)) throw bridgeError('zcode_desktop_invalid_request');
      checkBeforeDispatch(request);
      acquireWriter(request);
      ownsWriter = true;
      const snapshot = await protocol.request('session/resume', { sessionId: request.sessionId });
      checkBeforeDispatch(request);
      if (snapshot.session?.sessionId !== request.sessionId
        || fs.realpathSync(snapshot.session.workspace?.workspacePath) !== request.cwd) throw bridgeError('zcode_desktop_workspace_mismatch');
      if (['running', 'waiting'].includes(snapshot.session.status)
        || ['running', 'waiting'].includes(snapshot.projection?.status)) throw bridgeError('native_session_busy');
      const model = normalizeModel(request.model);
      const selected = snapshot.settings?.model?.current || snapshot.session.model;
      const selectedId = normalizeModel(typeof selected === 'string' ? selected.split('/').at(-1) : selected?.modelId);
      const selectedReference = normalizeModel(typeof selected === 'string' ? selected : `${selected?.providerId}/${selected?.modelId}`);
      if (!selectedId || model && model !== selectedId && model !== selectedReference) {
        throw bridgeError('zcode_desktop_model_switch_required', '请先在 ZCode Desktop 中选择该模型，再续聊原会话。');
      }
      let expectedRevision = snapshot.runtime?.stateRevision;
      const mode = request.approvalMode === 'plan' ? 'plan' : 'yolo';
      if (snapshot.settings?.mode?.current !== mode) {
        const changed = await protocol.request('session/setMode', { sessionId: request.sessionId, mode,
          ...(Number.isSafeInteger(expectedRevision) ? { expectedRevision } : {}) });
        expectedRevision = changed?.runtime?.stateRevision;
      }
      checkBeforeDispatch(request);
      // Persist dispatch before sending. Timeouts and restarts never replay a
      // prompt whose upstream outcome is uncertain.
      writePrivateJson(resultFile(request.runId), { runId: request.runId, sessionId: request.sessionId, state: 'dispatched' });
      const run = active.get(request.sessionId);
      run.dispatched = true;
      const accepted = await protocol.request('session/send', { sessionId: request.sessionId, content: request.prompt,
        inputId: `aih-${request.runId}`, ...(Number.isSafeInteger(expectedRevision) ? { expectedRevision } : {}) });
      if (accepted?.accepted !== true || accepted.sessionId !== request.sessionId
        || !Number.isSafeInteger(accepted.stateRevision)) throw bridgeError('zcode_desktop_turn_rejected');
      run.acceptedRevision = accepted.stateRevision;
      settleRun(request.sessionId, run);
      ownsWriter = false;
    } catch (error) {
      const run = active.get(request.sessionId);
      if (ownsWriter && run?.dispatched && error.dispatched !== false
        && !['zcode_desktop_protocol_failed', 'zcode_desktop_turn_rejected'].includes(error.code)) {
        run.uncertain = true;
        ownsWriter = false;
      }
      if (readPrivateJson(resultFile(request.runId))?.state !== 'settled') {
        writePrivateJson(resultFile(request.runId), { runId: request.runId, error: error.code || 'zcode_desktop_turn_failed',
          message: error.code ? error.message : 'ZCode 原生会话操作失败。' });
      }
      if (run?.uncertain) settleRun(request.sessionId, run);
    } finally {
      if (ownsWriter) releaseWriter(request.sessionId, request.runId);
    }
  }

  async function poll() {
    if (polling || disposed) return;
    polling = true;
    try {
      for (const [sessionId, run] of active) {
        if (cancelled(run) && (run.acceptedRevision !== undefined || run.uncertain) && !run.stopping) {
          run.stopping = true;
          try { await protocol.request('session/stop', { sessionId }); }
          catch (_) { run.stopping = false; }
        }
      }
      for (const name of fs.readdirSync(path.join(mailbox, 'requests'))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const file = path.join(mailbox, 'requests', name), request = readPrivateJson(file);
        if (fs.existsSync(`${file}.accepted`)) continue;
        if (request?.hostId !== String(pid) || name !== `${request.runId}.json`) continue;
        try { fs.renameSync(file, `${file}.accepted`); } catch (_) { continue; }
        execute(request).catch(() => {});
      }
    } finally { polling = false; }
  }

  return {
    poll, heartbeat,
    start() {
      for (const part of ['', 'hosts', 'requests', 'results', 'cancellations']) ensurePrivateDirectory(path.join(mailbox, part));
      protocol.on('input', observeInput);
      protocol.on('message', observeMessage);
      heartbeat();
      heartbeatTimer = setInterval(() => { try { heartbeat(); } catch (_) {} }, 2000);
      pollTimer = setInterval(() => poll().catch(() => {}), 150);
      heartbeatTimer.unref(); pollTimer.unref();
    },
    dispose() {
      disposed = true;
      clearInterval(heartbeatTimer); clearInterval(pollTimer);
      protocol.off('input', observeInput); protocol.off('message', observeMessage);
      try { heartbeat(); } catch (_) {}
    }
  };
}

module.exports = { createZcodeDesktopProtocolBridge };
