'use strict';

const { parseMihomoVersion, resolveMihomoBinary } = require('../mihomo-binary');
const { compileMihomoRelayConfigText, DEFAULT_BASE_PORT, DEFAULT_MAX_PORTS } = require('../mihomo-config');
const { compileMihomoProxy } = require('../../../proxy-pool/cores/mihomo/proxy-compiler');

/**
 * 中转内核：mihomo（Clash.Meta 系）。它补上 sing-box 编不了的协议：xhttp 传输、VLESS Encryption
 * （ML-KEM）、ShadowsocksR、Mieru。代价是没有 naive（那个只有 sing-box 有），所以两个内核互补。
 * 描述符契约见 kernels/index.js。
 */
module.exports = Object.freeze({
  id: 'mihomo',
  label: 'mihomo',
  envField: 'mihomoBin',
  configFileName: 'mihomo.yaml',
  basePort: DEFAULT_BASE_PORT,
  maxPorts: DEFAULT_MAX_PORTS,
  versionArgs: Object.freeze(['-v']),
  buildDependentProtocols: Object.freeze([]),
  resolveBinary: (options) => resolveMihomoBinary(options),
  parseVersion: (stdout) => parseMihomoVersion(stdout),
  compileNode(node) {
    return compileMihomoProxy(node, 'relay-probe', { target: 'mihomo' });
  },
  compileText: (nodes, options = {}) => compileMihomoRelayConfigText(nodes, options),
  // mihomo 的 `-t` 就是「只测配置」；`-d` 是它的数据目录（缓存/geo 落在那里，必须可写）。
  checkArgs: (configFile, runDir) => ['-t', '-d', runDir, '-f', configFile],
  runArgs: (configFile, runDir) => ['-d', runDir, '-f', configFile]
});
