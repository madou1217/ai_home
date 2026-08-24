'use strict';

const nativeFs = require('node:fs');
const nativeNet = require('node:net');
const nativeOs = require('node:os');
const nativePath = require('node:path');
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require('node:child_process');
const { request: undiciRequest } = require('undici');

const {
  atomicWritePrivateFile,
  ensurePrivateDirectory
} = require('../cli/services/toolkit/proxy-pool/secure-file-io');
const { normalizeClientPlatform } = require('../runtime/client-platform');
const {
  resolveZcodeNetworkUnderlay,
  targetNeedsZcodeNetworkDns,
  targetNeedsZcodeNetworkUnderlay
} = require('./zcode-network-underlay');
const { compileZcodeSingBoxConfig } = require('./zcode-sing-box-config');
const { probeSingBoxOutboundDelays } = require('./zcode-sing-box-delay-probe');
const { ZcodeSingBoxStateStore } = require('./zcode-sing-box-state-store');

const DEFAULT_BASE_PORT = 23100;
const DEFAULT_MAX_PORTS = 256;
const DEFAULT_CONTROLLER_PORT = 23990;
const DEFAULT_READINESS_TIMEOUT_MS = 5000;

function runtimeError(code, extra = {}) {
  return { ok: false, error: code, ...extra };
}

