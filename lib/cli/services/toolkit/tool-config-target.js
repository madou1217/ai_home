'use strict';

const nodeFs = require('node:fs');
const { discoverNetworkTools } = require('./network-tool-discovery');

/** 配置目标由插件提供；网络发现仍保留进程指向的权威目标与歧义结果。 */
function resolveToolConfigTarget(definition, options = {}) {
  const runtime = (options.networkRuntime || {})[definition.id] || {};
  if (!definition.config) return runtime;
  if (typeof definition.config.resolvePath !== 'function') {
    return options.networkRuntime ? runtime : discoverNetworkTools(options)[definition.id] || {};
  }
  const fs = options.fs || nodeFs;
  const configPath = String(definition.config.resolvePath(options) || '');
  const exists = Boolean(configPath && fs.existsSync(configPath));
  return {
    ...runtime, configPath, configCount: exists ? 1 : 0, configAmbiguous: false,
    configState: exists ? 'single' : 'none', configSource: 'standard-path',
    configFormat: definition.config.format
  };
}

module.exports = { resolveToolConfigTarget };
