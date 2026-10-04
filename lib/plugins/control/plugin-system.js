'use strict';

// 把控制面（control）与宿主生命周期（runtime-service）组装成服务端的插件系统。
// 每个 server 实例（以其长期存在的 state 对象为键）恰好一份，管理路由与启动恢复共用。

const path = require('node:path');
const { createPluginControl } = require('./control');
const { createPluginRuntimeService } = require('./runtime-service');

const systems = new WeakMap();

function hostVersionOf() {
  try { return require(path.join(__dirname, '..', '..', '..', 'package.json')).version; } catch (_error) { return '1.0.0'; }
}

function createPluginSystem(options = {}) {
  const hostVersion = options.hostVersion || hostVersionOf();
  const control = createPluginControl({ aiHomeDir: options.aiHomeDir, hostVersion, stateStore: options.stateStore });
  const runtime = createPluginRuntimeService({
    aiHomeDir: options.aiHomeDir,
    hostVersion,
    socketPath: options.socketPath,
    env: options.env,
    desiredPlugins: () => control.desiredPlugins(),
    recycleAfterGenerations: options.recycleAfterGenerations,
    backoffMs: options.backoffMs,
    supervisorFactory: options.supervisorFactory,
    log: options.log,
    onHostLog: options.onHostLog
  });
  control.attachRuntime(runtime);
  return { control, runtime };
}

function getPluginSystem(owner, options = {}) {
  if (!owner || typeof owner !== 'object') return createPluginSystem(options);
  if (!systems.has(owner)) systems.set(owner, createPluginSystem(options));
  return systems.get(owner);
}

module.exports = { createPluginSystem, getPluginSystem };
