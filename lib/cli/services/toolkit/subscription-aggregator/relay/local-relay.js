'use strict';

const nativeFs = require('node:fs');
const nativeNet = require('node:net');
const nativePath = require('node:path');
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require('node:child_process');

const { atomicWritePrivateFile } = require('../../proxy-pool/secure-file-io');
const { resolveProxyPoolAiHome } = require('../../proxy-pool/aih-home');
const { compileRelayConfig } = require('./relay-config');
const { parseSingBoxVersion, resolveSingBoxBinary } = require('./sing-box-binary');

/**
 * 本机中转边车：AIH 拉起一个 sing-box 进程，把「目标格式表达不了」的节点包成本地
 * SOCKS5 / HTTP 入口，让只认 ss/ssr/vmess/trojan/snell/socks5/http 的 Clash Premium 内核
 * （ClashX、Clash for Windows、Clash for Android）也能用上 VLESS / Hysteria2 / TUIC / WireGuard。
 *
 * 三条硬约束：
 * 1. **只监听 127.0.0.1** —— 这是给同一台机器上的客户端用的，不对外暴露。
 * 2. **fail-closed** —— 内核找不到、配置被拒、端口起不来，一律返回失败并且**不输出本地端口**；
 *    调用方于是退回「跳过这些节点」，绝不会出现「本地端口没起来、客户端却以为能用」的情况。
 * 3. **不自动下载内核** —— 找不到就让用户自己装（见 sing-box-binary）。
 */

const DEFAULT_READINESS_TIMEOUT_MS = 6000;
const DEFAULT_STOP_GRACE_MS = 1500;
const PORT_PROBE_WINDOW = 64;
const LOG_TAIL_BYTES = 600;

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function tail(text, length = LOG_TAIL_BYTES) {
  return String(text || '').slice(-length).trim();
}