function isExecutableFile(filePath, fsImpl = nativeFs) {
  if (!filePath) return false;
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile()) return false;
    fsImpl.accessSync(filePath, fsImpl.constants?.X_OK || nativeFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCommandPath(command, options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const pathValue = String(env.PATH || '');
  for (const directory of pathValue.split(pathImpl.delimiter).filter(Boolean)) {
    const candidate = pathImpl.join(directory, command);
    if (isExecutableFile(candidate, fsImpl)) return candidate;
  }
  return '';
}

function discoverSingBoxBinary(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const explicit = String(env.AIH_SING_BOX_BIN || '').trim();
  if (explicit) {
    const candidate = pathImpl.resolve(explicit);
    return isExecutableFile(candidate, fsImpl) ? { path: candidate, source: 'env' } : null;
  }
  const aiHomeDir = String(
    options.aiHomeDir
    || env.AIH_HOME
    || pathImpl.join(nativeOs.homedir(), '.ai_home')
  ).trim();
  const managedCandidate = pathImpl.join(aiHomeDir, 'bin', 'sing-box');
  if (isExecutableFile(managedCandidate, fsImpl)) {
    return { path: managedCandidate, source: 'aih-home' };
  }
  const fromPath = resolveCommandPath('sing-box', { env, fs: fsImpl, path: pathImpl });
  if (fromPath) return { path: fromPath, source: 'path' };
  for (const candidate of ['/opt/homebrew/bin/sing-box', '/usr/local/bin/sing-box']) {
    if (isExecutableFile(candidate, fsImpl)) return { path: candidate, source: 'known-path' };
  }
  return null;
}

function defaultIsPortAvailable(port) {
  return new Promise((resolve) => {
    const server = nativeNet.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port: Number(port), exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

function defaultListenerProbe(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = nativeNet.createConnection({ host: '127.0.0.1', port: Number(port) });
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function defaultIsChildRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function waitForExit(child, timeoutMs) {
  if (!defaultIsChildRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.('exit', onExit);
      resolve(exited || !defaultIsChildRunning(child));
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once?.('exit', onExit);
  });
}

async function defaultStopSidecar(child) {
  if (!defaultIsChildRunning(child)) return true;
  try { child.kill('SIGTERM'); } catch {}
  if (await waitForExit(child, 2000)) return true;
  try { child.kill('SIGKILL'); } catch {}
  return waitForExit(child, 1000);
}

function responseBodyText(response) {
  if (!response?.body || typeof response.body.text !== 'function') return Promise.resolve('');
  return response.body.text().catch(() => '');
}

async function closeSingBoxInboundConnections(input = {}) {
  const controllerPort = Number(input.controllerPort);
  const controllerSecret = String(input.controllerSecret || '').trim();
  const inboundTag = String(input.inboundTag || '').trim();
  const requestImpl = input.requestImpl || undiciRequest;
  if (!Number.isInteger(controllerPort) || controllerPort < 1 || !controllerSecret || !inboundTag) {
    return runtimeError('sing_box_connections_close_invalid');
  }
  const headers = { authorization: `Bearer ${controllerSecret}` };
  let listResponse;
  try {
    listResponse = await requestImpl(
      `http://127.0.0.1:${controllerPort}/connections`,
      { method: 'GET', headers }
    );
  } catch (error) {
    return runtimeError('sing_box_connections_list_failed', {
      reason: String(error?.message || error || 'unknown')
    });
  }
  const listStatus = Number(listResponse?.statusCode || 0);
  const listBody = await responseBodyText(listResponse);
  if (listStatus < 200 || listStatus >= 300) {
    return runtimeError('sing_box_connections_list_failed', {
      reason: listBody.slice(0, 200) || `http_${listStatus || 'unknown'}`
    });
  }
  let snapshot;
  try {
    snapshot = listBody ? JSON.parse(listBody) : {};
  } catch (error) {
    return runtimeError('sing_box_connections_list_failed', {
      reason: String(error?.message || error || 'invalid_json')
    });
  }
  const expectedType = `mixed/${inboundTag}`;
  const connectionIds = (Array.isArray(snapshot?.connections) ? snapshot.connections : [])
    .filter((connection) => connection?.metadata?.type === expectedType)
    .map((connection) => String(connection?.id || '').trim())
    .filter(Boolean);
  let closedConnections = 0;
  for (const connectionId of connectionIds) {
    let closeResponse;
    try {
      closeResponse = await requestImpl(
        `http://127.0.0.1:${controllerPort}/connections/${encodeURIComponent(connectionId)}`,
        { method: 'DELETE', headers }
      );
    } catch (error) {
      return runtimeError('sing_box_connection_close_failed', {
        reason: String(error?.message || error || 'unknown'),
        closedConnections
      });
    }
    const closeStatus = Number(closeResponse?.statusCode || 0);
    if (closeStatus < 200 || closeStatus >= 300) {
      const closeBody = await responseBodyText(closeResponse);
      return runtimeError('sing_box_connection_close_failed', {
        reason: closeBody.slice(0, 200) || `http_${closeStatus || 'unknown'}`,
        closedConnections
      });
    }
    closedConnections += 1;
  }
  return { ok: true, closedConnections };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function normalizeResolvedTarget(resolvedTarget) {
  if (!resolvedTarget?.ok || !resolvedTarget.target) throw new Error('invalid_zcode_resolved_target');
  const selectedTarget = cloneState(resolvedTarget.target);
  const candidateTargets = Array.isArray(resolvedTarget.candidateNodes)
    ? resolvedTarget.candidateNodes.map((node) => ({ kind: 'node', node: cloneState(node) }))
    : [selectedTarget];
  return {
    source: String(resolvedTarget.source || '').trim(),
    selectedTarget,
    candidateTargets,
    selectedNodeId: String(resolvedTarget.selectedNodeId || '').trim(),
    groupId: String(resolvedTarget.groupId || '').trim(),
    updatedAt: Date.now()
  };
}

class ZcodeSingBoxRuntime {
  constructor(options = {}) {
    this.fs = options.fs || nativeFs;
    this.path = options.path || nativePath;
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.platformKey = normalizeClientPlatform(this.platform);
    this.aiHomeDir = options.aiHomeDir || this.env.AIH_HOME || this.path.join(nativeOs.homedir(), '.ai_home');
    this.runtimeDir = options.runtimeDir || this.path.join(this.aiHomeDir, 'run', 'zcode-egress', 'sing-box');
    this.configPath = options.configPath || this.path.join(this.runtimeDir, 'config.json');
    this.logPath = options.logPath || this.path.join(this.runtimeDir, 'runtime.log');
    this.statusPath = options.statusPath || this.path.join(this.runtimeDir, 'status.json');
    this.basePort = Math.max(1024, Number(options.basePort || DEFAULT_BASE_PORT));
    this.maxPorts = Math.max(1, Number(options.maxPorts || DEFAULT_MAX_PORTS));
    this.requestedControllerPort = Math.max(1024, Number(
      options.requestedControllerPort || DEFAULT_CONTROLLER_PORT
    ));
    this.readinessTimeoutMs = Math.max(250, Number(
      options.readinessTimeoutMs || DEFAULT_READINESS_TIMEOUT_MS
    ));
    this.store = options.stateStore || new ZcodeSingBoxStateStore({
      fs: this.fs,
      path: this.path,
      aiHomeDir: this.aiHomeDir,
      runtimeDir: this.runtimeDir
    });
    this.discoverBinary = options.discoverBinary || (() => discoverSingBoxBinary({
      env: this.env,
      fs: this.fs,
      path: this.path,
      aiHomeDir: this.aiHomeDir
    }));
    this.isPortAvailable = options.isPortAvailable || defaultIsPortAvailable;
    this.validateConfig = options.validateConfig || ((input) => this._defaultValidateConfig(input));
    this.spawnSidecar = options.spawnSidecar || ((input) => this._defaultSpawnSidecar(input));
    this.stopSidecar = options.stopSidecar || defaultStopSidecar;
    this.isChildRunning = options.isChildRunning || defaultIsChildRunning;
    this.readinessProbe = options.readinessProbe || ((input) => this._defaultReadinessProbe(input));
    this.selectOutbound = options.selectOutbound || ((input) => this._defaultSelectOutbound(input));
    this.closeAccountConnections = options.closeAccountConnections
      || ((input) => closeSingBoxInboundConnections({ ...input, requestImpl: this.requestImpl }));
    this.probeOutboundDelays = options.probeOutboundDelays
      || ((input) => probeSingBoxOutboundDelays({ ...input, requestImpl: this.requestImpl }));
    this.spawnSync = options.spawnSync || nodeSpawnSync;
    this.spawn = options.spawn || nodeSpawn;
    this.resolveUnderlay = options.resolveUnderlay || resolveZcodeNetworkUnderlay;
    this.requestImpl = options.requestImpl || undiciRequest;
    this.child = null;
    this.binary = null;
    this.currentCompiled = null;
    this.lastError = null;
    this.operationQueue = Promise.resolve();
  }

  _enqueue(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  getPaths() {
    return {
      runtimeDir: this.runtimeDir,
      configPath: this.configPath,
      logPath: this.logPath,
      statusPath: this.statusPath,
      statePath: this.store.filePath
    };
  }

  readState() {
    return this.store.read();
  }

  _isRunning() {
    return this.isChildRunning(this.child);
  }

  _ensurePrivateFiles() {
    ensurePrivateDirectory(this.fs, this.runtimeDir);
    if (!this.fs.existsSync(this.logPath)) {
      this.fs.writeFileSync(this.logPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    if (typeof this.fs.chmodSync === 'function') this.fs.chmodSync(this.logPath, 0o600);
  }

  _writeStatus() {
    const state = this.store.read();
    const status = {
      engine: 'sing-box',
      installed: Boolean(this.binary),
      running: this._isRunning(),
      dataPlaneReady: Boolean(this._isRunning() && this.currentCompiled),
      pid: this._isRunning() ? Number(this.child?.pid) || null : null,
      configHash: this.currentCompiled?.configHash || null,
      accounts: Object.entries(state.accounts).map(([accountRef, account]) => ({
        accountRef,
        port: state.portAssignments[accountRef] || null,
        source: String(account.source || ''),
        selectedNodeId: String(account.selectedNodeId || '') || null,
        selectedOutboundTag: this.currentCompiled?.accounts?.[accountRef]?.selectedOutboundTag || null
      })),
      lastError: this.lastError
    };
    atomicWritePrivateFile(
      this.fs,
      this.path,
      this.statusPath,
      `${JSON.stringify(status, null, 2)}\n`
    );
    return status;
  }

  getStatus() {
    const state = this.store.read();
    return {
      engine: 'sing-box',
      installed: Boolean(this.binary),
      running: this._isRunning(),
      dataPlaneReady: Boolean(this._isRunning() && this.currentCompiled),
      pid: this._isRunning() ? Number(this.child?.pid) || null : null,
      controllerPort: state.controllerPort,
      accounts: Object.entries(state.accounts).map(([accountRef, account]) => ({
        accountRef,
        port: state.portAssignments[accountRef] || null,
        source: String(account.source || ''),
        selectedNodeId: String(account.selectedNodeId || '') || null
      })),
      lastError: this.lastError
    };
  }

  getAccountState(accountRef) {
    const normalizedRef = String(accountRef || '').trim();
    if (!normalizedRef) return null;
    const state = this.store.read();
    const account = state.accounts?.[normalizedRef];
    if (!account) return null;
    return {
      accountRef: normalizedRef,
      port: Number(state.portAssignments?.[normalizedRef]) || null,
      ...cloneState(account)
    };
  }

  async measureAccountCandidateLatencies(input = {}) {
    const accountRef = String(input.accountRef || '').trim();
    if (!accountRef) return runtimeError('invalid_zcode_sidecar_account');
    if (this.platformKey !== 'macos') {
      return runtimeError('not_supported', { platform: this.platformKey });
    }
    if (!this._isRunning() || !this.currentCompiled) {
      return runtimeError('zcode_egress_not_running');
    }

    const account = this.currentCompiled.accounts?.[accountRef];
    if (!account) return runtimeError('zcode_sidecar_account_not_found');
    const requestedNodeIds = new Set(
      (Array.isArray(input.nodeIds) ? input.nodeIds : [])
        .map((nodeId) => String(nodeId || '').trim())
        .filter(Boolean)
    );
    const candidates = (Array.isArray(account.candidateOutbounds)
      ? account.candidateOutbounds
      : [])
      .filter((candidate) => (
        requestedNodeIds.size === 0 || requestedNodeIds.has(candidate.nodeId)
      ));
    if (!candidates.length) {
      return {
        ok: true,
        results: [],
        measuredCount: 0,
        healthyCount: 0,
        failedCount: 0
      };
    }

    const state = this.store.read();
    try {
      return await this.probeOutboundDelays({
        controllerPort: state.controllerPort,
        controllerSecret: state.controllerSecret,
        candidates,
        concurrency: input.concurrency || this.env.AIH_ZCODE_EGRESS_DELAY_CONCURRENCY,
        timeoutMs: input.timeoutMs || this.env.AIH_ZCODE_EGRESS_DELAY_TIMEOUT_MS,
        targetUrl: input.targetUrl || this.env.AIH_ZCODE_EGRESS_DELAY_TARGET_URL
      });
    } catch (error) {
      return runtimeError('sing_box_delay_probe_failed', {
        reason: String(error?.message || error || 'unknown')
      });
    }
  }

  _refreshBinary() {
    try {
      this.binary = this.discoverBinary() || null;
    } catch {
      this.binary = null;
    }
    return this.binary;
  }

  async _ensureControllerPort(state) {
    if (state.controllerPort) {
      if (this._isRunning() && this.currentCompiled) return { ok: true, port: state.controllerPort };
      if (await this.isPortAvailable(state.controllerPort)) return { ok: true, port: state.controllerPort };
      return runtimeError('zcode_sidecar_controller_port_conflict', { port: state.controllerPort });
    }
    const assigned = new Set(Object.values(state.portAssignments).map(Number));
    for (let offset = 0; offset < this.maxPorts; offset += 1) {
      const port = this.requestedControllerPort + offset;
      if (port > 65535 || assigned.has(port)) continue;
      if (await this.isPortAvailable(port)) {
        state.controllerPort = port;
        return { ok: true, port };
      }
    }
    return runtimeError('zcode_sidecar_controller_port_unavailable');
  }

  async _ensureAccountPort(state, accountRef) {
    const existing = Number(state.portAssignments[accountRef]);
    if (Number.isInteger(existing) && existing >= 1024 && existing <= 65535) {
      const ownedByCurrent = this._isRunning()
        && this.currentCompiled?.accounts?.[accountRef]?.listenPort === existing;
      if (ownedByCurrent || await this.isPortAvailable(existing)) {
        return { ok: true, port: existing };
      }
      return runtimeError('zcode_sidecar_port_conflict', { port: existing });
    }
    const assigned = new Set([
      Number(state.controllerPort),
      ...Object.values(state.portAssignments).map(Number)
    ]);
    for (let offset = 0; offset < this.maxPorts; offset += 1) {
      const port = this.basePort + offset;
      if (port > 65535 || assigned.has(port)) continue;
      if (await this.isPortAvailable(port)) {
        state.portAssignments[accountRef] = port;
        return { ok: true, port };
      }
    }
    return runtimeError('zcode_sidecar_port_unavailable');
  }

  _compile(state) {
    const accounts = Object.entries(state.accounts).map(([accountRef, account]) => ({
      accountRef,
      listenPort: state.portAssignments[accountRef],
      selectedTarget: account.selectedTarget,
      candidateTargets: account.candidateTargets
    }));
    const targets = accounts.flatMap((account) => account.candidateTargets || []);
    let underlay = null;
    if (targets.some(targetNeedsZcodeNetworkUnderlay)) {
      let resolved;
      try {
        resolved = this.resolveUnderlay({
          platform: this.platform,
          spawnSync: this.spawnSync,
          requireDns: targets.some(targetNeedsZcodeNetworkDns)
        });
      } catch (error) {
        resolved = runtimeError('zcode_underlay_probe_failed', {
          reason: String(error?.message || error || 'unknown')
        });
      }
      if (!resolved?.ok) {
        const error = new Error(String(resolved?.error || 'zcode_underlay_unavailable'));
        error.code = String(resolved?.error || 'zcode_underlay_unavailable');
        throw error;
      }
      underlay = resolved;
    }
    return compileZcodeSingBoxConfig({
      controllerPort: state.controllerPort,
      controllerSecret: state.controllerSecret,
      logPath: this.logPath,
      underlay,
      accounts
    });
  }

  _writeConfig(compiled) {
    this._ensurePrivateFiles();
    atomicWritePrivateFile(this.fs, this.path, this.configPath, compiled.json);
  }

  async _defaultValidateConfig({ binary, configPath }) {
    const result = this.spawnSync(binary.path, ['check', '-c', configPath], {
      encoding: 'utf8',
      env: this.env,
      timeout: 5000,
      windowsHide: true
    });
    if (result?.status === 0) return { ok: true };
    return runtimeError('sing_box_config_invalid', {
      reason: String(result?.stderr || result?.stdout || 'sing-box check failed').slice(0, 300)
    });
  }

  async _defaultSpawnSidecar({ binary, configPath }) {
    const child = this.spawn(binary.path, ['run', '-c', configPath], {
      cwd: this.runtimeDir,
      env: this.env,
      stdio: 'ignore',
      windowsHide: true
    });
    child.once?.('exit', (code, signal) => {
      if (this.child !== child) return;
      this.lastError = `sing_box_exit_${code ?? signal ?? 'unknown'}`;
      this.currentCompiled = null;
      try { this._writeStatus(); } catch {}
    });
    return child;
  }

  async _defaultReadinessProbe({ controllerPort, accountPorts, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    const ports = [controllerPort, ...accountPorts];
    while (Date.now() < deadline) {
      const states = await Promise.all(ports.map((port) => defaultListenerProbe(port)));
      if (states.every(Boolean)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async _defaultSelectOutbound(input) {
    const response = await this.requestImpl(
      `http://127.0.0.1:${input.controllerPort}/proxies/${encodeURIComponent(input.selectorTag)}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${input.controllerSecret}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ name: input.outboundTag })
      }
    );
    const statusCode = Number(response?.statusCode || 0);
    const body = await responseBodyText(response);
    if (statusCode >= 200 && statusCode < 300) return { ok: true };
    return runtimeError('sing_box_selector_failed', {
      reason: body.slice(0, 200) || `http_${statusCode || 'unknown'}`
    });
  }

  async _startCompiled(compiled, state) {
    this._writeConfig(compiled);
    const validation = await this.validateConfig({
      binary: this.binary,
      configPath: this.configPath,
      runtimeDir: this.runtimeDir,
      compiled
    });
    if (!validation?.ok) return runtimeError(
      validation?.error || 'sing_box_config_invalid',
      validation?.reason ? { reason: String(validation.reason) } : {}
    );
    let child;
    try {
      child = await this.spawnSidecar({
        binary: this.binary,
        configPath: this.configPath,
        runtimeDir: this.runtimeDir,
        compiled
      });
    } catch (error) {
      return runtimeError('sing_box_start_failed', { reason: String(error?.message || error || 'unknown') });
    }
    if (!child) return runtimeError('sing_box_start_failed');
    this.child = child;
    let ready = false;
    let readinessReason = '';
    try {
      ready = await this.readinessProbe({
        child,
        controllerPort: state.controllerPort,
        accountPorts: Object.keys(state.accounts).map((accountRef) => state.portAssignments[accountRef]),
        timeoutMs: this.readinessTimeoutMs,
        compiled
      });
    } catch (error) {
      readinessReason = String(error?.message || error || 'unknown');
    }
    if (!ready) {
      let stopped = false;
      try {
        stopped = await this.stopSidecar(child);
      } catch {}
      if (stopped && this.child === child) this.child = null;
      if (!stopped) {
        return runtimeError('sing_box_readiness_cleanup_failed', {
          ...(readinessReason ? { reason: readinessReason } : {})
        });
      }
      return runtimeError('sing_box_readiness_failed', {
        ...(readinessReason ? { reason: readinessReason } : {})
      });
    }
    this.currentCompiled = compiled;
    return { ok: true };
  }

  async _restartWithRollback(nextCompiled, nextState, previousState) {
    const previousCompiled = this.currentCompiled;
    const previousChild = this.child;
    if (this._isRunning()) {
      const stopped = await this.stopSidecar(previousChild);
      if (!stopped) return runtimeError('sing_box_stop_failed');
      if (this.child === previousChild) this.child = null;
    }
    let started;
    try {
      started = await this._startCompiled(nextCompiled, nextState);
    } catch (error) {
      started = runtimeError('sing_box_start_failed', {
        reason: String(error?.message || error || 'unknown')
      });
    }
    if (started.ok) return { ok: true };

    if (previousCompiled && Object.keys(previousState.accounts).length > 0) {
      let restored;
      try {
        restored = this._isRunning()
          ? runtimeError('sing_box_stop_failed')
          : await this._startCompiled(previousCompiled, previousState);
      } catch (error) {
        restored = runtimeError('sing_box_start_failed', {
          reason: String(error?.message || error || 'unknown')
        });
      }
      if (!restored?.ok) {
        this.currentCompiled = null;
        return runtimeError('sing_box_restart_rollback_failed', {
          applyError: String(started.error || 'sing_box_start_failed'),
          reason: String(restored?.reason || restored?.error || 'sing_box_start_failed')
        });
      }
    } else {
      this.currentCompiled = null;
    }
    return started;
  }

  async _applyState(nextState, previousState, accountRef) {
    const nextCompiled = this._compile(nextState);
    const running = this._isRunning() && Boolean(this.currentCompiled);
    if (running && this.currentCompiled.shapeHash === nextCompiled.shapeHash) {
      const previousAccount = this.currentCompiled.accounts[accountRef];
      const nextAccount = nextCompiled.accounts[accountRef];
      if (
        previousAccount
        && nextAccount
        && previousAccount.selectedOutboundTag !== nextAccount.selectedOutboundTag
      ) {
        const selected = await this.selectOutbound({
          accountRef,
          controllerPort: nextState.controllerPort,
          controllerSecret: nextState.controllerSecret,
          selectorTag: nextAccount.selectorTag,
          outboundTag: nextAccount.selectedOutboundTag
        });
        if (!selected?.ok) {
          return runtimeError(selected?.error || 'sing_box_selector_failed', {
            ...(selected?.reason ? { reason: String(selected.reason) } : {})
          });
        }
        const closed = await this.closeAccountConnections({
          accountRef,
          controllerPort: nextState.controllerPort,
          controllerSecret: nextState.controllerSecret,
          inboundTag: nextAccount.inboundTag
        });
        if (!closed?.ok) {
          let rolledBack;
          try {
            rolledBack = await this.selectOutbound({
              accountRef,
              controllerPort: previousState.controllerPort,
              controllerSecret: previousState.controllerSecret,
              selectorTag: previousAccount.selectorTag,
              outboundTag: previousAccount.selectedOutboundTag
            });
          } catch (error) {
            rolledBack = runtimeError('sing_box_selector_rollback_failed', {
              reason: String(error?.message || error || 'unknown')
            });
          }
          if (!rolledBack?.ok) {
            const activeChild = this.child;
            let stopped = true;
            try {
              if (this._isRunning()) stopped = await this.stopSidecar(activeChild);
            } catch {
              stopped = false;
            }
            if (stopped && this.child === activeChild) this.child = null;
            this.currentCompiled = null;
            this.lastError = 'sing_box_selector_rollback_failed';
            try { this._writeStatus(); } catch {}
            return runtimeError('sing_box_selector_rollback_failed', {
              reason: String(
                rolledBack?.reason
                || rolledBack?.error
                || 'selector_rollback_failed'
              ),
              connectionError: String(closed?.error || 'sing_box_connection_close_failed'),
              ...(stopped ? {} : { stopFailed: true })
            });
          }
          return runtimeError(closed?.error || 'sing_box_connection_close_failed', {
            ...(closed?.reason ? { reason: String(closed.reason) } : {})
          });
        }
        this._writeConfig(nextCompiled);
        this.store.write(nextState);
        this.currentCompiled = nextCompiled;
        this.lastError = null;
        this._writeStatus();
        return {
          ok: true,
          action: 'selected',
          closedConnections: Number(closed.closedConnections || 0)
        };
      }
      this._writeConfig(nextCompiled);
      this.store.write(nextState);
      this.currentCompiled = nextCompiled;
      this.lastError = null;
      this._writeStatus();
      return { ok: true, action: 'unchanged' };
    }

    const action = running ? 'restarted' : 'started';
    const transitioned = await this._restartWithRollback(nextCompiled, nextState, previousState);
    if (!transitioned.ok) {
      this.lastError = transitioned.error;
      try { this._writeStatus(); } catch {}
      return transitioned;
    }
    try {
      this.store.write(nextState);
    } catch (error) {
      await this.stopSidecar(this.child);
      this.child = null;
      this.currentCompiled = null;
      if (Object.keys(previousState.accounts).length > 0) {
        try {
          const previousCompiled = this._compile(previousState);
          await this._startCompiled(previousCompiled, previousState);
        } catch {}
      }
      return runtimeError('zcode_sidecar_state_write_failed', {
        reason: String(error?.message || error || 'unknown')
      });
    }
    this.lastError = null;
    this._writeStatus();
    return { ok: true, action };
  }

  ensureAccountEndpoint(input = {}) {
    return this._enqueue(async () => {
      const accountRef = String(input.accountRef || '').trim();
      if (!accountRef) return runtimeError('invalid_zcode_sidecar_account');
      if (this.platformKey !== 'macos') {
        return runtimeError('not_supported', { platform: this.platformKey });
      }
      if (!this._refreshBinary()) return runtimeError('sing_box_unavailable');

      const previousState = this.store.read();
      const nextState = cloneState(previousState);
      const controller = await this._ensureControllerPort(nextState);
      if (!controller.ok) return controller;
      const assignment = await this._ensureAccountPort(nextState, accountRef);
      if (!assignment.ok) return assignment;

      let normalized;
      try {
        normalized = normalizeResolvedTarget(input.resolvedTarget);
      } catch (error) {
        return runtimeError('invalid_zcode_resolved_target', {
          reason: String(error?.message || error || 'unknown')
        });
      }
      nextState.accounts[accountRef] = normalized;
      let applied;
      try {
        applied = await this._applyState(nextState, previousState, accountRef);
      } catch (error) {
        const code = /^zcode_underlay_/.test(String(error?.code || ''))
          ? String(error.code)
          : 'sing_box_apply_failed';
        applied = runtimeError(code, {
          reason: String(error?.message || error || 'unknown')
        });
      }
      if (!applied.ok) return { ...applied, port: assignment.port };
      return {
        ok: true,
        action: applied.action,
        port: assignment.port,
        proxyServer: `127.0.0.1:${assignment.port}`,
        source: normalized.source,
        selectedNodeId: normalized.selectedNodeId || null,
        groupId: normalized.groupId || null,
        ...(applied.closedConnections !== undefined
          ? { closedConnections: applied.closedConnections }
          : {}),
        sidecar: this.getStatus()
      };
    });
  }

  releaseAccount(accountRef) {
    return this._enqueue(async () => {
      const normalizedRef = String(accountRef || '').trim();
      if (!normalizedRef) return runtimeError('invalid_zcode_sidecar_account');
      const previousState = this.store.read();
      if (!previousState.accounts[normalizedRef]) return { ok: true, action: 'unchanged' };
      const nextState = cloneState(previousState);
      delete nextState.accounts[normalizedRef];
      if (Object.keys(nextState.accounts).length === 0) {
        if (this._isRunning()) await this.stopSidecar(this.child);
        this.child = null;
        this.currentCompiled = null;
        this.store.write(nextState);
        this.lastError = null;
        this._ensurePrivateFiles();
        this._writeStatus();
        return { ok: true, action: 'stopped' };
      }
      if (!this._refreshBinary()) return runtimeError('sing_box_unavailable');
      const applied = await this._applyState(nextState, previousState, normalizedRef);
      return applied.ok ? { ok: true, action: applied.action } : applied;
    });
  }

  stop() {
    return this._enqueue(async () => {
      if (this._isRunning()) await this.stopSidecar(this.child);
      this.child = null;
      this.currentCompiled = null;
      this._ensurePrivateFiles();
      this._writeStatus();
      return { ok: true, action: 'stopped' };
    });
  }
}

const defaultRuntimes = new Map();
function resolveDefaultRuntimeKey(options = {}) {
  return String(
    options.aiHomeDir
    || process.env.AIH_HOME
    || nativePath.join(nativeOs.homedir(), '.ai_home')
  ).trim();
}

function getZcodeSingBoxRuntime(options = {}) {
  const customKeys = Object.keys(options).filter((key) => key !== 'aiHomeDir');
  if (customKeys.length > 0) return new ZcodeSingBoxRuntime(options);
  const aiHomeDir = resolveDefaultRuntimeKey(options);
  if (!defaultRuntimes.has(aiHomeDir)) {
    defaultRuntimes.set(aiHomeDir, new ZcodeSingBoxRuntime({ aiHomeDir }));
  }
  return defaultRuntimes.get(aiHomeDir);
}

function peekZcodeSingBoxRuntime(options = {}) {
  return defaultRuntimes.get(resolveDefaultRuntimeKey(options)) || null;
}

module.exports = {
  ZcodeSingBoxRuntime,
  closeSingBoxInboundConnections,
  discoverSingBoxBinary,
  getZcodeSingBoxRuntime,
  peekZcodeSingBoxRuntime
};
