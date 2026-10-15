'use strict';

const nativeFs = require('node:fs');
const nativeNet = require('node:net');
const nativePath = require('node:path');
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require('node:child_process');

const { atomicWritePrivateFile } = require('../../proxy-pool/secure-file-io');
const { resolveProxyPoolAiHome } = require('../../proxy-pool/aih-home');

/**
 * 一个内核的边车进程（sing-box 或 mihomo；内核差异全在描述符里，见 kernels/）。
 *
 * 三条硬约束：
 * 1. **默认只监听 127.0.0.1**。客户端在别的机器上时（手机 / 另一台电脑）必须绑可达地址，此时
 *    **必须有认证**（见 relay-credentials），否则等于在公网开一个无认证代理。
 * 2. **fail-closed** —— 内核找不到、配置被拒、端口起不来，一律返回失败并且**不输出本地入口**；
 *    调用方于是退回「跳过这些节点」，绝不会出现「端口没起来、客户端却以为能用」的情况。
 * 3. **不自动下载内核** —— 找不到就让用户自己装（见 kernel-binary）。
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

/** 回环地址（含 localhost 与整个 127/8）—— 只有这种情况允许不认证。 */
function isLoopbackHost(host) {
  const text = String(host || '').trim().toLowerCase();
  if (!text) return false;
  if (text === 'localhost' || text === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(text);
}

class KernelSidecar {
  constructor(options = {}) {
    if (!options.kernel) throw new Error('relay_kernel_required');
    this.kernel = options.kernel;
    this.fs = options.fs || nativeFs;
    this.net = options.net || nativeNet;
    this.path = options.path || nativePath;
    this.spawn = options.spawn || nodeSpawn;
    this.spawnSync = options.spawnSync || nodeSpawnSync;
    this.env = options.env || process.env;
    this.now = options.now || (() => Date.now());
    this.aiHomeDir = options.aiHomeDir || resolveProxyPoolAiHome({ aiHomeDir: options.aiHomeDir, env: this.env });
    this.runDir = options.runDir
      || this.path.join(this.aiHomeDir, 'run', 'subscription-relay', this.kernel.id);
    // AIH_RELAY_LISTEN_HOST 是运维口子：显式钉住绑定地址（例如只绑内网网卡）。
    this.listenHostOverride = String(options.listenHost || this.env.AIH_RELAY_LISTEN_HOST || '').trim();
    this.basePort = Number(options.basePort || this.kernel.basePort);
    this.maxPorts = Number(options.maxPorts || this.kernel.maxPorts);
    this.readinessTimeoutMs = Number(options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
    this.stopGraceMs = Number(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS);
    this.auth = options.auth || null;
    // 一旦有远端客户端用过，就保持「暴露 + 认证」形态：来回切形态会让边车反复重启。
    this.exposed = options.exposed === true;
    this.portByNode = new Map();
    this.binary = undefined;
    this.child = null;
    this.current = null;
    this.inFlight = null;
    this.exitHookInstalled = false;
  }

  /** 解析内核（命中缓存；**失败不缓存**，装了内核后下一次拉取就能用，不必重启服务）。 */
  resolveBinary() {
    if (this.binary) return this.binary;
    const resolved = this.kernel.resolveBinary({
      fs: this.fs, path: this.path, env: this.env, aiHomeDir: this.aiHomeDir
    });
    if (!resolved) {
      // 故意不记住「找不到」：用户把内核装进 ~/.ai_home/bin 之后，下一次拉订阅就该能用。
      // 代价是没装内核时每次都要再查一遍（几次 statSync + 一次 PATH 扫描）。
      return null;
    }
    const probe = this.spawnSync(resolved.path, [...this.kernel.versionArgs], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    this.binary = { ...resolved, version: probe && probe.status === 0 ? this.kernel.parseVersion(probe.stdout) : '' };
    return this.binary;
  }

  /** 供界面显示：这个内核能不能用、在哪、版本多少。不启动任何进程。 */
  availability() {
    const binary = this.resolveBinary();
    const running = Boolean(this.child && this.child.exitCode === null);
    const base = {
      id: this.kernel.id,
      label: this.kernel.label,
      envVar: this.kernel.envVar,
      basePort: this.basePort,
      maxPorts: this.maxPorts,
      portRange: `${this.basePort}-${this.basePort + this.maxPorts - 1}`,
      listenHost: running ? this.current.listenHost : '',
      authRequired: Boolean(running && this.current.auth),
      running,
      nodes: running && this.current ? this.current.endpoints.size : 0
    };
    if (!binary) return { ...base, available: false, binary: '', source: '', version: '', error: 'relay_binary_not_found' };
    return {
      ...base,
      available: true,
      binary: binary.path,
      source: binary.source,
      version: binary.version || '',
      error: ''
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

  /** 当前实际绑定的地址；没在跑返回 ''。远端请求要靠它判断「入口是不是可达」。 */
  activeListenHost() {
    if (!this.child || this.child.exitCode !== null) return '';
    return this.current ? this.current.listenHost : '';
  }

  /**
   * 确保边车在跑，并且覆盖 nodes 这批节点。
   * options.onlyIds 限定「谁要有本地入口」（其余只作为链上前置参与编译，见 relay-batch）。
   * options.remote 表示这次是给别的机器上的客户端用：绑定地址升级为可达地址并要求认证。
   * options.auth 是认证凭据（manager 统一持有，两个内核共用一份）。
   * → { ok, endpoints: Map<nodeId,{host,port,udp}>, skipped, error?, detail? }
   */
  async ensure(nodes, options = {}) {
    const binary = this.resolveBinary();
    if (!binary) return { ok: false, error: 'relay_binary_not_found', endpoints: new Map(), skipped: [] };
    const wanted = Array.isArray(nodes) ? nodes.filter((node) => node && node.id) : [];
    if (!wanted.length) return { ok: true, endpoints: new Map(), skipped: [] };
    if (options.remote === true) this.exposed = true;
    if (options.auth) this.auth = options.auth;
    const listenHost = this.listenHostOverride || (this.exposed ? '0.0.0.0' : '127.0.0.1');
    const auth = isLoopbackHost(listenHost) ? null : this.auth;
    if (!isLoopbackHost(listenHost) && !auth) {
      // 宁可不起，也不在公网开无认证代理。
      return { ok: false, error: 'relay_auth_required', endpoints: new Map(), skipped: [] };
    }
    const onlyIds = options.onlyIds instanceof Set ? options.onlyIds : null;
    const compileOptions = { version: binary.version || undefined, onlyIds, listenHost, auth, maxPorts: this.maxPorts };

    // 第一遍：只为拿到「哪些节点要有入口、按什么顺序」。
    const shape = this.kernel.compileText(wanted, { ...compileOptions, assignPort: () => 0 });
    const order = [...shape.endpoints.keys()];
    if (!order.length) return { ok: true, endpoints: new Map(), skipped: shape.skipped };

    const key = this._relayKey(wanted, { onlyIds, listenHost, auth });
    if (this.child && this.child.exitCode === null && this.current && this.current.key === key) {
      return { ok: true, endpoints: this.current.endpoints, skipped: shape.skipped };
    }
    // 同一批节点并发拉订阅时合并成一次重启。
    if (!this.inFlight) {
      this.inFlight = this._restart(binary, wanted, key, compileOptions)
        .finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  async _restart(binary, wanted, key, compileOptions) {
    await this._stopChild();
    let nodes = wanted;
    let droppedSkipped = [];
    // 两轮：第一轮按原样；只有「内核构建相关」的协议被内核拒掉时才去掉它们重试一次。
    for (let round = 0; round < 2; round += 1) {
      const shape = this.kernel.compileText(nodes, { ...compileOptions, assignPort: () => 0 });
      const order = [...shape.endpoints.keys()];
      if (!order.length) return { ok: true, endpoints: new Map(), skipped: [...droppedSkipped, ...shape.skipped] };
      const ports = await this._resolvePorts(order);
      if (!ports) return { ok: false, error: 'relay_port_unavailable', endpoints: new Map(), skipped: shape.skipped };
      const portByNode = new Map(order.map((nodeId, index) => [nodeId, ports[index]]));

      const configFile = this.path.join(this.runDir, this.kernel.configFileName);
      const logFile = this.path.join(this.runDir, `${this.kernel.id}.log`);
      const compiled = this.kernel.compileText(nodes, {
        ...compileOptions,
        assignPort: (nodeId) => portByNode.get(nodeId),
        logPath: logFile
      });
      if (!compiled.endpoints.size) {
        return { ok: true, endpoints: new Map(), skipped: [...droppedSkipped, ...compiled.skipped] };
      }
      // 端口探测与实际编译之间的一致性：探测过的端口必须原样落到配置里。
      for (const [nodeId, endpoint] of compiled.endpoints) {
        if (endpoint.port !== portByNode.get(nodeId)) {
          return { ok: false, error: 'relay_port_mismatch', endpoints: new Map(), skipped: compiled.skipped };
        }
      }
      atomicWritePrivateFile(this.fs, this.path, configFile, compiled.text, {});
      // 先 check 再 run：配置被内核拒掉时把它的原话带回去，而不是等进程起来再猜。
      const check = this.spawnSync(binary.path, this.kernel.checkArgs(configFile, this.runDir), {
        encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: this.runDir
      });
      if (!check || check.status !== 0) {
        const detail = tail((check && (check.stderr || check.stdout)) || '');
        // 内核构建差异（例如没有 libcronet 的 sing-box 不认 naive）：去掉这些节点重试一次，
        // 不让整批节点陪葬；其余情况就是真失败，照原话报给用户。
        const droppable = round === 0
          ? nodes.filter((node) => this.kernel.buildDependentProtocols.includes(String(node.protocol || '').toLowerCase()))
          : [];
        if (!droppable.length) {
          return { ok: false, error: 'relay_config_rejected', detail, endpoints: new Map(), skipped: compiled.skipped };
        }
        droppedSkipped = [...droppedSkipped, ...droppable.map((node) => ({
          nodeId: node.id,
          reason: `relay_kernel_unsupported_${String(node.protocol || '').toLowerCase()}`
        }))];
        nodes = nodes.filter((node) => !droppable.includes(node));
        continue;
      }
      return this._launch(binary, compiled, key, portByNode, ports, droppedSkipped, compileOptions, configFile, logFile);
    }
    return { ok: false, error: 'relay_config_rejected', endpoints: new Map(), skipped: droppedSkipped };
  }

  /** 配置已通过内核校验：拉起进程并等端口探活成功。 */
  async _launch(binary, compiled, key, portByNode, ports, droppedSkipped, compileOptions, configFile, logFile) {
    let logFd = null;
    try {
      logFd = this.fs.openSync(logFile, 'a');
      const child = this.spawn(binary.path, this.kernel.runArgs(configFile, this.runDir), {
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
        cwd: this.runDir,
        env: this.env
      });
      const ready = await this._waitReady(child, ports, compileOptions.listenHost);
      if (!ready.ok) {
        await this._kill(child);
        return {
          ok: false,
          error: ready.error,
          detail: this._readLogTail(logFile),
          endpoints: new Map(),
          skipped: compiled.skipped
        };
      }
      this._installExitHook();
      child.once('exit', () => {
        if (this.child === child) {
          this.child = null;
          this.current = null;
        }
      });
      // 入口要认证时把凭据挂到入口上：客户端配置里的 socks5 条目需要它（见 relay-credentials）。
      const endpoints = compileOptions.auth
        ? new Map([...compiled.endpoints].map(([nodeId, endpoint]) => [nodeId, {
          ...endpoint,
          username: compileOptions.auth.username,
          password: compileOptions.auth.password
        }]))
        : compiled.endpoints;
      this.child = child;
      this.current = {
        key,
        endpoints,
        configFile,
        logFile,
        listenHost: compileOptions.listenHost,
        auth: compileOptions.auth
      };
      this.portByNode = portByNode;
      return { ok: true, endpoints, skipped: [...droppedSkipped, ...compiled.skipped] };
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

  /** 端口是否空闲：按边车将绑定的地址试听（0.0.0.0 与 127.0.0.1 的占用情况不同）。 */
  _isPortFree(port) {
    const host = this.listenHostOverride || (this.exposed ? '0.0.0.0' : '127.0.0.1');
    return new Promise((resolve) => {
      const server = this.net.createServer();
      server.unref();
      server.once('error', () => resolve(false));
      server.listen({ host, port, exclusive: true }, () => {
        server.close(() => resolve(true));
      });
    });
  }

  async _waitReady(child, ports, listenHost) {
    // 绑 0.0.0.0 时用 127.0.0.1 探活；绑具体地址（含 IPv6）时按原地址探。
    const host = !listenHost || listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost;
    const deadline = this.now() + this.readinessTimeoutMs;
    while (this.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) return { ok: false, error: 'relay_process_exited' };
      const reachable = await Promise.all(ports.map((port) => this._canConnect(host, port)));
      if (reachable.every(Boolean)) return { ok: true };
      await delay(80);
    }
    return { ok: false, error: 'relay_readiness_timeout' };
  }

  _canConnect(host, port) {
    return new Promise((resolve) => {
      const socket = this.net.connect({ host, port });
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

  _readLogTail(logFile) {
    try {
      return tail(this.fs.readFileSync(logFile, 'utf8'));
    } catch (_error) {
      return '';
    }
  }

  // 只要节点集合、入口子集、绑定地址或凭据变了就要重启：只变端口分配不用重启。
  _relayKey(nodes, { onlyIds, listenHost, auth }) {
    const ids = onlyIds ? [...onlyIds].sort() : null;
    return JSON.stringify([
      this.kernel.id,
      nodes
        .map((node) => [node.id, node.protocol, node.server, node.port, node.chain || ''])
        .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
      ids,
      listenHost,
      auth ? auth.username : ''
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

module.exports = {
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_STOP_GRACE_MS,
  KernelSidecar,
  isLoopbackHost
};
