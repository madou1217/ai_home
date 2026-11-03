'use strict';

const { inferCountryCode } = require('./base-parser');

// 各订阅格式导入时共用：公共字段 + 协议插件映射出的字段 → 节点（去掉未定义字段）。
// 插件映射结果可以覆盖 protocol（例如 http 条目带 TLS 时映射成 https）。
function buildImportedNode({ plugin, name, server, port, fields }) {
  const nodeName = String(name ?? `${plugin.name} Node`);
  const host = String(server ?? '').trim();
  const country = inferCountryCode(nodeName, host);
  const node = {
    protocol: plugin.protocols[0],
    name: nodeName,
    server: host,
    port: Number(port),
    countryCode: country.code,
    countryName: country.name,
    countryFlag: country.flag,
    ...fields
  };
  return Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined));
}

function importError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  buildImportedNode,
  importError
};
