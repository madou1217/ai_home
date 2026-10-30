'use strict';

// 把代理池节点编译成出口池内核（mihomo）的运行时配置。
//
// 与 proxy-compiler 的分工：那个是「渲染订阅」用的（面向 Clash/Stash 客户端，
// 不关心运行时环境）；这里是「起一个本地内核」用的，必须额外处理两件宿主环境的事：
//
//   ① **绕过宿主 TUN**：用户可能开着 Surge/Clash 的 TUN 全局接管，此时内核的
//      出站会被劫持（实测：mihomo 直连节点超时，而 nc 直连同一 IP 可达）。
//      解法是把出站绑到物理网卡（interface-name），实测可绕过。
//   ② **DNS 不走宿主**：TUN 接管时系统 DNS 会返回 fake-ip（198.18.x.x），内核
//      解析节点域名会拿到假地址。解法是内核内置 DoH，实测节点域名可直接写、
//      无需预解析真实 IP。
//
// 节点字段编译复用协议的 compile.mihomo（单一事实来源），这里只补运行时字段。

const nodeOs = require('node:os');
const { compileMihomoProxy } = require('../cli/services/toolkit/proxy-pool/cores/mihomo/proxy-compiler');
const { buildNodeEntityId } = require('./egress-node-identity');

// 出口池内核只监听回环：它是一个本地出站端口，绝不对外暴露，也绝不接管系统网络。
const EGRESS_POOL_BIND_HOST = '127.0.0.1';
// 健康检查与节点切换用的控制端口（同样只回环）。
const EGRESS_POOL_CONTROLLER_HOST = '127.0.0.1';
// 内核自身解析域名用的解析器；刻意不用宿主 DNS（见模块头 ②），但都是**公共解析器**的地址，
// 不是宿主 resolver。
//
// 顺序：UDP 53 在前、DoH 在后（2026-10-26 事故 + 隔离实测）。mihomo 按 nameserver 列表
// **顺序**取应答，遇到不可达的解析器只会等到超时，不会跳到下一条 —— 只配 DoH 时，凡是
// 443 出不去而 53 通行的网络（宿主 TUN 全局接管 / 运营商拦 DoH），内核连节点域名都解析
// 不出来：池自报 ready、76/76 节点 probe_unreachable、所有走池的请求 5s 后被 reset
// （ECONNRESET），而同一时刻直连完全正常。隔离实测（/tmp 起同一个内核二进制）：
//   DoH-only → /dns/query 5.0s `context deadline exceeded`，节点探测失败、经池流量 000
//   UDP 在前 → /dns/query 0.2s 返回真实 IP，节点探测 1040ms、经池流量 204/0.81s
// DoH 留在后面兜住「:53 被劫持」的环境；那种环境下 UDP 会返回 fake-ip，由启动就绪判据
// （runtime 的 verifyNodeResolvable）判为不可用并 fail-closed，绝不拿假地址去拨号。
const EGRESS_POOL_DNS_UDP_SERVERS = Object.freeze(['1.1.1.1', '8.8.8.8']);
const EGRESS_POOL_DOH_SERVERS = Object.freeze([
  'https://1.1.1.1/dns-query',
  'https://8.8.8.8/dns-query'
]);
const EGRESS_POOL_DNS_SERVERS = Object.freeze([
  ...EGRESS_POOL_DNS_UDP_SERVERS,
  ...EGRESS_POOL_DOH_SERVERS
]);
const EGRESS_POOL_DOH_BOOTSTRAP = Object.freeze(['1.1.1.1', '8.8.8.8']);
const EGRESS_POOL_PROBE_GROUP = 'AIH-PROBE';

function laneGroupName(index) {
  return `LANE-${index}`;
}

