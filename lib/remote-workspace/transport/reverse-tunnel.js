'use strict';

// 反向隧道（C2）：让一台公网可达的远端（如 AWS）能 SSH 回到本机（如 NAT 后面的 Mac），本机零安装。
//
//   AWS（远端）                                   AIH Server（本机，Mac）
//   ssh -p P 127.0.0.1 ══SSH 反向转发（本机发起）══▶ net.connect(127.0.0.1:22) → 本机 sshd
//
// - 本机 AIH Server 在到远端的 SSH 连接上 forwardIn('127.0.0.1', P)：远端只在回环上监听，
//   不开公网端口、不改防火墙；
// - 远端连上 P 的流量被转到本机的 sshd（默认 127.0.0.1:22）。远端仍要过本机 sshd 的认证，
//   隧道本身不授予任何权限；
// - 远端那边把 127.0.0.1:P 登记成「SSH 开发机」，就能用全部远程工作区能力（Work、文件、AI 会话、终端）
//   操作本机目录。
//
// 隧道随连接断开而失效，由 ReverseTunnelSupervisor 负责退避重建。
// 光靠 raw 的 'close' 不够：连接半开（代理 / NAT 静默丢弃）或转发被 sshd 撤销时，
// 状态会停在「open」而远端监听其实已经没了 —— 所以监督者还会定期探活（probe）。

const net = require('node:net');
const { remoteError } = require('../errors');

const DEFAULT_PROBE_INTERVAL_MS = 30000;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
// sshd 对「这个端口已经被自己占着」的第二次 forwardIn 就回这句（已实测）。
const BIND_TAKEN_PATTERN = /unable to bind|already in use|address already in use/i;

class ReverseTunnel {
  /**
   * @param {{ remote: object, remotePort: number, localHost?: string, localPort?: number }} options
   *   remote：到远端的 ssh2 Client（建议独立车道）
   */
  constructor({ remote, remotePort, localHost = '127.0.0.1', localPort = 22 }) {
    this.remote = remote;
    this.remotePort = Number(remotePort);
    this.localHost = localHost;
    this.localPort = Number(localPort);
    this.port = 0;
    this.closed = false;
    this.sockets = new Set();
    this.stats = { connections: 0, failed: 0, rebounds: 0 };
    this.onTcpConnection = (info, accept, reject) => {
      if (!this.port || Number(info.destPort) !== this.port) return; // 别的转发（如出网中继）
      const local = net.connect(this.localPort, this.localHost);
      local.once('connect', () => {
        const channel = accept();
        this.stats.connections += 1;
        this.track(channel);
        this.track(local);
        channel.pipe(local);
        local.pipe(channel);
        const closeBoth = () => {
          try { channel.end(); } catch (_error) { /* gone */ }
          try { local.destroy(); } catch (_error) { /* gone */ }
        };
        channel.once('close', closeBoth);
        local.once('close', closeBoth);
        channel.on('error', closeBoth);
        local.on('error', closeBoth);
      });
      local.once('error', () => {
        if (local.connecting !== false) {
          this.stats.failed += 1;
          try { reject(); } catch (_error) { /* 已处理 */ }
        }
      });
    };
  }

  track(stream) {
    this.sockets.add(stream);
    stream.once('close', () => this.sockets.delete(stream));
  }

  open() {
    if (!Number.isInteger(this.remotePort) || this.remotePort < 1024 || this.remotePort > 65535) {
      return Promise.reject(remoteError('invalid_tunnel_port', '远端端口必须在 1024–65535'));
    }
    return new Promise((resolve, reject) => {
      this.remote.on('tcp connection', this.onTcpConnection);
      this.remote.forwardIn('127.0.0.1', this.remotePort, (error, port) => {
        if (error) {
          this.remote.removeListener('tcp connection', this.onTcpConnection);
          return reject(remoteError('tunnel_forward_refused', '远端拒绝反向转发（端口被占用，或 sshd 不允许 AllowTcpForwarding）', { cause: String(error.message || error) }));
        }
        this.port = Number(port || this.remotePort);
        resolve(this.port);
      });
    });
  }

