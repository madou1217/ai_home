'use strict';

const { PluginError } = require('../sdk/errors');

function createInvocationContext(options = {}) {
  const parent = options.parent;
  const now = options.now || Date.now;
  const inheritedDeadline = parent?.deadline || Infinity;
  const requested = Number(options.deadline || inheritedDeadline);
  const deadline = Math.min(inheritedDeadline, Number.isFinite(requested) ? requested : inheritedDeadline);
  const controller = new AbortController();
  const signal = options.signal;
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const context = {
    invocationId: String(options.invocationId || parent?.invocationId || cryptoRandomId()),
    instanceId: String(options.instanceId || parent?.instanceId || ''),
    generation: Number(options.generation || parent?.generation || 0),
    deadline,
    signal: controller.signal,
    depth: Number(parent?.depth || 0) + 1,
    child(childOptions = {}) {
      if (context.depth >= 32) throw new PluginError('plugin_invocation_recursion');
      return createInvocationContext({ ...childOptions, parent: context, signal: controller.signal });
    },
    assertActive() {
      if (controller.signal.aborted) throw new PluginError('plugin_rpc_cancelled');
      if (now() >= deadline) throw new PluginError('plugin_rpc_timeout');
    },
    dispose() { if (signal) signal.removeEventListener('abort', onAbort); controller.abort(); }
  };
  return context;
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

module.exports = { createInvocationContext };
