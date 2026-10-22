'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand } = require('../proxy-target-plugins/proxy-command');
const { output, probeFailureStatus, runCommand, runCommandAsync } = require('./os-command');

function parseMacBypassList(text) {
  const block = String(text || '').match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/i);
  if (!block) return [];
  return Array.from(block[1].matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm), (match) => match[1].trim()).filter(Boolean);
}

// 启用的网络服务名（`networksetup -listnetworkserviceorder` 里不带星号的那些）。
// 名字含空格，按行解析不能按空白切。
function parseServiceOrder(stdout) {
  const services = [];
  for (const line of String(stdout || '').split('\n')) {
    const match = line.match(/^\(\d+\)\s+(.+?)\s*$/);
    if (match) services.push({ name: match[1].trim(), disabled: false });
    else if (/^\s*\(\*\)/.test(line)) {
      const disabled = line.match(/^\s*\(\*\)\s+(.+?)\s*$/);
      if (disabled && services.length) services[services.length - 1].disabled = true;
    }
  }
  return services.filter((service) => service.name && !service.disabled);
}

function listEnabledServices(options) {
  const res = execCommand('networksetup', ['-listnetworkserviceorder'], options);
  if (!res.ok || !res.stdout) return [];
  return parseServiceOrder(res.stdout);
}

/** 汇总各网络服务的代理查询结果；命令本身由调用方并发跑完后传进来。 */
function combineServiceProbes(services, probesByService) {
  const combined = { httpProxy: '', httpsProxy: '', socksProxy: '', bypassList: [] };
  for (const service of services) {
    const probes = probesByService.get(service.name) || {};
    for (const [command, key] of [['-getwebproxy', 'httpProxy'], ['-getsecurewebproxy', 'httpsProxy'], ['-getsocksfirewallproxy', 'socksProxy']]) {
      const res = probes[command];
      if (!res || !res.ok || !/Enabled:\s*Yes/i.test(res.stdout)) continue;
      const host = (res.stdout.match(/Server:\s*(\S+)/i) || [])[1] || '';
      const port = (res.stdout.match(/Port:\s*(\d+)/i) || [])[1] || '';
      if (!host || !port || combined[key]) continue;
      combined[key] = key === 'socksProxy' ? `socks5://${host}:${port}` : `http://${host}:${port}`;
    }
    if (!combined.bypassList.length) {
      const res = probes['-getproxybypassdomains'];
      if (res && res.ok && res.stdout && !/There aren't any bypass domains/i.test(res.stdout)) {
        combined.bypassList = res.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      }
    }
  }
  return (combined.httpProxy || combined.httpsProxy || combined.socksProxy) ? combined : null;
}

const SERVICE_PROXY_COMMANDS = ['-getwebproxy', '-getsecurewebproxy', '-getsocksfirewallproxy', '-getproxybypassdomains'];

/**
 * 异步版 detectServiceProxy：先取服务列表，再把**所有**服务的 4 条查询并发跑。
 * 串行版本在 5 个网络服务的机器上要等 21 个进程依次结束，期间主线程被 spawnSync 占住。
 */
async function detectServiceProxyAsync(options) {
  const orderRes = await runCommandAsync(options, 'networksetup', ['-listnetworkserviceorder']);
  if (!orderRes.ok || !orderRes.stdout) return null;
  const services = parseServiceOrder(orderRes.stdout);
  const entries = await Promise.all(services.map(async (service) => {
    const probes = await Promise.all(SERVICE_PROXY_COMMANDS.map((command) =>
      runCommandAsync(options, 'networksetup', [command, service.name])));
    return [service.name, Object.fromEntries(SERVICE_PROXY_COMMANDS.map((command, index) => [command, probes[index]]))];
  }));
  return combineServiceProbes(services, new Map(entries));
}

/**
 * 按网络服务读代理（`networksetup -getwebproxy <服务>`）。
 *
 * 为什么需要这条路：`scutil --proxy` 报的是**内核汇总视图**，代理软件用 TUN/网络扩展
 * 模式接管流量时（实测 Surge 在 utun4 上），汇总视图显示 `HTTPEnable: 0`，而 Wi-Fi
 * 服务上 127.0.0.1:6152 是配好的、也确实能用。只读 scutil 会让「现有系统代理」这个
 * 出口在用户明明有代理时报「不可用」。
 *
 * @returns {{ httpProxy: string, httpsProxy: string, socksProxy: string, bypassList: string[] }|null}
 */