  /**
   * 探活：再向 sshd 请求一次同一个转发端口。
   *   - 回「Unable to bind」→ 端口还在我们自己手上，转发健康；
   *   - 回成功 → 转发此前已经丢了，这次重新绑上，隧道自愈（计入 stats.rebounds）；
   *   - 其它错误 / 超时 / 连接已断（ssh2 会同步抛 Not connected）→ 隧道不可用。
   * @returns {Promise<void>} 健康时 resolve，不可用时 reject
   */
  probe(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(remoteError('tunnel_closed', '隧道已关闭'));
    if (!this.port) return Promise.reject(remoteError('tunnel_not_open', '隧道尚未建立'));
    const remote = this.remote;
    const wait = Math.max(10, Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(remoteError('probe_timeout', '隧道连接无响应'));
      }, wait);
      if (timer && typeof timer.unref === 'function') timer.unref();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!error) return resolve();
        reject(remoteError('probe_failed', '隧道连接不可用', { cause: String(error.message || error) }));
      };
      try {
        remote.forwardIn('127.0.0.1', this.port, (error) => {
          if (!error) {
            this.stats.rebounds += 1;
            return finish(null);
          }
          if (BIND_TAKEN_PATTERN.test(String(error.message || ''))) return finish(null);
          finish(error);
        });
      } catch (error) {
        finish(error); // 连接已断：ssh2 同步抛 Not connected
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.sockets) { try { stream.destroy ? stream.destroy() : stream.end(); } catch (_error) { /* gone */ } }
    this.sockets.clear();
    try { this.remote.removeListener('tcp connection', this.onTcpConnection); } catch (_error) { /* gone */ }
    if (this.port) {
      const port = this.port;
      this.port = 0;
      try { this.remote.unforwardIn('127.0.0.1', port, () => {}); } catch (_error) { /* 连接已断 */ }
    }
  }
}

const BACKOFF_MS = [2000, 5000, 10000, 30000, 60000];

/**
 * 按连接配置维持反向隧道：连接记录里 reverseTunnel = { remotePort, localPort? } 即开启。
 * 断线后退避重建；配置变化（reconcile）时关旧开新；定期探活，转发丢了就重建。
 */
class ReverseTunnelSupervisor {
  constructor({
    openTunnel,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    setIntervalTimer = setInterval,
    clearIntervalTimer = clearInterval,
    probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    now = Date.now,
    log = () => {}
  }) {
    this.openTunnel = openTunnel; // (connectionId, spec) => Promise<{ tunnel, raw }>
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.setIntervalTimer = setIntervalTimer;
    this.clearIntervalTimer = clearIntervalTimer;
    this.probeIntervalMs = Number(probeIntervalMs) || 0;
    this.probeTimeoutMs = Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS;
    this.now = now;
    this.log = log;
    this.entries = new Map(); // connectionId → { spec, tunnel, timer, probeTimer, attempt, status, error, generation }
  }

  /** 让运行中的隧道与 connections 配置一致。 */
  reconcile(connections) {
    const wanted = new Map();
    for (const connection of Array.isArray(connections) ? connections : []) {
      const spec = connection && connection.reverseTunnel;
      if (spec && Number(spec.remotePort)) wanted.set(connection.id, { remotePort: Number(spec.remotePort), localPort: Number(spec.localPort) || 22 });
    }
    for (const [id, entry] of this.entries) {
      const next = wanted.get(id);
      if (!next || next.remotePort !== entry.spec.remotePort || next.localPort !== entry.spec.localPort) this.stop(id);
    }
    for (const [id, spec] of wanted) if (!this.entries.has(id)) this.start(id, spec);
  }

  start(id, spec) {
    const entry = {
      spec,
      tunnel: null,
      timer: null,
      probeTimer: null,
      probing: false,
      attempt: 0,
      status: 'connecting',
      error: '',
      stopped: false,
      generation: 0,
      openedAt: 0,
      lastProbeAt: 0
    };
    this.entries.set(id, entry);
    this.connect(id, entry);
  }

