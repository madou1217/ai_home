'use strict';

const nativeFs = require('node:fs');
const nativeNet = require('node:net');
const nativePath = require('node:path');
const { spawn: nodeSpawn, spawnSync: nodeSpawnSync } = require('node:child_process');

const { resolveProxyPoolAiHome } = require('../../proxy-pool/aih-home');
const { KERNELS, splitByKernel } = require('./kernels');
const { KernelSidecar, isLoopbackHost } = require('./kernel-sidecar');
const { resolveRelayCredentials } = require('./relay-credentials');

/**
 * 本机中转的门面（进程内单例）：把「目标格式表达不了」的节点包成本地代理入口。
 *
 * 一台 AIH 最多两个边车进程，各自一个内核：
 * - sing-box：默认内核，覆盖最广（含 naive）；
 * - mihomo：补 sing-box 编不出来的（xhttp 传输、VLESS Encryption、ShadowsocksR、Mieru）。
 * 节点按「链」分组后逐个挑能编出它的内核（见 kernels/index），所以一份订阅里混杂的协议都能包。
 *
 * 入口地址与可达性：
 * - 客户端在本机（回环请求）→ 绑 127.0.0.1、入口写 127.0.0.1，不需要认证；
 * - 客户端在别的机器上（手机 / 另一台电脑 / 公网）→ 绑 0.0.0.0 并要求认证，入口写**客户端用的那个
 *   Host**（它一定是客户端能连到的地址）。运维可用 AIH_RELAY_LISTEN_HOST 钉住绑定网卡。
 * 一旦有远端客户端用过，就保持「暴露 + 认证」形态，避免同一份订阅在本机/远端之间来回重启边车。
 *
 * 三条硬约束（继承自边车）：fail-closed、不自动下载内核、只把本地入口交给「内核真编得出来」的节点。
 */

class LocalRelay {
  constructor(options = {}) {
    this.fs = options.fs || nativeFs;
    this.net = options.net || nativeNet;
    this.path = options.path || nativePath;
    this.env = options.env || process.env;
    this.aiHomeDir = options.aiHomeDir || resolveProxyPoolAiHome({ aiHomeDir: options.aiHomeDir, env: this.env });
    this.runDir = options.runDir || this.path.join(this.aiHomeDir, 'run', 'subscription-relay');
    this.exposed = options.exposed === true;
    this.credentialsValue = options.credentials || null;
    const sidecarOptions = {
      fs: this.fs,
      net: this.net,
      path: this.path,
      spawn: options.spawn || nodeSpawn,
      spawnSync: options.spawnSync || nodeSpawnSync,
      env: this.env,
      now: options.now,
      aiHomeDir: this.aiHomeDir,
      basePort: options.basePort,
      maxPorts: options.maxPorts,
      listenHost: options.listenHost,
      readinessTimeoutMs: options.readinessTimeoutMs,
      stopGraceMs: options.stopGraceMs
    };
    this.sidecars = new Map(KERNELS.map((kernel) => [kernel.id, new KernelSidecar({
      ...sidecarOptions,
      kernel,
      runDir: this.path.join(this.runDir, kernel.id),
      exposed: this.exposed
    })]));
  }

  sidecar(kernelId) {
    return this.sidecars.get(kernelId) || null;
  }

  /** 认证凭据（懒生成，落盘 0600）。只有暴露形态才需要，见 relay-credentials。 */
  credentials() {
    if (!this.credentialsValue) {
      this.credentialsValue = resolveRelayCredentials({
        fs: this.fs, path: this.path, runDir: this.runDir, env: this.env
      });
    }
    return this.credentialsValue;
  }

