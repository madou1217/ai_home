'use strict';

// 出口池运行时：起一个只监听回环的 mihomo 子进程，把代理池节点变成一个本地
// HTTP 出站端口，供账号出口绑定消费（`url` 模式指向 127.0.0.1:<mixedPort>）。
//
// 为什么需要它（2026-10-17 实测，排障必读）：
//   - 免费档（opencode Zen `-free`）按**出口 IP** 限流，一个 IP 用满就 429；
//     用户的聚合订阅里有很多出口，轮换即可恢复 —— 这是本模块存在的理由。
//   - 用户可能开着 Surge/Clash 的 **TUN 全局接管**。此时内核直连节点会超时
//     （实测 `context deadline exceeded`），而 `nc` 直连同一 IP 可达 ——
//     差异就在 TUN 劫持了内核的出站。**必须把出站绑到物理网卡**（interface-name）
//     才能绕过：实测不绑网卡 000、绑网卡 200，因此绑网卡是必需而非可选。
//   - TUN 还会让系统 DNS 返回 fake-ip（198.18.x.x）。内核因此内置 DoH，
//     节点域名可直接写，无需预解析真实 IP（实测 200）。
//
// 边界（硬约束）：只开回环端口，不写 tun 段、不改系统代理、不碰宿主网络配置。
// 用户电脑的网络行为完全不受影响 —— 这是「不改变用户环境」原则的落点。

const childProcess = require('node:child_process');
const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const { resolveMihomoCorePath } = require('./egress-pool-core-resolver');
const {
  buildEgressPoolConfig,
  EGRESS_POOL_BIND_HOST,
  EGRESS_POOL_PROBE_GROUP,
  laneGroupName
} = require('./egress-pool-config');
const { lookupExitGeo } = require('./egress-geo');
const poolStateFile = require('./egress-pool-state-file');
const { EgressPoolNodeHealth } = require('./egress-pool-node-health');
const { DEFAULT_PROXY_PROBE_URL } = require('./egress-pool-probe-target');
const {
  EGRESS_POOL_NODE_GEO_TTL_MS,
  EGRESS_POOL_PROBE_INTERVAL_MS,
  EGRESS_POOL_PROBE_TIMEOUT_MS,
  EGRESS_POOL_UPSTREAM_PROBE_TIMEOUT_MS
} = require('../cli/config/constants');

// 内核冷启动（读配置 + 建 DoH 连接池）实测约 1-3s；给足余量但不无限等。
const STARTUP_TIMEOUT_MS = 15000;
const STARTUP_POLL_INTERVAL_MS = 200;
// 切换节点后上游需要重建连接，给一点稳定时间再判定。
const SWITCH_SETTLE_MS = 120;
// 控制端口请求超时：切换节点是本地回环调用，正常在毫秒级。
const CONTROLLER_TIMEOUT_MS = 5000;
// 回收自己的孤儿内核后，等它释放端口的上限。
const REAP_TIMEOUT_MS = 3000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 经指定 HTTP 代理发一次请求的默认实现：每次新建 ProxyAgent、读完即关。
 * 不复用连接是刻意的 —— 探测入站切换节点后，复用的 CONNECT 隧道仍连着上一个节点。
 * 返回一个只含 ok/status/headers/text() 的响应对象（正文已读完）。
 */
function defaultProxyFetch(proxyUrl, url, init = {}) {
  // eslint-disable-next-line global-require
  const { tryRequireProxyAgent } = require('../server/http-utils-utils');
  const ProxyAgent = tryRequireProxyAgent();
  if (!ProxyAgent) return Promise.reject(Object.assign(new Error('proxy_agent_unavailable'), { code: 'proxy_agent_unavailable' }));
  const agent = new ProxyAgent(proxyUrl);
  return fetch(url, { ...init, dispatcher: agent })
    .then(async (res) => {
      const text = await res.text().catch(() => '');
      return { ok: res.ok, status: res.status, headers: res.headers, text: async () => text };
    })
    .finally(() => { agent.close().catch(() => {}); });
}

/** 分配一个空闲的回环端口（内核默认端口段，避开常见冲突）。 */
function pickPort(seed) {
  const base = 20000 + (Number(seed) % 1000) * 2;
  return base;
}

/**
 * 出口池运行时。
 *
 * 生命周期：start() → 就绪后 proxyUrl 可用 → stop() 收尾。
 * 未 start 或启动失败时 proxyUrl 为 ''，调用方据此 fail-closed。
 */
