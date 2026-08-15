'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const DEFAULT_DATA_FILE = path.join(os.homedir(), '.ai-home', 'proxy-pool.json');

function generateNodeId(node) {
  const seed = `${node.protocol}:${node.server}:${node.port}:${node.uuid || node.password || node.username || ''}:${node.name}`;
  return 'node_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

function generateSubId(url, name) {
  const seed = `${url}:${name}`;
  return 'sub_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

class ProxyNodeStore {
  constructor(filePath = DEFAULT_DATA_FILE) {
    this.filePath = filePath;
    this._ensureStore();
  }

  _ensureStore() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(this.filePath)) {
        const initial = {
          version: 1,
          nodes: [],
          subscriptions: [],
          groups: [
            { id: 'all', name: '全部节点', icon: '🌐' },
            { id: 'ai', name: 'AI 专线', icon: '🤖' },
            { id: 'dev', name: '开发加速', icon: '⚡' },
            { id: 'dedicated', name: '独立端口', icon: '🔌' }
          ],
          routing: {
            mode: 'rule', // 'global' | 'rule' | 'direct'
            activeOutboundNodeId: null,
            rules: [
              { id: 'r_openai', name: 'OpenAI 规则', target: 'openai', outbound: 'proxy', domains: ['openai.com', 'ai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com'] },
              { id: 'r_claude', name: 'Anthropic Claude 规则', target: 'claude', outbound: 'proxy', domains: ['anthropic.com', 'claude.ai'] },
              { id: 'r_gemini', name: 'Google Gemini 规则', target: 'gemini', outbound: 'proxy', domains: ['googleapis.com', 'google.com', 'generativelanguage.googleapis.com'] },
              { id: 'r_github', name: 'GitHub 规则', target: 'github', outbound: 'proxy', domains: ['github.com', 'githubusercontent.com', 'githubassets.com'] },
              { id: 'r_cn', name: '中国大陆直连', target: 'direct', outbound: 'direct', domains: ['cn', 'aliyun.com', 'tencent.com', 'baidu.com', 'taobao.com', 'tsinghua.edu.cn'] }
            ]
          },
          dedicatedPorts: {
            enabled: true,
            maxPorts: 32,
            basePort: 10801,
            mappings: {} // { [nodeId]: port }
          }
        };
        fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), 'utf8');
      }
    } catch (_e) {
      // ignore
    }
  }

  _readData() {
    try {
      this._ensureStore();
      const content = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(content);
    } catch (_e) {
      return { nodes: [], subscriptions: [], groups: [], routing: {}, dedicatedPorts: {} };
    }
  }

  _writeData(data) {
    try {
      this._ensureStore();
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  listNodes(filter = {}) {
    const data = this._readData();
    let nodes = data.nodes || [];

    if (filter.group) {
      if (filter.group === 'dedicated') {
        const dedicatedNodeIds = Object.keys(data.dedicatedPorts?.mappings || {});
        nodes = nodes.filter((n) => dedicatedNodeIds.includes(n.id));
      } else if (filter.group !== 'all') {
        nodes = nodes.filter((n) => n.group === filter.group || (n.tags && n.tags.includes(filter.group)) || n.countryCode === filter.group);
      }
    }

    if (filter.protocol) {
      nodes = nodes.filter((n) => n.protocol === filter.protocol);
    }

    return nodes.map((n) => {
      const dedicatedPort = data.dedicatedPorts?.mappings?.[n.id];
      return {
        ...n,
        dedicatedPort: dedicatedPort || null
      };
    });
  }

  getNode(nodeId) {
    const data = this._readData();
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (!node) return null;
    const dedicatedPort = data.dedicatedPorts?.mappings?.[nodeId];
    return { ...node, dedicatedPort: dedicatedPort || null };
  }

  upsertNode(nodeInput) {
    const data = this._readData();
    const nodes = data.nodes || [];
    const id = nodeInput.id || generateNodeId(nodeInput);

    const completeNode = {
      id,
      name: nodeInput.name || 'Custom Node',
      protocol: nodeInput.protocol || 'shadowsocks',
      server: nodeInput.server,
      port: Number(nodeInput.port),
      password: nodeInput.password,
      uuid: nodeInput.uuid,
      cipher: nodeInput.cipher,
      alterId: nodeInput.alterId,
      network: nodeInput.network || 'tcp',
      tls: Boolean(nodeInput.tls),
      sni: nodeInput.sni,
      path: nodeInput.path,
      host: nodeInput.host,
      group: nodeInput.group || 'default',
      tags: nodeInput.tags || [],
      countryCode: nodeInput.countryCode || 'UN',
      countryName: nodeInput.countryName || '其它',
      countryFlag: nodeInput.countryFlag || '🌐',
      subscriptionId: nodeInput.subscriptionId || null,
      latencyMs: nodeInput.latencyMs || null,
      lastChecked: nodeInput.lastChecked || null,
      updatedAt: Date.now()
    };

    const index = nodes.findIndex((n) => n.id === id);
    if (index !== -1) {
      nodes[index] = { ...nodes[index], ...completeNode };
    } else {
      nodes.push(completeNode);
    }

    data.nodes = nodes;
    this._writeData(data);
    return completeNode;
  }

  bulkUpsertNodes(nodeList, subscriptionId = null) {
    const data = this._readData();
    let nodes = data.nodes || [];

    // If subscriptionId is provided, we can replace or update existing nodes belonging to this subscription
    if (subscriptionId) {
      nodes = nodes.filter((n) => n.subscriptionId !== subscriptionId);
    }

    const inserted = [];
    for (const nodeInput of nodeList) {
      const id = nodeInput.id || generateNodeId(nodeInput);
      const completeNode = {
        ...nodeInput,
        id,
        subscriptionId: subscriptionId || nodeInput.subscriptionId || null,
        updatedAt: Date.now()
      };
      nodes.push(completeNode);
      inserted.push(completeNode);
    }

    data.nodes = nodes;
    this._writeData(data);
    return inserted;
  }

  deleteNode(nodeId) {
    const data = this._readData();
    data.nodes = (data.nodes || []).filter((n) => n.id !== nodeId);
    if (data.dedicatedPorts?.mappings?.[nodeId]) {
      delete data.dedicatedPorts.mappings[nodeId];
    }
    this._writeData(data);
    return true;
  }

  listSubscriptions() {
    const data = this._readData();
    return data.subscriptions || [];
  }

  upsertSubscription(subInput) {
    const data = this._readData();
    const subs = data.subscriptions || [];
    const id = subInput.id || generateSubId(subInput.url, subInput.name);

    const subRecord = {
      id,
      name: subInput.name || '我的订阅',
      url: subInput.url,
      autoUpdate: subInput.autoUpdate !== false,
      intervalHours: subInput.intervalHours || 24,
      nodeCount: subInput.nodeCount || 0,
      lastSyncedAt: subInput.lastSyncedAt || null,
      updatedAt: Date.now()
    };

    const index = subs.findIndex((s) => s.id === id);
    if (index !== -1) {
      subs[index] = { ...subs[index], ...subRecord };
    } else {
      subs.push(subRecord);
    }

    data.subscriptions = subs;
    this._writeData(data);
    return subRecord;
  }

  deleteSubscription(subId) {
    const data = this._readData();
    data.subscriptions = (data.subscriptions || []).filter((s) => s.id !== subId);
    data.nodes = (data.nodes || []).filter((n) => n.subscriptionId !== subId);
    this._writeData(data);
    return true;
  }

  getRoutingConfig() {
    const data = this._readData();
    return data.routing || { mode: 'rule', rules: [] };
  }

  setRoutingConfig(routing) {
    const data = this._readData();
    data.routing = { ...data.routing, ...routing };
    this._writeData(data);
    return data.routing;
  }

  getDedicatedPortsConfig() {
    const data = this._readData();
    return data.dedicatedPorts || { enabled: true, maxPorts: 32, basePort: 10801, mappings: {} };
  }

  setDedicatedPortsConfig(config) {
    const data = this._readData();
    data.dedicatedPorts = { ...data.dedicatedPorts, ...config };
    this._writeData(data);
    return data.dedicatedPorts;
  }

  assignDedicatedPort(nodeId, requestedPort = null) {
    const data = this._readData();
    const config = data.dedicatedPorts || { enabled: true, maxPorts: 32, basePort: 10801, mappings: {} };
    const mappings = config.mappings || {};

    if (mappings[nodeId]) {
      return { ok: true, port: mappings[nodeId], alreadyAssigned: true };
    }

    const currentCount = Object.keys(mappings).length;
    const maxLimit = config.maxPorts || 32;
    if (currentCount >= maxLimit) {
      return { ok: false, error: `已达到最大并发独立端口上限 (${maxLimit})` };
    }

    const usedPorts = new Set(Object.values(mappings));
    let assigned = requestedPort ? Number(requestedPort) : (config.basePort || 10801);

    while (usedPorts.has(assigned)) {
      assigned++;
    }

    mappings[nodeId] = assigned;
    config.mappings = mappings;
    data.dedicatedPorts = config;
    this._writeData(data);

    return { ok: true, port: assigned };
  }

  releaseDedicatedPort(nodeId) {
    const data = this._readData();
    if (data.dedicatedPorts?.mappings?.[nodeId]) {
      const releasedPort = data.dedicatedPorts.mappings[nodeId];
      delete data.dedicatedPorts.mappings[nodeId];
      this._writeData(data);
      return { ok: true, releasedPort };
    }
    return { ok: true, releasedPort: null };
  }

  updateNodeLatency(nodeId, latencyMs) {
    const data = this._readData();
    const node = (data.nodes || []).find((n) => n.id === nodeId);
    if (node) {
      node.latencyMs = latencyMs;
      node.lastChecked = Date.now();
      this._writeData(data);
    }
  }
}

let defaultStoreInstance = null;
function getProxyNodeStore() {
  if (!defaultStoreInstance) {
    defaultStoreInstance = new ProxyNodeStore();
  }
  return defaultStoreInstance;
}

module.exports = {
  ProxyNodeStore,
  getProxyNodeStore,
  generateNodeId,
  generateSubId
};
