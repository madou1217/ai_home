'use strict';

const { ChatRuntimeError } = require('./contracts');

function createActive(context, prompt, model, reasoningEffort, imagePaths = []) {
  let resolve;
  let reject;
  const done = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return {
    context, done, model, reasoningEffort, nativeThreadId: '', nativeTurnId: '',
    imagePaths, prompt, reject, resolve, settled: false
  };
}

function settleFromNative(active, mapped) {
  if (active.settled) return;
  if (mapped.type === 'turn.failed') {
    const error = new ChatRuntimeError('codex_turn_failed', 502, mapped.payload);
    error.message = text(mapped.payload && mapped.payload.error && mapped.payload.error.message)
      || error.code;
    rejectActive(active, error);
    return;
  }
  active.settled = true;
  active.resolve({
    status: mapped.type === 'turn.interrupted' ? 'interrupted' : 'completed'
  });
}

function rejectActive(active, error) {
  if (active.settled) return;
  active.settled = true;
  active.reject(error instanceof Error ? error : new Error(String(error || 'codex_turn_failed')));
}

function codexCapabilities(runtime) {
  return Object.freeze({
    revision: runtime.capabilityHash || runtime.fingerprint || runtime.version,
    capabilities: Object.freeze({
      'session.resume': support('native'),
      'timeline.reasoning': support('native'),
      'timeline.tool': support('native'),
      'timeline.diff': support('native'),
      'mode.plan': support('native'),
      'interaction.question': support('native'),
      'interaction.approval': support('native'),
      'interaction.plan_confirmation': support(
        'emulated',
        'aih_plan_implementation_workflow'
      ),
      'turn.interrupt': support('native'),
      'turn.steer.current': support('native'),
      'turn.steer.tool_boundary': support(
        'emulated',
        'aih_chat_runtime_tool_boundary_queue'
      ),
      'turn.queue': support('emulated', 'aih_chat_runtime_queue'),
      'slash.execute': support('native'),
      'terminal.stream': support('unsupported', 'codex_app_server_uses_typed_shell_items'),
      'run.adopt': support('native')
    }),
    slashCommands: Object.freeze(['compact']),
    turnInterveneModes: Object.freeze(['steer_current'])
  });
}

function support(value, reason) {
  return Object.freeze({ support: value, ...(reason ? { reason } : {}) });
}

function clientOptions(options, session, runtime) {
  return {
    accountRef: session.executionAccountRef,
    accountIdentityValidator: options.accountIdentityValidator,
    aiHomeDir: options.aiHomeDir,
    endpoint: options.endpoint,
    env: options.env,
    getProfileDir: options.getProfileDir,
    runtimeExecutablePath: runtime.executablePath,
    runtimeFingerprint: runtime.fingerprint,
    runtimeScope: runtime.runtimeScope,
    spawnSyncImpl: options.spawnSyncImpl,
    wsImpl: options.wsImpl
  };
}

function requireSession(session) {
  if (!session || text(session.provider).toLowerCase() !== 'codex' || !text(session.sessionId)) {
    throw new ChatRuntimeError('codex_driver_session_invalid', 422);
  }
  return session;
}

function requireRuntime(runtime) {
  if (!runtime || text(runtime.provider).toLowerCase() !== 'codex' || !text(runtime.runtimeScope)) {
    throw new ChatRuntimeError('codex_driver_runtime_invalid', 422);
  }
  return runtime;
}

function approvalMode(policy) {
  return text(policy && policy.approvalMode).toLowerCase() || 'bypass';
}

function requiredText(value, code) {
  const valueText = text(value);
  if (!valueText) throw new ChatRuntimeError(code, 422);
  return valueText;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = {
  approvalMode,
  clientOptions,
  codexCapabilities,
  createActive,
  rejectActive,
  requiredText,
  requireRuntime,
  requireSession,
  settleFromNative,
  text
};
