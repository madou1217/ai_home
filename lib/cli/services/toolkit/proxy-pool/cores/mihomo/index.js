'use strict';

const {
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_MIXED_PORT,
  compileMihomoConfig
} = require('./config-compiler');
const {
  chooseLoopbackPort,
  discoverMihomoCore,
  executeMihomoInstall,
  planMihomoInstall,
  removeManagedMihomo
} = require('./core-manager');
const { MihomoRuntime } = require('./runtime');

/**
 * Mihomo 代理内核插件。
 *
 * 内核插件契约（与 contracts/plugins 的 contributes 字段对齐：id / capability）：
 * - id / name / capability='proxy-pool.core' / configFormat
 * - platforms: 支持的平台（数据）
 * - compileConfig(input, options) → { content, ... } 生成内核配置
 * - createRuntime(options) → 运行时实例（start/stop/reload/pingNode/getStatus）
 * - manager: { discover, plan, execute, remove } 内核程序的探测与安装管理
 * - defaults: { mixedPort, controllerPort }；chooseLoopbackPort(options) 选取回环端口
 * 节点出站字段由协议插件的 compile[coreId] 负责，内核只编排整体配置。
 */
module.exports = Object.freeze({
  id: 'mihomo',
  capability: 'proxy-pool.core',
  name: 'Mihomo',
  configFormat: 'yaml',
  platforms: Object.freeze(['macos', 'windows', 'linux']),
  defaults: Object.freeze({ mixedPort: DEFAULT_MIXED_PORT, controllerPort: DEFAULT_CONTROLLER_PORT }),
  compileConfig: compileMihomoConfig,
  createRuntime: (options) => new MihomoRuntime(options),
  chooseLoopbackPort,
  manager: Object.freeze({
    discover: discoverMihomoCore,
    plan: planMihomoInstall,
    execute: executeMihomoInstall,
    remove: removeManagedMihomo
  })
});
