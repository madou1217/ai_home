'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { request } = require('undici');
const {
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_MIXED_PORT,
  compileMihomoConfig
} = require('./mihomo-config-compiler');
const {
  chooseLoopbackPort,
  knownMihomoCandidates,
  managedMihomoRoot,
  parseVersion
} = require('./mihomo-core-manager');
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('./secure-file-io');

function isExecutableFile(filePath, fsImpl = nativeFs) {
  if (!filePath) return false;
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile()) return false;
    if (typeof fsImpl.accessSync === 'function') {
      fsImpl.accessSync(filePath, fsImpl.constants?.X_OK || nativeFs.constants.X_OK);
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function defaultResolveCommandPath(command, options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const platform = options.platform || process.platform;
  const pathValue = String(env.PATH || '');
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(pathImpl.delimiter || nativePath.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathImpl.join(directory, `${command}${extension}`);
      if (isExecutableFile(candidate, fsImpl)) return candidate;
    }
  }
  return '';
}

function discoverMihomoBinary(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const platform = options.platform || process.platform;
  const resolveCommandPath = options.resolveCommandPath || ((command) => (
    defaultResolveCommandPath(command, { env, fs: fsImpl, path: pathImpl, platform: options.platform })
  ));

  if (env.AIH_MIHOMO_BIN) {
    const explicitPath = pathImpl.resolve(String(env.AIH_MIHOMO_BIN));
    if (isExecutableFile(explicitPath, fsImpl)) {
      return { path: explicitPath, binaryName: pathImpl.basename(explicitPath) };
    }
    return null;
  }

  for (const binaryName of ['mihomo', 'clash-meta']) {
    try {
      const resolved = resolveCommandPath(binaryName);
      if (resolved) return { path: resolved, binaryName };
    } catch (_error) {
      // A resolver is an optional integration boundary. Failure means unavailable.
    }
  }
  const managedCandidates = [
    pathImpl.join(managedMihomoRoot({ aiHomeDir: options.aiHomeDir || env.AIH_HOME, env, path: pathImpl }), 'current', platform === 'win32' ? 'mihomo.exe' : 'mihomo'),
    pathImpl.join(managedMihomoRoot({ aiHomeDir: options.aiHomeDir || env.AIH_HOME, env, path: pathImpl }), 'current', 'mihomo')
  ];
  for (const candidate of [...managedCandidates, ...knownMihomoCandidates({ ...options, env, path: pathImpl })]) {
    if (!isExecutableFile(candidate, fsImpl)) continue;
    return { path: candidate, binaryName: pathImpl.basename(candidate), source: managedCandidates.includes(candidate) ? 'managed' : 'known-app', managed: managedCandidates.includes(candidate) };
  }
  return null;
}

function responseBodyText(response) {
  if (!response?.body || typeof response.body.text !== 'function') return Promise.resolve('');
  return response.body.text().catch(() => '');
}

function defaultListenerProbe(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: Number(port) });
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

class MihomoRuntime {
  constructor(options = {}) {
    this.fs = options.fs || nativeFs;
    this.path = options.path || nativePath;
    this.env = options.env || process.env;
    this.spawnSync = options.spawnSync || spawnSync;
    this.spawn = options.spawn || spawn;
    this.requestImpl = options.requestImpl || request;
    this.readinessProbe = options.readinessProbe || null;
    this.listenerProbe = options.listenerProbe || null;
    this.aiHomeDir = options.aiHomeDir || this.env.AIH_HOME || this.path.join(os.homedir(), '.ai_home');
    this.runtimeDir = options.runtimeDir || this.path.join(this.aiHomeDir, 'run', 'proxy-pool', 'mihomo');
    this.configPath = options.configPath || this.path.join(this.runtimeDir, 'config.yaml');
    this.controllerPort = Number(options.controllerPort || DEFAULT_CONTROLLER_PORT);
    this.controllerSecret = String(options.controllerSecret || crypto.randomBytes(24).toString('hex'));
    this.requestedMixedPort = Number(options.mixedPort || DEFAULT_MIXED_PORT);
    this.effectiveMixedPort = null;
    this.portSelection = null;
    this.readinessTimeoutMs = Number(options.readinessTimeoutMs || 5000);
    this.terminateTimeoutMs = Number(options.terminateTimeoutMs || 2000);
    this.killTimeoutMs = Number(options.killTimeoutMs || 1000);
    this.binary = discoverMihomoBinary({
      env: this.env,
      fs: this.fs,
      path: this.path,
      platform: options.platform,
      aiHomeDir: this.aiHomeDir,
      resolveCommandPath: options.resolveCommandPath
    });
    this.binarySource = this.binary?.source || (this.binary ? 'path' : null);
    this.binaryManaged = Boolean(this.binary?.managed);
    this.version = this.binary ? this._readVersion() : null;
    this.child = null;
    this.ready = false;
    this.lastError = null;
    this.lastCompiled = null;
    this.activeListenerStates = [];
    this.operationQueue = Promise.resolve();
  }

