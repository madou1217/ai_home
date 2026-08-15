'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { inferCountryCode, normalizeServerHost } = require('./protocol-parsers/base-parser');
const { isValidPort, SUPPORTED_PROTOCOLS } = require('./mihomo-config-compiler');
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('./secure-file-io');

const NODE_METADATA_FIELDS = [
  'id', 'name', 'protocol', 'server', 'port', 'group', 'tags',
  'countryCode', 'countryName', 'countryFlag',
  'subscriptionId', 'latencyMs', 'lastChecked', 'updatedAt', 'createdAt', 'rawUri',
  'dedicatedPort'
];
const NODE_PROTOCOL_FIELDS = {
  shadowsocks: ['password', 'cipher', 'plugin', 'pluginOpts'],
  vmess: ['uuid', 'cipher', 'alterId', 'network', 'tls', 'sni', 'path', 'host', 'type', 'alpn', 'serviceName', 'allowInsecure'],
  vless: ['uuid', 'network', 'tls', 'sni', 'path', 'host', 'alpn', 'flow', 'security', 'publicKey', 'shortId', 'fingerprint', 'serviceName', 'allowInsecure'],
  trojan: ['password', 'network', 'tls', 'sni', 'path', 'host', 'alpn', 'serviceName', 'allowInsecure'],
  hysteria2: ['password', 'tls', 'sni', 'insecure', 'allowInsecure', 'obfs', 'obfsPassword', 'upMbps', 'downMbps'],
  socks5: ['username', 'password'],
  http: ['username', 'password', 'tls', 'sni', 'allowInsecure'],
  https: ['username', 'password', 'tls', 'sni', 'allowInsecure']
};

function createStoreError(code, message = code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function createInitialData() {
  return {
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
      mode: 'rule',
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
      mappings: {}
    },
    network: {
      tun: {
        enabled: false,
        stack: 'mixed',
        autoRoute: true,
        autoDetectInterface: true,
        strictRoute: false,
        dnsHijack: ['any:53']
      }
    }
  };
}

