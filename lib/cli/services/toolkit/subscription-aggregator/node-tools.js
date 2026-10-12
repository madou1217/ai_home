'use strict';

const { getProtocolPlugin, normalizeProtocol } = require('../proxy-pool/protocols');
const { encodeProxyNode } = require('../proxy-pool/protocol-parsers');
const { describeProtocolForms } = require('../proxy-pool/protocol-form');
const { NodeLatencyMeter } = require('./node-latency');
const { NodeProbe } = require('./node-probe');

// 节点工具（节点表格、TCP 延迟、探针、把分享链接解析成表单字段）：只读节点库、不改聚合配置，
// 从订阅聚合服务里分出来，各自的依赖（延迟测量、探针）可以注入替换。

const MAX_PARSED_NODES = 50;

function toolError(code) {
  return { ok: false, error: code };
}

class NodeToolsService {
  constructor(options = {}) {
    if (!options.sources) throw new Error('node_tools_sources_required');
    this.sources = options.sources;
    this.latency = options.latency || new NodeLatencyMeter();
    this.prober = options.prober || new NodeProbe();
  }

  nodesOf(sourceId) {
    if (!this.sources.listSources().some((source) => source.id === sourceId)) return null;
    return this.sources.listNodes().filter((node) => node.subscriptionId === sourceId);
  }

  /** 订阅源里的节点；分享链接含凭据，只给管理界面。 */
  sourceNodes(sourceId) {
    const nodes = this.nodesOf(sourceId);
    if (!nodes) return toolError('subscription_not_found');
    return {
      ok: true,
      nodes: nodes.map((node) => ({
        id: node.id,
        name: node.name,
        protocol: node.protocol,
        server: node.server,
        port: Number(node.port),
        flag: node.countryFlag || '',
        link: encodeProxyNode(node) || ''
      }))
    };
  }

  async measureLatency(sourceId, { fresh = false } = {}) {
    const nodes = this.nodesOf(sourceId);
    if (!nodes) return toolError('subscription_not_found');
    const results = await this.latency.measure(nodes.map((node) => ({ key: node.id, server: node.server, port: node.port })), { fresh });
    return { ok: true, results };
  }

  probe(input = {}) {
    return this.prober.probe(input);
  }

  /** 分享链接或配置 → 带全部协议字段的节点（填进手动节点表单），只留插件声明的字段。 */
  parseNodes(input = {}) {
    const content = typeof input?.content === 'string' ? input.content : '';
    if (!content.trim()) return toolError('invalid_subscription_content');
    const parsed = this.sources.previewContent(content);
    const nodes = parsed.nodes.slice(0, MAX_PARSED_NODES).map((node) => {
      const protocol = normalizeProtocol(node.protocol);
      const plugin = getProtocolPlugin(protocol);
      const fields = Object.keys(plugin?.fields || {})
        .filter((field) => node[field] !== undefined && node[field] !== '')
        .map((field) => [field, node[field]]);
      return { protocol, name: node.name, server: node.server, port: Number(node.port), ...Object.fromEntries(fields) };
    });
    return {
      ok: true,
      format: parsed.format || '',
      nodes,
      skippedNodes: parsed.skippedNodes.map((item) => ({ name: item.name || '', reason: item.reason }))
    };
  }

  protocolForms() {
    return describeProtocolForms();
  }
}

module.exports = {
  NodeToolsService
};
