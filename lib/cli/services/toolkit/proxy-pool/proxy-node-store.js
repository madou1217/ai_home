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

const NODE_METADATA_FIELDS = [
  'id', 'name', 'protocol', 'server', 'port', 'group', 'tags',
  'countryCode', 'countryName', 'countryFlag',
  'subscriptionId', 'latencyMs', 'lastChecked', 'updatedAt', 'createdAt', 'rawUri'
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
    manualGroups: [],
    groupPolicies: {}
  };
}

// 本地代理内核下线后不再使用的旧字段（分流、专用端口、TUN、内核、出口故障转移、静态分组），下次写入时清掉。
const RETIRED_DATA_KEYS = Object.freeze(['routing', 'dedicatedPorts', 'network', 'core', 'outboundFailover', 'groups']);

const DEFAULT_PROXY_GROUP_STRATEGY = 'sticky';
const DEFAULT_PROXY_GROUP_FAILOVER_STRATEGY = 'lowest_latency';
const PROXY_GROUP_STRATEGIES = new Set([
  DEFAULT_PROXY_GROUP_STRATEGY,
  'lowest_latency',
  'round_robin',
  'random'
]);
const RESERVED_PROXY_GROUP_IDS = new Set(['all', 'ai', 'dev']);

function generateGroupId(name) {
  const entropy = `${String(name || '')}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`;
  return `group_${crypto.createHash('sha256').update(entropy).digest('hex').slice(0, 12)}`;
}

function normalizeGroupNodeIds(value) {
  if (!Array.isArray(value)) throw createStoreError('invalid_proxy_group_nodes');
  return [...new Set(value.map((nodeId) => String(nodeId || '').trim()).filter(Boolean))];
}

function normalizeGroupStrategy(value, fallback) {
  const strategy = String(value || fallback || '').trim().toLowerCase();
  if (!PROXY_GROUP_STRATEGIES.has(strategy)) {
    throw createStoreError('invalid_proxy_group_strategy');
  }
  return strategy;
}

function resolveGroupPolicy(data, group) {
  const persisted = data.groupPolicies && typeof data.groupPolicies === 'object'
    ? data.groupPolicies[group.id]
    : null;
  return {
    ...group,
    strategy: normalizeGroupStrategy(
      group.strategy || persisted?.strategy,
      DEFAULT_PROXY_GROUP_STRATEGY
    ),
    failoverStrategy: normalizeGroupStrategy(
      group.failoverStrategy || persisted?.failoverStrategy,
      DEFAULT_PROXY_GROUP_FAILOVER_STRATEGY
    )
  };
}

function isAutomaticGroup(data, groupId) {
  if (RESERVED_PROXY_GROUP_IDS.has(groupId)) return true;
  if (groupId.startsWith('subscription:')) {
    const subscriptionId = groupId.slice('subscription:'.length);
    return (data.subscriptions || []).some((subscription) => subscription.id === subscriptionId);
  }
  return (data.nodes || []).some((node) => (node.countryCode || 'UN') === groupId);
}

function resolveGroupNodeIds(data, groupId) {
  const id = String(groupId || '').trim();
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  if (!id || id === 'all') return new Set(nodes.map((node) => node.id));
  if (id === 'ai') {
    return new Set(nodes
      .filter((node) => node.tags?.includes('ai') || /openai|claude|chatgpt|gemini|grok|ai/i.test(node.name))
      .map((node) => node.id));
  }
  if (id === 'dev') {
    return new Set(nodes
      .filter((node) => node.tags?.includes('dev') || /github|git|dev|speed|加速/i.test(node.name))
      .map((node) => node.id));
  }
  if (id.startsWith('subscription:')) {
    const subscriptionId = id.slice('subscription:'.length);
    return new Set(nodes
      .filter((node) => node.subscriptionId === subscriptionId)
      .map((node) => node.id));
  }
  const manual = (data.manualGroups || []).find((group) => group.id === id);
  if (manual) return new Set(manual.nodeIds || []);
  return new Set(nodes
    .filter((node) => node.group === id || node.tags?.includes(id) || node.countryCode === id)
    .map((node) => node.id));
}

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
  const fields = NODE_PROTOCOL_FIELDS[protocol] || [];
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

