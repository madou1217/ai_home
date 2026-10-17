'use strict';

const { parseSingBoxVersion, resolveSingBoxBinary } = require('../sing-box-binary');
const { compileRelayConfig, DEFAULT_BASE_PORT, DEFAULT_MAX_PORTS } = require('../relay-config');
const { compileSingBoxNodeOutbound } = require('../../../proxy-pool/cores/sing-box/node-outbound');

/**
 * 中转内核：sing-box。默认内核（覆盖最广、JSON 配置好校验），编不出来的协议交给 mihomo。
 * 描述符契约见 kernels/index.js。
 */
module.exports = Object.freeze({
  id: 'sing-box',
  label: 'sing-box',
  envField: 'singBoxBin',
  configFileName: 'sing-box.json',
  basePort: DEFAULT_BASE_PORT,
  maxPorts: DEFAULT_MAX_PORTS,
  versionArgs: Object.freeze(['version']),
  // 只有带 libcronet 的构建认 naive 出站：内核 check 被拒时先去掉它重试一次。
  buildDependentProtocols: Object.freeze(['naive']),
  resolveBinary: (options) => resolveSingBoxBinary(options),
  parseVersion: (stdout) => parseSingBoxVersion(stdout),
  compileNode(node, options = {}) {
    return compileSingBoxNodeOutbound(node, 'relay-probe', {
      version: options.version,
      officialApp: options.officialApp !== false
    });
  },
  compileText(nodes, options = {}) {
    const { config, endpoints, skipped } = compileRelayConfig(nodes, options);
    return { text: `${JSON.stringify(config, null, 2)}\n`, endpoints, skipped };
  },
  checkArgs: (configFile) => ['check', '-c', configFile],
  runArgs: (configFile) => ['run', '-c', configFile]
});
