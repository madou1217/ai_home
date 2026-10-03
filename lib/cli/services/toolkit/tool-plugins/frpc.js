'use strict';

const nodeFs = require('node:fs');
const {
  lifecycleForTool,
  resolveManagedToolPlans
} = require('../tool-lifecycle');
const { resolveManagedFrpcPath } = require('../tool-lifecycle/shared');

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
  capabilities: Object.freeze(['detect', 'version', 'config-edit']),
  runtimeInspectable: true,
  config: Object.freeze({ name: 'frpc.toml', format: 'toml' }),
  preferredExecutable,
  lifecycle: Object.freeze({
    describe: lifecycleForTool,
    resolvePlans: resolveManagedToolPlans
  })
});