  /** 供界面显示：哪些内核能用、在哪、版本多少、边车在不在跑、端口段是多少。不启动任何进程。 */
  availability() {
    const kernels = [...this.sidecars.values()].map((sidecar) => sidecar.availability());
    const available = kernels.filter((kernel) => kernel.available);
    const running = kernels.filter((kernel) => kernel.running);
    const preferred = available[0] || kernels[0];
    const basePort = Math.min(...kernels.map((kernel) => kernel.basePort));
    const maxPort = Math.max(...kernels.map((kernel) => kernel.basePort + kernel.maxPorts - 1));
    return {
      available: available.length > 0,
      binary: preferred.binary,
      source: preferred.source,
      version: preferred.version,
      running: running.length > 0,
      nodes: running.reduce((sum, kernel) => sum + kernel.nodes, 0),
      basePort,
      maxPort,
      portRange: `${basePort}-${maxPort}`,
      listenHost: running.length ? running[0].listenHost : '',
      authRequired: running.some((kernel) => kernel.authRequired),
      kernels,
      error: available.length ? '' : 'relay_binary_not_found'
    };
  }

  /** 当前生效的全部本地入口（两个内核合并）。没在跑就是空表。 */
  activeEndpoints() {
    const merged = new Map();
    for (const sidecar of this.sidecars.values()) {
      for (const [nodeId, endpoint] of sidecar.activeEndpoints()) merged.set(nodeId, endpoint);
    }
    return merged;
  }

  /** 当前实际绑定的地址；没在跑返回 ''。远端请求靠它判断「入口是不是可达」。 */
  activeListenHost() {
    for (const sidecar of this.sidecars.values()) {
      const host = sidecar.activeListenHost();
      if (host) return host;
    }
    return '';
  }

  /** 是否处于「对外暴露」形态（绑非回环地址 + 认证）。 */
  isExposed() {
    const host = this.activeListenHost();
    return Boolean(host) && !isLoopbackHost(host);
  }

  /**
   * 确保中转在跑，并覆盖 nodes 这批节点。
   * options.onlyIds 限定「谁要有本地入口」；options.remote 表示客户端在别的机器上。
   * → { ok, endpoints, skipped, error?, detail?, errors?: [{kernelId, error}] }
   */
  async ensure(nodes, options = {}) {
    const remote = options.remote === true;
    if (remote) this.exposed = true;
    for (const sidecar of this.sidecars.values()) if (this.exposed) sidecar.exposed = true;
    const auth = this.exposed ? this.credentials() : null;
    const groups = splitByKernel(nodes, { onlyIds: options.onlyIds });
    if (!groups.length) return { ok: true, endpoints: new Map(), skipped: [], errors: [] };
    const results = await Promise.all(groups.map(({ kernel, nodes: list }) => this.sidecar(kernel.id)
      .ensure(list, { ...options, remote, auth })));
    const endpoints = new Map();
    const skipped = [];
    const errors = [];
    for (const [index, result] of results.entries()) {
      for (const [nodeId, endpoint] of result.endpoints) endpoints.set(nodeId, endpoint);
      skipped.push(...(result.skipped || []));
      if (result.ok !== true) {
        errors.push({ kernelId: groups[index].kernel.id, error: result.error || 'relay_failed', detail: result.detail || '' });
      }
    }
    // 一个内核起不来不该毁掉另一个内核的入口：只要还有入口可用就算可用，错误照样带回去。
    return {
      ok: endpoints.size > 0 || errors.length === 0,
      endpoints,
      skipped,
      errors,
      error: errors.length ? errors[0].error : '',
      detail: errors.length ? errors[0].detail : ''
    };
  }

  /** 停掉全部边车（服务端退出 / 手动关闭时调用）。 */
  async stop() {
    await Promise.all([...this.sidecars.values()].map((sidecar) => sidecar.stop()));
    return { ok: true };
  }
}

let sharedRelay = null;

/** 进程内单例：一个 AIH 只需要一组边车。 */
function getLocalRelay(options = {}) {
  if (!sharedRelay) sharedRelay = new LocalRelay(options);
  return sharedRelay;
}

function resetLocalRelayForTests() {
  sharedRelay = null;
}

module.exports = {
  LocalRelay,
  getLocalRelay,
  resetLocalRelayForTests
};