// TUN / 虚拟网卡：macOS 是 utun*；Windows 上 Clash Verge / mihomo 的 TUN 网卡名就叫「Clash」「Meta」，
// 其它常见的有 wintun / sing-box / WireGuard（2026-10-19 Windows 真机：绑到「Clash」后经池的 HTTPS 全部握手失败）。
const VIRTUAL_INTERFACE_PATTERN = /^(utun|tun|tap|wintun)|clash|mihomo|^meta|sing-?box|wireguard/i;

// 198.18.0.0/15 是 fake-ip / TUN 网关的惯用地址段（Clash / Surge 都用它），不可能是物理出口。
function isTunAddress(address) {
  const parts = String(address || '').split('.').map(Number);
  return parts.length === 4 && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

/**
 * 选物理网卡：有非内部 IPv4、不是 TUN / 虚拟网卡（名称或 198.18/15 地址）的那条。
 * 找不到时返回 ''，调用方就不绑网卡（直连环境本来也不需要）。
 */
function resolvePhysicalInterface(networkInterfaces) {
  const source = typeof networkInterfaces === 'function'
    ? networkInterfaces
    : nodeOs.networkInterfaces;
  let interfaces = {};
  try {
    interfaces = source() || {};
  } catch (_error) {
    return '';
  }
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE_PATTERN.test(name)) continue;
    const list = Array.isArray(addresses) ? addresses : [];
    const usable = list.find((entry) => (
      entry && entry.family === 'IPv4' && !entry.internal && !isTunAddress(entry.address)
    ));
    if (usable) return name;
  }
  return '';
}

/**
 * 编译出口池内核配置。
 *
 * @param {object} options
 * @param {Array} options.nodes        代理池节点（node-store 的形状）
 * @param {number} options.mixedPort   本地 http/socks 混合端口
 * @param {number} options.controllerPort 控制端口（健康检查/切换节点）
 * @param {string} options.secret    控制端口的访问密钥（每次启动随机生成）
 * @param {string} [options.interfaceName] 绑定的物理网卡；空则用自动探测
 * @param {Function} [options.networkInterfaces] 注入用（测试）
 * @param {number} [options.probePort]  探测专用入站端口（组 AIH-PROBE）；0/缺省 = 不开
 * @param {number[]} [options.lanePorts] 车道入站端口（组 LANE-<i>）；缺省 = 不开车道
 * @returns {{ config: object, nodeNames: string[] }}
 *
 * 车道（lane）：每个车道是一个独立的 select 组 + 一个只回环的 mixed 入站。账号绑定池时由
 * 规划器（server/egress-pool-planner）分到某个车道，车道的活动节点在 AIH 侧按「可用节点集合」
 * 选择 —— 组本身包含**全部**节点，所以账号的节点范围 / 地区判定变化时只需切选择，不用重载内核。
 * 探测入站（AIH-PROBE）同理：经它可以让一次请求走指定节点，而不动任何车道或 GLOBAL。
 */
