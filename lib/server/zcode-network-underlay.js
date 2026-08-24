'use strict';

// ZCode 节点出口只读探测 macOS 的物理 underlay。这里不修改路由、DNS 或系统代理；
// 仅把默认物理接口与该接口的 scoped DNS 提供给 sing-box 的远端 outbound。

const net = require('node:net');
const { spawnSync: nodeSpawnSync } = require('node:child_process');

const { normalizeClientPlatform } = require('../runtime/client-platform');

function normalizePhysicalInterfaceName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(name)) return '';
  if (/^(?:lo\d*|utun\d*|tun\d*|tap\d*|bridge\d*|awdl\d*|llw\d*)$/i.test(name)) return '';
  return name;
}

function parseMacDefaultRouteInterface(output) {
  const match = String(output || '').match(/^\s*interface:\s*(\S+)\s*$/im);
  return normalizePhysicalInterfaceName(match?.[1]);
}

function normalizeDnsServer(value) {
  const address = String(value || '').trim().replace(/^\[|\]$/g, '').split('%')[0];
  const family = net.isIP(address);
  if (!family) return '';
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224) return '';
    if (octets[0] === 169 && octets[1] === 254) return '';
    if (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19)) return '';
    return address;
  }
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('ff')) {
    return '';
  }
  return address;
}

function collectDnsServers(blocks) {
  const result = [];
  for (const block of blocks) {
    for (const match of String(block || '').matchAll(/^\s*nameserver\[\d+\]\s*:\s*(\S+)\s*$/gim)) {
      const address = normalizeDnsServer(match[1]);
      if (address && !result.includes(address)) result.push(address);
    }
  }
  return result;
}

function parseMacScopedDnsServers(output, interfaceName) {
  const normalizedInterface = normalizePhysicalInterfaceName(interfaceName);
  if (!normalizedInterface) return [];
  const blocks = String(output || '').split(/(?=^resolver #\d+)/gm);
  const scoped = blocks.filter((block) => {
    const match = block.match(/^\s*if_index\s*:\s*\d+\s*\(([^)]+)\)\s*$/im);
    return normalizePhysicalInterfaceName(match?.[1]) === normalizedInterface;
  });
  return collectDnsServers(scoped);
}

function parseMacFallbackDnsServers(output) {
  const blocks = String(output || '').split(/(?=^resolver #\d+)/gm)
    .filter((block) => !/^\s*if_index\s*:/im.test(block));
  return collectDnsServers(blocks);
}

function runCommand(spawnSync, command, args) {
  try {
    return spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    }) || {};
  } catch (error) {
    return { status: null, stdout: '', stderr: String(error?.message || error || '') };
  }
}

function resolveZcodeNetworkUnderlay(options = {}) {
  const rawPlatform = options.platform || process.platform;
  const platform = normalizeClientPlatform(rawPlatform);
  if (platform !== 'macos') return { ok: false, error: 'not_supported', platform };
  const spawnSync = options.spawnSync || nodeSpawnSync;
  const route = runCommand(spawnSync, 'route', ['-n', 'get', 'default']);
  const interfaceName = route.status === 0
    ? parseMacDefaultRouteInterface(route.stdout)
    : '';
  if (!interfaceName) return { ok: false, error: 'zcode_underlay_interface_unavailable' };

  const dns = runCommand(spawnSync, 'scutil', ['--dns']);
  const scopedServers = dns.status === 0
    ? parseMacScopedDnsServers(dns.stdout, interfaceName)
    : [];
  const dnsServer = scopedServers[0]
    || (dns.status === 0 ? parseMacFallbackDnsServers(dns.stdout)[0] : '')
    || '';
  if (!dnsServer && options.requireDns !== false) {
    return { ok: false, error: 'zcode_underlay_dns_unavailable', interfaceName };
  }
  return { ok: true, platform, interfaceName, dnsServer };
}

function isLoopbackHost(value) {
  const host = String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function resolveTargetServer(target) {
  if (!target || typeof target !== 'object' || target.kind === 'direct') return '';
  if (target.kind === 'node') return String(target.node?.server || '').trim();
  if (target.kind !== 'proxy-url') return '';
  const raw = String(target.proxyUrl || '').trim();
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return parsed.hostname;
  } catch {
    return '';
  }
}

function targetNeedsZcodeNetworkUnderlay(target) {
  const server = resolveTargetServer(target);
  return Boolean(server) && !isLoopbackHost(server);
}

function targetNeedsZcodeNetworkDns(target) {
  const server = resolveTargetServer(target).replace(/^\[|\]$/g, '');
  return Boolean(server) && !isLoopbackHost(server) && !net.isIP(server);
}

module.exports = {
  normalizeDnsServer,
  normalizePhysicalInterfaceName,
  parseMacDefaultRouteInterface,
  parseMacScopedDnsServers,
  resolveZcodeNetworkUnderlay,
  targetNeedsZcodeNetworkDns,
  targetNeedsZcodeNetworkUnderlay
};
