'use strict';

// 把控制面（control）与宿主生命周期（runtime-service）组装成服务端的插件系统。
// 每个 server 实例（以其长期存在的 state 对象为键）恰好一份，管理路由与启动恢复共用。

const path = require('node:path');
const { createPluginControl } = require('./control');
const { createPluginRuntimeService } = require('./runtime-service');
const { getProviderRegistry } = require('../../providers');
const {
  createProviderDescriptorCollector
} = require('../provider/descriptor-collector');

const systems = new WeakMap();

function hostVersionOf() {
  try { return require(path.join(__dirname, '..', '..', '..', 'package.json')).version; } catch (_error) { return '1.0.0'; }
}

function createPluginSystem(options = {}) {
  const hostVersion = options.hostVersion || hostVersionOf();
  const control = createPluginControl({ aiHomeDir: options.aiHomeDir, hostVersion, stateStore: options.stateStore });
  // provider.descriptor 与插件代次同生共死：代次内的描述符先校验、激活后整体替换
  // provider 注册表的 plugin origin；宿主崩溃/停用时清空，内置 defs 永远不受影响。
  const providerRegistry = options.providerDescriptorSync === false
    ? null
    : (options.providerRegistry || getProviderRegistry());
  const descriptorCollector = providerRegistry
    ? createProviderDescriptorCollector({ origin: 'plugin' })
    : null;
  const runtime = createPluginRuntimeService({
    aiHomeDir: options.aiHomeDir,
    hostVersion,
    socketPath: options.socketPath,
    env: options.env,
    desiredPlugins: () => control.desiredPlugins(),
    recycleAfterGenerations: options.recycleAfterGenerations,
    retireTimeoutMs: options.retireTimeoutMs,
    observeQueueLimit: options.observeQueueLimit,
    backoffMs: options.backoffMs,
    supervisorFactory: options.supervisorFactory,
    log: options.log,
    onHostLog: options.onHostLog,
    collectProviderDescriptors: descriptorCollector
      ? async ({ invoke, snapshot }) => {
          const chain = snapshot.byCapability.get('provider.descriptor') || [];
          const contributions = [];
          for (const item of chain) {
            try {
              const result = await invoke(item.id, { kind: 'descriptors' });
              const value = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
              contributions.push({
                id: item.id,
                instanceId: item.instanceId,
                failurePolicy: item.failurePolicy,
                value: value && Object.prototype.hasOwnProperty.call(value, 'value') ? value.value : value
              });
            } catch (error) {
              contributions.push({
                id: item.id,
                instanceId: item.instanceId,
                failurePolicy: item.failurePolicy,
                collect: async () => { throw error; }
              });
            }
          }
          return descriptorCollector.collect(contributions, { register: false });
        }
      : null,
    onProviderDescriptors: providerRegistry
      ? (payload) => providerRegistry.replaceOrigin('plugin', payload.descriptors || [], {
          onError: (error) => {
            if (typeof options.log === 'function') {
              options.log({ event: 'provider_descriptor_rejected', ...error });
            }
          }
        })
      : null
  });
  control.attachRuntime(runtime);
  return { control, runtime };
}

// 让 Go 数据面接入插件：push 把投影推给 Go 的管理接口（由 go-core-host 提供）。重复调用只保留第一份。
function attachGoProjection(system, push, options = {}) {
  if (!system || system.goProjection || typeof push !== 'function') return system && system.goProjection;
  const { createGoProjectionSync } = require('./go-projection-sync');
  system.goProjection = createGoProjectionSync({
    runtime: system.runtime, push, accountRefs: options.accountRefs, log: options.log, intervalMs: options.intervalMs
  });
  system.goProjection.start();
  return system.goProjection;
}

function getPluginSystem(owner, options = {}) {
  if (!owner || typeof owner !== 'object') return createPluginSystem(options);
  if (!systems.has(owner)) systems.set(owner, createPluginSystem(options));
  return systems.get(owner);
}

// 只取已存在的实例，不创建：网关热路径用它判断「有没有插件」，单元测试里的假 state 不会意外拉起插件系统。
function peekPluginSystem(owner) {
  return owner && typeof owner === 'object' ? systems.get(owner) || null : null;
}

module.exports = { attachGoProjection, createPluginSystem, getPluginSystem, peekPluginSystem };
