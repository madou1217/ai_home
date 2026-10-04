'use strict';

const { chooseLoopbackPort } = require('../loopback-port');
const { ProcessCoreRuntime } = require('../process-core-runtime');
const {
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_MIXED_PORT,
  MIXED_INBOUND_TAG,
  compileSingBoxConfig
} = require('./config-compiler');
const { discoverSingBoxBinary, parseVersion } = require('./core-manager');

const SING_BOX_RUNTIME_SPEC = Object.freeze({
  engine: 'sing-box',
  errorPrefix: 'sing_box',
  displayName: 'sing-box',
  // 与 ZCode 出口的 run/zcode-egress/sing-box 分开，互不接管对方进程。
  runtimeDirName: 'sing-box',
  configFileName: 'config.json',
  defaultControllerPort: DEFAULT_CONTROLLER_PORT,
  defaultMixedPort: DEFAULT_MIXED_PORT,
  discoverBinary: discoverSingBoxBinary,
  versionArgs: ['version'],
  parseVersion,
  chooseLoopbackPort,
  compileConfig: compileSingBoxConfig,
  mixedPortOf: (compiled) => compiled?.mixedPort
    || compiled?.config?.inbounds?.find((inbound) => inbound.tag === MIXED_INBOUND_TAG)?.listen_port,
  validateArgs: (runtime) => ['check', '-c', runtime.configPath],
  runArgs: (runtime) => ['run', '-c', runtime.configPath, '-D', runtime.runtimeDir]
});

/**
 * sing-box 内核运行时：共用骨架（../process-core-runtime.js）。
 * sing-box 没有热重载接口，重载走骨架默认的「校验 → 停 → 启 → 失败回滚」。
 */
class SingBoxRuntime extends ProcessCoreRuntime {
  constructor(options = {}) {
    super(options, SING_BOX_RUNTIME_SPEC);
  }
}

module.exports = {
  SING_BOX_RUNTIME_SPEC,
  SingBoxRuntime
};
