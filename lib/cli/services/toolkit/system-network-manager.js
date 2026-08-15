'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { detectSystemProxy } = require('./proxy-manager');

const WINDOWS_INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function command(options, command, args = []) {
  if (typeof options.execCommand === 'function') return options.execCommand(command, args);
  try {
    return options.spawnSync
      ? options.spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true })
      : spawnSync(command, args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  } catch (error) {
    return { status: null, stdout: '', stderr: error.message };
  }
}

function output(result) {
  return String(result?.stdout || '');
}

function parseTunProcesses(text, options = {}) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return { active: false, owner: null, evidence: [] };
  const ownedPid = Number(options.ownedPid);
  if (Number.isInteger(ownedPid) && ownedPid > 0) {
    const ownedProcess = String(text || '').split(/\r?\n/).find((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return match && Number(match[1]) === ownedPid && /mihomo|clash-meta/i.test(match[2]);
    });
    if (ownedProcess) return { active: true, owner: 'aih', evidence: ['process:aih-mihomo'] };
  }
  if (/clash[- ]?verge|verge[- ]mihomo/.test(lower)) return { active: true, owner: 'clash-verge', evidence: ['process:clash-verge'] };
  if (/mihomo|clash-meta/.test(lower)) return { active: true, owner: 'mihomo', evidence: ['process:mihomo'] };
  if (/sing-box|singbox/.test(lower)) return { active: true, owner: 'sing-box', evidence: ['process:sing-box'] };
  return { active: true, owner: 'external', evidence: ['process:network-core'] };
}

