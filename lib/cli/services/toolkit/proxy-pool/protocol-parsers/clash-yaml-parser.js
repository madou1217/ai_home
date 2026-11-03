'use strict';

// Clash / mihomo 订阅 → 节点。文本交给 yaml 库解析（锚点、流式映射、引号与多行字符串都按
// YAML 规范处理，同结构的 JSON 也能读），字段映射交给认领该类型的协议插件（imports.clash）。
// 单条代理映射失败只跳过这一条并记录原因，不影响其它节点。

const YAML = require('yaml');
const { buildImportedNode, importError: parseError } = require('./imported-node');

// 按需加载：协议插件引用的内核字段工具依赖契约层，顶层 require 会形成初始化环。
function findClashPlugin(type) {
  return require('../protocols').findProtocolPluginForImport('clash', type);
}

function readProxies(text) {
  let document;
  try {
    // merge：Clash 配置常用 `<<: *anchor` 复用公共字段（YAML 1.1 合并键，1.2 默认不展开）。
    document = YAML.parse(String(text || ''), { uniqueKeys: false, merge: true });
  } catch (_error) {
    throw parseError('invalid_clash_yaml');
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.proxies)) {
    throw parseError('invalid_clash_yaml');
  }
  return document.proxies;
}

function convertClashProxy(proxy) {
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) throw parseError('invalid_clash_proxy');
  const type = String(proxy.type || '').trim().toLowerCase();
  const plugin = findClashPlugin(type);
  if (!plugin) throw parseError(`unsupported_proxy_protocol_${type || 'empty'}`);
  return buildImportedNode({
    plugin,
    name: proxy.name ?? 'Clash Node',
    server: proxy.server,
    port: proxy.port,
    fields: plugin.imports.clash.parse(proxy)
  });
}

function parseClashYamlProxiesDetailed(text) {
  let proxies;
  try {
    proxies = readProxies(text);
  } catch (error) {
    return { nodes: [], skippedNodes: [], warnings: [error.code || 'invalid_clash_yaml'] };
  }
  const nodes = [];
  const skippedNodes = [];
  for (const proxy of proxies) {
    try {
      nodes.push(convertClashProxy(proxy));
    } catch (error) {
      skippedNodes.push({
        nodeId: null,
        name: proxy && proxy.name !== undefined ? String(proxy.name) : null,
        reason: error.code || error.message
      });
    }
  }
  return { nodes, skippedNodes, warnings: [] };
}

function parseClashYamlProxies(text) {
  return parseClashYamlProxiesDetailed(text).nodes;
}

module.exports = {
  convertClashProxy,
  parseClashYamlProxies,
  parseClashYamlProxiesDetailed
};