class EgressPoolRuntime {
  constructor(options = {}) {
    this.options = options;
    this.fs = options.fs || nodeFs;
    this.path = options.path || nodePath;
    this.os = options.os || nodeOs;
    this.env = options.env || process.env || {};
    this.spawn = options.spawn || childProcess.spawn;
    this.fetchImpl = options.fetch || fetch;
    this.aiHomeDir = normalizeString(options.aiHomeDir);
    this.nodes = Array.isArray(options.nodes) ? options.nodes : [];
    this.mixedPort = Number(options.mixedPort) || pickPort(1);
    this.controllerPort = Number(options.controllerPort) || this.mixedPort + 1;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.processObj = options.processObj || process;
    this.isPidAlive = typeof options.isPidAlive === 'function'
      ? options.isPidAlive
      : (pid) => poolStateFile.isPidAlive(pid, this.processObj);
    this.reapTimeoutMs = Number(options.reapTimeoutMs) > 0 ? Number(options.reapTimeoutMs) : REAP_TIMEOUT_MS;

    this.child = null;
    // 启动代次：stop() 每次 +1。start() 在每个 await 之后核对代次，stop 抢在中途时
    // 立即放弃（已 spawn 的子进程当场结束），不会留下一个没人跟踪的内核。
    this.generation = 0;
    this.stateFileWritten = false;
    // 子进程是否仍存活：就绪判定必须同时满足「控制端口应答」与「我们起的那个进程还活着」，
    // 否则上次崩溃遗留的孤儿内核占着同一端口时，会被误认作本次启动成功（见 waitForReady）。
    this.childAlive = false;
    this.controllerSecret = '';
    this.started = false;
    this.nodeNames = [];
    this.activeNodeIndex = 0;
    this.workDir = '';
    this.lastError = '';
    // 可注入：测试里把启动超时压到毫秒级，避免「内核不就绪」的用例空等 15s。
    this.startupTimeoutMs = Number(options.startupTimeoutMs) > 0
      ? Number(options.startupTimeoutMs)
      : STARTUP_TIMEOUT_MS;
    this.startupPollIntervalMs = Number(options.startupPollIntervalMs) > 0
      ? Number(options.startupPollIntervalMs)
      : STARTUP_POLL_INTERVAL_MS;
    this.switchSettleMs = Number.isFinite(Number(options.switchSettleMs))
      ? Math.max(0, Number(options.switchSettleMs))
      : SWITCH_SETTLE_MS;
    // 节点账本（冷却 / 统计 / 事件流，见 egress-pool-node-health）。可注入：测试用内存账本。
    this.health = options.health || new EgressPoolNodeHealth({
      fs: this.fs, path: this.path, aiHomeDir: this.aiHomeDir, now: options.now
    });
    // 恢复探测：经内核的 /proxies/<name>/delay 探一个中性地址，不切换出站、不影响在途请求。
    this.probeIntervalMs = Number(options.probeIntervalMs) >= 0 && options.probeIntervalMs !== undefined
      ? Number(options.probeIntervalMs)
      : EGRESS_POOL_PROBE_INTERVAL_MS;
    this.probeTimeoutMs = Number(options.probeTimeoutMs) > 0 ? Number(options.probeTimeoutMs) : EGRESS_POOL_PROBE_TIMEOUT_MS;
    this.probeUrl = normalizeString(options.probeUrl) || DEFAULT_PROXY_PROBE_URL;
    this.probeTimer = null;
    this.probing = false;
    // 车道与探测入站（见 egress-pool-config）。端口由服务分配；未给 = 不开（单出口旧行为）。
    this.probePort = Number(options.probePort) || 0;
    this.lanes = (Array.isArray(options.lanePorts) ? options.lanePorts : [])
      .map(Number).filter((port) => Number.isInteger(port) && port > 0)
      .map((port, index) => emptyLane(index, port));
    this.accountLane = new Map();
    this.laneOverflow = [];
    this.overflowAccounts = new Set();
    this.proxyFetch = typeof options.proxyFetch === 'function' ? options.proxyFetch : defaultProxyFetch;
    this.probeQueue = Promise.resolve();
    this.geoTtlMs = Number(options.geoTtlMs) > 0 ? Number(options.geoTtlMs) : EGRESS_POOL_NODE_GEO_TTL_MS;
    this.upstreamProbeTimeoutMs = Number(options.upstreamProbeTimeoutMs) > 0
      ? Number(options.upstreamProbeTimeoutMs)
      : EGRESS_POOL_UPSTREAM_PROBE_TIMEOUT_MS;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
  }

  /** 本地出站代理地址；未就绪时返回 ''（调用方 fail-closed）。 */
  get proxyUrl() {
    return this.started ? `http://${EGRESS_POOL_BIND_HOST}:${this.mixedPort}` : '';
  }

  get ready() {
    return this.started;
  }

  get status() {
    return {
      ready: this.started,
      proxyUrl: this.proxyUrl,
      nodeCount: this.nodeNames.length,
      activeNodeIndex: this.activeNodeIndex,
      activeNode: this.nodeNames[this.activeNodeIndex] || '',
      workDir: this.workDir,
      lastError: this.lastError,
      coolingCount: this.nodeNames.filter((name) => this.health.isCooling(name)).length,
      probeIntervalMs: this.probeIntervalMs,
      probePort: this.probePort,
      laneSlots: this.lanes.length,
      lanes: this.describeLanes(),
      laneOverflow: this.laneOverflow.slice()
    };
  }

