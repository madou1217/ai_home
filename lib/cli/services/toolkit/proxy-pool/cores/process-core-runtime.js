'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { request } = require('undici');
const { atomicWritePrivateFile, ensurePrivateDirectory } = require('../secure-file-io');
const { resolveProxyPoolAiHome } = require('../aih-home');

/**
 * 代理内核进程运行时的共用骨架（模板方法）：
 * 串行操作队列、子进程启动/就绪探测/监听探测/优雅终止、状态快照与 clash 兼容控制器测速。
 * 内核差异（程序发现、配置编译、校验与启动参数、重载方式）由 spec 与子类钩子提供。
 */
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

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function defaultKillPid(pid, signal) {
  try { process.kill(pid, signal); } catch (_error) { /* already gone */ }
}

// 读取进程命令行用于归属核对：Linux 读 /proc，其它 POSIX 用 ps；Windows 不做核对（返回空即不接管）。
function defaultReadCommandLine(pid) {
  if (process.platform === 'win32') return '';
  try {
    return nativeFs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch (_error) {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return result?.status === 0 ? String(result.stdout || '').trim() : '';
  }
}

class ProcessCoreRuntime {
  /**
   * @param {Object} options 运行时注入项（fs/path/env/spawn/requestImpl/探针/端口/目录…）
   * @param {Object} spec 内核描述：engine/displayName/runtimeDirName/configFileName/defaultControllerPort/
   *   defaultMixedPort/discoverBinary/versionArgs/parseVersion/chooseLoopbackPort/compileConfig/
   *   mixedPortOf/validateArgs/runArgs
   */
  constructor(options = {}, spec = {}) {
    this.spec = spec;
    this.engine = spec.engine;
    // 错误码前缀（如 mihomo_config_invalid / sing_box_config_invalid），默认同 engine。
    this.errorPrefix = spec.errorPrefix || spec.engine;
    this.displayName = spec.displayName || spec.engine;
    this.fs = options.fs || nativeFs;
    this.path = options.path || nativePath;
    this.env = options.env || process.env;
    this.spawnSync = options.spawnSync || spawnSync;
    this.spawn = options.spawn || spawn;
    this.requestImpl = options.requestImpl || request;
    this.readinessProbe = options.readinessProbe || null;
    this.readCommandLine = options.readCommandLine || defaultReadCommandLine;
    this.isPidAlive = options.isPidAlive || defaultIsPidAlive;
    this.killPid = options.killPid || defaultKillPid;
    this.listenerProbe = options.listenerProbe || null;
    this.aiHomeDir = resolveProxyPoolAiHome({ aiHomeDir: options.aiHomeDir, env: this.env, path: this.path });
    this.runtimeDir = options.runtimeDir || this.path.join(this.aiHomeDir, 'run', 'proxy-pool', spec.runtimeDirName || spec.engine);
    this.configPath = options.configPath || this.path.join(this.runtimeDir, spec.configFileName);
    this.pidFilePath = this.path.join(this.runtimeDir, 'core.pid');
    this.controllerPort = Number(options.controllerPort || spec.defaultControllerPort);
    this.controllerSecret = String(options.controllerSecret || crypto.randomBytes(24).toString('hex'));
    this.requestedMixedPort = Number(options.mixedPort || spec.defaultMixedPort);
    this.effectiveMixedPort = null;
    this.portSelection = null;
    this.readinessTimeoutMs = Number(options.readinessTimeoutMs || 5000);
    this.terminateTimeoutMs = Number(options.terminateTimeoutMs || 2000);
    this.killTimeoutMs = Number(options.killTimeoutMs || 1000);
    this.binary = spec.discoverBinary({
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
      const result = this.spawnSync(this.binary.path, this.spec.versionArgs, {
        encoding: 'utf8',
        env: this.env,
        timeout: 3000
      });
      if (result?.status !== 0) return null;
      return this.spec.parseVersion(result.stdout || result.stderr) || null;
    } catch (_error) {
      return null;
    }
  }

  _isRunning() {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  _writePidFile(child) {
    if (!Number.isInteger(child?.pid)) return;
    try {
      this._ensureRuntimeDir();
      atomicWritePrivateFile(this.fs, this.path, this.pidFilePath, JSON.stringify({
        pid: child.pid,
        engine: this.engine,
        configPath: this.configPath,
        startedAt: Date.now()
      }));
    } catch (_error) { /* best effort: orphan reaping just becomes unavailable */ }
  }

  _removePidFile(pid) {
    try {
      const recorded = JSON.parse(this.fs.readFileSync(this.pidFilePath, 'utf8'));
      if (pid !== undefined && pid !== null && Number(recorded?.pid) !== Number(pid)) return;
      this.fs.unlinkSync(this.pidFilePath);
    } catch (_error) { /* nothing recorded */ }
  }

  /**
   * 结束上一次服务实例遗留的内核进程（服务被强杀、或停止时内核没跟着退出）。
   * 只认 pid 文件记录、仍存活、且命令行指向本运行时配置文件的进程，避免误杀被复用的 pid。
   */
  async reapOrphanedProcess() {
    let recorded = null;
    try { recorded = JSON.parse(this.fs.readFileSync(this.pidFilePath, 'utf8')); } catch (_error) { return { reaped: false }; }
    const pid = Number(recorded?.pid);
    const ownPid = this.child?.pid;
    if (!Number.isInteger(pid) || pid <= 0 || pid === ownPid) return { reaped: false };
    if (!this.isPidAlive(pid)) {
      this._removePidFile(pid);
      return { reaped: false, stale: true };
    }
    const commandLine = String(this.readCommandLine(pid) || '');
    if (!commandLine.includes(this.configPath)) {
      this._removePidFile(pid);
      return { reaped: false, foreign: true };
    }
    this.killPid(pid, 'SIGTERM');
    const deadline = Date.now() + this.terminateTimeoutMs;
    while (this.isPidAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.isPidAlive(pid)) this.killPid(pid, 'SIGKILL');
    this._removePidFile(pid);
    return { reaped: true, pid };
  }

  _compiledMixedPort(compiled) {
    return compiled ? this.spec.mixedPortOf(compiled) : null;
  }

  getOwnedProcessId() {
    return this._isRunning() && Number.isInteger(this.child?.pid) ? this.child.pid : null;
  }

  getStatus() {
    const running = this._isRunning();
    const dataPlaneReady = Boolean(running && this.ready);
    return {
      engine: this.engine,
      installed: Boolean(this.binary),
      running,
      dataPlaneReady,
      binaryName: this.binary?.binaryName || null,
      binarySource: this.binarySource,
      binaryManaged: this.binaryManaged,
      version: this.version,
      requestedMixedPort: this.requestedMixedPort,
      mixedPort: this.effectiveMixedPort || this._compiledMixedPort(this.lastCompiled) || this.requestedMixedPort,
      portSelection: this.portSelection,
      mixedProxyUrl: dataPlaneReady
        ? `http://127.0.0.1:${this._compiledMixedPort(this.lastCompiled) || this.spec.defaultMixedPort}`
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
    this.binary = this.spec.discoverBinary({
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
    if (this._isRunning() && this._compiledMixedPort(this.lastCompiled)) {
      this.effectiveMixedPort = Number(this._compiledMixedPort(this.lastCompiled));
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
    const selection = await this.spec.chooseLoopbackPort(Number(state.mixedPort || this.requestedMixedPort), {
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
    const compiled = this.spec.compileConfig({
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
    const result = this.spawnSync(this.binary.path, this.spec.validateArgs(this), {
      encoding: 'utf8',
      env: this.env,
      timeout: 10000,
      windowsHide: true
    });
    if (!result || result.status !== 0) {
      const message = String(result?.stderr || result?.stdout || `${this.displayName} rejected the generated configuration`).trim();
      const error = new Error(message);
      error.code = `${this.errorPrefix}_config_invalid`;
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
    const mixedReady = await probe(this._compiledMixedPort(compiled), 1000);
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

    await this.reapOrphanedProcess();

    let compiled;
    try {
      compiled = await this._compileAndWrite(state);
      this._validateConfig();
    } catch (error) {
      this.lastError = error.code || error.message || `${this.errorPrefix}_config_invalid`;
      return this._result('start', false, {
        error: error.code || `${this.errorPrefix}_config_invalid`,
        message: error.message
      });
    }

    const launched = await this._launch(compiled);
    if (!launched.ok) {
      return this._result('start', false, {
        error: launched.error,
        message: launched.message,
        warnings: compiled.warnings
      });
    }
    return this._result('start', true, { warnings: compiled.warnings });
  }

  /**
   * 按已写入的配置拉起内核进程并等待控制器与全部监听就绪。
   * 返回 { ok } 或 { ok:false, error, message }；失败时进程已被终止并清理状态。
   */
  async _launch(compiled) {
    try {
      const child = this.spawn(this.binary.path, this.spec.runArgs(this), {
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
        this._removePidFile(child.pid);
        if (this.child === child) {
          this.ready = false;
          this.child = null;
          if (code !== 0 && code !== null) {
            this.lastError = stderr.trim() || `${this.errorPrefix}_exited_${code}${signal ? `_${signal}` : ''}`;
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
        return { ok: false, error: 'proxy_core_start_failed', message: this.lastError };
      }
      const ready = await this._probeReadiness() && await this._probeConfiguredListeners(compiled);
      if (!ready) {
        const stopped = await this._terminateChild(child);
        this.ready = false;
        this.activeListenerStates = [];
        if (stopped) this.child = null;
        this.lastError = stopped ? 'proxy_core_readiness_failed' : 'proxy_core_termination_failed';
        return {
          ok: false,
          error: 'proxy_core_readiness_failed',
          message: stderr.trim() || (stopped ? undefined : `${this.displayName} failed readiness and did not exit after SIGKILL`)
        };
      }
      this.ready = true;
      this.lastError = null;
      this._writePidFile(child);
      return { ok: true };
    } catch (error) {
      const child = this.child;
      const stopped = child ? await this._terminateChild(child) : true;
      if (stopped) this.child = null;
      this.ready = false;
      this.lastError = stopped ? error.message : 'proxy_core_termination_failed';
      return {
        ok: false,
        error: 'proxy_core_start_failed',
        message: stopped ? error.message : `${error.message}; ${this.displayName} did not exit after SIGKILL`
      };
    }
  }

  reload(state = {}) {
    return this._enqueueOperation(() => this._reload(state));
  }

  /**
   * 默认重载策略：没有热重载接口的内核（如 sing-box）按「编译 → 校验 → 停 → 启」重启，
   * 新配置起不来时恢复旧配置文件并按旧配置重新拉起。支持热重载的内核（mihomo）覆写本方法。
   */
  async _reload(state = {}) {
    if (!this.binary) {
      this.lastError = 'proxy_core_unavailable';
      return this._result('reload', false, { error: 'proxy_core_unavailable' });
    }
    if (!this._isRunning()) {
      this.lastError = 'proxy_core_not_running';
      return this._result('reload', false, { error: 'proxy_core_not_running' });
    }
    let previousConfig = null;
    const previousCompiled = this.lastCompiled;
    try { previousConfig = this.fs.readFileSync(this.configPath, 'utf8'); } catch (_error) { /* first reload */ }
    let compiled;
    try {
      compiled = await this._compileAndWrite(state);
      this._validateConfig();
    } catch (error) {
      if (previousConfig !== null) this._restoreConfig(previousConfig);
      this.lastError = error.code || error.message;
      return this._result('reload', false, {
        error: error.code || 'proxy_core_reload_failed',
        message: error.message,
        warnings: compiled?.warnings || []
      });
    }
    const stopped = await this._terminateChild(this.child);
    if (!stopped) {
      this.lastError = 'proxy_core_stop_failed';
      return this._result('reload', false, { error: 'proxy_core_stop_failed', warnings: compiled.warnings });
    }
    this.child = null;
    this.ready = false;
    const started = await this._launch(compiled);
    if (started.ok) {
      this.lastCompiled = compiled;
      this.lastError = null;
      return this._result('reload', true, { warnings: compiled.warnings });
    }
    // 新配置拉不起来：恢复旧配置并按旧配置重启，尽量保住数据面。
    if (previousConfig !== null && previousCompiled) {
      this._restoreConfig(previousConfig);
      const restored = await this._launch(previousCompiled);
      if (restored.ok) this.lastCompiled = previousCompiled;
    }
    this.lastError = started.error;
    return this._result('reload', false, {
      error: started.error === 'proxy_core_readiness_failed' ? 'proxy_core_readiness_failed' : 'proxy_core_reload_failed',
      message: started.message,
      warnings: compiled.warnings
    });
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
          message: `${this.displayName} did not exit after SIGTERM and SIGKILL`
        });
      }
    }
    this._removePidFile(child?.pid);
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
        return { ok: false, error: `${this.errorPrefix}_delay_http_${response.statusCode}` };
      }
      const data = await response.body.json();
      const delay = Number(data?.delay);
      if (!Number.isFinite(delay) || delay < 0) return { ok: false, error: `${this.errorPrefix}_delay_invalid_response` };
      return { ok: true, latencyMs: delay };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

module.exports = {
  ProcessCoreRuntime,
  defaultListenerProbe,
  responseBodyText
};