function detectTun(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  let interfaceOutput = '';
  let routeOutput = '';
  let processOutput = '';
  if (platform === 'darwin') {
    interfaceOutput = output(command(options, 'ifconfig'));
    routeOutput = output(command(options, 'netstat', ['-rn']));
    processOutput = output(command(options, 'ps', ['-axo', 'pid=,command=']));
  } else if (platform === 'linux') {
    interfaceOutput = output(command(options, 'ip', ['-o', 'link', 'show', 'type', 'tun']));
    routeOutput = output(command(options, 'ip', ['rule', 'show']));
    processOutput = output(command(options, 'ps', ['-eo', 'pid=,command=']));
  } else if (platform === 'win32') {
    interfaceOutput = output(command(options, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapter | Select-Object Name,Status,InterfaceDescription | ConvertTo-Json -Compress']));
    routeOutput = output(command(options, 'route.exe', ['print']));
    processOutput = output(command(options, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Select-Object Name,Id | ConvertTo-Json -Compress']));
  }
  const process = parseTunProcesses(processOutput, { ownedPid: options.ownedPid });
  const interfaceMatch = platform === 'darwin'
    ? /(?:^|\n)utun\d+:/m.test(interfaceOutput)
    : platform === 'linux'
      ? Boolean(interfaceOutput.trim())
      : /wintun|wireguard|tap|tun/i.test(interfaceOutput);
  const routeMatch = platform === 'darwin'
    ? /utun\d+/i.test(routeOutput)
    : platform === 'linux'
      ? /(^|\n)\d+:/m.test(routeOutput)
      : /wintun|wireguard|0\.0\.0\.0\s+0\.0\.0\.0/i.test(`${interfaceOutput}\n${routeOutput}`);
  const active = Boolean(interfaceMatch && (routeMatch || process.active));
  return {
    state: active ? 'active' : (interfaceMatch || routeMatch ? 'unknown' : 'inactive'),
    owner: active ? process.owner : null,
    interfaceDetected: interfaceMatch,
    routeDetected: routeMatch,
    evidence: [...new Set([
      ...(interfaceMatch ? ['interface'] : []),
      ...(routeMatch ? ['route'] : []),
      ...process.evidence
    ])]
  };
}

function detectNetworkLayer(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  const systemProxy = options.systemProxy || detectSystemProxy({ ...options, platform });
  const tun = options.tun || detectTun({ ...options, platform });
  const effectiveRoute = tun.state === 'active'
    ? 'tun'
    : systemProxy.enabled
      ? 'system-proxy'
        : tun.state === 'unknown'
          ? 'unknown'
          : 'direct-unknown';
  const externalTun = tun.state === 'active' && tun.owner !== 'aih';
  return {
    platform,
    systemProxy,
    tun,
    effectiveRoute,
    effectiveRouteKnown: effectiveRoute !== 'direct-unknown' && effectiveRoute !== 'unknown',
    takeoverAllowed: !externalTun,
    conflicts: externalTun ? [`external_tun_active:${tun.owner || 'unknown'}`] : []
  };
}

function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

function parseProxyUrl(proxyUrl) {
  try {
    const url = new URL(String(proxyUrl || ''));
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || url.username || url.password) return null;
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { protocol: url.protocol, host: url.hostname, port };
  } catch (_error) {
    return null;
  }
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

function readMacProxySnapshot(service, options = {}) {
  const name = String(service || '').trim();
  if (!name) return { ok: false, error: 'network_service_required' };
  const run = (args) => command(options, 'networksetup', args);
  const webResult = run(['-getwebproxy', name]);
  const secureWebResult = run(['-getsecurewebproxy', name]);
  const socksResult = run(['-getsocksfirewallproxy', name]);
  const pacResult = run(['-getautoproxyurl', name]);
  const results = [webResult, secureWebResult, socksResult, pacResult];
  if (results.some((result) => result?.status !== 0 && result?.ok !== true)) {
    return {
      ok: false,
      error: 'system_proxy_snapshot_unavailable',
      service,
      failures: results.map((result, index) => result?.status === 0 || result?.ok === true ? null : index).filter((value) => value !== null)
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

function unquoteGsettings(value) {
  return String(value || '').trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

function readLinuxProxySnapshot(options = {}) {
  const run = (args) => command(options, 'gsettings', args);
  const modeResult = run(['get', 'org.gnome.system.proxy', 'mode']);
  if (modeResult?.status !== 0 && modeResult?.ok !== true) return { ok: false, error: 'system_proxy_snapshot_unavailable' };
  const mode = unquoteGsettings(output(modeResult));
  const read = (schema, key) => unquoteGsettings(output(run(['get', schema, key])));
  const snapshot = {
    mode: mode || 'none',
    http: { host: read('org.gnome.system.proxy.http', 'host'), port: Number(read('org.gnome.system.proxy.http', 'port')) || 0 },
    https: { host: read('org.gnome.system.proxy.https', 'host'), port: Number(read('org.gnome.system.proxy.https', 'port')) || 0 },
    socks: { host: read('org.gnome.system.proxy.socks', 'host'), port: Number(read('org.gnome.system.proxy.socks', 'port')) || 0 },
    autoconfigUrl: read('org.gnome.system.proxy', 'autoconfig-url')
  };
  return { ok: true, ...snapshot };
}

function readWindowsProxySnapshot(options = {}) {
  const result = command(options, 'reg.exe', ['query', WINDOWS_INTERNET_SETTINGS_KEY]);
  if (result?.status !== 0 && result?.ok !== true) return { ok: false, error: 'system_proxy_snapshot_unavailable' };
  const text = output(result);
  const value = (name) => (text.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im')) || [])[1]?.trim() || '';
  return {
    ok: true,
    proxyEnable: Number(value('ProxyEnable')) || 0,
    proxyServer: value('ProxyServer'),
    proxyOverride: value('ProxyOverride'),
    autoConfigUrl: value('AutoConfigURL')
  };
}

function macOperations(service, proxy) {
  const host = proxy.host === '::1' ? '::1' : proxy.host;
  return [
    { key: 'web', command: 'networksetup', args: ['-setwebproxy', service, host, String(proxy.port)] },
    { key: 'web-state', command: 'networksetup', args: ['-setwebproxystate', service, 'on'] },
    { key: 'secureWeb', command: 'networksetup', args: ['-setsecurewebproxy', service, host, String(proxy.port)] },
    { key: 'secureWeb-state', command: 'networksetup', args: ['-setsecurewebproxystate', service, 'on'] },
    { key: 'socks', command: 'networksetup', args: ['-setsocksfirewallproxy', service, host, String(proxy.port)] },
    { key: 'socks-state', command: 'networksetup', args: ['-setsocksfirewallproxystate', service, 'on'] }
  ];
}

function macDisableOperations(service) {
  return [
    { key: 'web-disable', command: 'networksetup', args: ['-setwebproxystate', service, 'off'] },
    { key: 'secureWeb-disable', command: 'networksetup', args: ['-setsecurewebproxystate', service, 'off'] },
    { key: 'socks-disable', command: 'networksetup', args: ['-setsocksfirewallproxystate', service, 'off'] },
    { key: 'pac-disable', command: 'networksetup', args: ['-setautoproxystate', service, 'off'] }
  ];
}

function linuxOperations(proxy) {
  const host = proxy.host;
  const port = String(proxy.port);
  return [
    { key: 'linux-mode', command: 'gsettings', args: ['set', 'org.gnome.system.proxy', 'mode', 'manual'] },
    { key: 'linux-http-host', command: 'gsettings', args: ['set', 'org.gnome.system.proxy.http', 'host', host] },
    { key: 'linux-http-port', command: 'gsettings', args: ['set', 'org.gnome.system.proxy.http', 'port', port] },
    { key: 'linux-https-host', command: 'gsettings', args: ['set', 'org.gnome.system.proxy.https', 'host', host] },
    { key: 'linux-https-port', command: 'gsettings', args: ['set', 'org.gnome.system.proxy.https', 'port', port] },
    { key: 'linux-socks-host', command: 'gsettings', args: ['set', 'org.gnome.system.proxy.socks', 'host', host] },
    { key: 'linux-socks-port', command: 'gsettings', args: ['set', 'org.gnome.system.proxy.socks', 'port', port] }
  ];
}

function linuxDisableOperations() {
  return [{ key: 'linux-mode-none', command: 'gsettings', args: ['set', 'org.gnome.system.proxy', 'mode', 'none'] }];
}

function linuxRollbackOperations(snapshot = {}) {
  const mode = ['none', 'manual', 'auto'].includes(snapshot.mode) ? snapshot.mode : 'none';
  const operations = [{ key: 'linux-mode-restore', command: 'gsettings', args: ['set', 'org.gnome.system.proxy', 'mode', mode] }];
  if (mode === 'manual') {
    for (const [schema, value] of [
      ['org.gnome.system.proxy.http', snapshot.http],
      ['org.gnome.system.proxy.https', snapshot.https],
      ['org.gnome.system.proxy.socks', snapshot.socks]
    ]) {
      if (!value) continue;
      operations.push({ key: `linux-${schema}-host-restore`, command: 'gsettings', args: ['set', schema, 'host', String(value.host || '')] });
      operations.push({ key: `linux-${schema}-port-restore`, command: 'gsettings', args: ['set', schema, 'port', String(Number(value.port) || 0)] });
    }
  }
  if (mode === 'auto' && snapshot.autoconfigUrl) {
    operations.push({ key: 'linux-autoconfig-restore', command: 'gsettings', args: ['set', 'org.gnome.system.proxy', 'autoconfig-url', String(snapshot.autoconfigUrl)] });
  }
  return operations;
}

function windowsOperations(proxy) {
  const server = `${proxy.host}:${proxy.port}`;
  return [
    { key: 'windows-server', command: 'reg.exe', args: ['add', WINDOWS_INTERNET_SETTINGS_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', server, '/f'] },
    { key: 'windows-enable', command: 'reg.exe', args: ['add', WINDOWS_INTERNET_SETTINGS_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'] },
    { key: 'windows-refresh', command: 'RUNDLL32.EXE', args: ['user32.dll,UpdatePerUserSystemParameters'] }
  ];
}

function windowsDisableOperations() {
  return [
    { key: 'windows-disable', command: 'reg.exe', args: ['add', WINDOWS_INTERNET_SETTINGS_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'] },
    { key: 'windows-refresh', command: 'RUNDLL32.EXE', args: ['user32.dll,UpdatePerUserSystemParameters'] }
  ];
}

function windowsRollbackOperations(snapshot = {}) {
  const operations = [];
  if (snapshot.proxyServer) {
    operations.push({ key: 'windows-server-restore', command: 'reg.exe', args: ['add', WINDOWS_INTERNET_SETTINGS_KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', snapshot.proxyServer, '/f'] });
  }
  operations.push({ key: 'windows-enable-restore', command: 'reg.exe', args: ['add', WINDOWS_INTERNET_SETTINGS_KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', snapshot.proxyEnable === 1 ? '1' : '0', '/f'] });
  if (snapshot.proxyOverride) {
    operations.push({ key: 'windows-override-restore', command: 'reg.exe', args: ['add', WINDOWS_INTERNET_SETTINGS_KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', snapshot.proxyOverride, '/f'] });
  }
  operations.push({ key: 'windows-refresh-restore', command: 'RUNDLL32.EXE', args: ['user32.dll,UpdatePerUserSystemParameters'] });
  return operations;
}

function macRollbackOperations(service, snapshot = {}) {
  const operations = [];
  const add = (key, args) => operations.push({ key, command: 'networksetup', args });
  for (const [kind, setter, stateSetter] of [
    ['web', '-setwebproxy', '-setwebproxystate'],
    ['secureWeb', '-setsecurewebproxy', '-setsecurewebproxystate'],
    ['socks', '-setsocksfirewallproxy', '-setsocksfirewallproxystate']
  ]) {
    const current = snapshot[kind] || {};
    if (current.enabled && current.server && current.port) {
      add(`${kind}-restore`, [setter, service, current.server, String(current.port)]);
      add(`${kind}-restore-state`, [stateSetter, service, 'on']);
    } else {
      add(`${kind}-restore-state`, [stateSetter, service, 'off']);
    }
  }
  if (snapshot.pac?.enabled && snapshot.pac.url) {
    add('pac-restore', ['-setautoproxyurl', service, snapshot.pac.url]);
    add('pac-restore-state', ['-setautoproxystate', service, 'on']);
  } else {
    add('pac-restore-state', ['-setautoproxystate', service, 'off']);
  }
  return operations;
}

function planSystemProxy(input = {}) {
  const platform = String(input.platform || process.platform).toLowerCase();
  const proxy = parseProxyUrl(input.proxyUrl);
  if (input.action !== 'enable' && input.action !== 'disable' && input.action !== 'restore') {
    return { ok: false, error: 'unsupported_system_proxy_action' };
  }
  if (input.action === 'enable' && !proxy) return { ok: false, error: 'invalid_local_proxy_url' };
  if (input.network?.tun?.state === 'active' && input.network.tun.owner !== 'aih') {
    return { ok: false, error: 'external_tun_active' };
  }
  const service = String(input.service || '').trim();
  if (platform === 'darwin' && !service) return { ok: false, error: 'network_service_required' };
  if (!['darwin', 'linux', 'win32'].includes(platform)) return { ok: false, error: 'system_proxy_platform_unsupported' };
  const current = input.current || {};
  let operations;
  let rollbackOperations;
  let snapshot;
  if (platform === 'darwin') {
    operations = input.action === 'enable'
      ? macOperations(service, proxy)
      : input.action === 'disable'
        ? macDisableOperations(service)
        : macRollbackOperations(service, current);
    rollbackOperations = macRollbackOperations(service, current);
    snapshot = { service, ...current };
  } else if (platform === 'linux') {
    operations = input.action === 'enable'
      ? linuxOperations(proxy)
      : input.action === 'disable'
        ? linuxDisableOperations()
        : linuxRollbackOperations(current);
    rollbackOperations = linuxRollbackOperations(current);
    snapshot = { ...current };
  } else {
    operations = input.action === 'enable'
      ? windowsOperations(proxy)
      : input.action === 'disable'
        ? windowsDisableOperations()
        : windowsRollbackOperations(current);
    rollbackOperations = windowsRollbackOperations(current);
    snapshot = { ...current };
  }
  return {
    ok: true,
    plan: {
      platform,
      action: input.action,
      service,
      proxyUrl: input.proxyUrl || null,
      snapshot,
      snapshotHash: hashSnapshot(snapshot),
      operations,
      rollbackOperations
    }
  };
}

async function executeSystemProxyPlan(plan, options = {}) {
  if (options.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  if (!plan || !plan.snapshotHash || options.expectedSnapshotHash !== plan.snapshotHash) {
    return { ok: false, error: 'system_proxy_snapshot_changed' };
  }
  const run = options.execCommand || ((commandName, args) => command(options, commandName, args));
  const operations = [];
  for (const operation of plan.operations || []) {
    const result = run(operation.command, operation.args);
    const item = { key: operation.key, ok: result?.status === 0 || result?.ok === true, exitCode: result?.status ?? null };
    operations.push(item);
    if (!item.ok) {
      let rollbackApplied = true;
      for (const rollback of plan.rollbackOperations || []) {
        const rollbackResult = run(rollback.command, rollback.args);
        if (!(rollbackResult?.status === 0 || rollbackResult?.ok === true)) rollbackApplied = false;
      }
      return {
        ok: false,
        error: rollbackApplied ? 'system_proxy_rollback_applied' : 'system_proxy_rollback_failed',
        rollbackApplied,
        operations
      };
    }
  }
  return { ok: true, applied: true, operations };
}

module.exports = {
  detectNetworkLayer,
  detectTun,
  executeSystemProxyPlan,
  hashSnapshot,
  parseProxyUrl,
  parseNetworksetupPac,
  parseNetworksetupProxy,
  planSystemProxy,
  readMacProxySnapshot,
  readLinuxProxySnapshot,
  readWindowsProxySnapshot
};
