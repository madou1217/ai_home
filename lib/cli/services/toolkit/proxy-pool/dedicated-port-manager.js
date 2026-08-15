'use strict';

const {
  hasRoutingWarnings,
  isCoreResultFullyApplied,
  mergeWarnings
} = require('./core-apply-result');
const { chooseLoopbackPort } = require('./mihomo-core-manager');
const { DEFAULT_CONTROLLER_PORT } = require('./mihomo-config-compiler');

/**
 * Coordinates persisted dedicated-listener intent with the Mihomo data plane.
 * It never opens sockets itself; Mihomo is the only protocol implementation.
 */
class DedicatedPortManager {
  constructor(nodeStore, options = {}) {
    this.nodeStore = nodeStore;
    this.coreRuntime = options.coreRuntime;
    this.choosePort = options.choosePort || chooseLoopbackPort;
    this.isPortAvailable = options.isPortAvailable;
    this.stateProvider = options.stateProvider || (() => ({
      nodes: this.nodeStore.listNodes(),
      routing: this.nodeStore.getRoutingConfig(),
      dedicatedPorts: this.nodeStore.getDedicatedPortsConfig()
    }));
  }

  getActiveServers() {
    const status = this.coreRuntime?.getStatus?.();
    if (!status?.dataPlaneReady) return [];
    return Array.isArray(status.activeListeners)
      ? status.activeListeners.filter((listener) => listener.listening)
      : [];
  }

  _unavailableError() {
    const status = this.coreRuntime?.getStatus?.();
    return {
      ok: false,
      applied: false,
      error: status?.installed ? 'proxy_core_not_running' : 'proxy_core_unavailable',
      core: status || null
    };
  }

  async _reloadCore() {
    try {
      return await this.coreRuntime.reload(this.stateProvider());
    } catch (error) {
      return { ok: false, applied: false, error: 'proxy_core_reload_failed', message: error.message };
    }
  }

  async _rollbackDesiredMutation(restore, rejection) {
    try {
      restore();
    } catch (error) {
      return {
        ok: false,
        applied: false,
        error: 'dedicated_port_rollback_failed',
        message: error.message,
        core: rejection.core || this.coreRuntime?.getStatus?.() || null,
        warnings: mergeWarnings([rejection.error], rejection.warnings)
      };
    }

    const compensation = await this._reloadCore();
    if (!isCoreResultFullyApplied(compensation)) {
      return {
        ok: false,
        applied: false,
        error: 'dedicated_port_rollback_failed',
        message: compensation.message || 'proxy_core_rollback_not_applied',
        core: compensation.core || this.coreRuntime?.getStatus?.() || null,
        warnings: mergeWarnings(
          [rejection.error, compensation.error],
          rejection.warnings,
          compensation.warnings
        )
      };
    }
    return {
      ok: false,
      applied: false,
      error: rejection.error || (hasRoutingWarnings(rejection)
        ? 'routing_not_fully_applied'
        : 'proxy_core_reload_failed'),
      message: rejection.message,
      core: compensation.core || this.coreRuntime?.getStatus?.() || null,
      warnings: mergeWarnings(rejection.warnings)
    };
  }