function generateNodeId(node) {
  const seed = `${node.protocol}:${node.server}:${node.port}:${node.uuid || node.password || node.username || ''}:${node.name}`;
  return `node_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

function generateSubId(url, name) {
  const seed = `${url}:${name}`;
  return `sub_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

function autoDetectTagsAndCountry(node) {
  const name = String(node.name || '');
  const server = String(node.server || '');
  const country = inferCountryCode(name, server);
  const tags = Array.isArray(node.tags) ? [...new Set(node.tags.map(String))] : [];
  if (/openai|chatgpt|gpt|claude|anthropic|gemini|grok|ai/i.test(name) && !tags.includes('ai')) tags.push('ai');
  if (/github|git|dev|speed|加速/i.test(name) && !tags.includes('dev')) tags.push('dev');
  return {
    countryCode: node.countryCode && node.countryCode !== 'UN' ? node.countryCode : country.code,
    countryName: node.countryName && node.countryName !== '其它' ? node.countryName : country.name,
    countryFlag: node.countryFlag && node.countryFlag !== '🌐' ? node.countryFlag : country.flag,
    tags
  };
}

function normalizeProtocol(protocol) {
  const value = String(protocol || '').toLowerCase();
  return value === 'ss' ? 'shadowsocks' : (value === 'hy2' ? 'hysteria2' : value);
}

function validateProxyNodeInput(nodeInput) {
  if (!nodeInput || typeof nodeInput !== 'object' || Array.isArray(nodeInput)) {
    throw createStoreError('invalid_proxy_node');
  }
  const protocol = normalizeProtocol(nodeInput.protocol);
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw createStoreError('unsupported_proxy_protocol', `unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const allowedFields = new Set(NODE_METADATA_FIELDS.concat(NODE_PROTOCOL_FIELDS[protocol] || []));
  const unknownField = Object.keys(nodeInput).find((field) => (
    nodeInput[field] !== undefined && !allowedFields.has(field)
  ));
  if (unknownField) throw createStoreError('unsupported_proxy_field', `unsupported_proxy_field_${unknownField}`);
  const server = typeof nodeInput.server === 'string' ? normalizeServerHost(nodeInput.server) : '';
  if (!server) throw createStoreError('invalid_proxy_server');
  if (!isValidPort(nodeInput.port)) throw createStoreError('invalid_proxy_port');
  if (nodeInput.name !== undefined && typeof nodeInput.name !== 'string') throw createStoreError('invalid_proxy_name');
  if (nodeInput.tags !== undefined && (!Array.isArray(nodeInput.tags) || nodeInput.tags.some((tag) => typeof tag !== 'string'))) {
    throw createStoreError('invalid_proxy_tags');
  }
  for (const field of ['username', 'password', 'uuid', 'cipher', 'sni', 'path', 'host', 'flow', 'security', 'publicKey', 'shortId', 'fingerprint', 'serviceName', 'obfs', 'obfsPassword']) {
    if (nodeInput[field] !== undefined && typeof nodeInput[field] !== 'string') {
      throw createStoreError('invalid_proxy_field', `invalid_proxy_field_${field}`);
    }
  }
  for (const field of ['tls', 'allowInsecure', 'insecure']) {
    if (nodeInput[field] !== undefined && typeof nodeInput[field] !== 'boolean') {
      throw createStoreError('invalid_proxy_field', `invalid_proxy_field_${field}`);
    }
  }
  if (nodeInput.alterId !== undefined && (!Number.isInteger(Number(nodeInput.alterId)) || Number(nodeInput.alterId) < 0)) {
    throw createStoreError('invalid_proxy_field', 'invalid_proxy_field_alterId');
  }
  if (nodeInput.alpn !== undefined && !(
    typeof nodeInput.alpn === 'string' ||
    (Array.isArray(nodeInput.alpn) && nodeInput.alpn.every((value) => typeof value === 'string'))
  )) throw createStoreError('invalid_proxy_field', 'invalid_proxy_field_alpn');
  if (nodeInput.pluginOpts !== undefined) {
    const validObject = nodeInput.pluginOpts && typeof nodeInput.pluginOpts === 'object' && !Array.isArray(nodeInput.pluginOpts) &&
      Object.keys(nodeInput.pluginOpts).every((key) => !['__proto__', 'prototype', 'constructor'].includes(key)) &&
      Object.values(nodeInput.pluginOpts).every((value) => ['string', 'number', 'boolean'].includes(typeof value));
    if (typeof nodeInput.pluginOpts !== 'string' && !validObject) {
      throw createStoreError('invalid_proxy_field', 'invalid_proxy_field_pluginOpts');
    }
  }
  for (const field of ['upMbps', 'downMbps']) {
    if (nodeInput[field] !== undefined && (!Number.isFinite(Number(nodeInput[field])) || Number(nodeInput[field]) <= 0)) {
      throw createStoreError('invalid_proxy_field', `invalid_proxy_field_${field}`);
    }
  }
  if (nodeInput.network && !['tcp', 'ws', 'grpc'].includes(String(nodeInput.network).toLowerCase())) {
    throw createStoreError('unsupported_proxy_transport', `unsupported_proxy_transport_${nodeInput.network}`);
  }
  return { protocol, server, port: Number(nodeInput.port) };
}

function validateSubscriptionUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (_error) {
    throw createStoreError('invalid_subscription_url');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createStoreError('invalid_subscription_url');
  }
  return parsed.toString();
}

class ProxyNodeStore {
  constructor(filePathOrOptions) {
    const options = typeof filePathOrOptions === 'string'
      ? { filePath: filePathOrOptions }
      : (filePathOrOptions || {});
    this.fs = options.fs || nativeFs;
    this.path = options.path || nativePath;
    this.env = options.env || process.env;
    const aiHomeDir = options.aiHomeDir || this.env.AIH_HOME || this.path.join(os.homedir(), '.ai_home');
    this.filePath = options.filePath || this.path.join(aiHomeDir, 'proxy-pool.json');
    this.manageDirectoryPermissions = !options.filePath;
    this.lockPath = `${this.filePath}.lock`;
    this.lockTimeoutMs = Number(options.lockTimeoutMs || 2000);
    this.lockHeld = false;
    this._ensureStore();
  }

  _ensureStore() {
    const directoryPath = this.path.dirname(this.filePath);
    try {
      ensurePrivateDirectory(this.fs, directoryPath, { enforceMode: this.manageDirectoryPermissions });
      if (!this.fs.existsSync(this.filePath)) {
        const lockDescriptor = this.lockHeld ? null : this._acquireLock();
        try {
          if (!this.fs.existsSync(this.filePath)) {
            atomicWritePrivateFile(
              this.fs,
              this.path,
              this.filePath,
              `${JSON.stringify(createInitialData(), null, 2)}\n`,
              { enforceMode: this.manageDirectoryPermissions }
            );
          }
        } finally {
          if (lockDescriptor !== null) this._releaseLock(lockDescriptor);
        }
      } else if (typeof this.fs.chmodSync === 'function') {
        this.fs.chmodSync(this.filePath, 0o600);
      }
    } catch (error) {
      throw createStoreError('proxy_store_initialization_failed', error.message, error);
    }
  }

  _readData() {
    this._ensureStore();
    let content;
    try {
      content = this.fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      throw createStoreError('proxy_store_read_failed', error.message, error);
    }
    try {
      const data = JSON.parse(content);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('root must be an object');
      return data;
    } catch (error) {
      throw createStoreError('proxy_store_corrupt', 'proxy_store_corrupt', error);
    }
  }

  _writeData(data) {
    try {
      atomicWritePrivateFile(
        this.fs,
        this.path,
        this.filePath,
        `${JSON.stringify(data, null, 2)}\n`,
        { enforceMode: this.manageDirectoryPermissions }
      );
      return true;
    } catch (error) {
      throw createStoreError('proxy_store_write_failed', error.message, error);
    }
  }

  _acquireLock() {
    if (typeof this.fs.openSync !== 'function') return null;
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      let descriptor;
      try {
        descriptor = this.fs.openSync(this.lockPath, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw createStoreError('proxy_store_lock_failed', error.message, error);
        if (this._clearStaleLock()) continue;
        if (Date.now() >= deadline) throw createStoreError('proxy_store_busy');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        continue;
      }
      try {
        this.fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        this.fs.fsyncSync?.(descriptor);
        return descriptor;
      } catch (error) {
        try { this.fs.closeSync(descriptor); } catch (_closeError) { /* best effort */ }
        try { this.fs.unlinkSync(this.lockPath); } catch (_unlinkError) { /* best effort */ }
        throw createStoreError('proxy_store_lock_failed', error.message, error);
      }
    }
  }

  _clearStaleLock() {
    try {
      const stat = this.fs.statSync(this.lockPath);
      let owner = null;
      try { owner = JSON.parse(this.fs.readFileSync(this.lockPath, 'utf8')); } catch (_error) { /* incomplete lock */ }
      let ownerAlive = true;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          ownerAlive = error.code === 'EPERM';
        }
      }
      const ageMs = Date.now() - Number(owner?.createdAt || stat.mtimeMs || Date.now());
      if (ownerAlive && ageMs <= 30000) return false;
      this.fs.unlinkSync(this.lockPath);
      return true;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  }

  _mutate(mutator) {
    const lockDescriptor = this._acquireLock();
    this.lockHeld = true;
    try {
      const data = this._readData();
      const result = mutator(data);
      this._writeData(data);
      return result;
    } finally {
      this.lockHeld = false;
      if (lockDescriptor !== null) this._releaseLock(lockDescriptor);
    }
  }

  _releaseLock(lockDescriptor) {
    try { this.fs.closeSync(lockDescriptor); } finally {
      try { this.fs.unlinkSync(this.lockPath); } catch (_error) { /* already released */ }
    }
  }

  listNodes(filter = {}) {
    const data = this._readData();
    let nodes = Array.isArray(data.nodes) ? data.nodes : [];
    if (filter.group) {
      if (filter.group === 'dedicated') {
        const dedicatedNodeIds = new Set(Object.keys(data.dedicatedPorts?.mappings || {}));
        nodes = nodes.filter((node) => dedicatedNodeIds.has(node.id));
      } else if (filter.group === 'ai') {
        nodes = nodes.filter((node) => node.tags?.includes('ai') || /openai|claude|chatgpt|gemini|grok|ai/i.test(node.name));
      } else if (filter.group === 'dev') {
        nodes = nodes.filter((node) => node.tags?.includes('dev') || /github|git|dev|speed|加速/i.test(node.name));
      } else if (filter.group !== 'all') {
        nodes = nodes.filter((node) => node.group === filter.group || node.tags?.includes(filter.group) || node.countryCode === filter.group);
      }
    }
    if (filter.protocol) nodes = nodes.filter((node) => node.protocol === filter.protocol);
    return nodes.map((node) => ({
      ...node,
      dedicatedPort: data.dedicatedPorts?.mappings?.[node.id] || null
    }));
  }

  getNode(nodeId) {
    const data = this._readData();
    const node = (data.nodes || []).find((candidate) => candidate.id === nodeId);
    return node ? { ...node, dedicatedPort: data.dedicatedPorts?.mappings?.[nodeId] || null } : null;
  }

  _completeNode(nodeInput) {
    const normalized = validateProxyNodeInput(nodeInput);
    const { dedicatedPort: _dedicatedPort, ...persistedInput } = nodeInput;
    const identity = { ...persistedInput, ...normalized };
    const detected = autoDetectTagsAndCountry(identity);
    return {
      ...identity,
      id: nodeInput.id || generateNodeId(identity),
      name: nodeInput.name || 'Custom Node',
      group: nodeInput.group || 'default',
      tags: detected.tags,
      countryCode: detected.countryCode,
      countryName: detected.countryName,
      countryFlag: detected.countryFlag,
      subscriptionId: nodeInput.subscriptionId || null,
      latencyMs: nodeInput.latencyMs ?? null,
      lastChecked: nodeInput.lastChecked || null,
      updatedAt: Date.now()
    };
  }

  upsertNode(nodeInput) {
    const completeNode = this._completeNode(nodeInput);
    return this._mutate((data) => {
      const nodes = Array.isArray(data.nodes) ? data.nodes : [];
      const index = nodes.findIndex((node) => node.id === completeNode.id);
      if (index === -1) nodes.push(completeNode);
      else nodes[index] = { ...nodes[index], ...completeNode };
      data.nodes = nodes;
      return completeNode;
    });
  }

  bulkUpsertNodes(nodeList, subscriptionId = null) {
    if (!Array.isArray(nodeList)) throw createStoreError('invalid_proxy_node_list');
    const inserted = nodeList.map((node) => this._completeNode({
      ...node,
      subscriptionId: subscriptionId || node.subscriptionId || null
    }));
    return this._mutate((data) => {
      let nodes = Array.isArray(data.nodes) ? data.nodes : [];
      if (subscriptionId) nodes = nodes.filter((node) => node.subscriptionId !== subscriptionId);
      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (const node of inserted) byId.set(node.id, node);
      data.nodes = Array.from(byId.values());
      return inserted;
    });
  }

  replaceSubscriptionNodes(subscriptionId, nodeList, subscriptionPatch = {}) {
    return this.replaceSubscriptionNodesWithSnapshot(subscriptionId, nodeList, subscriptionPatch).nodes;
  }

  replaceSubscriptionNodesWithSnapshot(subscriptionId, nodeList, subscriptionPatch = {}) {
    if (!subscriptionId) throw createStoreError('invalid_subscription_id');
    const inserted = nodeList.map((node) => this._completeNode({ ...node, subscriptionId }));
    return this._mutate((data) => {
      const previousNodes = (data.nodes || [])
        .filter((node) => node.subscriptionId === subscriptionId)
        .map((node) => ({ ...node }));
      const previousNodeIds = new Set(previousNodes.map((node) => node.id));
      const nextNodeIds = new Set(inserted.map((node) => node.id));
      const subscription = (data.subscriptions || []).find((candidate) => candidate.id === subscriptionId);
      if (!subscription) throw createStoreError('subscription_not_found');
      const previousMappings = data.dedicatedPorts?.mappings || {};
      const snapshot = {
        subscription: { ...subscription },
        nodes: previousNodes,
        dedicatedPorts: Object.fromEntries(
          previousNodes
            .filter((node) => previousMappings[node.id])
            .map((node) => [node.id, previousMappings[node.id]])
        )
      };

      data.nodes = (data.nodes || []).filter((node) => node.subscriptionId !== subscriptionId).concat(inserted);
      if (data.dedicatedPorts?.mappings) {
        for (const nodeId of previousNodeIds) {
          if (!nextNodeIds.has(nodeId)) delete data.dedicatedPorts.mappings[nodeId];
        }
      }
      Object.assign(subscription, subscriptionPatch, {
        nodeCount: inserted.length,
        lastSyncedAt: Date.now(),
        updatedAt: Date.now(),
        autoUpdate: false,
        manualSyncOnly: true
      });
      return { nodes: inserted, snapshot };
    });
  }

  restoreSubscriptionSnapshot(snapshot) {
    const subscription = snapshot?.subscription;
    if (!subscription?.id) throw createStoreError('invalid_subscription_snapshot');
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.map((node) => {
      const { dedicatedPort: _dedicatedPort, ...persistedNode } = node;
      return persistedNode;
    }) : [];
    const restoredNodeIds = new Set(nodes.map((node) => node.id));
    const dedicatedPorts = snapshot.dedicatedPorts && typeof snapshot.dedicatedPorts === 'object'
      ? snapshot.dedicatedPorts
      : {};

    return this._mutate((data) => {
      const currentNodeIds = new Set(
        (data.nodes || [])
          .filter((node) => node.subscriptionId === subscription.id)
          .map((node) => node.id)
      );
      data.nodes = (data.nodes || [])
        .filter((node) => node.subscriptionId !== subscription.id)
        .concat(nodes);

      const subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      const subscriptionIndex = subscriptions.findIndex((candidate) => candidate.id === subscription.id);
      const restoredSubscription = {
        ...subscription,
        autoUpdate: false,
        manualSyncOnly: true
      };
      if (subscriptionIndex === -1) subscriptions.push(restoredSubscription);
      else subscriptions[subscriptionIndex] = restoredSubscription;
      data.subscriptions = subscriptions;

      const portConfig = data.dedicatedPorts || {
        enabled: true,
        maxPorts: 32,
        basePort: 10801,
        mappings: {}
      };
      const mappings = portConfig.mappings || {};
      for (const nodeId of new Set([...currentNodeIds, ...restoredNodeIds])) delete mappings[nodeId];
      for (const [nodeId, port] of Object.entries(dedicatedPorts)) {
        if (restoredNodeIds.has(nodeId)) mappings[nodeId] = port;
      }
      portConfig.mappings = mappings;
      data.dedicatedPorts = portConfig;
      return true;
    });
  }

  deleteNode(nodeId) {
    this.deleteNodeWithSnapshot(nodeId);
    return true;
  }

  deleteNodeWithSnapshot(nodeId) {
    return this._mutate((data) => {
      const node = (data.nodes || []).find((candidate) => candidate.id === nodeId);
      if (!node) return null;
      const dedicatedPort = data.dedicatedPorts?.mappings?.[nodeId] || null;
      data.nodes = (data.nodes || []).filter((node) => node.id !== nodeId);
      if (data.dedicatedPorts?.mappings) delete data.dedicatedPorts.mappings[nodeId];
      return { node: { ...node }, dedicatedPort };
    });
  }

  restoreNodeSnapshot(snapshot) {
    if (!snapshot?.node?.id) throw createStoreError('invalid_proxy_node_snapshot');
    const { dedicatedPort: _dedicatedPort, ...node } = snapshot.node;
    return this._mutate((data) => {
      const nodes = Array.isArray(data.nodes) ? data.nodes : [];
      const index = nodes.findIndex((candidate) => candidate.id === node.id);
      if (index === -1) nodes.push(node);
      else nodes[index] = node;
      data.nodes = nodes;
      const portConfig = data.dedicatedPorts || {
        enabled: true,
        maxPorts: 32,
        basePort: 10801,
        mappings: {}
      };
      const mappings = portConfig.mappings || {};
      if (snapshot.dedicatedPort) mappings[node.id] = snapshot.dedicatedPort;
      else delete mappings[node.id];
      portConfig.mappings = mappings;
      data.dedicatedPorts = portConfig;
      return true;
    });
  }

  listSubscriptions() {
    return (this._readData().subscriptions || []).map((subscription) => ({
      ...subscription,
      autoUpdate: false,
      manualSyncOnly: true
    }));
  }

  upsertSubscription(subInput) {
    if (!subInput || typeof subInput !== 'object') throw createStoreError('invalid_subscription');
    const url = validateSubscriptionUrl(subInput.url);
    const id = subInput.id || generateSubId(url, subInput.name);
    const subRecord = {
      id,
      name: String(subInput.name || '我的订阅'),
      url,
      autoUpdate: false,
      manualSyncOnly: true,
      intervalHours: null,
      nodeCount: Number(subInput.nodeCount || 0),
      lastSyncedAt: subInput.lastSyncedAt || null,
      updatedAt: Date.now()
    };
    return this._mutate((data) => {
      const subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      const index = subscriptions.findIndex((subscription) => subscription.id === id);
      if (index === -1) subscriptions.push(subRecord);
      else subscriptions[index] = { ...subscriptions[index], ...subRecord };
      data.subscriptions = subscriptions;
      return subRecord;
    });
  }

  deleteSubscription(subId) {
    this.deleteSubscriptionWithSnapshot(subId);
    return true;
  }

  deleteSubscriptionWithSnapshot(subId) {
    return this._mutate((data) => {
      const subscription = (data.subscriptions || []).find((candidate) => candidate.id === subId);
      if (!subscription) return null;
      const removedNodes = (data.nodes || [])
        .filter((node) => node.subscriptionId === subId)
        .map((node) => ({ ...node }));
      const removedNodeIds = new Set(removedNodes.map((node) => node.id));
      const mappings = data.dedicatedPorts?.mappings || {};
      const snapshot = {
        subscription: { ...subscription },
        nodes: removedNodes,
        dedicatedPorts: Object.fromEntries(
          removedNodes
            .filter((node) => mappings[node.id])
            .map((node) => [node.id, mappings[node.id]])
        )
      };
      data.subscriptions = (data.subscriptions || []).filter((subscription) => subscription.id !== subId);
      data.nodes = (data.nodes || []).filter((node) => node.subscriptionId !== subId);
      if (data.dedicatedPorts?.mappings) {
        for (const nodeId of removedNodeIds) delete data.dedicatedPorts.mappings[nodeId];
      }
      return snapshot;
    });
  }

  listGroups() {
    const data = this._readData();
    const nodes = data.nodes || [];
    const groups = [
      { id: 'all', name: '全部节点', icon: '🌐', count: nodes.length },
      { id: 'ai', name: 'AI 专线', icon: '🤖', count: nodes.filter((node) => node.tags?.includes('ai') || /openai|claude|chatgpt|gemini|grok|ai/i.test(node.name)).length },
      { id: 'dev', name: '开发加速', icon: '⚡', count: nodes.filter((node) => node.tags?.includes('dev') || /github|git|dev|speed|加速/i.test(node.name)).length },
      { id: 'dedicated', name: '独立端口', icon: '🔌', count: Object.keys(data.dedicatedPorts?.mappings || {}).length }
    ];
    const countries = new Map();
    for (const node of nodes) {
      const code = node.countryCode || 'UN';
      if (!countries.has(code)) {
        const flag = node.countryFlag || '🌐';
        countries.set(code, { id: code, name: `${flag} ${node.countryName || '其它'}`, icon: flag, count: 0 });
      }
      countries.get(code).count += 1;
    }
    return groups.concat(Array.from(countries.values()));
  }

  getRoutingConfig() {
    const routing = this._readData().routing;
    return routing || { mode: 'rule', activeOutboundNodeId: null, rules: [] };
  }

  setRoutingConfig(routing) {
    if (!routing || typeof routing !== 'object') throw createStoreError('invalid_routing_config');
    if (routing.mode !== undefined && !['global', 'rule', 'direct'].includes(routing.mode)) {
      throw createStoreError('invalid_routing_mode');
    }
    if (routing.rules !== undefined && !Array.isArray(routing.rules)) throw createStoreError('invalid_routing_rules');
    return this._mutate((data) => {
      data.routing = { ...(data.routing || {}), ...routing };
      return data.routing;
    });
  }

  getDedicatedPortsConfig() {
    return this._readData().dedicatedPorts || { enabled: true, maxPorts: 32, basePort: 10801, mappings: {} };
  }

  setDedicatedPortsConfig(config) {
    if (!config || typeof config !== 'object') throw createStoreError('invalid_dedicated_ports_config');
    if (config.basePort !== undefined && !isValidPort(config.basePort)) throw createStoreError('invalid_proxy_port');
    if (config.maxPorts !== undefined && (!Number.isInteger(Number(config.maxPorts)) || Number(config.maxPorts) < 1 || Number(config.maxPorts) > 256)) {
      throw createStoreError('invalid_dedicated_port_limit');
    }
    const update = {};
    if (config.enabled !== undefined) update.enabled = Boolean(config.enabled);
    if (config.basePort !== undefined) update.basePort = Number(config.basePort);
    if (config.maxPorts !== undefined) update.maxPorts = Number(config.maxPorts);
    return this._mutate((data) => {
      data.dedicatedPorts = { ...(data.dedicatedPorts || {}), ...update };
      return data.dedicatedPorts;
    });
  }

  getNetworkConfig() {
    const tun = this._readData().network?.tun || {};
    return {
      tun: {
        enabled: tun.enabled === true,
        stack: ['system', 'gvisor', 'mixed'].includes(String(tun.stack || '').toLowerCase())
          ? String(tun.stack).toLowerCase()
          : 'mixed',
        autoRoute: tun.autoRoute !== false,
        autoDetectInterface: tun.autoDetectInterface !== false,
        strictRoute: tun.strictRoute === true,
        dnsHijack: Array.isArray(tun.dnsHijack) && tun.dnsHijack.length
          ? tun.dnsHijack.map(String).filter(Boolean)
          : ['any:53']
      }
    };
  }

  setNetworkConfig(config = {}) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw createStoreError('invalid_network_config');
    }
    const tun = config.tun || {};
    if (tun.stack !== undefined && !['system', 'gvisor', 'mixed'].includes(String(tun.stack).toLowerCase())) {
      throw createStoreError('invalid_tun_stack');
    }
    if (tun.dnsHijack !== undefined && (!Array.isArray(tun.dnsHijack) || tun.dnsHijack.some((item) => typeof item !== 'string' || !item.trim()))) {
      throw createStoreError('invalid_tun_dns_hijack');
    }
    return this._mutate((data) => {
      const current = this.getNetworkConfig();
      const nextTun = {
        ...current.tun,
        ...tun,
        enabled: tun.enabled === undefined ? current.tun.enabled : Boolean(tun.enabled),
        stack: tun.stack === undefined ? current.tun.stack : String(tun.stack).toLowerCase(),
        autoRoute: tun.autoRoute === undefined ? current.tun.autoRoute : Boolean(tun.autoRoute),
        autoDetectInterface: tun.autoDetectInterface === undefined ? current.tun.autoDetectInterface : Boolean(tun.autoDetectInterface),
        strictRoute: tun.strictRoute === undefined ? current.tun.strictRoute : Boolean(tun.strictRoute),
        dnsHijack: tun.dnsHijack === undefined ? current.tun.dnsHijack : tun.dnsHijack.map(String).filter(Boolean)
      };
      data.network = { ...(data.network || {}), tun: nextTun };
      return { tun: { ...nextTun, dnsHijack: [...nextTun.dnsHijack] } };
    });
  }

  assignDedicatedPort(nodeId, requestedPort = null) {
    return this._mutate((data) => {
      const config = data.dedicatedPorts || { enabled: true, maxPorts: 32, basePort: 10801, mappings: {} };
      const mappings = config.mappings || {};
      if (mappings[nodeId]) return { ok: true, port: mappings[nodeId], alreadyAssigned: true };
      const maxLimit = Number(config.maxPorts || 32);
      if (Object.keys(mappings).length >= maxLimit) {
        return {
          ok: false,
          error: `已达到最大并发独立端口上限 (${maxLimit})`,
          code: 'dedicated_port_limit_reached'
        };
      }
      const usedPorts = new Set(Object.values(mappings).map(Number));
      let assigned;
      if (requestedPort !== null && requestedPort !== undefined) {
        if (!isValidPort(requestedPort)) return { ok: false, error: 'invalid_proxy_port' };
        assigned = Number(requestedPort);
        if (usedPorts.has(assigned)) return { ok: false, error: 'dedicated_port_in_use' };
      } else {
        assigned = Number(config.basePort || 10801);
        while (usedPorts.has(assigned) && assigned <= 65535) assigned += 1;
        if (!isValidPort(assigned)) return { ok: false, error: 'no_dedicated_port_available' };
      }
      mappings[nodeId] = assigned;
      config.mappings = mappings;
      data.dedicatedPorts = config;
      return { ok: true, port: assigned };
    });
  }

  releaseDedicatedPort(nodeId) {
    return this._mutate((data) => {
      const releasedPort = data.dedicatedPorts?.mappings?.[nodeId] || null;
      if (releasedPort) delete data.dedicatedPorts.mappings[nodeId];
      return { ok: true, releasedPort };
    });
  }

  updateNodeLatency(nodeId, latencyMs) {
    return this._mutate((data) => {
      const node = (data.nodes || []).find((candidate) => candidate.id === nodeId);
      if (!node) return false;
      node.latencyMs = Number(latencyMs);
      node.lastChecked = Date.now();
      return true;
    });
  }
}

let defaultStoreInstance = null;
function getProxyNodeStore(options) {
  if (options) return new ProxyNodeStore(options);
  if (!defaultStoreInstance) defaultStoreInstance = new ProxyNodeStore();
  return defaultStoreInstance;
}

module.exports = {
  ProxyNodeStore,
  createInitialData,
  generateNodeId,
  generateSubId,
  getProxyNodeStore,
  validateProxyNodeInput,
  validateSubscriptionUrl
};