function detectServiceProxy(options) {
  const services = listEnabledServices(options);
  const probesByService = new Map();
  for (const service of services) {
    const probes = {};
    for (const command of SERVICE_PROXY_COMMANDS) {
      probes[command] = execCommand('networksetup', [command, service.name], options);
    }
    probesByService.set(service.name, probes);
  }
  return combineServiceProbes(services, probesByService);
}

// 当前生效的系统代理（scutil 汇总视图，只读诊断用）。
function detectProxy(options, result) {
  result.source = 'scutil --proxy';
  const res = execCommand('scutil', ['--proxy'], options);
  applyScutilOutput(res, result);
  if (res.ok && res.stdout && !result.enabled) {
    // 汇总视图没代理时再看网络服务：TUN/网络扩展模式下代理不写进汇总视图（见 detectServiceProxy）。
    const service = detectServiceProxy(options);
    if (service) applyServiceProxy(service, result);
  }
  return result;
}

/** 异步版：scutil 与「按网络服务探测」并发跑，结果一致时优先汇总视图。 */
async function detectProxyAsync(options = {}) {
  const result = createEmptyResult(options);
  result.source = 'scutil --proxy';
  const [scutilRes, service] = await Promise.all([
    runCommandAsync(options, 'scutil', ['--proxy']),
    detectServiceProxyAsync(options)
  ]);
  applyScutilOutput(scutilRes, result);
  if (!result.enabled && service) applyServiceProxy(service, result);
  return result;
}

function createEmptyResult(options = {}) {
  const processObj = options.processObj || process;
  return {
    platform: options.platform || processObj.platform,
    scope: 'operating-system',
    source: '',
    probeStatus: 'unsupported',
    enabled: false,
    httpProxy: '',
    httpsProxy: '',
    socksProxy: '',
    bypassList: []
  };
}

function applyServiceProxy(service, result) {
  result.source = 'networksetup -getwebproxy';
  result.enabled = true;
  result.probeStatus = 'available';
  result.httpProxy = service.httpProxy;
  result.httpsProxy = service.httpsProxy;
  result.socksProxy = service.socksProxy;
  result.bypassList = service.bypassList;
}

function applyScutilOutput(res, result) {
  if (res && res.ok && res.stdout) {
    const out = res.stdout;
    const httpEnabled = /HTTPEnable\s*:\s*1/i.test(out);
    const httpsEnabled = /HTTPSEnable\s*:\s*1/i.test(out);
    const socksEnabled = /SOCKSEnable\s*:\s*1/i.test(out);

    const httpHost = (out.match(/HTTPProxy\s*:\s*([^\s\n]+)/i) || [])[1] || '';
    const httpPort = (out.match(/HTTPPort\s*:\s*(\d+)/i) || [])[1] || '';
    const httpsHost = (out.match(/HTTPSProxy\s*:\s*([^\s\n]+)/i) || [])[1] || '';
    const httpsPort = (out.match(/HTTPSPort\s*:\s*(\d+)/i) || [])[1] || '';
    const socksHost = (out.match(/SOCKSProxy\s*:\s*([^\s\n]+)/i) || [])[1] || '';
    const socksPort = (out.match(/SOCKSPort\s*:\s*(\d+)/i) || [])[1] || '';

    result.enabled = httpEnabled || httpsEnabled || socksEnabled;
    result.probeStatus = result.enabled ? 'available' : 'unset';
    if (httpEnabled && httpHost && httpPort) result.httpProxy = `http://${httpHost}:${httpPort}`;
    if (httpsEnabled && httpsHost && httpsPort) result.httpsProxy = `http://${httpsHost}:${httpsPort}`;
    if (socksEnabled && socksHost && socksPort) result.socksProxy = `socks5://${socksHost}:${socksPort}`;
    result.bypassList = parseMacBypassList(out);
  } else if (res && res.ok) {
    result.probeStatus = 'unset';
  } else {
    result.probeStatus = probeFailureStatus(res);
  }
}

const tun = {
  probe(options) {
    return {
      interfaceOutput: output(runCommand(options, 'ifconfig')),
      routeOutput: output(runCommand(options, 'netstat', ['-rn'])),
      processOutput: output(runCommand(options, 'ps', ['-axo', 'pid=,command=']))
    };
  },
  interfaceDetected: ({ interfaceOutput }) => /(?:^|\n)utun\d+:/m.test(interfaceOutput),
  routeDetected: ({ routeOutput }) => /utun\d+/i.test(routeOutput)
};

module.exports = Object.freeze({
  id: 'macos',
  name: 'macOS 网络偏好设置',
  capability: 'toolkit.system-proxy',
  hostPlatform: 'darwin',
  platforms: Object.freeze([CLIENT_PLATFORMS.MACOS]),
  detectProxy,
  detectProxyAsync,
  tun
});
