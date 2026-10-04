'use strict';

const {
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_MIXED_PORT,
  compileSingBoxConfig
} = require('./config-compiler');
const {
  discoverSingBoxCore,
  executeSingBoxInstall,
  planSingBoxInstall,
  removeManagedSingBox
} = require('./core-manager');
const { SingBoxRuntime } = require('./runtime');
const { chooseLoopbackPort } = require('../loopback-port');

/**
 * sing-box 代理内核插件（契约见 ../mihomo/index.js）。
 * 节点出站由协议插件的 compile['sing-box'] 生成；配置为 JSON，重载为重启式。
 */
module.exports = Object.freeze({
  id: 'sing-box',
  capability: 'proxy-pool.core',
  name: 'sing-box',
  configFormat: 'json',
  platforms: Object.freeze(['macos', 'windows', 'linux']),
  capabilities: Object.freeze({ hotReload: false, dedicatedPorts: true, tun: true }),
  releaseUrl: 'https://github.com/SagerNet/sing-box/releases',
  defaults: Object.freeze({ mixedPort: DEFAULT_MIXED_PORT, controllerPort: DEFAULT_CONTROLLER_PORT }),
  compileConfig: compileSingBoxConfig,
  createRuntime: (options) => new SingBoxRuntime(options),
  chooseLoopbackPort,
  manager: Object.freeze({
    discover: discoverSingBoxCore,
    plan: planSingBoxInstall,
    execute: executeSingBoxInstall,
    remove: removeManagedSingBox
  })
});
