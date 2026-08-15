'use strict';

const { getProxyNodeStore, validateProxyNodeInput } = require('./proxy-node-store');
const {
  encodeProxyNode,
  parseClashYamlProxiesDetailed,
  parseSubscriptionContent
} = require('./protocol-parsers');
const { compileMihomoConfig } = require('./mihomo-config-compiler');
const { MihomoRuntime } = require('./mihomo-runtime');
const { DedicatedPortManager } = require('./dedicated-port-manager');
const { RoutingManager } = require('./routing-manager');
const { SubscriptionFetcher } = require('./subscription-fetcher');
const {
  detectNetworkLayer,
  executeSystemProxyPlan,
  planSystemProxy,
  readMacProxySnapshot,
  readLinuxProxySnapshot,
  readWindowsProxySnapshot,
  hashSnapshot
} = require('../system-network-manager');
const {
  hasRoutingWarnings,
  isCoreResultFullyApplied,
  mergeWarnings,
  normalizeCoreApplyResult
} = require('./core-apply-result');

function serviceError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isSingleHttpUrl(value) {
  const text = String(value || '').trim();
  if (!text || /[\r\n]/.test(text)) return false;
  try {
    return ['http:', 'https:'].includes(new URL(text).protocol);
  } catch (_error) {
    return false;
  }
}

function unsupportedSchemes(content) {
  const supported = new Set(['ss', 'vmess', 'vless', 'trojan', 'hy2', 'hysteria2', 'hysteria', 'socks', 'socks5', 'http', 'https']);
  const schemes = [];
  for (const line of String(content || '').split(/[\r\n]+/)) {
    const match = line.trim().match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (match && !supported.has(match[1].toLowerCase())) schemes.push(match[1].toLowerCase());
  }
  return [...new Set(schemes)];
}

function validateRoutingRules(rules) {
  if (!Array.isArray(rules)) throw serviceError('invalid_routing_rules');
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw serviceError('invalid_routing_rule');
    const allowed = new Set(['id', 'name', 'target', 'outbound', 'nodeId', 'domains', 'ips']);
    const unknown = Object.keys(rule).find((field) => !allowed.has(field));
    if (unknown) throw serviceError('unsupported_routing_field', `unsupported_routing_field_${unknown}`);
    const outbound = rule.outbound || 'proxy';
    if (!['proxy', 'direct', 'reject'].includes(outbound)) throw serviceError('invalid_routing_outbound');
    if (rule.domains !== undefined && !Array.isArray(rule.domains)) throw serviceError('invalid_routing_domains');
    if (rule.ips !== undefined && !Array.isArray(rule.ips)) throw serviceError('invalid_routing_ips');
    return {
      ...rule,
      id: String(rule.id || `rule_${index + 1}`),
      outbound,
      domains: (rule.domains || []).map(String),
      ips: (rule.ips || []).map(String)
    };
  });
}

function routingSignature(routing) {
  return JSON.stringify({
    mode: routing?.mode || 'rule',
    activeOutboundNodeId: routing?.activeOutboundNodeId || null,
    rules: routing?.rules || []
  });
}

class ProxyPoolService {
  constructor(options = {}) {
    this.store = options.store || getProxyNodeStore(options.storeOptions);
    this.coreRuntime = options.coreRuntime || new MihomoRuntime(options.coreRuntimeOptions);
    this.routingManager = options.routingManager || new RoutingManager(this.store);
    this.subscriptionFetcher = options.subscriptionFetcher || new SubscriptionFetcher(options.subscriptionOptions);
    this.mixedPort = Number(options.mixedPort || 10800);
    this.appliedRoutingSignature = null;
    this.mutationTail = Promise.resolve();
    this.portManager = options.portManager || new DedicatedPortManager(this.store, {
      coreRuntime: this.coreRuntime,
      stateProvider: () => this._coreState()
    });
  }