class LocalRelay {
  constructor(options = {}) {
    this.fs = options.fs || nativeFs;
    this.net = options.net || nativeNet;
    this.path = options.path || nativePath;
    this.spawn = options.spawn || nodeSpawn;
    this.spawnSync = options.spawnSync || nodeSpawnSync;
    this.env = options.env || process.env;
    this.now = options.now || (() => Date.now());
    this.aiHomeDir = options.aiHomeDir || resolveProxyPoolAiHome({ aiHomeDir: options.aiHomeDir, env: this.env });
    this.runDir = options.runDir || this.path.join(this.aiHomeDir, 'run', 'subscription-relay');
    this.basePort = Number(options.basePort || 23100);
    this.maxPorts = Number(options.maxPorts || 256);
    this.readinessTimeoutMs = Number(options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
    this.stopGraceMs = Number(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    this.portByNode = new Map();
    this.binary = undefined;
    this.child = null;
    this.current = null;
    this.inFlight = null;
    this.exitHookInstalled = false;
  }

  /** 解析内核（缓存结果）。找不到返回 null。 */
  resolveBinary() {
    if (this.binary !== undefined) return this.binary;
    const resolved = resolveSingBoxBinary({ fs: this.fs, path: this.path, env: this.env, aiHomeDir: this.aiHomeDir });
    if (!resolved) {
      this.binary = null;
      return null;
    }
    // 版本决定能不能用某些协议的出站（插件的 singBoxSince），顺手问一次。
    const probe = this.spawnSync(resolved.path, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    this.binary = { ...resolved, version: probe && probe.status === 0 ? parseSingBoxVersion(probe.stdout) : '' };
    return this.binary;
  }

  /** 供界面显示：中转能不能用、内核在哪、版本多少。不启动任何进程。 */
  availability() {
    const binary = this.resolveBinary();
    if (!binary) return { available: false, error: 'relay_binary_not_found' };
    return {
      available: true,
      binary: binary.path,
      source: binary.source,
      version: binary.version || '',
      running: Boolean(this.child && this.child.exitCode === null),
      nodes: this.current ? this.current.endpoints.size : 0,
      basePort: this.basePort
    };
  }

  /** 当前生效的「节点 id → 本地入口」。没在跑就是空表（fail-closed）。 */
  endpointFor(nodeId) {
    if (!this.child || this.child.exitCode !== null) return null;
    return (this.current && this.current.endpoints.get(nodeId)) || null;
  }

  /** 当前生效的全部本地入口（同步快照）。没在跑就是空表。 */
  activeEndpoints() {
    if (!this.child || this.child.exitCode !== null) return new Map();
    return this.current ? this.current.endpoints : new Map();
  }

  /**
   * 确保中转在跑，并且覆盖 nodes 这批节点。
   * options.onlyIds 限定「谁要有本地入口」（其余只作为链上前置参与编译，见 relay-config）。
   * → { ok, endpoints: Map<nodeId,{host,port,udp}>, skipped, error?, detail? }
   */
  async ensure(nodes, options = {}) {
    const binary = this.resolveBinary();
    if (!binary) return { ok: false, error: 'relay_binary_not_found', endpoints: new Map(), skipped: [] };
    const wanted = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
    if (!wanted.length) return { ok: true, endpoints: new Map(), skipped: [] };
    const onlyIds = options.onlyIds instanceof Set ? options.onlyIds : null;

    // 第一遍：只为拿到「哪些节点要有入口、按什么顺序」。
    const shape = compileRelayConfig(wanted, { maxPorts: this.maxPorts, version: binary.version || undefined, onlyIds });
    const order = [...shape.endpoints.keys()];
    if (!order.length) return { ok: true, endpoints: new Map(), skipped: shape.skipped };

    const key = this._relayKey(wanted, onlyIds);
    if (this.child && this.child.exitCode === null && this.current && this.current.key === key) {
      return { ok: true, endpoints: this.current.endpoints, skipped: shape.skipped };
    }
    // 同一批节点并发拉订阅时合并成一次重启。
    if (!this.inFlight) {
      this.inFlight = this._restart(binary, wanted, order, key, shape.skipped, onlyIds)
        .finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async _restart(binary, wanted, order, key, chainSkipped, onlyIds) {
    await this._stopChild();
    const ports = await this._resolvePorts(order);
    if (!ports) return { ok: false, error: 'relay_port_unavailable', endpoints: new Map(), skipped: chainSkipped };
    const portByNode = new Map(order.map((nodeId, index) => [nodeId, ports[index]]));

    const configPath = this.path.join(this.runDir, 'config.json');
    const logPath = this.path.join(this.runDir, 'sing-box.log');
    const compiled = compileRelayConfig(wanted, {
      maxPorts: this.maxPorts,
      version: binary.version || undefined,
      logPath,
      onlyIds,
      assignPort: (nodeId) => portByNode.get(nodeId)
    });
    if (!compiled.endpoints.size) return { ok: true, endpoints: new Map(), skipped: compiled.skipped };
    // 端口探测与实际编译之间的一致性：探测过的端口必须原样落到配置里。
    for (const [nodeId, endpoint] of compiled.endpoints) {
      if (endpoint.port !== portByNode.get(nodeId)) return { ok: false, error: 'relay_port_mismatch', endpoints: new Map(), skipped: compiled.skipped };
    }

    atomicWritePrivateFile(this.fs, this.path, configPath, `${JSON.stringify(compiled.config, null, 2)}\n`, {});
    // 先 check 再 run：配置被内核拒掉时把它的原话带回去，而不是等进程起来再猜。
    const check = this.spawnSync(binary.path, ['check', '-c', configPath], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (!check || check.status !== 0) {
      return {
        ok: false,
        error: 'relay_config_rejected',
        detail: tail((check && (check.stderr || check.stdout)) || ''),
        endpoints: new Map(),
        skipped: compiled.skipped
      };
    }

    let logFd = null;
    try {
      logFd = this.fs.openSync(logPath, 'a');
      const child = this.spawn(binary.path, ['run', '-c', configPath], {
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        env: this.env
      });
      const ready = await this._waitReady(child, ports);
      if (!ready.ok) {
        await this._kill(child);
        return { ok: false, error: ready.error, detail: this._readLogTail(logPath), endpoints: new Map(), skipped: compiled.skipped };
      }
      this._installExitHook();
      child.once('exit', () => {
        if (this.child === child) {
          this.child = null;
          this.current = null;
        }
      });
      this.child = child;
      this.current = { key, endpoints: compiled.endpoints, configPath, logPath };
      this.portByNode = portByNode;
      return { ok: true, endpoints: compiled.endpoints, skipped: compiled.skipped };
    } catch (error) {
      return { ok: false, error: 'relay_spawn_failed', detail: tail(error.message), endpoints: new Map(), skipped: compiled.skipped };
    } finally {
      if (logFd !== null) {
        try { this.fs.closeSync(logFd); } catch (_closeError) { /* 子进程已持有自己的 fd */ }
      }
    }
  }

  /** 停掉边车（服务端退出 / 手动关闭时调用）。 */
  async stop() {
    await this._stopChild();
    return { ok: true };
  }

  async _stopChild() {
    const child = this.child;
    this.child = null;
    this.current = null;
    if (child) await this._kill(child);
  }

  async _kill(child) {
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = new Promise((resolve) => { child.once('exit', resolve); });
    try { child.kill('SIGTERM'); } catch (_error) { /* 已经退出 */ }
    await Promise.race([exited, delay(this.stopGraceMs)]);
    if (child.exitCode === null && !child.signalCode) {
      try { child.kill('SIGKILL'); } catch (_error) { /* 已经退出 */ }
    }
  }

  /** 端口分配：先复用记下来的（同一节点端口稳定），再从基址往上找空的。 */
  async _resolvePorts(order) {
    const taken = new Set();
    const ports = new Array(order.length).fill(0);
    for (let index = 0; index < order.length; index += 1) {
      const remembered = this.portByNode.get(order[index]);
      if (remembered && !taken.has(remembered) && await this._isPortFree(remembered)) {
        ports[index] = remembered;
        taken.add(remembered);
      }
    }
    let candidate = this.basePort;
    const ceiling = this.basePort + order.length + PORT_PROBE_WINDOW;
    for (let index = 0; index < order.length; index += 1) {
      if (ports[index]) continue;
      while (candidate < ceiling && (taken.has(candidate) || !(await this._isPortFree(candidate)))) candidate += 1;
      if (candidate >= ceiling) return null;
      ports[index] = candidate;
      taken.add(candidate);
      candidate += 1;
    }
    return ports;
  }

  _isPortFree(port) {
    return new Promise((resolve) => {
      const server = this.net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.close(() => resolve(true));
      });
    });
  }

  async _waitReady(child, ports) {
    const deadline = this.now() + this.readinessTimeoutMs;
    while (this.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) return { ok: false, error: 'relay_process_exited' };
      const reachable = await Promise.all(ports.map((port) => this._canConnect(port)));
      if (reachable.every(Boolean)) return { ok: true };
      await delay(80);
    }
    return { ok: false, error: 'relay_readiness_timeout' };
  }

  _canConnect(port) {
    return new Promise((resolve) => {
      const socket = this.net.connect({ host: '127.0.0.1', port });
      const done = (value) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500);
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.once('timeout', () => done(false));
    });
  }

  _readLogTail(logPath) {
    try {
      return tail(this.fs.readFileSync(logPath, 'utf8'));
    } catch (_error) {
      return '';
    }
  }

  // 只要节点集合或「谁要有入口」变了就要重启：只变端口分配不用重启。
  _relayKey(nodes, onlyIds) {
    const ids = onlyIds ? [...onlyIds].sort() : null;
    return JSON.stringify([
      nodes
        .map((node) => [node.id, node.protocol, node.server, node.port, node.chain || ''])
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
      ids
    ]);
  }

  _installExitHook() {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    // 服务端被 SIGKILL 时这个钩子不会跑，边车会活下来占着端口；下次启动探测到端口被占就顺延，
    // 所以不会因此彻底起不来（代价是极端情况下多留一个空闲进程）。
    process.once('exit', () => {
      const child = this.child;
      if (child && child.exitCode === null && !child.signalCode) {
        try { child.kill('SIGKILL'); } catch (_error) { /* 已经退出 */ }
      }
    });
  }
}

let sharedRelay = null;

/** 进程内单例：一个 AIH 只需要一个边车。 */
function getLocalRelay(options = {}) {
  if (!sharedRelay) sharedRelay = new LocalRelay(options);
  return sharedRelay;
}

function resetLocalRelayForTests() {
  sharedRelay = null;
}

module.exports = {
  DEFAULT_READINESS_TIMEOUT_MS,
  LocalRelay,
  getLocalRelay,
  resetLocalRelayForTests
};