  async connect(id, entry) {
    if (entry.stopped) return;
    const generation = (entry.generation += 1);
    entry.status = 'connecting';
    try {
      const { tunnel, raw } = await this.openTunnel(id, entry.spec);
      // 建立过程中被停掉 / 又被新的一代接管：关掉这条，别去动新的转发。
      if (entry.stopped || entry.generation !== generation) { tunnel.close(); return; }
      entry.tunnel = tunnel;
      entry.status = 'open';
      entry.error = '';
      entry.attempt = 0;
      entry.openedAt = this.now();
      this.log({ kind: 'reverse_tunnel_open', connectionId: id, remotePort: entry.spec.remotePort, localPort: entry.spec.localPort });
      raw.once('close', () => {
        if (entry.generation !== generation) return; // 旧一代的事件，忽略
        entry.tunnel = null;
        this.stopProbe(entry);
        this.retry(id, entry, 'connection_closed');
      });
      this.startProbe(id, entry);
    } catch (error) {
      if (entry.stopped || entry.generation !== generation) return;
      this.retry(id, entry, String(error && (error.code || error.message) || error));
    }
  }

  startProbe(id, entry) {
    this.stopProbe(entry);
    if (!(this.probeIntervalMs > 0)) return;
    const timer = this.setIntervalTimer(() => { this.check(id, entry); }, this.probeIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    entry.probeTimer = timer;
  }

  stopProbe(entry) {
    if (entry.probeTimer) {
      this.clearIntervalTimer(entry.probeTimer);
      entry.probeTimer = null;
    }
  }

  /**
   * 探活：连不上 / 转发已丢就重建。转发丢了但连接还在的情况（代理静默断流、
   * 旧实例的 unforwardIn 落在共享连接上）只有探活能发现 —— 'close' 不会触发。
   */
  async check(id, entry) {
    if (entry.stopped || !entry.tunnel || entry.probing) return;
    entry.probing = true;
    const tunnel = entry.tunnel;
    const startedAt = this.now();
    const reboundsBefore = tunnel.stats ? tunnel.stats.rebounds : 0;
    try {
      await tunnel.probe(this.probeTimeoutMs);
      entry.lastProbeAt = this.now();
      const rebounds = tunnel.stats ? tunnel.stats.rebounds : 0;
      // 转发丢了但连接还在：这次探活把它重新绑上了，值得单独记一条。
      if (rebounds > reboundsBefore) {
        this.log({ kind: 'reverse_tunnel_probe_rebound', connectionId: id, remotePort: entry.spec.remotePort, rebounds });
      }
      this.log({
        kind: 'reverse_tunnel_probe',
        connectionId: id,
        remotePort: entry.spec.remotePort,
        ok: true,
        durationMs: this.now() - startedAt,
        rebounds
      });
    } catch (error) {
      if (entry.stopped || entry.tunnel !== tunnel) return;
      const reason = String(error && (error.code || error.message) || error);
      this.log({ kind: 'reverse_tunnel_dead', connectionId: id, reason });
      this.stopProbe(entry);
      entry.tunnel = null;
      try { tunnel.close(); } catch (_error) { /* gone */ }
      this.retry(id, entry, reason);
    } finally {
      entry.probing = false;
    }
  }

  retry(id, entry, reason) {
    if (entry.stopped) return;
    entry.status = 'retrying';
    entry.error = reason;
    entry.generation += 1; // 旧一代的迟到事件不再生效
    this.stopProbe(entry);
    const delay = BACKOFF_MS[Math.min(entry.attempt, BACKOFF_MS.length - 1)];
    entry.attempt += 1;
    this.log({ kind: 'reverse_tunnel_retry', connectionId: id, reason, delayMs: delay });
    entry.timer = this.setTimer(() => { entry.timer = null; this.connect(id, entry); }, delay);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  stop(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.stopped = true;
    entry.generation += 1;
    if (entry.timer) this.clearTimer(entry.timer);
    this.stopProbe(entry);
    if (entry.tunnel) entry.tunnel.close();
    this.entries.delete(id);
  }

  status() {
    return [...this.entries].map(([connectionId, entry]) => ({
      connectionId,
      remotePort: entry.spec.remotePort,
      localPort: entry.spec.localPort,
      status: entry.status,
      error: entry.error,
      connections: entry.tunnel ? entry.tunnel.stats.connections : 0,
      rebounds: entry.tunnel ? entry.tunnel.stats.rebounds : 0,
      openedAt: entry.openedAt || 0,
      lastProbeAt: entry.lastProbeAt || 0
    }));
  }

  close() {
    for (const id of [...this.entries.keys()]) this.stop(id);
  }
}

module.exports = {
  BIND_TAKEN_PATTERN,
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  ReverseTunnel,
  ReverseTunnelSupervisor
};