  _coreState() {
    return {
      mixedPort: this.mixedPort,
      nodes: this.store.listNodes(),
      routing: this.store.getRoutingConfig(),
      dedicatedPorts: this.store.getDedicatedPortsConfig(),
      network: this.store.getNetworkConfig?.() || { tun: { enabled: false } },
      tun: this.store.getNetworkConfig?.()?.tun || { enabled: false }
    };
  }

  _enqueueMutation(operation) {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async _safeReload() {
    try {
      return await this.coreRuntime.reload(this._coreState());
    } catch (error) {
      return { ok: false, applied: false, error: 'proxy_core_reload_failed', message: error.message };
    }
  }

  async _finishMutation({ restore, rollbackErrorCode, success, warnings = [] }) {
    const coreBefore = this.getCoreStatus();
    if (!coreBefore.running) {
      this.appliedRoutingSignature = null;
      return { ...success, applied: true, core: coreBefore, warnings: mergeWarnings(warnings) };
    }

    const reload = await this._safeReload();
    if (isCoreResultFullyApplied(reload)) {
      this.appliedRoutingSignature = routingSignature(this.store.getRoutingConfig());
      return {
        ...success,
        applied: true,
        core: reload.core || this.getCoreStatus(),
        warnings: mergeWarnings(warnings, reload.warnings)
      };
    }

    this.appliedRoutingSignature = null;
    try {
      restore();
    } catch (error) {
      return {
        ok: false,
        applied: false,
        error: rollbackErrorCode,
        message: error.message,
        core: reload.core || this.getCoreStatus(),
        warnings: mergeWarnings(warnings, [reload.error], reload.warnings)
      };
    }

    let compensation = null;
    if (this.getCoreStatus().running) {
      compensation = await this._safeReload();
      if (!isCoreResultFullyApplied(compensation)) {
        return {
          ok: false,
          applied: false,
          error: rollbackErrorCode,
          message: compensation.message || 'proxy_core_rollback_not_applied',
          core: compensation.core || this.getCoreStatus(),
          warnings: mergeWarnings(
            warnings,
            [reload.error || 'routing_not_fully_applied', compensation.error],
            reload.warnings,
            compensation.warnings
          )
        };
      }
      this.appliedRoutingSignature = routingSignature(this.store.getRoutingConfig());
    }

    return {
      ok: false,
      applied: false,
      error: reload.error || (hasRoutingWarnings(reload) ? 'routing_not_fully_applied' : 'proxy_core_reload_failed'),
      message: reload.message,
      core: compensation?.core || reload.core || this.getCoreStatus(),
      warnings: mergeWarnings(warnings, reload.warnings)
    };
  }

  listNodes(filter = {}) {
    const nodes = this.store.listNodes(filter);
    const routing = this.routingManager.getRoutingState();
    return {
      ok: true,
      total: nodes.length,
      activeOutboundNodeId: routing.activeOutboundNodeId,
      routingMode: routing.mode,
      groups: this.store.listGroups(),
      nodes
    };
  }

  getNode(nodeId) {
    const node = this.store.getNode(nodeId);
    if (!node) return { ok: false, error: 'node_not_found' };
    return { ok: true, node, uri: encodeProxyNode(node) };
  }

  _validateRuntimeNode(node) {
    validateProxyNodeInput(node);
    const compiled = compileMihomoConfig({
      nodes: [node],
      routing: { mode: 'direct', rules: [] },
      dedicatedPorts: { mappings: {} }
    }, { includeController: false });
    if (compiled.exportedNodeCount !== 1) {
      throw serviceError(compiled.skippedNodes[0]?.reason || 'invalid_proxy_node');
    }
  }

  upsertNode(nodeInput) {
    return this._enqueueMutation(() => this._upsertNode(nodeInput));
  }

  _upsertNode(nodeInput) {
    this._validateRuntimeNode(nodeInput);
    const node = this.store.upsertNode(nodeInput);
    const core = this.getCoreStatus();
    return {
      ok: true,
      node,
      uri: encodeProxyNode(node),
      applied: !core.running,
      core,
      warnings: core.running ? ['proxy_core_reload_required'] : []
    };
  }

  deleteNode(nodeId) {
    return this._enqueueMutation(() => this._deleteNode(nodeId));
  }

  async _deleteNode(nodeId) {
    let snapshot;
    if (typeof this.store.deleteNodeWithSnapshot === 'function') {
      snapshot = this.store.deleteNodeWithSnapshot(nodeId);
    } else {
      const node = this.store.getNode(nodeId);
      if (!node) return { ok: false, applied: false, error: 'node_not_found' };
      snapshot = {
        node,
        dedicatedPort: this.store.getDedicatedPortsConfig().mappings?.[nodeId] || null
      };
      this.store.deleteNode(nodeId);
    }
    if (!snapshot) return { ok: false, applied: false, error: 'node_not_found' };

    return this._finishMutation({
      rollbackErrorCode: 'node_rollback_failed',
      restore: () => {
        if (typeof this.store.restoreNodeSnapshot === 'function') {
          this.store.restoreNodeSnapshot(snapshot);
          return;
        }
        this.store.upsertNode(snapshot.node);
        if (snapshot.dedicatedPort) this.store.assignDedicatedPort(nodeId, snapshot.dedicatedPort);
      },
      success: { ok: true }
    });
  }

  _parseImportContent(content, subscriptionId = null) {
    const clashResult = /^\s*proxies\s*:/m.test(String(content || ''))
      ? parseClashYamlProxiesDetailed(content)
      : null;
    const parsedNodes = clashResult ? clashResult.nodes : parseSubscriptionContent(content);
    const nodes = [];
    const skippedNodes = (clashResult?.skippedNodes || []).concat(unsupportedSchemes(content).map((protocol) => ({
      nodeId: null,
      name: null,
      reason: `unsupported_proxy_protocol_${protocol}`
    })));
    for (const node of parsedNodes) {
      try {
        this._validateRuntimeNode(node);
        nodes.push({ ...node, subscriptionId: subscriptionId || node.subscriptionId || null });
      } catch (error) {
        skippedNodes.push({
          nodeId: node.id || null,
          name: node.name || null,
          reason: error.message
        });
      }
    }
    return { nodes, skippedNodes, warnings: clashResult?.warnings || [] };
  }

  importNodes(textOrUrls, subscriptionId = null) {
    return this._enqueueMutation(() => this._importNodes(textOrUrls, subscriptionId));
  }

  _importNodes(textOrUrls, subscriptionId = null) {
    if (isSingleHttpUrl(textOrUrls)) {
      return { ok: false, error: 'subscription_url_requires_subscription_flow', count: 0 };
    }
    const parsed = this._parseImportContent(textOrUrls, subscriptionId);
    if (!parsed.nodes.length) {
      return {
        ok: false,
        error: 'no_valid_proxy_nodes_found',
        count: 0,
        skippedNodes: parsed.skippedNodes,
        warnings: parsed.warnings
      };
    }
    const inserted = this.store.bulkUpsertNodes(parsed.nodes, subscriptionId);
    const core = this.getCoreStatus();
    return {
      ok: true,
      count: inserted.length,
      nodes: inserted,
      skippedNodes: parsed.skippedNodes,
      warnings: parsed.warnings.concat(core.running ? ['proxy_core_reload_required'] : []),
      applied: !core.running
    };
  }

  exportAggregateSubscription(format = 'mihomo', filter = {}) {
    const normalizedFormat = String(format || 'mihomo').toLowerCase();
    if (!['mihomo', 'clash', 'yaml', 'base64'].includes(normalizedFormat)) {
      return {
        ok: false,
        error: 'unsupported_export_format',
        supportedFormats: ['mihomo', 'base64']
      };
    }
    const nodes = this.store.listNodes(filter);
    const requestedNodeCount = nodes.length;
    if (normalizedFormat !== 'base64') {
      const compiled = compileMihomoConfig({
        mixedPort: this.mixedPort,
        nodes,
        routing: this.store.getRoutingConfig(),
        dedicatedPorts: { mappings: {} }
      }, { includeController: false });
      return {
        ok: true,
        format: 'mihomo',
        contentType: 'text/yaml; charset=utf-8',
        requestedNodeCount,
        nodeCount: compiled.exportedNodeCount,
        exportedNodeCount: compiled.exportedNodeCount,
        skippedNodes: compiled.skippedNodes,
        warnings: compiled.warnings,
        content: compiled.content
      };
    }

    const uris = [];
    const skippedNodes = [];
    for (const node of nodes) {
      const compiled = compileMihomoConfig({ nodes: [node], routing: { mode: 'direct' } }, { includeController: false });
      if (compiled.exportedNodeCount === 0) {
        skippedNodes.push(...compiled.skippedNodes);
        continue;
      }
      const uri = encodeProxyNode(node);
      if (!uri) {
        skippedNodes.push({ nodeId: node.id || null, name: node.name || null, reason: 'unsupported_proxy_uri_export' });
        continue;
      }
      uris.push(uri);
    }
    const content = Buffer.from(uris.join('\n'), 'utf8').toString('base64');
    return {
      ok: true,
      format: 'base64',
      contentType: 'text/plain; charset=utf-8',
      requestedNodeCount,
      nodeCount: uris.length,
      exportedNodeCount: uris.length,
      skippedNodes,
      warnings: skippedNodes.length ? ['some_proxy_nodes_were_skipped'] : [],
      content
    };
  }

  listSubscriptions() {
    const subscriptions = this.store.listSubscriptions().map((subscription) => ({
      ...subscription,
      autoUpdate: false,
      manualSyncOnly: true
    }));
    return { ok: true, manualSyncOnly: true, subscriptions };
  }

  upsertSubscription(subInput) {
    return this._enqueueMutation(() => this._upsertSubscription(subInput));
  }

  _upsertSubscription(subInput) {
    const subscription = this.store.upsertSubscription(subInput);
    return { ok: true, manualSyncOnly: true, subscription };
  }

  _captureSubscriptionSnapshot(subscription) {
    const nodes = this.store.listNodes()
      .filter((node) => node.subscriptionId === subscription.id)
      .map((node) => {
        const { dedicatedPort: _dedicatedPort, ...persistedNode } = node;
        return persistedNode;
      });
    const mappings = this.store.getDedicatedPortsConfig().mappings || {};
    return {
      subscription,
      nodes,
      dedicatedPorts: Object.fromEntries(
        nodes
          .filter((node) => mappings[node.id])
          .map((node) => [node.id, mappings[node.id]])
      )
    };
  }

  _restoreSubscriptionSnapshot(snapshot) {
    if (typeof this.store.restoreSubscriptionSnapshot === 'function') {
      this.store.restoreSubscriptionSnapshot(snapshot);
      return;
    }
    this.store.bulkUpsertNodes(snapshot.nodes, snapshot.subscription.id);
    this.store.upsertSubscription(snapshot.subscription);
    for (const [nodeId, port] of Object.entries(snapshot.dedicatedPorts)) {
      this.store.assignDedicatedPort(nodeId, port);
    }
  }

  deleteSubscription(subId) {
    return this._enqueueMutation(() => this._deleteSubscription(subId));
  }

  async _deleteSubscription(subId) {
    let snapshot;
    if (typeof this.store.deleteSubscriptionWithSnapshot === 'function') {
      snapshot = this.store.deleteSubscriptionWithSnapshot(subId);
    } else {
      const subscription = this.store.listSubscriptions().find((candidate) => candidate.id === subId);
      if (!subscription) return { ok: false, applied: false, error: 'subscription_not_found' };
      snapshot = this._captureSubscriptionSnapshot(subscription);
      this.store.deleteSubscription(subId);
    }
    if (!snapshot) return { ok: false, applied: false, error: 'subscription_not_found' };

    return this._finishMutation({
      rollbackErrorCode: 'subscription_rollback_failed',
      restore: () => this._restoreSubscriptionSnapshot(snapshot),
      success: { ok: true, removedNodeCount: snapshot.nodes.length }
    });
  }

  async syncSubscription(subId) {
    const subscription = this.store.listSubscriptions().find((candidate) => candidate.id === subId);
    if (!subscription) return { ok: false, applied: false, error: 'subscription_not_found' };
    let fetched;
    let parsed;
    try {
      fetched = await this.subscriptionFetcher.fetch(subscription.url);
      parsed = this._parseImportContent(fetched.content, subscription.id);
    } catch (error) {
      return {
        ok: false,
        applied: false,
        error: error.code || 'subscription_fetch_failed',
        message: error.message
      };
    }
    if (!parsed.nodes.length) {
      return {
        ok: false,
        applied: false,
        error: 'no_valid_proxy_nodes_found',
        count: 0,
        skippedNodes: parsed.skippedNodes,
        warnings: parsed.warnings
      };
    }
    return this._enqueueMutation(() => this._applySubscriptionSync(subscription, fetched, parsed));
  }

  async _applySubscriptionSync(expectedSubscription, fetched, parsed) {
    const subscription = this.store.listSubscriptions()
      .find((candidate) => candidate.id === expectedSubscription.id);
    if (!subscription) return { ok: false, applied: false, error: 'subscription_not_found' };
    if (
      subscription.url !== expectedSubscription.url ||
      subscription.updatedAt !== expectedSubscription.updatedAt
    ) {
      return { ok: false, applied: false, error: 'subscription_changed_during_sync' };
    }

    let inserted;
    let snapshot;
    if (typeof this.store.replaceSubscriptionNodesWithSnapshot === 'function') {
      const replacement = this.store.replaceSubscriptionNodesWithSnapshot(
        subscription.id,
        parsed.nodes,
        { sourceUrl: fetched.url }
      );
      inserted = replacement.nodes;
      snapshot = replacement.snapshot;
    } else {
      snapshot = this._captureSubscriptionSnapshot(subscription);
      if (typeof this.store.replaceSubscriptionNodes === 'function') {
        inserted = this.store.replaceSubscriptionNodes(subscription.id, parsed.nodes, { sourceUrl: fetched.url });
      } else {
        inserted = this.store.bulkUpsertNodes(parsed.nodes, subscription.id);
        this.store.upsertSubscription({
          ...subscription,
          nodeCount: inserted.length,
          lastSyncedAt: Date.now()
        });
      }
    }

    return this._finishMutation({
      rollbackErrorCode: 'subscription_rollback_failed',
      restore: () => this._restoreSubscriptionSnapshot(snapshot),
      success: {
        ok: true,
        count: inserted.length,
        nodes: inserted,
        skippedNodes: parsed.skippedNodes,
        manualSyncOnly: true
      },
      warnings: parsed.warnings
    });
  }

  async pingNode(nodeId) {
    const node = this.store.getNode(nodeId);
    if (!node) return { ok: false, error: 'node_not_found' };
    if (!this.getCoreStatus().dataPlaneReady) return { ok: false, error: 'proxy_core_unavailable' };
    const result = await this.coreRuntime.pingNode(node);
    this.store.updateNodeLatency(nodeId, result.ok ? result.latencyMs : -1);
    return {
      ok: true,
      nodeId,
      reachable: result.ok,
      latencyMs: result.ok ? result.latencyMs : null,
      error: result.ok ? null : result.error
    };
  }

  async pingAllNodes(filter = {}) {
    if (!this.getCoreStatus().dataPlaneReady) return { ok: false, error: 'proxy_core_unavailable' };
    const results = {};
    for (const node of this.store.listNodes(filter)) {
      const result = await this.coreRuntime.pingNode(node);
      results[node.id] = result;
      this.store.updateNodeLatency(node.id, result.ok ? result.latencyMs : -1);
    }
    return { ok: true, testedCount: Object.keys(results).length, results };
  }

  getDedicatedPorts() {
    return {
      ok: true,
      config: this.store.getDedicatedPortsConfig(),
      active: this.portManager.getActiveServers(),
      core: this.getCoreStatus()
    };
  }

  toggleDedicatedPort(nodeId, enabled, requestedPort = null) {
    return this._enqueueMutation(() => this._toggleDedicatedPort(nodeId, enabled, requestedPort));
  }

  async _toggleDedicatedPort(nodeId, enabled, requestedPort = null) {
    if (!nodeId) return { ok: false, error: 'node_id_required' };
    return enabled
      ? this.portManager.startDedicatedPortForNode(nodeId, requestedPort)
      : this.portManager.stopDedicatedPortForNode(nodeId);
  }

  updateDedicatedPortsConfig(config) {
    return this._enqueueMutation(() => this._updateDedicatedPortsConfig(config));
  }

  _updateDedicatedPortsConfig(config) {
    const updated = this.store.setDedicatedPortsConfig(config);
    return { ok: true, config: updated, applied: false, warnings: ['proxy_core_reload_required'] };
  }

  getRouting() {
    const routing = this.routingManager.getRoutingState();
    const core = this.getCoreStatus();
    return {
      ok: true,
      routing,
      desired: routing,
      applied: Boolean(core.dataPlaneReady && this.appliedRoutingSignature === routingSignature(routing)),
      core
    };
  }

  async _applyDesiredRouting(routing) {
    const coreBefore = this.getCoreStatus();
    if (!coreBefore.dataPlaneReady) {
      return {
        ok: true,
        routing,
        desired: routing,
        applied: false,
        error: coreBefore.installed ? 'proxy_core_not_running' : 'proxy_core_unavailable',
        core: coreBefore
      };
    }
    const reload = await this.coreRuntime.reload(this._coreState());
    const fullyApplied = isCoreResultFullyApplied(reload);
    this.appliedRoutingSignature = fullyApplied ? routingSignature(routing) : null;
    return {
      ok: true,
      routing,
      desired: routing,
      applied: fullyApplied,
      error: fullyApplied ? undefined : (reload.error || 'routing_not_fully_applied'),
      message: reload.message,
      core: reload.core || this.getCoreStatus(),
      warnings: reload.warnings || []
    };
  }

  setRoutingMode(mode, activeOutboundNodeId = null) {
    return this._enqueueMutation(() => this._setRoutingMode(mode, activeOutboundNodeId));
  }

  async _setRoutingMode(mode, activeOutboundNodeId = null) {
    if (activeOutboundNodeId && !this.store.getNode(activeOutboundNodeId)) throw serviceError('node_not_found');
    const routing = this.routingManager.setRoutingMode(mode, activeOutboundNodeId);
    return this._applyDesiredRouting(routing);
  }

  updateRoutingRules(rules) {
    return this._enqueueMutation(() => this._updateRoutingRules(rules));
  }

  async _updateRoutingRules(rules) {
    const routing = this.routingManager.updateRules(validateRoutingRules(rules));
    return this._applyDesiredRouting(routing);
  }

  updateRouting(config = {}) {
    return this._enqueueMutation(() => this._updateRouting(config));
  }

  async _updateRouting(config = {}) {
    const update = {};
    if (config.mode !== undefined) {
      if (!['global', 'rule', 'direct'].includes(config.mode)) throw serviceError('invalid_routing_mode');
      update.mode = config.mode;
    }
    if (config.activeOutboundNodeId !== undefined) {
      if (config.activeOutboundNodeId && !this.store.getNode(config.activeOutboundNodeId)) {
        throw serviceError('node_not_found');
      }
      update.activeOutboundNodeId = config.activeOutboundNodeId || null;
    }
    if (config.rules !== undefined) update.rules = validateRoutingRules(config.rules);
    if (Object.keys(update).length === 0) throw serviceError('invalid_routing_config');
    const routing = this.store.setRoutingConfig(update);
    return this._applyDesiredRouting(routing);
  }

  getCoreStatus() {
    const network = this.store.getNetworkConfig?.() || { tun: { enabled: false } };
    return {
      engine: 'mihomo',
      installed: false,
      running: false,
      dataPlaneReady: false,
      binaryName: null,
      version: null,
      mixedProxyUrl: null,
      activeListeners: [],
      lastError: null,
      tun: network.tun || { enabled: false },
      ...(this.coreRuntime?.getStatus?.() || {})
    };
  }

  getNetworkStatus(options = {}) {
    const ownedPid = options.ownedPid || this.coreRuntime?.getOwnedProcessId?.();
    return {
      ok: true,
      ...detectNetworkLayer({ ...options, ownedPid })
    };
  }

  planNetworkIntegration(input = {}, options = {}) {
    const action = String(input.action || '').toLowerCase();
    const network = input.network || this.getNetworkStatus(options);
    if (!['enable', 'disable', 'restore'].includes(action)) {
      return { ok: false, error: 'unsupported_system_proxy_action' };
    }
    if (action === 'enable') {
      const core = this.getCoreStatus();
      if (!core.dataPlaneReady || !core.mixedProxyUrl) {
        return { ok: false, error: core.installed ? 'proxy_core_not_running' : 'proxy_core_unavailable', core };
      }
    }
    const service = String(input.service || '').trim();
    let current = input.current;
    const platform = String(options.platform || process.platform).toLowerCase();
    if (!current && ((platform === 'darwin' && service) || platform === 'linux' || platform === 'win32')) {
      const snapshot = platform === 'darwin'
        ? readMacProxySnapshot(service, options)
        : platform === 'linux'
          ? readLinuxProxySnapshot(options)
          : readWindowsProxySnapshot(options);
      if (!snapshot.ok) return snapshot;
      if (platform === 'darwin') {
        current = {
          web: snapshot.web,
          secureWeb: snapshot.secureWeb,
          socks: snapshot.socks,
          pac: snapshot.pac
        };
      } else {
        const { ok: _ok, ...withoutStatus } = snapshot;
        current = withoutStatus;
      }
    }
    const result = planSystemProxy({
      ...input,
      action,
      service,
      current,
      proxyUrl: input.proxyUrl || this.getCoreStatus().mixedProxyUrl,
      network
    });
    if (!result.ok) return result;
    return {
      ok: true,
      plan: {
        ...result.plan,
        planId: hashSnapshot({ action, service, snapshotHash: result.plan.snapshotHash })
      },
      network,
      core: this.getCoreStatus()
    };
  }

  applyNetworkIntegration(plan, options = {}) {
    return this._enqueueMutation(() => executeSystemProxyPlan(plan, options));
  }

  planTunIntegration(input = {}, options = {}) {
    const action = String(input.action || '').toLowerCase();
    if (!['enable', 'disable'].includes(action)) return { ok: false, error: 'unsupported_tun_action' };
    const network = input.network || this.getNetworkStatus(options);
    if (network.tun?.state === 'active' && network.tun.owner !== 'aih') {
      return { ok: false, error: 'external_tun_active', network };
    }
    const current = this.store.getNetworkConfig?.() || { tun: { enabled: false } };
    const tun = {
      ...current.tun,
      ...(input.tun || {}),
      enabled: action === 'enable'
    };
    return {
      ok: true,
      plan: {
        action,
        tun,
        previousTun: current.tun,
        snapshotHash: hashSnapshot({ tun: current.tun, network: network.tun })
      },
      network,
      core: this.getCoreStatus()
    };
  }

  applyTunIntegration(plan, options = {}) {
    return this._enqueueMutation(() => this._applyTunIntegration(plan, options));
  }

  async _applyTunIntegration(plan, options = {}) {
    if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
    if (!plan?.snapshotHash || options.expectedSnapshotHash !== plan.snapshotHash) {
      return { ok: false, error: 'tun_snapshot_changed' };
    }
    const network = options.network || this.getNetworkStatus(options);
    if (network.tun?.state === 'active' && network.tun.owner !== 'aih') {
      return { ok: false, error: 'external_tun_active', network };
    }
    const currentConfig = this.store.getNetworkConfig?.() || { tun: { enabled: false } };
    if (hashSnapshot({ tun: currentConfig.tun, network: network.tun }) !== plan.snapshotHash) {
      return { ok: false, error: 'tun_snapshot_changed', network };
    }
    const previousTun = plan.previousTun || { enabled: false };
    try {
      const config = this.store.setNetworkConfig({ tun: plan.tun });
      const core = this.getCoreStatus();
      if (core.running) {
        const result = await this._safeReload();
        if (!isCoreResultFullyApplied(result)) {
          this.store.setNetworkConfig({ tun: previousTun });
          return {
            ok: false,
            applied: false,
            error: result.error || 'proxy_core_reload_failed',
            message: result.message,
            core: result.core || this.getCoreStatus(),
            warnings: result.warnings || []
          };
        }
        return { ok: true, applied: true, config, core: result.core || this.getCoreStatus(), warnings: result.warnings || [] };
      }
      return { ok: true, applied: true, config, core: this.getCoreStatus(), warnings: ['proxy_core_reload_required'] };
    } catch (error) {
      try { this.store.setNetworkConfig({ tun: previousTun }); } catch (_rollbackError) { /* report original failure */ }
      return { ok: false, applied: false, error: error.code || 'tun_config_failed', message: error.message };
    }
  }

  startCore() {
    return this._enqueueMutation(() => this._startCore());
  }

  async _startCore() {
    const state = this._coreState();
    const tunGuard = this._guardTunOwnership('start', state);
    if (tunGuard) return tunGuard;
    const result = normalizeCoreApplyResult(await this.coreRuntime.start(state));
    this.appliedRoutingSignature = isCoreResultFullyApplied(result) ? routingSignature(state.routing) : null;
    return result;
  }

  stopCore() {
    return this._enqueueMutation(() => this._stopCore());
  }

  async _stopCore() {
    const result = await this.coreRuntime.stop();
    if (result.ok && result.applied === true) this.appliedRoutingSignature = null;
    return result;
  }

  close() {
    return this._enqueueMutation(() => this._close());
  }

  async _close() {
    const current = this.getCoreStatus();
    if (!current.running) {
      this.appliedRoutingSignature = null;
      return {
        ok: true,
        action: 'stop',
        applied: true,
        core: current,
        warnings: []
      };
    }
    if (typeof this.coreRuntime.stop !== 'function') {
      return {
        ok: false,
        action: 'stop',
        applied: false,
        error: 'proxy_core_stop_unavailable',
        core: current,
        warnings: []
      };
    }
    const result = normalizeCoreApplyResult(await this.coreRuntime.stop());
    if (isCoreResultFullyApplied(result)) this.appliedRoutingSignature = null;
    return { ...result, action: 'stop' };
  }

  reloadCore() {
    return this._enqueueMutation(() => this._reloadCore());
  }

  async _reloadCore() {
    const state = this._coreState();
    const tunGuard = this._guardTunOwnership('reload', state);
    if (tunGuard) return tunGuard;
    const result = normalizeCoreApplyResult(await this.coreRuntime.reload(state));
    this.appliedRoutingSignature = isCoreResultFullyApplied(result) ? routingSignature(state.routing) : null;
    return result;
  }

  _guardTunOwnership(action, state) {
    if (state.tun?.enabled !== true) return null;
    const network = this.getNetworkStatus();
    if (network.tun?.state !== 'active' || network.tun.owner === 'aih') return null;
    return {
      ok: false,
      action,
      applied: false,
      error: 'external_tun_active',
      message: `外部 TUN（${network.tun.owner || 'unknown'}）正在运行，AIH 不会接管`,
      core: this.getCoreStatus(),
      warnings: network.conflicts || []
    };
  }
}

let defaultService = null;
function getProxyPoolService(options) {
  if (options) return new ProxyPoolService(options);
  if (!defaultService) defaultService = new ProxyPoolService();
  return defaultService;
}

async function closeDefaultProxyPoolService() {
  if (!defaultService) return { ok: true, applied: true, action: 'stop', skipped: true };
  const service = defaultService;
  defaultService = null;
  return service.close();
}

module.exports = {
  ProxyPoolService,
  getProxyPoolService,
  closeDefaultProxyPoolService,
  isSingleHttpUrl,
  unsupportedSchemes,
  validateRoutingRules,
  routingSignature
};