function buildEgressPoolConfig(options = {}) {
  const nodes = Array.isArray(options.nodes) ? options.nodes : [];
  const mixedPort = Number(options.mixedPort);
  const controllerPort = Number(options.controllerPort);
  if (!Number.isInteger(mixedPort) || mixedPort <= 0) throw new Error('egress_pool_mixed_port_required');
  if (!Number.isInteger(controllerPort) || controllerPort <= 0) throw new Error('egress_pool_controller_port_required');
  // 控制端口是信任边界：mihomo 的 PUT /configs 能整体改写运行配置（例如打开 allow-lan
  // 把节点暴露到局域网），默认 CORS 又放行任意来源。没有密钥就等于把它交给本机任意
  // 进程和浏览器页面，因此密钥是必填项而不是可选加固。
  const secret = typeof options.secret === 'string' ? options.secret.trim() : '';
  if (!secret) throw new Error('egress_pool_controller_secret_required');

  const interfaceName = String(
    options.interfaceName !== undefined
      ? options.interfaceName
      : resolvePhysicalInterface(options.networkInterfaces || nodeOs.networkInterfaces)
  ).trim();

  const proxies = [];
  const nodeEntries = [];
  for (const node of nodes) {
    // 名字按「成功编译的序号」编，不用原始下标 —— 跳过坏节点后名字不会出现空洞，
    // 日志和 UI 里的 node-N 才能对得上池中的第 N 个可用出口。
    const name = `node-${proxies.length}`;
    let compiled;
    try {
      compiled = compileMihomoProxy(node, name);
    } catch (_error) {
      // 单个节点编译失败（协议不支持/字段缺失）不该拖垮整池：跳过它，
      // 剩下的节点仍能服务。调用方从 nodeNames 长度就能看出跳过了几个。
      continue;
    }
    if (interfaceName) compiled['interface-name'] = interfaceName;
    proxies.push(compiled);
    // 名字 → 原始节点（出口身份 / 展示名 / 国家），供节点账本与 WebUI 用；不含编译后的凭据字段。
    nodeEntries.push({ name, node: { ...node, nodeId: buildNodeEntityId(node) } });
  }
  if (proxies.length === 0) throw new Error('egress_pool_no_usable_nodes');

  const allNames = proxies.map((proxy) => proxy.name);
  const probePort = Number(options.probePort) || 0;
  const lanePorts = (Array.isArray(options.lanePorts) ? options.lanePorts : [])
    .map(Number).filter((port) => Number.isInteger(port) && port > 0);
  const extraGroups = [];
  const listeners = [];
  if (probePort > 0) {
    extraGroups.push({ name: EGRESS_POOL_PROBE_GROUP, type: 'select', proxies: allNames.slice() });
    listeners.push({ name: 'aih-probe', type: 'mixed', port: probePort, listen: EGRESS_POOL_BIND_HOST, proxy: EGRESS_POOL_PROBE_GROUP });
  }
  lanePorts.forEach((port, index) => {
    const group = laneGroupName(index);
    extraGroups.push({ name: group, type: 'select', proxies: allNames.slice() });
    listeners.push({ name: `aih-lane-${index}`, type: 'mixed', port, listen: EGRESS_POOL_BIND_HOST, proxy: group });
  });

  return {
    config: {
      'mixed-port': mixedPort,
      'external-controller': `${EGRESS_POOL_CONTROLLER_HOST}:${controllerPort}`,
      secret,
      'allow-lan': false,
      // 只出站，不接管：没有 tun 段，也没有 auto-route —— 用户电脑的网络不受影响。
      mode: 'global',
      'log-level': 'warning',
      dns: {
        enable: true,
        ipv6: false,
        nameserver: [...EGRESS_POOL_DNS_SERVERS],
        'default-nameserver': [...EGRESS_POOL_DOH_BOOTSTRAP],
        // 节点自己的域名就靠这条解析：它是拨号的前置条件，顺序与 nameserver 一致。
        'proxy-server-nameserver': [...EGRESS_POOL_DNS_SERVERS]
      },
      proxies,
      'proxy-groups': [{
        name: 'GLOBAL',
        type: 'select',
        proxies: allNames.slice()
      }, ...extraGroups],
      ...(listeners.length ? { listeners } : {}),
      rules: ['MATCH,GLOBAL']
    },
    nodeNames: proxies.map((proxy) => proxy.name),
    nodeEntries,
    interfaceName
  };
}

module.exports = {
  EGRESS_POOL_BIND_HOST,
  EGRESS_POOL_CONTROLLER_HOST,
  EGRESS_POOL_DNS_SERVERS,
  EGRESS_POOL_DNS_UDP_SERVERS,
  EGRESS_POOL_DOH_BOOTSTRAP,
  EGRESS_POOL_DOH_SERVERS,
  EGRESS_POOL_PROBE_GROUP,
  buildEgressPoolConfig,
  isTunAddress,
  laneGroupName,
  resolvePhysicalInterface
};
