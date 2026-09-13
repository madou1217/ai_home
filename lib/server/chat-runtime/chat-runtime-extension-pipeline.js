'use strict';

const EXTENSION_HOOKS = Object.freeze({
  observe: 'observe',
  beforeCommand: 'beforeCommand',
  prepareNextTurn: 'prepareNextTurn',
  beforeToolCall: 'beforeToolCall',
  afterToolCall: 'afterToolCall',
  dispose: 'dispose'
});

class ChatRuntimeExtensionPipeline {
  constructor(options = {}) {
    this.extensions = [];
    this.onObserverError = typeof options.onObserverError === 'function'
      ? options.onObserverError
      : () => {};
    for (const extension of options.extensions || []) this.register(extension);
  }

  register(extension) {
    if (!extension || typeof extension !== 'object') {
      throw new TypeError('chat runtime extension must be an object');
    }
    const hooks = Object.values(EXTENSION_HOOKS).filter((name) => extension[name] !== undefined);
    if (hooks.some((name) => typeof extension[name] !== 'function')) {
      throw new TypeError('chat runtime extension hooks must be functions');
    }
    if (hooks.length === 0) throw new TypeError('chat runtime extension has no hooks');
    this.extensions.push(extension);
    return () => this.unregister(extension);
  }

  unregister(extension) {
    const index = this.extensions.indexOf(extension);
    if (index < 0) return false;
    this.extensions.splice(index, 1);
    this.disposeExtension(extension, { reason: 'unregister' });
    return true;
  }

  close() {
    for (const extension of [...this.extensions]) this.unregister(extension);
  }

  async runWaterfall(stage, value, context = {}) {
    requireStage(stage, EXTENSION_HOOKS.prepareNextTurn);
    let current = value;
    for (const extension of this.extensions) {
      if (typeof extension[EXTENSION_HOOKS.prepareNextTurn] !== 'function') continue;
      const next = await extension[EXTENSION_HOOKS.prepareNextTurn](current, context);
      if (next !== undefined) current = next;
    }
    return current;
  }

  async runSerial(stage, value, context = {}) {
    requireStage(stage, EXTENSION_HOOKS.beforeCommand);
    for (const extension of this.extensions) {
      if (typeof extension[EXTENSION_HOOKS.beforeCommand] === 'function') {
        await extension[EXTENSION_HOOKS.beforeCommand](value, context);
      }
    }
  }

  async runToolHook(stage, event, context = {}) {
    if (stage !== EXTENSION_HOOKS.beforeToolCall && stage !== EXTENSION_HOOKS.afterToolCall) {
      throw new Error(`chat_runtime_extension_stage_unsupported:${String(stage || '')}`);
    }
    for (const extension of this.extensions) {
      const hook = extension[stage];
      if (typeof hook === 'function') await hook(event, context);
    }
  }

  observe(value, context = {}) {
    for (const extension of this.extensions) {
      if (typeof extension[EXTENSION_HOOKS.observe] !== 'function') continue;
      try {
        const result = extension[EXTENSION_HOOKS.observe](value, context);
        if (result && typeof result.then === 'function') {
          result.catch((error) => this.reportObserverError(error, value, context));
        }
      } catch (error) {
        this.reportObserverError(error, value, context);
      }
    }
  }

  reportObserverError(error, value, context) {
    try { this.onObserverError(error, value, context); } catch (_sinkError) {}
  }

  disposeExtension(extension, context) {
    if (typeof extension.dispose !== 'function') return;
    try {
      const result = extension.dispose(context);
      if (result && typeof result.then === 'function') {
        result.catch((error) => this.reportObserverError(error, {
          type: 'extension.dispose.failed'
        }, context));
      }
    } catch (error) {
      this.reportObserverError(error, { type: 'extension.dispose.failed' }, context);
    }
  }
}

function createChatRuntimeExtensionPipeline(options = {}) {
  if (options instanceof ChatRuntimeExtensionPipeline) return options;
  if (Array.isArray(options)) return new ChatRuntimeExtensionPipeline({ extensions: options });
  if (options && options.extensions instanceof ChatRuntimeExtensionPipeline) {
    return options.extensions;
  }
  return new ChatRuntimeExtensionPipeline(options);
}

function requireStage(stage, expected) {
  if (String(stage || '').trim() !== expected) {
    throw new Error(`chat_runtime_extension_stage_unsupported:${String(stage || '')}`);
  }
}

module.exports = {
  ChatRuntimeExtensionPipeline,
  createChatRuntimeExtensionPipeline,
  EXTENSION_HOOKS
};
