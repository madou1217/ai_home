'use strict';

// 宿主侧的插件分发入口。M0 只实现「按顺序串行、上一项输出作下一项输入」一种语义，用于测量与后续接线；
// observer / serial / waterfall / middleware 的区分在 M2 接入网关时按能力合同补齐。
//
// 热路径约束：某个能力没有任何已发布的贡献项时，dispatch 直接返回原值——不启动 Plugin Host 进程、
// 不建立 RPC 连接、不分配调用上下文。没装插件的部署与没有插件化之前的行为和开销保持一致。
// 有贡献项时按发布快照中的稳定顺序逐个调用，快照替换不影响已经开始的调用。

const { PluginError } = require('../sdk/errors');

function createPluginDispatcher(options = {}) {
  const supervisor = options.supervisor;
  if (!supervisor || typeof supervisor.call !== 'function') throw new PluginError('plugin_dispatcher_supervisor_missing');
  let snapshot = Object.freeze({ generation: 0, byCapability: new Map() });

  // contributions: [{ id, capability, order?, instanceId }]，来自已 activate 的代次。
  function publish(generation, contributions = []) {
    const byCapability = new Map();
    const sorted = [...contributions].sort((left, right) => Number(left.order || 0) - Number(right.order || 0)
      || String(left.instanceId || '').localeCompare(String(right.instanceId || ''))
      || String(left.id).localeCompare(String(right.id)));
    for (const item of sorted) {
      if (!byCapability.has(item.capability)) byCapability.set(item.capability, []);
      byCapability.get(item.capability).push(Object.freeze({ id: item.id, instanceId: item.instanceId }));
    }
    snapshot = Object.freeze({ generation: Number(generation) || 0, byCapability });
    return snapshot;
  }

  function hasContributions(capability) {
    return (snapshot.byCapability.get(capability) || []).length > 0;
  }

  async function dispatch(capability, value, callOptions = {}) {
    const current = snapshot;
    const chain = current.byCapability.get(capability);
    if (!chain || chain.length === 0) return { value, invoked: 0 };
    let result = value;
    for (const item of chain) {
      const response = await supervisor.call('invoke', {
        generation: current.generation, contributionId: item.id, value: result
      }, callOptions);
      result = response.value;
    }
    return { value: result, invoked: chain.length };
  }

  return { publish, dispatch, hasContributions, current: () => snapshot };
}

module.exports = { createPluginDispatcher };
