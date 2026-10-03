'use strict';

// 插件 SDK 入口：插件代码只依赖这里（运行时由宿主把 `@ai-home/plugin-sdk` 解析到宿主自带的这一份）。

const { PluginError } = require('./errors');
const { freezeJson, validateManifest, validateConfiguration } = require('./manifest');
const contract = require('./contract.generated.json');

// handler 想附带二进制数据时显式返回 withPayload(value, bytes)；其余返回值一律原样当作 JSON 值，
// 宿主不会去猜一个带 value 字段的普通对象是不是信封。
const RESULT_WITH_PAYLOAD = Symbol.for('aih.plugin.result-with-payload');

function withPayload(value, payload) {
  if (!(payload instanceof Uint8Array)) throw new PluginError('plugin_payload_invalid', 'payload 必须是 Uint8Array / Buffer');
  return Object.freeze({ [RESULT_WITH_PAYLOAD]: true, value, payload });
}

// 不冻结插件对象：Cordis 会在插件对象上记录运行期元数据。
function definePlugin(plugin) {
  if (!plugin || typeof plugin.apply !== 'function') throw new PluginError('plugin_entry_invalid');
  return { ...plugin };
}

module.exports = { definePlugin, withPayload, RESULT_WITH_PAYLOAD, freezeJson, PluginError, validateManifest, validateConfiguration, contract };
