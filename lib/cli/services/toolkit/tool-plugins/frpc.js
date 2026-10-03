'use strict';

const nodeFs = require('node:fs');
const {
  lifecycleForTool,
  resolveManagedToolPlans
} = require('../tool-lifecycle');
const { resolveManagedFrpcPath } = require('../tool-lifecycle/shared');
const {
  FRPC_CONFIG_TEMPLATE,
  defaultFrpcConfigPath,
  verifyFrpcConfig
} = require('./frpc-config');

// AIH 自管安装位置优先于 PATH 中的同名程序。
function preferredExecutable(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const candidate = resolveManagedFrpcPath(options);
  try {
    return candidate && fsImpl.existsSync(candidate) ? candidate : '';
  } catch (_error) {
    return '';
  }
}

module.exports = Object.freeze({
  id: 'frpc',
  category: 'network-access',
  name: 'frpc',
  role: 'FRP 客户端反向隧道',
  platforms: Object.freeze(['darwin', 'linux', 'win32']),
  commands: Object.freeze(['frpc']),
  versionArgs: Object.freeze([['--version'], ['-v']]),
  capabilities: Object.freeze(['detect', 'version', 'config-edit', 'service']),
  runtimeInspectable: true,
  config: Object.freeze({ name: 'frpc.toml', format: 'toml', validate: verifyFrpcConfig }),
  service: Object.freeze({
    processRole: 'frpc',
    homebrewFormula: 'frpc',
    launchArgs: (configPath) => ['-c', configPath],
    defaultConfigPath: defaultFrpcConfigPath,
    configTemplate: FRPC_CONFIG_TEMPLATE
  }),
  preferredExecutable,
  lifecycle: Object.freeze({
    describe: lifecycleForTool,
    resolvePlans: resolveManagedToolPlans
  })
});
