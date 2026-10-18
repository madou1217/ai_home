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

// 出口池内核只监听回环：它是一个本地出站端口，绝不对外暴露，也绝不接管系统网络。
const EGRESS_POOL_BIND_HOST = '127.0.0.1';
// 健康检查与节点切换用的控制端口（同样只回环）。
const EGRESS_POOL_CONTROLLER_HOST = '127.0.0.1';
// 内核自身解析域名用的 DoH；刻意不用宿主 DNS（见模块头 ②）。
const EGRESS_POOL_DOH_SERVERS = Object.freeze([
  'https://1.1.1.1/dns-query',
  'https://8.8.8.8/dns-query'
]);
const EGRESS_POOL_DOH_BOOTSTRAP = Object.freeze(['1.1.1.1', '8.8.8.8']);

/**
 * 选物理网卡：有非内部 IPv4 且不是 utun（TUN 虚拟口）的那条。
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
    if (/^utun/i.test(name)) continue;
    const list = Array.isArray(addresses) ? addresses : [];
    const usable = list.find((entry) => (
      entry && entry.family === 'IPv4' && !entry.internal
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
 * @returns {{ config: object, nodeNames: string[] }}
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
  }
  if (proxies.length === 0) throw new Error('egress_pool_no_usable_nodes');

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
        nameserver: [...EGRESS_POOL_DOH_SERVERS],
        'default-nameserver': [...EGRESS_POOL_DOH_BOOTSTRAP],
        'proxy-server-nameserver': [...EGRESS_POOL_DOH_SERVERS]
      },
      proxies,
      'proxy-groups': [{
        name: 'GLOBAL',
        type: 'select',
        proxies: proxies.map((proxy) => proxy.name)
      }],
      rules: ['MATCH,GLOBAL']
    },
    nodeNames: proxies.map((proxy) => proxy.name),
    interfaceName
  };
}

module.exports = {
  EGRESS_POOL_BIND_HOST,
  EGRESS_POOL_CONTROLLER_HOST,
  EGRESS_POOL_DOH_BOOTSTRAP,
  EGRESS_POOL_DOH_SERVERS,
  buildEgressPoolConfig,
  resolvePhysicalInterface
};