function listGroupsFromData(data) {
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const groups = [
    { id: 'all', name: '全部节点', icon: '🌐', kind: 'system', count: nodes.length },
    { id: 'ai', name: 'AI 专线', icon: '🤖', kind: 'system', count: nodes.filter((node) => node.tags?.includes('ai') || /openai|claude|chatgpt|gemini|grok|ai/i.test(node.name)).length },
    { id: 'dev', name: '开发加速', icon: '⚡', kind: 'system', count: nodes.filter((node) => node.tags?.includes('dev') || /github|git|dev|speed|加速/i.test(node.name)).length }
  ];
  for (const subscription of data.subscriptions || []) {
    groups.push({
      id: `subscription:${subscription.id}`,
      name: subscription.name,
      icon: '🔗',
      kind: 'subscription',
      count: nodes.filter((node) => node.subscriptionId === subscription.id).length
    });
  }
  const countries = new Map();
  for (const node of nodes) {
    const code = node.countryCode || 'UN';
    if (!countries.has(code)) {
      const flag = node.countryFlag || '🌐';
      countries.set(code, {
        id: code,
        name: `${flag} ${node.countryName || '其它'}`,
        icon: flag,
        kind: 'country',
        count: 0
      });
    }
    countries.get(code).count += 1;
  }
  const manualGroups = (data.manualGroups || []).map((group) => ({
    ...group,
    kind: 'manual',
    count: (group.nodeIds || []).filter((nodeId) => nodes.some((node) => node.id === nodeId)).length
  }));
  return groups
    .concat(Array.from(countries.values()), manualGroups)
    .map((group) => resolveGroupPolicy(data, group));
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
    const data = this._readData();
    let nodes = Array.isArray(data.nodes) ? data.nodes : [];
    if (filter.group) {
      const memberIds = resolveGroupNodeIds(data, filter.group);
      nodes = nodes.filter((node) => memberIds.has(node.id));
    }
    if (filter.protocol) nodes = nodes.filter((node) => node.protocol === filter.protocol);
    return nodes.map((node) => ({ ...node }));
  }

  getNode(nodeId) {
    const node = (this._readData().nodes || []).find((candidate) => candidate.id === nodeId);
    return node ? { ...node } : null;
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

  listGroups() {
    return listGroupsFromData(this._readData());
  }

  getGroup(groupId) {
    const id = String(groupId || '').trim();
    if (!id) return null;
    const data = this._readData();
    const listed = this.listGroups().find((group) => group.id === id);
    if (!listed) return null;
    if (listed.kind === 'manual') return { ...listed, nodeIds: [...(listed.nodeIds || [])] };
    return {
      ...listed,
      nodeIds: [...resolveGroupNodeIds(data, id)]
    };
  }

  upsertGroup(groupInput) {
    if (!groupInput || typeof groupInput !== 'object' || Array.isArray(groupInput)) {
      throw createStoreError('invalid_proxy_group');
    }
    const allowedFields = new Set([
      'id', 'name', 'icon', 'nodeIds', 'strategy', 'failoverStrategy'
    ]);
    const unknownField = Object.keys(groupInput).find((field) => !allowedFields.has(field));
    if (unknownField) throw createStoreError('unsupported_proxy_group_field');
    const name = String(groupInput.name || '').trim();
    if (!name) throw createStoreError('invalid_proxy_group_name');
    const requestedId = String(groupInput.id || '').trim();
    if (RESERVED_PROXY_GROUP_IDS.has(requestedId)) throw createStoreError('reserved_proxy_group_id');
    if (requestedId && !/^group_[A-Za-z0-9_-]+$/.test(requestedId)) {
      throw createStoreError('invalid_proxy_group_id');
    }
    const nodeIds = normalizeGroupNodeIds(groupInput.nodeIds || []);

    return this._mutate((data) => {
      const knownNodeIds = new Set((data.nodes || []).map((node) => node.id));
      if (nodeIds.some((nodeId) => !knownNodeIds.has(nodeId))) {
        throw createStoreError('group_node_not_found');
      }
      const manualGroups = Array.isArray(data.manualGroups) ? data.manualGroups : [];
      const id = requestedId || generateGroupId(name);
      const index = manualGroups.findIndex((group) => group.id === id);
      const previous = index >= 0 ? manualGroups[index] : null;
      const strategy = normalizeGroupStrategy(
        groupInput.strategy || previous?.strategy,
        DEFAULT_PROXY_GROUP_STRATEGY
      );
      const failoverStrategy = normalizeGroupStrategy(
        groupInput.failoverStrategy || previous?.failoverStrategy,
        DEFAULT_PROXY_GROUP_FAILOVER_STRATEGY
      );
      const now = Date.now();
      const record = {
        id,
        name,
        icon: String(groupInput.icon || (index >= 0 ? manualGroups[index].icon : '') || '').trim(),
        kind: 'manual',
        nodeIds,
        strategy,
        failoverStrategy,
        createdAt: index >= 0 ? manualGroups[index].createdAt : now,
        updatedAt: now
      };
      if (index === -1) manualGroups.push(record);
      else manualGroups[index] = record;
      data.manualGroups = manualGroups;
      return { ...record, nodeIds: [...record.nodeIds] };
    });
  }

  deleteGroup(groupId) {
    const id = String(groupId || '').trim();
    if (!id || RESERVED_PROXY_GROUP_IDS.has(id)) return false;
    return this._mutate((data) => {
      const manualGroups = Array.isArray(data.manualGroups) ? data.manualGroups : [];
      const next = manualGroups.filter((group) => group.id !== id);
      if (next.length === manualGroups.length) return false;
      data.manualGroups = next;
      if (data.groupPolicies && typeof data.groupPolicies === 'object') {
        delete data.groupPolicies[id];
      }
      return true;
    });
  }

  updateGroupPolicy(groupId, policyInput = {}) {
    const id = String(groupId || '').trim();
    if (!id) throw createStoreError('proxy_group_id_required');
    if (!policyInput || typeof policyInput !== 'object' || Array.isArray(policyInput)) {
      throw createStoreError('invalid_proxy_group_policy');
    }
    const allowedFields = new Set(['strategy', 'failoverStrategy']);
    const unknownField = Object.keys(policyInput).find((field) => !allowedFields.has(field));
    if (unknownField) throw createStoreError('unsupported_proxy_group_policy_field');

    return this._mutate((data) => {
      const manualGroups = Array.isArray(data.manualGroups) ? data.manualGroups : [];
      const manual = manualGroups.find((group) => group.id === id);
      if (!manual && !isAutomaticGroup(data, id)) {
        throw createStoreError('proxy_group_not_found');
      }
      const current = manual || data.groupPolicies?.[id] || {};
      const strategy = normalizeGroupStrategy(
        policyInput.strategy || current.strategy,
        DEFAULT_PROXY_GROUP_STRATEGY
      );
      const failoverStrategy = normalizeGroupStrategy(
        policyInput.failoverStrategy || current.failoverStrategy,
        DEFAULT_PROXY_GROUP_FAILOVER_STRATEGY
      );
      if (manual) {
        manual.strategy = strategy;
        manual.failoverStrategy = failoverStrategy;
        manual.updatedAt = Date.now();
        return resolveGroupPolicy(data, {
          ...manual,
          count: (manual.nodeIds || []).filter((nodeId) => (
            (data.nodes || []).some((node) => node.id === nodeId)
          )).length
        });
      }
      if (!data.groupPolicies || typeof data.groupPolicies !== 'object') data.groupPolicies = {};
      data.groupPolicies[id] = { strategy, failoverStrategy, updatedAt: Date.now() };
      const automatic = listGroupsFromData(data).find((group) => group.id === id);
      return automatic || null;
    });
  }

  updateNodeLatencies(results, checkedAt = Date.now()) {
    const normalized = new Map();
    for (const result of Array.isArray(results) ? results : []) {
      const nodeId = String(result?.nodeId || '').trim();
      const latencyMs = Number(result?.latencyMs);
      if (!nodeId || !Number.isFinite(latencyMs) || latencyMs < -1) continue;
      normalized.set(nodeId, latencyMs);
    }
    const timestamp = Number(checkedAt);
    const lastChecked = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
    return this._mutate((data) => {
      let updated = 0;
      for (const node of data.nodes || []) {
        if (!normalized.has(node.id)) continue;
        node.latencyMs = normalized.get(node.id);
        node.lastChecked = lastChecked;
        normalized.delete(node.id);
        updated += 1;
      }
      return { updated, missing: normalized.size };
    });
  }

  updateNodeLatency(nodeId, latencyMs) {
    return this.updateNodeLatencies([{ nodeId, latencyMs }]).updated === 1;
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
