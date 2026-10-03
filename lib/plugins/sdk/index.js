'use strict';

// 插件 SDK 入口：插件代码只依赖这里（运行时由宿主把 `@ai-home/plugin-sdk` 解析到宿主自带的这一份）。

const { PluginError } = require('./errors');
const { freezeJson, validateManifest, validateConfiguration } = require('./manifest');
const contract = require('./contract.generated.json');

// 不冻结插件对象：Cordis 会在插件对象上记录运行期元数据。
function definePlugin(plugin) {
  if (!plugin || typeof plugin.apply !== 'function') throw new PluginError('plugin_entry_invalid');
  return { ...plugin };
}

module.exports = { definePlugin, freezeJson, PluginError, validateManifest, validateConfiguration, contract };