  _enqueueOperation(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  _isChildRunning(child) {
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  _waitForChildExit(child, timeoutMs) {
    if (!this._isChildRunning(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const onExit = () => finish(true);
      const finish = (exited) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off?.('exit', onExit);
        resolve(exited || !this._isChildRunning(child));
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once?.('exit', onExit);
    });
  }

  async _terminateChild(child) {
    if (!this._isChildRunning(child)) return true;
    try { child.kill?.('SIGTERM'); } catch (_error) { /* verify through process state */ }
    if (await this._waitForChildExit(child, this.terminateTimeoutMs)) return true;
    try { child.kill?.('SIGKILL'); } catch (_error) { /* verify through process state */ }
    return this._waitForChildExit(child, this.killTimeoutMs);
  }

  _readVersion() {
    try {
      const result = this.spawnSync(this.binary.path, ['-v'], {
        encoding: 'utf8',
        env: this.env,
        timeout: 3000
      });
      if (result?.status !== 0) return null;
      return parseVersion(result.stdout || result.stderr) || null;
    } catch (_error) {
      return null;
    }
  }

  _isRunning() {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  getOwnedProcessId() {
    return this._isRunning() && Number.isInteger(this.child?.pid) ? this.child.pid : null;
  }

  getStatus() {
    const running = this._isRunning();
    const dataPlaneReady = Boolean(running && this.ready);
    return {
      engine: 'mihomo',
      installed: Boolean(this.binary),
      running,
      dataPlaneReady,
      binaryName: this.binary?.binaryName || null,
      binarySource: this.binarySource,
      binaryManaged: this.binaryManaged,
      version: this.version,
      requestedMixedPort: this.requestedMixedPort,
      mixedPort: this.effectiveMixedPort || this.lastCompiled?.config?.['mixed-port'] || this.requestedMixedPort,
      portSelection: this.portSelection,
      mixedProxyUrl: dataPlaneReady
        ? `http://127.0.0.1:${this.lastCompiled?.config?.['mixed-port'] || DEFAULT_MIXED_PORT}`
        : null,
      activeListeners: dataPlaneReady
        ? this.activeListenerStates.filter((listener) => listener.listening).map((listener) => ({ ...listener }))
        : [],
      lastError: this.lastError
    };
  }

  _result(action, ok, extra = {}) {
    return {
      ok,
      action,
      applied: ok,
      ...extra,
      core: this.getStatus(),
      warnings: extra.warnings || []
    };
  }

  _ensureRuntimeDir() {
    ensurePrivateDirectory(this.fs, this.runtimeDir);
  }

  refreshBinary(options = {}) {
    this.binary = discoverMihomoBinary({
      env: options.env || this.env,
      fs: options.fs || this.fs,
      path: options.path || this.path,
      platform: options.platform,
      aiHomeDir: options.aiHomeDir || this.aiHomeDir,
      resolveCommandPath: options.resolveCommandPath
    });
    this.binarySource = this.binary?.source || (this.binary ? 'path' : null);
    this.binaryManaged = Boolean(this.binary?.managed);
    this.version = this.binary ? this._readVersion() : null;
    return this.getStatus();
  }

  async _resolveMixedPort(state = {}) {
    if (this._isRunning() && this.lastCompiled?.config?.['mixed-port']) {
      this.effectiveMixedPort = Number(this.lastCompiled.config['mixed-port']);
      this.portSelection = {
        ok: true,
        port: this.effectiveMixedPort,
        requestedPort: Number(state.mixedPort || this.requestedMixedPort),
        reused: true,
        reason: 'running_core_port_reused'
      };
      return this.effectiveMixedPort;
    }
    const dedicatedPorts = state.dedicatedPorts?.mappings || {};
    const reservedPorts = [this.controllerPort, ...Object.values(dedicatedPorts).map(Number)];
    const selection = await chooseLoopbackPort(Number(state.mixedPort || this.requestedMixedPort), {
      reservedPorts,
      minPort: Math.max(1024, Number(state.mixedPort || this.requestedMixedPort)),
      maxPort: Math.min(65535, Math.max(Number(state.mixedPort || this.requestedMixedPort) + 32, 10832))
    });
    if (!selection.ok) {
      const error = new Error(selection.error);
      error.code = selection.error;
      throw error;
    }
    this.effectiveMixedPort = selection.port;
    this.portSelection = selection;
    return selection.port;
  }

  async _compileAndWrite(state) {
    const mixedPort = await this._resolveMixedPort(state);
    const compiled = compileMihomoConfig({
      ...state,
      mixedPort,
      controllerPort: this.controllerPort,
      controllerSecret: this.controllerSecret
    });
    this._ensureRuntimeDir();
    atomicWritePrivateFile(this.fs, this.path, this.configPath, compiled.content);
    return compiled;
  }

  _restoreConfig(content) {
    if (typeof content !== 'string') return;
    atomicWritePrivateFile(this.fs, this.path, this.configPath, content);
  }

  _validateConfig() {
    const result = this.spawnSync(this.binary.path, [
      '-t',
      '-d', this.runtimeDir,
      '-f', this.configPath
    ], {
      encoding: 'utf8',
      env: this.env,
      timeout: 10000,
      windowsHide: true
    });
    if (!result || result.status !== 0) {
      const message = String(result?.stderr || result?.stdout || 'Mihomo rejected the generated configuration').trim();
      const error = new Error(message);
      error.code = 'mihomo_config_invalid';
      throw error;
    }
  }

  async _defaultReadinessProbe() {
    const deadline = Date.now() + this.readinessTimeoutMs;
    const url = `http://127.0.0.1:${this.controllerPort}/version`;
    do {
      if (!this._isRunning()) return false;
      try {
        const response = await this.requestImpl(url, {
          method: 'GET',
          headers: this._controllerHeaders(),
          headersTimeout: 500,
          bodyTimeout: 500
        });
        if (response.statusCode >= 200 && response.statusCode < 300) {
          await responseBodyText(response);
          return true;
        }
        await responseBodyText(response);
      } catch (_error) {
        // The controller needs a short startup window.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return false;
  }

  async _probeReadiness() {
    if (this.readinessProbe) {
      return Boolean(await this.readinessProbe({
        port: this.controllerPort,
        secret: this.controllerSecret,
        child: this.child
      }));
    }
    return this._defaultReadinessProbe();
  }

  async _probeConfiguredListeners(compiled) {
    const configured = compiled?.activeListeners || [];
    if (this.readinessProbe && !this.listenerProbe) {
      this.activeListenerStates = configured.map((listener) => ({ ...listener, listening: true }));
      return true;
    }
    const probe = this.listenerProbe || defaultListenerProbe;
    const mixedReady = await probe(compiled.config['mixed-port'], 1000);
    const activeListenerStates = [];
    for (const listener of configured) {
      const listening = await probe(listener.port, 1000);
      activeListenerStates.push({ ...listener, listening: Boolean(listening) });
    }
    this.activeListenerStates = activeListenerStates;
    return Boolean(mixedReady && activeListenerStates.every((listener) => listener.listening));
  }

  _controllerHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this.controllerSecret}`,
      ...extra
    };
  }

  start(state = {}) {
    return this._enqueueOperation(() => this._start(state));
  }

  async _start(state = {}) {
    if (!this.binary) {
      this.lastError = 'proxy_core_unavailable';
      return this._result('start', false, { error: 'proxy_core_unavailable' });
    }
    if (this._isRunning()) {
      this.lastError = 'proxy_core_already_running';
      return this._result('start', false, { error: 'proxy_core_already_running' });
    }

    let compiled;
    try {
      compiled = await this._compileAndWrite(state);
      this._validateConfig();
    } catch (error) {
      this.lastError = error.code || error.message || 'mihomo_config_invalid';
      return this._result('start', false, {
        error: error.code || 'mihomo_config_invalid',
        message: error.message
      });
    }

    try {
      const child = this.spawn(this.binary.path, [
        '-d', this.runtimeDir,
        '-f', this.configPath
      ], {
        cwd: this.runtimeDir,
        env: this.env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
      this.child = child;
      this.lastCompiled = compiled;
      this.ready = false;
      let stderr = '';
      let spawnError = null;
      child.stderr?.on?.('data', (chunk) => {
        if (stderr.length < 8192) stderr += String(chunk).slice(0, 8192 - stderr.length);
      });
      child.once?.('exit', (code, signal) => {
        if (this.child === child) {
          this.ready = false;
          this.child = null;
          if (code !== 0 && code !== null) {
            this.lastError = stderr.trim() || `mihomo_exited_${code}${signal ? `_${signal}` : ''}`;
          }
        }
      });
      child.once?.('error', (error) => {
        spawnError = error;
        if (this.child === child) {
          this.ready = false;
          this.child = null;
          this.lastError = error.message;
        }
      });
      await new Promise((resolve) => setImmediate(resolve));
      if (spawnError || !this._isRunning()) {
        this.child = null;
        this.lastCompiled = null;
        this.lastError = spawnError?.message || stderr.trim() || 'proxy_core_start_failed';
        return this._result('start', false, {
          error: 'proxy_core_start_failed',
          message: this.lastError,
          warnings: compiled.warnings
        });
      }
      const ready = await this._probeReadiness() && await this._probeConfiguredListeners(compiled);
      if (!ready) {
        const stopped = await this._terminateChild(child);
        this.ready = false;
        this.activeListenerStates = [];
        if (stopped) this.child = null;
        this.lastError = stopped ? 'proxy_core_readiness_failed' : 'proxy_core_termination_failed';
        return this._result('start', false, {
          error: 'proxy_core_readiness_failed',
          message: stderr.trim() || (stopped ? undefined : 'Mihomo failed readiness and did not exit after SIGKILL'),
          warnings: compiled.warnings
        });
      }
      this.ready = true;
      this.lastError = null;
      return this._result('start', true, { warnings: compiled.warnings });
    } catch (error) {
      const child = this.child;
      const stopped = child ? await this._terminateChild(child) : true;
      if (stopped) this.child = null;
      this.ready = false;
      this.lastError = stopped ? error.message : 'proxy_core_termination_failed';
      return this._result('start', false, {
        error: 'proxy_core_start_failed',
        message: stopped ? error.message : `${error.message}; Mihomo did not exit after SIGKILL`,
        warnings: compiled.warnings
      });
    }
  }

  reload(state = {}) {
    return this._enqueueOperation(() => this._reload(state));
  }

  async _reload(state = {}) {
    if (!this.binary) {
      this.lastError = 'proxy_core_unavailable';
      return this._result('reload', false, { error: 'proxy_core_unavailable' });
    }
    if (!this._isRunning()) {
      this.lastError = 'proxy_core_not_running';
      return this._result('reload', false, { error: 'proxy_core_not_running' });
    }

    let compiled;
    let previousConfig = null;
    let reloadMayHaveReachedCore = false;
    try {
      try { previousConfig = this.fs.readFileSync(this.configPath, 'utf8'); } catch (_error) { /* first reload */ }
      compiled = await this._compileAndWrite(state);
      this._validateConfig();
      reloadMayHaveReachedCore = true;
      const response = await this.requestImpl(
        `http://127.0.0.1:${this.controllerPort}/configs?force=true`,
        {
          method: 'PUT',
          headers: this._controllerHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ path: this.configPath }),
          headersTimeout: 3000,
          bodyTimeout: 3000
        }
      );
      const responseText = await responseBodyText(response);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(responseText || `Mihomo reload returned HTTP ${response.statusCode}`);
      }
      this.ready = await this._probeReadiness() && await this._probeConfiguredListeners(compiled);
      if (!this.ready) {
        const error = new Error('proxy_core_readiness_failed');
        error.code = 'proxy_core_readiness_failed';
        throw error;
      }
      this.lastCompiled = compiled;
      this.lastError = null;
      return this._result('reload', true, { warnings: compiled.warnings });
    } catch (error) {
      if (previousConfig !== null) {
        try {
          this._restoreConfig(previousConfig);
          if (reloadMayHaveReachedCore && this._isRunning()) {
            const rollbackResponse = await this.requestImpl(
              `http://127.0.0.1:${this.controllerPort}/configs?force=true`,
              {
                method: 'PUT',
                headers: this._controllerHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ path: this.configPath }),
                headersTimeout: 3000,
                bodyTimeout: 3000
              }
            );
            await responseBodyText(rollbackResponse);
            this.ready = rollbackResponse.statusCode >= 200 && rollbackResponse.statusCode < 300
              ? await this._probeReadiness() && await this._probeConfiguredListeners(this.lastCompiled)
              : false;
          }
        } catch (_rollbackError) {
          this.ready = false;
        }
      }
      this.lastError = error.code || error.message;
      return this._result('reload', false, {
        error: error.code || 'proxy_core_reload_failed',
        message: error.message,
        warnings: compiled?.warnings || []
      });
    }
  }

  stop() {
    return this._enqueueOperation(() => this._stop());
  }

  async _stop() {
    const child = this.child;
    if (child && this._isRunning()) {
      const stopped = await this._terminateChild(child);
      if (!stopped) {
        this.ready = false;
        this.lastError = 'proxy_core_stop_failed';
        return this._result('stop', false, {
          error: 'proxy_core_stop_failed',
          message: 'Mihomo did not exit after SIGTERM and SIGKILL'
        });
      }
    }
    this.child = null;
    this.ready = false;
    this.lastCompiled = null;
    this.activeListenerStates = [];
    this.lastError = null;
    return this._result('stop', true);
  }

  async pingNode(node, options = {}) {
    if (!this.getStatus().dataPlaneReady) {
      return { ok: false, error: 'proxy_core_unavailable' };
    }
    const proxyName = this.lastCompiled?.nodeNameById?.[node?.id];
    if (!proxyName) return { ok: false, error: 'proxy_node_not_loaded' };
    const timeout = Math.max(1, Math.min(Number(options.timeout || 5000), 30000));
    const testUrl = options.url || 'https://www.gstatic.com/generate_204';
    try {
      const endpoint = new URL(
        `/proxies/${encodeURIComponent(proxyName)}/delay`,
        `http://127.0.0.1:${this.controllerPort}`
      );
      endpoint.searchParams.set('timeout', String(timeout));
      endpoint.searchParams.set('url', testUrl);
      const response = await this.requestImpl(endpoint.toString(), {
        method: 'GET',
        headers: this._controllerHeaders(),
        headersTimeout: timeout + 1000,
        bodyTimeout: timeout + 1000
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await responseBodyText(response);
        return { ok: false, error: `mihomo_delay_http_${response.statusCode}` };
      }
      const data = await response.body.json();
      const delay = Number(data?.delay);
      if (!Number.isFinite(delay) || delay < 0) return { ok: false, error: 'mihomo_delay_invalid_response' };
      return { ok: true, latencyMs: delay };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

module.exports = {
  MihomoRuntime,
  atomicWritePrivateFile,
  defaultResolveCommandPath,
  defaultListenerProbe,
  discoverMihomoBinary
};
