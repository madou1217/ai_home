'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand } = require('../proxy-target-plugins/proxy-command');
const { output, probeFailureStatus, runCommand, succeeded } = require('./os-command');

function parseMacBypassList(text) {
  const block = String(text || '').match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/i);
  if (!block) return [];
  return Array.from(block[1].matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm), (match) => match[1].trim()).filter(Boolean);
}

// 当前生效的系统代理（scutil 汇总视图，只读诊断用）。
function detectProxy(options, result) {
  result.source = 'scutil --proxy';
  const res = execCommand('scutil', ['--proxy'], options);
  if (res.ok && res.stdout) {
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
  } else if (res.ok) {
    result.probeStatus = 'unset';
  } else {
    result.probeStatus = probeFailureStatus(res);
  }
  return result;
}

function parseNetworksetupProxy(outputText) {
  const text = String(outputText || '');
  const enabled = /(^|\n)\s*Enabled:\s*(Yes|On|1)\s*$/im.test(text);
  const server = (text.match(/(^|\n)\s*Server:\s*(.*?)\s*$/im) || [])[2] || '';
  const port = Number((text.match(/(^|\n)\s*Port:\s*(\d+)\s*$/im) || [])[2] || 0);
  const bypass = Array.from(text.matchAll(/(^|\n)\s*(?:Exceptions|Bypass Domains?):\s*(.*?)\s*$/gim), (match) => match[2].trim())
    .filter(Boolean)
    .flatMap((value) => value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean));
  return {
    enabled,
    server,
    port: Number.isInteger(port) ? port : 0,
    bypass
  };
}

function parseNetworksetupPac(outputText) {
  const text = String(outputText || '');
  const enabled = /(^|\n)\s*Enabled:\s*(Yes|On|1)\s*$/im.test(text);
  const url = (text.match(/(^|\n)\s*URL:\s*(.*?)\s*$/im) || [])[2] || '';
  return { enabled, url };
}

// 按网络服务（Wi-Fi、Ethernet…）读取可回滚的完整快照。
function readSnapshot(service, options = {}) {
  const name = String(service || '').trim();
  if (!name) return { ok: false, error: 'network_service_required' };
  const run = (args) => runCommand(options, 'networksetup', args);
  const webResult = run(['-getwebproxy', name]);
  const secureWebResult = run(['-getsecurewebproxy', name]);
  const socksResult = run(['-getsocksfirewallproxy', name]);
  const pacResult = run(['-getautoproxyurl', name]);
  const results = [webResult, secureWebResult, socksResult, pacResult];
  if (results.some((result) => !succeeded(result))) {
    return {
      ok: false,
      error: 'system_proxy_snapshot_unavailable',
      service,
      failures: results.map((result, index) => (succeeded(result) ? null : index)).filter((value) => value !== null)
    };
  }
  return {
    ok: true,
    service: name,
    web: parseNetworksetupProxy(output(webResult)),
    secureWeb: parseNetworksetupProxy(output(secureWebResult)),
    socks: parseNetworksetupProxy(output(socksResult)),
    pac: parseNetworksetupPac(output(pacResult))
  };
}

function currentFromSnapshot(snapshot) {
  return { web: snapshot.web, secureWeb: snapshot.secureWeb, socks: snapshot.socks, pac: snapshot.pac };
}

function enableOperations({ service, proxy }) {
  const host = proxy.host;
  return [
    { key: 'web', command: 'networksetup', args: ['-setwebproxy', service, host, String(proxy.port)] },
    { key: 'web-state', command: 'networksetup', args: ['-setwebproxystate', service, 'on'] },
    { key: 'secureWeb', command: 'networksetup', args: ['-setsecurewebproxy', service, host, String(proxy.port)] },
    { key: 'secureWeb-state', command: 'networksetup', args: ['-setsecurewebproxystate', service, 'on'] },
    { key: 'socks', command: 'networksetup', args: ['-setsocksfirewallproxy', service, host, String(proxy.port)] },
    { key: 'socks-state', command: 'networksetup', args: ['-setsocksfirewallproxystate', service, 'on'] }
  ];
}

function disableOperations({ service }) {
  return [
    { key: 'web-disable', command: 'networksetup', args: ['-setwebproxystate', service, 'off'] },
    { key: 'secureWeb-disable', command: 'networksetup', args: ['-setsecurewebproxystate', service, 'off'] },
    { key: 'socks-disable', command: 'networksetup', args: ['-setsocksfirewallproxystate', service, 'off'] },
    { key: 'pac-disable', command: 'networksetup', args: ['-setautoproxystate', service, 'off'] }
  ];
}

function restoreOperations({ service, current = {} }) {
  const operations = [];
  const add = (key, args) => operations.push({ key, command: 'networksetup', args });
  for (const [kind, setter, stateSetter] of [
    ['web', '-setwebproxy', '-setwebproxystate'],
    ['secureWeb', '-setsecurewebproxy', '-setsecurewebproxystate'],
    ['socks', '-setsocksfirewallproxy', '-setsocksfirewallproxystate']
  ]) {
    const value = current[kind] || {};
    if (value.enabled && value.server && value.port) {
      add(`${kind}-restore`, [setter, service, value.server, String(value.port)]);
      add(`${kind}-restore-state`, [stateSetter, service, 'on']);
    } else {
      add(`${kind}-restore-state`, [stateSetter, service, 'off']);
    }
  }
  if (current.pac?.enabled && current.pac.url) {
    add('pac-restore', ['-setautoproxyurl', service, current.pac.url]);
    add('pac-restore-state', ['-setautoproxystate', service, 'on']);
  } else {
    add('pac-restore-state', ['-setautoproxystate', service, 'off']);
  }
  return operations;
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
  // 系统代理按网络服务设置，规划前必须指定服务名。
  requiresService: true,
  detectProxy,
  readSnapshot,
  currentFromSnapshot,
  snapshotFor: ({ service, current }) => ({ service, ...current }),
  enableOperations,
  disableOperations,
  restoreOperations,
  tun,
  parseNetworksetupPac,
  parseNetworksetupProxy
});
