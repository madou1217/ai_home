'use strict';

const { PluginError } = require('../sdk/errors');
const { createInvocationContext } = require('./invocation');

const MODES = Object.freeze({ observer: 'observer', terminal: 'terminal', serial: 'serial', waterfall: 'waterfall', middleware: 'middleware' });

function sortContributions(items) {
  return [...items].sort((left, right) => Number(left.order || 0) - Number(right.order || 0)
    || String(left.instanceId || '').localeCompare(String(right.instanceId || ''))
    || String(left.id || '').localeCompare(String(right.id || '')));
}

function createCapabilityPipeline(options = {}) {
  const invoke = options.invoke;
  const report = options.report || (() => {});
  let snapshot = Object.freeze({ generation: 0, byCapability: new Map() });

  function install(generation, contributions = []) {
    const byCapability = new Map();
    for (const item of sortContributions(contributions)) {
      if (!byCapability.has(item.capability)) byCapability.set(item.capability, []);
      byCapability.get(item.capability).push(Object.freeze({ ...item }));
    }
    snapshot = Object.freeze({ generation: Number(generation), byCapability });
    return snapshot;
  }

  function current() { return snapshot; }

  async function call(item, value, context, mode) {
    const child = context.child({ instanceId: item.instanceId, generation: snapshot.generation });
    child.assertActive();
    try { return await invoke(item.id, value, { ...child, mode }); }
    finally { child.dispose(); }
  }

  async function observe(capability, value, options = {}) {
    const items = snapshot.byCapability.get(capability) || [];
    const context = createInvocationContext({ ...options, generation: snapshot.generation });
    for (const item of items) {
      try { await call(item, value, context, MODES.observer); }
      catch (error) { report({ phase: 'observe', item, error }); }
    }
  }

  async function serial(capability, value, options = {}) {
    const items = snapshot.byCapability.get(capability) || [];
    const context = createInvocationContext({ ...options, generation: snapshot.generation });
    let result = value;
    for (const item of items) {
      result = await call(item, result, context, MODES.serial);
    }
    return result;
  }

  async function waterfall(capability, value, options = {}) {
    const items = snapshot.byCapability.get(capability) || [];
    const context = createInvocationContext({ ...options, generation: snapshot.generation });
    let result = value;
    for (const item of items) {
      result = await call(item, result, context, MODES.waterfall);
      if (result === undefined) throw new PluginError('plugin_waterfall_invalid');
    }
    return result;
  }

  async function terminal(capability, value, options = {}) {
    const items = snapshot.byCapability.get(capability) || [];
    const context = createInvocationContext({ ...options, generation: snapshot.generation });
    let result = value;
    for (const item of items) {
      const candidate = await call(item, value, context, MODES.terminal);
      if (candidate !== undefined) result = candidate;
    }
    return result;
  }

  async function middleware(capability, value, terminal, options = {}) {
    const items = snapshot.byCapability.get(capability) || [];
    const context = createInvocationContext({ ...options, generation: snapshot.generation });
    let index = -1;
    const dispatch = async (position, current) => {
      if (position <= index) throw new PluginError('plugin_next_called_twice');
      index = position;
      const item = items[position];
      if (!item) return terminal(current, context);
      let nextCalled = false;
      const next = async (nextValue = current) => {
        if (nextCalled) throw new PluginError('plugin_next_called_twice');
        nextCalled = true;
        return dispatch(position + 1, nextValue);
      };
      return invoke(item.id, current, { ...context, mode: MODES.middleware, next });
    };
    try { return await dispatch(0, value); } finally { context.dispose(); }
  }

  return { current, install, middleware, observe, serial, terminal, waterfall };
}

module.exports = { MODES, createCapabilityPipeline, sortContributions };
