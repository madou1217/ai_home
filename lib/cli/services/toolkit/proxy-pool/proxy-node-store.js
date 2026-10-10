'use strict';

const { resolveProxyPoolAiHome } = require('./aih-home');
const nativeFs = require('node:fs');
const nativePath = require('node:path');
const crypto = require('node:crypto');
const { inferCountryCode, normalizeServerHost } = require('./protocol-parsers/base-parser');
const {
  isValidPort,
  normalizeProtocol,
  SUPPORTED_PROTOCOLS
} = require('./proxy-protocol-contract');
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('./secure-file-io');
const { validateDeclaredFields } = require('./protocol-fields');

// 协议字段由各协议插件声明（./protocols 的 fields / required）。按需加载：插件引用的
// 内核字段工具依赖本模块所在的契约层，顶层 require 会形成初始化环。
function protocolPlugin(protocol) {
  return require('./protocols').getProtocolPlugin(protocol);
}

const NODE_METADATA_FIELDS = [
  'id', 'name', 'protocol', 'server', 'port', 'group', 'tags',
  'countryCode', 'countryName', 'countryFlag',
  'subscriptionId', 'latencyMs', 'lastChecked', 'updatedAt', 'createdAt', 'rawUri'
];

function createStoreError(code, message = code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function createInitialData() {
  return {
    version: 1,
    nodes: [],
    subscriptions: []
  };
}

// 本地代理内核与节点/分组出口下线后不再使用的旧字段（分流、专用端口、TUN、内核、
// 出口故障转移、静态分组、手动分组与分组策略），下次写入时清掉。
const RETIRED_DATA_KEYS = Object.freeze([
  'routing', 'dedicatedPorts', 'network', 'core', 'outboundFailover', 'groups', 'manualGroups', 'groupPolicies'
]);

function generateNodeId(node) {
  const seed = `${node.protocol}:${node.server}:${node.port}:${node.uuid || node.password || node.username || ''}:${node.name}`;
  return `node_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

function normalizeConnectionValue(field, value) {
  if (field === 'network') return String(value || 'tcp').trim().toLowerCase();
  if (['tls', 'allowInsecure', 'insecure'].includes(field)) return value === true;
  if (Array.isArray(value)) return value.map((item) => normalizeConnectionValue('', item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeConnectionValue(key, item)])
    );
  }
  return value === undefined || value === '' ? null : value;
}

function buildProxyNodeConnectionKey(node) {
  const protocol = normalizeProtocol(node?.protocol);
  const fields = Object.keys(protocolPlugin(protocol)?.fields || {});
  const identity = [
    ['protocol', protocol],
    ['server', normalizeServerHost(node?.server)],
    ['port', Number(node?.port) || 0],
    ...fields.map((field) => [field, normalizeConnectionValue(field, node?.[field])])
  ];
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function reconcileSubscriptionNodes(previousNodes, nextNodes) {
  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  const previousByConnection = new Map();
  for (const node of previousNodes) {
    const key = buildProxyNodeConnectionKey(node);
    if (!previousByConnection.has(key)) previousByConnection.set(key, []);
    previousByConnection.get(key).push(node);
  }
  const usedIds = new Set();
  const takeConnectionMatch = (node) => {
    const queue = previousByConnection.get(buildProxyNodeConnectionKey(node)) || [];
    while (queue.length > 0) {
      const candidate = queue.shift();
      if (!usedIds.has(candidate.id)) return candidate;
    }
    return null;
  };
  return nextNodes.map((node) => {
    const exact = previousById.get(node.id);
    const previous = exact && !usedIds.has(exact.id) ? exact : takeConnectionMatch(node);
    if (!previous) return node;
    usedIds.add(previous.id);
    return {
      ...node,
      id: previous.id,
      latencyMs: node.latencyMs === null || node.latencyMs === undefined
        ? (previous.latencyMs ?? null)
        : node.latencyMs,
      lastChecked: node.lastChecked || previous.lastChecked || null,
      createdAt: node.createdAt || previous.createdAt
    };
  });
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

function validateProxyNodeInput(nodeInput) {
  if (!nodeInput || typeof nodeInput !== 'object' || Array.isArray(nodeInput)) {
    throw createStoreError('invalid_proxy_node');
  }
  const protocol = normalizeProtocol(nodeInput.protocol);
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw createStoreError('unsupported_proxy_protocol', `unsupported_proxy_protocol_${protocol || 'empty'}`);
  }
  const plugin = protocolPlugin(protocol);
  const allowedFields = new Set(NODE_METADATA_FIELDS.concat(Object.keys(plugin.fields || {})));
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
  try {
    validateDeclaredFields(nodeInput, plugin);
  } catch (error) {
    // 字段非法、传输层不支持沿用通用错误码，具体字段放在 message；缺必填字段保留具体码。
    const specific = String(error.code || error.message || 'invalid_proxy_field');
    const generic = specific.startsWith('invalid_proxy_field_') ? 'invalid_proxy_field'
      : specific.startsWith('unsupported_proxy_transport_') ? 'unsupported_proxy_transport'
        : specific;
    throw createStoreError(generic, specific, error);
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
    const aiHomeDir = resolveProxyPoolAiHome({ aiHomeDir: options.aiHomeDir, env: this.env, path: this.path });
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
    for (const key of RETIRED_DATA_KEYS) delete data[key];
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
    const stored = this._readData().nodes;
    let nodes = Array.isArray(stored) ? stored : [];
    if (filter.protocol) nodes = nodes.filter((node) => node.protocol === filter.protocol);
    return nodes.map((node) => ({ ...node }));
  }

  _completeNode(nodeInput) {
    const normalized = validateProxyNodeInput(nodeInput);
    const identity = { ...nodeInput, ...normalized };
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
    if (!subscriptionId) throw createStoreError('invalid_subscription_id');
    const prepared = nodeList.map((node) => this._completeNode({ ...node, subscriptionId }));
    return this._mutate((data) => {
      const subscription = (data.subscriptions || []).find((candidate) => candidate.id === subscriptionId);
      if (!subscription) throw createStoreError('subscription_not_found');
      const previousNodes = (data.nodes || []).filter((node) => node.subscriptionId === subscriptionId);
      const inserted = reconcileSubscriptionNodes(previousNodes, prepared);
      data.nodes = (data.nodes || []).filter((node) => node.subscriptionId !== subscriptionId).concat(inserted);
      Object.assign(subscription, subscriptionPatch, {
        nodeCount: inserted.length,
        lastSyncedAt: Date.now(),
        updatedAt: Date.now(),
        autoUpdate: false,
        manualSyncOnly: true
      });
      return inserted;
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

  /** 删除订阅及其节点，返回被删除的节点数；订阅不存在时返回 null。 */
  deleteSubscription(subId) {
    return this._mutate((data) => {
      const subscription = (data.subscriptions || []).find((candidate) => candidate.id === subId);
      if (!subscription) return null;
      const before = (data.nodes || []).length;
      data.subscriptions = (data.subscriptions || []).filter((candidate) => candidate.id !== subId);
      data.nodes = (data.nodes || []).filter((node) => node.subscriptionId !== subId);
      return before - data.nodes.length;
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
  buildProxyNodeConnectionKey,
  createInitialData,
  generateNodeId,
  generateSubId,
  getProxyNodeStore,
  validateProxyNodeInput,
  validateSubscriptionUrl
};
