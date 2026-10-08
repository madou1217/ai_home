'use strict';

const { PluginError } = require('../sdk/errors');

function createPluginHostAdapter(options = {}) {
  const manager = options.manager;
  const pipeline = options.pipeline;
  if (!manager || !pipeline) throw new PluginError('plugin_adapter_dependencies_missing');

  function contributions() {
    const listed = manager.list();
    const enabled = new Set(listed.instances.filter((item) => item.enabled).map((item) => item.instanceId));
    return listed.installed.flatMap((item) => item.manifest.contributes.map((contribution) => ({
      ...contribution, pluginId: item.pluginId,
      instanceId: listed.instances.find((instance) => instance.pluginId === item.pluginId && enabled.has(instance.instanceId))?.instanceId
    }))).filter((item) => item.instanceId);
  }

  function refresh() {
    const listed = manager.list();
    const generation = Number(listed.activeGeneration || 0);
    pipeline.install(generation, contributions());
    return generation;
  }

  async function invoke(id, value, context) {
    if (!context || typeof context.assertActive !== 'function') throw new PluginError('plugin_invocation_context_invalid');
    context.assertActive();
    const response = await manager.invoke(id, value, { signal: context.signal, timeoutMs: Math.max(1, context.deadline - Date.now()) });
    context.assertActive();
    return response?.value;
  }

  return { invoke, pipeline, refresh };
}

module.exports = { createPluginHostAdapter };