  describeLanes() {
    return this.lanes.filter((lane) => lane.key).map((lane) => ({
      index: lane.index,
      key: lane.key,
      proxyUrl: this.started ? laneUrl(lane) : '',
      activeNode: lane.active,
      allowedCount: lane.allowed ? this.nodeNames.filter((name) => lane.allowed.has(name)).length : this.nodeNames.length,
      accounts: lane.accounts.slice(),
      strategy: lane.strategy,
      upstream: lane.upstream,
      blocked: lane.blocked
    }));
  }

  /** 节点账本快照（WebUI 出口池面板用）。 */
  healthSnapshot() {
    return this.health.snapshot();
  }

  /**
   * 启动内核。返回 { ok, proxyUrl, nodeCount } 或 { ok:false, error }。
   * 任何失败都只记录、不抛 —— 出口池是增强能力，缺内核不该影响其它 provider。
   */
  async start() {
    if (this.started) return { ok: true, proxyUrl: this.proxyUrl, nodeCount: this.nodeNames.length };
    if (this.nodes.length === 0) {
      this.lastError = 'egress_pool_no_nodes';
      return { ok: false, error: this.lastError };
    }
    const core = resolveMihomoCorePath({
      fs: this.fs, path: this.path, env: this.env, aiHomeDir: this.aiHomeDir
    });
    if (!core) {
      this.lastError = 'egress_pool_core_not_found';
      return { ok: false, error: this.lastError };
    }

    const generation = this.generation;
    const stoppedMeanwhile = () => {
      if (generation === this.generation) return false;
      this.lastError = 'egress_pool_stopped_during_start';
      return true;
    };

    // 上次 server 硬崩溃留下的**自己的**孤儿内核：凭运行文件里的密钥验明正身后回收。
    await this.reapOwnOrphan();
    if (stoppedMeanwhile()) return { ok: false, error: this.lastError };

    // 端口仍被占用（无法证明是自己的孤儿，或回收失败）：不起新进程。
    // 新进程会因端口冲突起不来，而孤儿仍会应答控制端口，最终把孤儿的旧配置当成本次的池。
    const portBusy = await this.controllerPortAnswers();
    if (stoppedMeanwhile()) return { ok: false, error: this.lastError };
    if (portBusy) {
      this.lastError = 'egress_pool_controller_port_in_use';
      return { ok: false, error: this.lastError };
    }

    // 每次启动换一把控制端口密钥：只有本进程知道，孤儿/他人进程无法冒充。
    this.controllerSecret = nodeCrypto.randomBytes(24).toString('hex');

    let built;
    try {
      built = buildEgressPoolConfig({
        nodes: this.nodes,
        mixedPort: this.mixedPort,
        controllerPort: this.controllerPort,
        secret: this.controllerSecret,
        networkInterfaces: this.options.networkInterfaces || this.os.networkInterfaces,
        probePort: this.probePort,
        lanePorts: this.lanes.map((lane) => lane.port)
      });
    } catch (error) {
      this.lastError = `egress_pool_config_failed:${normalizeString(error && error.message)}`;
      return { ok: false, error: this.lastError };
    }

    this.workDir = poolStateFile.egressPoolWorkDir(this.aiHomeDir, this.path);
    try {
      // 配置里有全部节点的服务器与密码/UUID，以及控制端口密钥：目录 0700、文件 0600。
      // writeFileSync 的 mode 只在新建时生效，已存在的文件再显式 chmod 一次。
      this.fs.mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
      if (typeof this.fs.chmodSync === 'function') this.fs.chmodSync(this.workDir, 0o700);
      const configPath = this.path.join(this.workDir, 'config.json');
      this.fs.writeFileSync(configPath, JSON.stringify(built.config, null, 1), { mode: 0o600 });
      if (typeof this.fs.chmodSync === 'function') this.fs.chmodSync(configPath, 0o600);
    } catch (error) {
      this.lastError = `egress_pool_workdir_failed:${normalizeString(error && error.message)}`;
      return { ok: false, error: this.lastError };
    }

    try {
      this.child = this.spawn(core.path, ['-d', this.workDir, '-f', this.path.join(this.workDir, 'config.json')], {
        env: { ...this.env },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      this.lastError = `egress_pool_spawn_failed:${normalizeString(error && error.message)}`;
      return { ok: false, error: this.lastError };
    }
    if (this.child && this.child.stderr && typeof this.child.stderr.on === 'function') {
      this.child.stderr.on('data', () => { /* 内核日志不进主日志；需要时看 workDir/mihomo.log */ });
    }
    const spawnedChild = this.child;
    this.childAlive = Boolean(this.child);
    if (this.child && typeof this.child.on === 'function') {
      const child = this.child;
      child.on('error', (error) => {
        this.lastError = `egress_pool_child_error:${normalizeString(error && error.message)}`;
        if (this.child === child) {
          this.childAlive = false;
          this.started = false;
        }
      });
      const onExit = () => {
        if (this.child !== child) return;
        this.childAlive = false;
        this.started = false;
        if (this.stateFileWritten) {
          this.stateFileWritten = false;
          poolStateFile.removeEgressPoolState({ fs: this.fs, path: this.path, aiHomeDir: this.aiHomeDir });
        }
      };
      child.on('exit', onExit);
      child.on('close', onExit);
    }

    const ready = await this.waitForReady();
    if (stoppedMeanwhile()) {
      // stop() 已结束 this.child；这里兜底结束本次 spawn 的进程（stop 可能早于赋值）。
      this.killChild(spawnedChild);
      return { ok: false, error: this.lastError };
    }
    if (!ready) {
      this.stop();
      return { ok: false, error: this.lastError || 'egress_pool_startup_timeout' };
    }

    this.started = true;
    this.stateFileWritten = poolStateFile.writeEgressPoolState({
      fs: this.fs,
      path: this.path,
      aiHomeDir: this.aiHomeDir,
      ownerPid: this.processObj.pid,
      corePid: spawnedChild && spawnedChild.pid,
      proxyUrl: this.proxyUrl,
      controllerPort: this.controllerPort,
      secret: this.controllerSecret,
      lanes: this.laneUrlMap()
    });
    this.spawnedCorePid = spawnedChild && spawnedChild.pid;
    this.nodeNames = built.nodeNames;
    this.activeNodeIndex = 0;
    this.health.bindNodes(built.nodeEntries || built.nodeNames.map((name) => ({ name, node: null })));
    // 冷却跨重启生效：起步节点若仍在冷却（上次刚被限），直接从第一个可用节点开始。
    if (this.health.isCooling(this.nodeNames[0])) {
      const first = this.health.pickNext(-1);
      if (first > 0) await this.selectNode(this.nodeNames[first]);
    }
    // 启动前规划器已分好的车道：内核里每个车道组默认停在第一个节点，按各自的可用集合重选一次。
    for (const lane of this.lanes) {
      if (!lane.key) continue;
      lane.active = '';
      // eslint-disable-next-line no-await-in-loop
      await this.reselectLane(lane, 'lane_assigned');
    }
    if (this.lanes.some((lane) => lane.key)) this.writeStateFile();
    this.startProbeLoop();
    this.logger(`egress-pool ready: ${built.nodeNames.length} nodes on ${this.proxyUrl}`
      + (built.interfaceName ? ` (bound ${built.interfaceName})` : ' (no interface binding)'));
    return { ok: true, proxyUrl: this.proxyUrl, nodeCount: this.nodeNames.length };
  }

  /**
   * 轮询控制端口 /version（带本次密钥），直到内核可应答或超时。
   * 子进程已退出时立即判失败：此时还在应答的只可能是别的进程。
   */
  async waitForReady() {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!this.childAlive) {
        if (!this.lastError) this.lastError = 'egress_pool_core_exited';
        return false;
      }
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.controllerRequest('/version');
      if (ok !== null && this.childAlive) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, this.startupPollIntervalMs));
    }
    return false;
  }

  /** 启动前探测：控制端口上是否已有任何 HTTP 应答者（不带密钥，任何状态码都算）。 */
  async controllerPortAnswers() {
    const url = `http://127.0.0.1:${this.controllerPort}/version`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTROLLER_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      return Boolean(res);
    } catch (_error) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 调内核控制 API（带本次启动的密钥）；返回解析后的 JSON，失败返回 null。 */
  async controllerRequest(apiPath, init) {
    return this.controllerRequestAt(this.controllerPort, this.controllerSecret, apiPath, init);
  }

  async controllerRequestAt(port, secret, apiPath, init) {
    const url = `http://127.0.0.1:${port}${apiPath}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONTROLLER_TIMEOUT_MS);
      try {
        const res = await this.fetchImpl(url, {
          ...(init || {}),
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...((init && init.headers) || {}),
            authorization: `Bearer ${secret}`
          }
        });
        if (!res || !res.ok) return null;
        const text = await res.text();
        return text ? JSON.parse(text) : {};
      } finally {
        clearTimeout(timer);
      }
    } catch (_error) {
      return null;
    }
  }

  /**
   * 切到下一个节点（被 429 时的核心动作）。返回切换后的节点名；无可用节点返回 ''。
   * 池中只有一个节点时原地返回它（调用方仍可用它重试一次）。
   *
   * fromNode = 调用方失败时用的节点（比较后再换）：池是所有请求共享的单一出站口，
   * 两个并发请求同时在 node-0 失败时，若各自无条件 +1，就会连跳两格，把对方刚换到的
   * 好节点又切走（2026-10-18 实测：opencode 的标题请求与正文请求同时轮换，各跳满 6 次）。
   * 所以只有池仍停在 fromNode 时才前进；已被别人切走就直接返回当前节点让调用方重试。
   * 轮换串行执行，保证「比较」和「切换」之间不会插进另一次切换。
   */
  rotateNode(fromNode, reason) {
    const run = () => this.rotateNodeNow(fromNode, reason);
    this.rotationQueue = (this.rotationQueue || Promise.resolve()).then(run, run);
    return this.rotationQueue;
  }

  async rotateNodeNow(fromNode, reason) {
    if (!this.started || this.nodeNames.length === 0) return '';
    const expected = normalizeString(fromNode);
    const active = this.nodeNames[this.activeNodeIndex] || '';
    if (expected && active && expected !== active) return active;
    // 跳过冷却中的节点（见 egress-pool-node-health 的 pickNext）；全冷却时选最早解冻的。
    const picked = this.health.pickNext(this.activeNodeIndex);
    const next = picked >= 0 ? picked : (this.activeNodeIndex + 1) % this.nodeNames.length;
    const name = this.nodeNames[next];
    const ok = await this.controllerRequest('/proxies/GLOBAL', {
      method: 'PUT',
      body: JSON.stringify({ name })
    });
    if (ok === null) return '';
    this.activeNodeIndex = next;
    this.health.recordSwitch(active, name, reason || 'rotate');
    if (this.switchSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.switchSettleMs));
    }
    return name;
  }

  /** 切到指定节点。 */
  async selectNode(name) {
    const target = normalizeString(name);
    const index = this.nodeNames.indexOf(target);
    if (index < 0) return '';
    const ok = await this.controllerRequest('/proxies/GLOBAL', {
      method: 'PUT',
      body: JSON.stringify({ name: target })
    });
    if (ok === null) return '';
    const previous = this.nodeNames[this.activeNodeIndex] || '';
    this.activeNodeIndex = index;
    if (previous !== target) this.health.recordSwitch(previous, target, 'select');
    return target;
  }

  /** 记录一次经 name 出口的请求结果（transport 调用；outcome = { ok } 或 { ok:false, kind }）。 */
  recordNodeOutcome(name, outcome = {}, context = {}) {
    const node = normalizeString(name);
    if (!node || !this.nodeNames.includes(node)) return;
    if (outcome.ok) {
      this.health.recordSuccess(node, context);
      return;
    }
    this.health.recordFailure(node, outcome.kind, context);
    // 当前出口刚进冷却：立即切离（比较后再换，与请求路径的轮换不会叠加跳格）。否则请求的
    // 跳数用完、池停在这个已冷却的节点上，下一个请求还得先在它身上再撞一次（2026-10-19 实测）。
    if (!this.health.isCooling(node)) return;
    if (node === this.nodeNames[this.activeNodeIndex]) {
      this.rotateNode(node, outcome.kind).catch(() => {});
    }
    this.lanes.forEach((lane) => {
      if (lane.key && lane.active === node) this.rotateLaneAt(lane.index, node, outcome.kind).catch(() => {});
    });
  }

  // ── 车道 ────────────────────────────────────────────────────────────────

  laneUrlMap() {
    const out = {};
    this.accountLane.forEach((index, accountRef) => {
      const lane = this.lanes[index];
      if (lane && lane.key && !lane.blocked) out[accountRef] = laneUrl(lane);
    });
    return out;
  }

  laneOf(accountRef) {
    const index = this.accountLane.get(normalizeString(accountRef));
    return index === undefined ? null : (this.lanes[index] || null);
  }

  /** 账号的车道出站地址：未分到车道返回 null（调用方用默认出口）；车道无可用节点返回 ''（fail-closed）。 */
  laneProxyUrl(accountRef) {
    const lane = this.laneOf(accountRef);
    if (!lane) return this.overflowAccounts && this.overflowAccounts.has(normalizeString(accountRef)) ? '' : null;
    if (!this.started || lane.blocked || !lane.active) return '';
    return laneUrl(lane);
  }

  laneActiveNode(accountRef) {
    const lane = this.laneOf(accountRef);
    return lane && this.started ? lane.active : '';
  }

  /** 车道不可用的原因（给错误详情）；可用返回 ''。 */
  laneUnavailableReason(accountRef) {
    const lane = this.laneOf(accountRef);
    if (!lane) return this.overflowAccounts && this.overflowAccounts.has(normalizeString(accountRef)) ? 'egress_pool_lane_overflow' : '';
    if (lane.blocked) return lane.blocked;
    return lane.active ? '' : 'egress_pool_lane_not_ready';
  }

  /**
   * 应用规划器给出的车道表（server/egress-pool-planner）。
   * plan = [{ key, accounts: [accountRef], allowed: string[] | null, avoidGroup?, strategy?, upstream? }]
   *   allowed = 车道可用的节点名（节点范围 ∩ 地区判定允许）；null = 全部节点。
   * 已有 key 保留原车道与活动节点（不打断在途连接）；新 key 分到空闲车道；车道不够时记入 laneOverflow
   * （这些账号回落到默认出口，由规划器提前把独占降成共享来避免）。与轮换共用一条串行队列。
   */
  applyLanePlan(plan) {
    // 分配是同步的：规划完成后请求立即能查到自己的车道（节点还没选好时按未就绪 fail-closed）。
    const summary = this.assignLanes(plan);
    const run = () => this.reselectAssignedLanes();
    this.rotationQueue = (this.rotationQueue || Promise.resolve()).then(run, run);
    return this.rotationQueue.then(() => ({ lanes: this.describeLanes(), overflow: summary.overflow }));
  }

  assignLanes(plan) {
    const specs = (Array.isArray(plan) ? plan : []).filter((spec) => spec && normalizeString(spec.key));
    const wanted = new Map(specs.map((spec) => [normalizeString(spec.key), spec]));
    // 释放不再需要的车道。
    this.lanes.forEach((lane) => {
      if (lane.key && !wanted.has(lane.key)) Object.assign(lane, emptyLane(lane.index, lane.port));
    });
    const overflow = [];
    this.overflowAccounts = new Set();
    wanted.forEach((spec, key) => {
      const accounts = [...new Set((spec.accounts || []).map(normalizeString).filter(Boolean))];
      let lane = this.lanes.find((candidate) => candidate.key === key);
      if (!lane) lane = this.lanes.find((candidate) => !candidate.key);
      if (!lane) {
        overflow.push(key);
        accounts.forEach((accountRef) => this.overflowAccounts.add(accountRef));
        return;
      }
      const allowed = Array.isArray(spec.allowed) ? new Set(spec.allowed.map(normalizeString).filter(Boolean)) : null;
      const changed = lane.key !== key || !sameSet(lane.allowed, allowed) || lane.avoidGroup !== normalizeString(spec.avoidGroup);
      lane.key = key;
      lane.accounts = accounts;
      lane.allowed = allowed;
      lane.avoidGroup = normalizeString(spec.avoidGroup);
      lane.strategy = normalizeString(spec.strategy) || 'shared';
      lane.upstream = normalizeString(spec.upstream);
      lane.blockedHint = normalizeString(spec.blockedReason);
      if (changed) lane.dirty = true;
    });
    this.laneOverflow = overflow;
    this.accountLane = new Map();
    this.lanes.forEach((lane) => {
      if (lane.key) lane.accounts.forEach((accountRef) => this.accountLane.set(accountRef, lane.index));
    });
    return { overflow };
  }

  async reselectAssignedLanes() {
    if (!this.started) return;
    for (const lane of this.lanes) {
      if (!lane.key) continue;
      const valid = !lane.dirty
        && lane.active
        && (!lane.allowed || lane.allowed.has(lane.active))
        && !this.health.isCooling(lane.active);
      lane.dirty = false;
      if (valid) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.reselectLane(lane, lane.active ? 'scope_changed' : 'lane_assigned', { keepIfAllowed: true });
    }
    this.writeStateFile();
  }

  /** 其它同组车道正在用的节点（独占策略：同上游的账号彼此错开出口）。 */
  laneAvoidSet(lane) {
    if (!lane.avoidGroup) return new Set();
    return new Set(this.lanes
      .filter((other) => other !== lane && other.key && other.avoidGroup === lane.avoidGroup && other.active)
      .map((other) => other.active));
  }

  async reselectLane(lane, reason, options = {}) {
    if (options.keepIfAllowed && lane.active && (!lane.allowed || lane.allowed.has(lane.active))
      && !this.health.isCooling(lane.active)) {
      lane.blocked = '';
      return lane.active;
    }
    const fromIndex = lane.active ? this.nodeNames.indexOf(lane.active) : -1;
    const picked = this.health.pickNext(fromIndex, { allowed: lane.allowed, avoid: this.laneAvoidSet(lane) });
    if (picked < 0) {
      lane.blocked = lane.blockedHint || 'egress_pool_no_allowed_nodes';
      lane.active = '';
      return '';
    }
    const name = this.nodeNames[picked];
    const ok = await this.controllerRequest(`/proxies/${encodeURIComponent(laneGroupName(lane.index))}`, {
      method: 'PUT',
      body: JSON.stringify({ name })
    });
    if (ok === null) {
      lane.blocked = 'egress_pool_lane_select_failed';
      return '';
    }
    const previous = lane.active;
    lane.active = name;
    lane.blocked = '';
    if (previous !== name) this.health.recordSwitch(previous, name, `${reason || 'rotate'}@lane-${lane.index}`);
    return name;
  }

  /** 账号车道换下一个节点（与 rotateNode 同语义：fromNode 不是当前节点时不前进）。 */
  rotateLane(accountRef, fromNode, reason) {
    const lane = this.laneOf(accountRef);
    if (!lane) return this.rotateNode(fromNode, reason);
    return this.rotateLaneAt(lane.index, fromNode, reason);
  }

  rotateLaneAt(index, fromNode, reason) {
    const run = async () => {
      const lane = this.lanes[index];
      if (!this.started || !lane || !lane.key) return '';
      const expected = normalizeString(fromNode);
      if (expected && lane.active && expected !== lane.active) return lane.active;
      const name = await this.reselectLane(lane, reason);
      if (name && this.switchSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, this.switchSettleMs));
      if (name) this.writeStateFile();
      return name;
    };
    this.rotationQueue = (this.rotationQueue || Promise.resolve()).then(run, run);
    return this.rotationQueue;
  }

  writeStateFile() {
    if (!this.started) return;
    this.stateFileWritten = poolStateFile.writeEgressPoolState({
      fs: this.fs,
      path: this.path,
      aiHomeDir: this.aiHomeDir,
      ownerPid: this.processObj.pid,
      corePid: this.spawnedCorePid,
      proxyUrl: this.proxyUrl,
      controllerPort: this.controllerPort,
      secret: this.controllerSecret,
      lanes: this.laneUrlMap()
    }) || this.stateFileWritten;
  }

  // ── 经指定节点的探测（AIH-PROBE 入站，串行）─────────────────────────────

  /**
   * 让 fn 里的请求走指定节点：先把 AIH-PROBE 切到 name，再把「经探测入站」的 fetch 交给 fn。
   * 串行执行 —— 探测入站只有一个，并发会互相改掉对方的节点。
   */
  withProbeNode(name, fn) {
    const run = async () => {
      const node = normalizeString(name);
      if (!this.started || !this.probePort) return { ok: false, error: 'egress_pool_probe_unavailable' };
      if (!this.nodeNames.includes(node)) return { ok: false, error: 'egress_pool_node_unknown' };
      const switched = await this.controllerRequest(`/proxies/${encodeURIComponent(EGRESS_POOL_PROBE_GROUP)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: node })
      });
      if (switched === null) return { ok: false, error: 'egress_pool_probe_select_failed' };
      const proxyUrl = `http://${EGRESS_POOL_BIND_HOST}:${this.probePort}`;
      return fn((url, init) => this.proxyFetch(proxyUrl, url, init));
    };
    const next = this.probeQueue.then(run, run);
    this.probeQueue = next.catch(() => {});
    return next;
  }

  /** 查询节点的真实出口位置并记进账本。force=false 时未过期的结果直接返回。 */
  async lookupNodeGeo(name, options = {}) {
    const cached = this.health.geoOf(name);
    if (!options.force && cached && Number(cached.at) + this.geoTtlMs > this.now()) return { ok: true, geo: cached, cached: true };
    const result = await this.withProbeNode(name, (proxiedFetch) => lookupExitGeo({ fetch: proxiedFetch }));
    if (result && result.ok) this.health.recordGeo(name, result.geo);
    return result;
  }

  /** 补齐缺位置 / 位置过期的节点（逐个串行，limit 控制单次数量）。 */
  async refreshNodeGeos(options = {}) {
    const limit = Number(options.limit) > 0 ? Number(options.limit) : this.nodeNames.length;
    const at = this.now();
    const due = this.nodeNames.filter((name) => {
      const geo = this.health.geoOf(name);
      return options.force || !geo || Number(geo.at) + this.geoTtlMs <= at;
    }).slice(0, limit);
    const results = [];
    for (const name of due) {
      if (!this.started) break;
      // eslint-disable-next-line no-await-in-loop
      results.push({ name, ...(await this.lookupNodeGeo(name, { force: options.force })) });
    }
    return results;
  }

  /**
   * 不带凭据经指定节点请求上游一次（地区判定的被动探测）。
   * @returns {{ ok:true, reached:true, status, text } | { ok:true, reached:false, error } | { ok:false, error }}
   *   ok:false = 探测本身没法做（池未就绪 / 节点未知）；reached:false = 请求没拿到任何 HTTP 响应。
   */
  async fetchUpstreamViaNode(name, url, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.upstreamProbeTimeoutMs;
    return this.withProbeNode(name, async (proxiedFetch) => {
      try {
        const res = await proxiedFetch(url, {
          method: options.method || 'GET',
          headers: { accept: 'application/json', connection: 'close', ...(options.headers || {}) },
          signal: AbortSignal.timeout(timeoutMs)
        });
        const text = String(await res.text()).slice(0, 4000);
        return { ok: true, reached: true, status: res.status, text };
      } catch (error) {
        const code = normalizeString(error && error.cause && error.cause.code)
          || normalizeString(error && error.code)
          || normalizeString(error && error.name)
          || 'error';
        return { ok: true, reached: false, error: code };
      }
    });
  }

  /** 人工解除节点冷却。 */
  clearNodeCooldown(name) {
    return this.health.clearCooldown(normalizeString(name));
  }

  /** 经内核探测单个节点：GET /proxies/<name>/delay（不切换出站）。 */
  async probeNode(name) {
    const node = normalizeString(name);
    if (!this.started || !this.nodeNames.includes(node)) return { ok: false, error: 'egress_pool_node_unknown' };
    const query = `timeout=${this.probeTimeoutMs}&url=${encodeURIComponent(this.probeUrl)}`;
    const result = await this.controllerRequest(`/proxies/${encodeURIComponent(node)}/delay?${query}`);
    const latencyMs = Number(result && result.delay);
    const outcome = latencyMs > 0 ? { ok: true, latencyMs } : { ok: false, error: 'probe_unreachable' };
    this.health.recordProbe(node, { ...outcome, reportFailure: this.health.isCooling(node) });
    return outcome;
  }

  /** 探一批到期节点（网络类冷却中的 + 从未探测过的）；全量探测时 6 路并发，不阻塞请求。 */
  async probeDue(options = {}) {
    if (!this.started || this.probing) return [];
    this.probing = true;
    try {
      const names = options.all ? this.nodeNames.slice() : this.health.dueForProbe(options.limit || 8);
      const concurrency = options.all ? 6 : 1;
      const results = new Array(names.length);
      let cursor = 0;
      const worker = async () => {
        while (this.started && cursor < names.length) {
          const index = cursor;
          cursor += 1;
          // eslint-disable-next-line no-await-in-loop
          results[index] = { name: names[index], ...(await this.probeNode(names[index])) };
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
      return results.filter(Boolean);
    } finally {
      this.probing = false;
    }
  }

  startProbeLoop() {
    this.stopProbeLoop();
    if (!(this.probeIntervalMs > 0)) return;
    this.probeTimer = setInterval(() => { this.probeDue().catch(() => {}); }, this.probeIntervalMs);
    if (typeof this.probeTimer.unref === 'function') this.probeTimer.unref();
  }

  stopProbeLoop() {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /**
   * 回收自己的孤儿内核（server 被 SIGKILL/崩溃后，非 detached 的子进程仍可能占着端口）。
   * 只有同时满足以下条件才结束进程：运行文件存在、写它的 server 已不在（或就是本进程）、
   * 登记的内核进程仍存活、且它用文件里的密钥在控制端口上应答 —— 证明是我们起的那个。
   * 返回 'reaped' / ''。永不抛。
   */
  async reapOwnOrphan() {
    const fileOptions = { fs: this.fs, path: this.path, aiHomeDir: this.aiHomeDir };
    const state = poolStateFile.readEgressPoolState(fileOptions);
    if (!state) return '';
    if (state.ownerPid !== this.processObj.pid && this.isPidAlive(state.ownerPid)) return '';
    if (!this.isPidAlive(state.corePid)) {
      poolStateFile.removeEgressPoolState(fileOptions);
      return '';
    }
    if (!state.secret || !state.controllerPort) return '';
    const verified = await this.controllerRequestAt(state.controllerPort, state.secret, '/version');
    if (verified === null) return '';
    try {
      this.processObj.kill(state.corePid, 'SIGTERM');
    } catch (_error) {
      return '';
    }
    const deadline = Date.now() + this.reapTimeoutMs;
    while (Date.now() < deadline && this.isPidAlive(state.corePid)) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, this.startupPollIntervalMs));
    }
    poolStateFile.removeEgressPoolState(fileOptions);
    this.logger(`egress-pool reaped orphaned core pid ${state.corePid}`);
    return 'reaped';
  }

  killChild(child) {
    if (!child) return;
    try {
      if (typeof child.kill === 'function') child.kill();
    } catch (_error) {
      /* best effort */
    }
  }

  /** 停止内核并清理。幂等。 */
  stop() {
    this.generation += 1;
    this.lanes.forEach((lane) => { lane.active = ''; });
    this.stopProbeLoop();
    if (this.started && this.health) this.health.flush();
    this.started = false;
    this.childAlive = false;
    const child = this.child;
    this.child = null;
    if (this.stateFileWritten) {
      this.stateFileWritten = false;
      poolStateFile.removeEgressPoolState({ fs: this.fs, path: this.path, aiHomeDir: this.aiHomeDir });
    }
    this.killChild(child);
  }
}

function emptyLane(index, port) {
  return {
    index, port, key: '', active: '', allowed: null, avoidGroup: '', accounts: [], strategy: '', upstream: '',
    blocked: '', blockedHint: '', dirty: false
  };
}

function sameSet(a, b) {
  if (!a || !b) return a === b;
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function laneUrl(lane) {
  return `http://${EGRESS_POOL_BIND_HOST}:${lane.port}`;
}

module.exports = {
  EgressPoolRuntime,
  REAP_TIMEOUT_MS,
  STARTUP_POLL_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
  pickPort
};