  async startDedicatedPortForNode(nodeId, requestedPort = null) {
    const node = this.nodeStore.getNode(nodeId);
    if (!node) return { ok: false, applied: false, error: 'node_not_found' };
    const status = this.coreRuntime?.getStatus?.();
    if (!status?.dataPlaneReady) return this._unavailableError();

    let selectedPort = requestedPort;
    const existingPort = this.nodeStore.getDedicatedPortsConfig().mappings?.[nodeId] || null;
    if (existingPort && !selectedPort) selectedPort = existingPort;
    if (selectedPort === null || selectedPort === undefined) {
      const config = this.nodeStore.getDedicatedPortsConfig();
      const state = this.stateProvider() || {};
      const reservedPorts = [
        DEFAULT_CONTROLLER_PORT,
        state.mixedPort,
        ...Object.values(config.mappings || {}).map(Number)
      ].filter((port) => Number.isInteger(Number(port)));
      const selection = await this.choosePort(Number(config.basePort || 10801), {
        reservedPorts,
        minPort: Math.max(1024, Number(config.basePort || 10801)),
        maxPort: Math.min(65535, Number(config.basePort || 10801) + Math.max(Number(config.maxPorts || 32), 32) + 32),
        ...(this.isPortAvailable ? { isPortAvailable: this.isPortAvailable } : {})
      });
      if (!selection.ok) return { ok: false, applied: false, error: 'no_dedicated_port_available', range: selection.range };
      selectedPort = selection.port;
    }
    const assignment = this.nodeStore.assignDedicatedPort(nodeId, selectedPort);
    if (!assignment.ok) return { ...assignment, applied: false };
    if (assignment.alreadyAssigned) {
      const listener = this.getActiveServers().find((candidate) => candidate.nodeId === nodeId);
      if (listener) return { ok: true, applied: true, port: assignment.port, running: true, core: status };
    }

    const restoreAssignment = () => {
      if (!assignment.alreadyAssigned) this.nodeStore.releaseDedicatedPort(nodeId);
    };
    const reload = await this._reloadCore();
    if (!isCoreResultFullyApplied(reload)) {
      return this._rollbackDesiredMutation(restoreAssignment, {
        ...reload,
        error: reload.error || (hasRoutingWarnings(reload)
          ? 'routing_not_fully_applied'
          : 'proxy_core_reload_failed')
      });
    }
    const listener = this.getActiveServers().find((candidate) => candidate.nodeId === nodeId);
    if (!listener?.listening) {
      return this._rollbackDesiredMutation(restoreAssignment, {
        ok: false,
        applied: false,
        error: 'proxy_core_readiness_failed',
        message: `Mihomo did not open dedicated listener 127.0.0.1:${assignment.port}`,
        core: this.coreRuntime.getStatus(),
        warnings: reload.warnings || []
      });
    }
    return {
      ok: true,
      applied: true,
      port: assignment.port,
      running: true,
      core: reload.core
    };
  }

  async stopDedicatedPortForNode(nodeId) {
    const config = this.nodeStore.getDedicatedPortsConfig();
    const previousPort = config.mappings?.[nodeId] || null;
    this.nodeStore.releaseDedicatedPort(nodeId);
    const status = this.coreRuntime?.getStatus?.();
    if (!previousPort) {
      return { ok: true, applied: true, running: false, releasedPort: null, core: status || null };
    }
    if (!status?.running) {
      return { ok: true, applied: true, running: false, releasedPort: previousPort, core: status || null };
    }
    if (!status.dataPlaneReady) {
      this.nodeStore.assignDedicatedPort(nodeId, previousPort);
      return this._unavailableError();
    }
    const reload = await this._reloadCore();
    if (!isCoreResultFullyApplied(reload)) {
      return this._rollbackDesiredMutation(
        () => this.nodeStore.assignDedicatedPort(nodeId, previousPort),
        {
          ...reload,
          error: reload.error || (hasRoutingWarnings(reload)
            ? 'routing_not_fully_applied'
            : 'proxy_core_reload_failed')
        }
      );
    }
    return { ok: true, applied: true, running: false, releasedPort: previousPort, core: reload.core };
  }

  async stopAll() {
    const mappings = { ...(this.nodeStore.getDedicatedPortsConfig().mappings || {}) };
    for (const nodeId of Object.keys(mappings)) this.nodeStore.releaseDedicatedPort(nodeId);
    const status = this.coreRuntime?.getStatus?.();
    if (Object.keys(mappings).length === 0 || !status?.running) {
      return { ok: true, applied: true, core: status || null };
    }
    if (!status.dataPlaneReady) {
      for (const [nodeId, port] of Object.entries(mappings)) this.nodeStore.assignDedicatedPort(nodeId, port);
      return this._unavailableError();
    }
    const reload = await this._reloadCore();
    if (isCoreResultFullyApplied(reload)) return reload;
    return this._rollbackDesiredMutation(() => {
      for (const [nodeId, port] of Object.entries(mappings)) this.nodeStore.assignDedicatedPort(nodeId, port);
    }, {
      ...reload,
      error: reload.error || (hasRoutingWarnings(reload)
        ? 'routing_not_fully_applied'
        : 'proxy_core_reload_failed')
    });
  }
}

const defaultManagers = new WeakMap();
function getDedicatedPortManager(store, options = {}) {
  if (options.coreRuntime || options.stateProvider) return new DedicatedPortManager(store, options);
  if (!defaultManagers.has(store)) defaultManagers.set(store, new DedicatedPortManager(store, options));
  return defaultManagers.get(store);
}

module.exports = {
  DedicatedPortManager,
  getDedicatedPortManager
};
