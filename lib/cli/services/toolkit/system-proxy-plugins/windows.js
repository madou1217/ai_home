'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { readWindowsSystemProxy } = require('../../../../runtime/windows-system-proxy');
const { output, runCommand, succeeded } = require('./os-command');

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const REFRESH = { command: 'RUNDLL32.EXE', args: ['user32.dll,UpdatePerUserSystemParameters'] };
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

function detectProxy(options, result) {
  result.source = 'windows-registry';
  try {
    const readProxy = options.readWindowsSystemProxy || readWindowsSystemProxy;
    const winProxy = readProxy();
    if (winProxy.HTTP_PROXY || winProxy.HTTPS_PROXY || winProxy.ALL_PROXY) {
      result.enabled = true;
      result.probeStatus = 'available';
      result.httpProxy = winProxy.HTTP_PROXY || '';
      result.httpsProxy = winProxy.HTTPS_PROXY || '';
      result.socksProxy = winProxy.ALL_PROXY || '';
    } else {
      result.probeStatus = 'unset';
    }
  } catch (_error) {
    result.probeStatus = 'error';
  }
  return result;
}

function readSnapshot(_service, options = {}) {
  const result = runCommand(options, 'reg.exe', ['query', INTERNET_SETTINGS_KEY]);
  if (!succeeded(result)) return { ok: false, error: 'system_proxy_snapshot_unavailable' };
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

function regAdd(key, name, type, data) {
  return { key, command: 'reg.exe', args: ['add', INTERNET_SETTINGS_KEY, '/v', name, '/t', type, '/d', data, '/f'] };
}

function enableOperations({ proxy }) {
  return [
    regAdd('windows-server', 'ProxyServer', 'REG_SZ', `${proxy.host}:${proxy.port}`),
    regAdd('windows-enable', 'ProxyEnable', 'REG_DWORD', '1'),
    { key: 'windows-refresh', ...REFRESH }
  ];
}

function disableOperations() {
  return [
    regAdd('windows-disable', 'ProxyEnable', 'REG_DWORD', '0'),
    { key: 'windows-refresh', ...REFRESH }
  ];
}

function restoreOperations({ current = {} }) {
  const operations = [];
  if (current.proxyServer) operations.push(regAdd('windows-server-restore', 'ProxyServer', 'REG_SZ', current.proxyServer));
  operations.push(regAdd('windows-enable-restore', 'ProxyEnable', 'REG_DWORD', current.proxyEnable === 1 ? '1' : '0'));
  if (current.proxyOverride) operations.push(regAdd('windows-override-restore', 'ProxyOverride', 'REG_SZ', current.proxyOverride));
  operations.push({ key: 'windows-refresh-restore', ...REFRESH });
  return operations;
}

const tun = {
  probe(options) {
    return {
      interfaceOutput: output(runCommand(options, 'powershell.exe', [...POWERSHELL_ARGS, 'Get-NetAdapter | Select-Object Name,Status,InterfaceDescription | ConvertTo-Json -Compress'])),
      routeOutput: output(runCommand(options, 'route.exe', ['print'])),
      processOutput: output(runCommand(options, 'powershell.exe', [...POWERSHELL_ARGS, 'Get-Process | Select-Object Name,Id | ConvertTo-Json -Compress']))
    };
  },
  interfaceDetected: ({ interfaceOutput }) => /wintun|wireguard|tap|tun/i.test(interfaceOutput),
  routeDetected: ({ interfaceOutput, routeOutput }) => /wintun|wireguard|0\.0\.0\.0\s+0\.0\.0\.0/i.test(`${interfaceOutput}\n${routeOutput}`)
};

module.exports = Object.freeze({
  id: 'windows',
  name: 'Windows Internet 设置（注册表）',
  capability: 'toolkit.system-proxy',
  hostPlatform: 'win32',
  platforms: Object.freeze([CLIENT_PLATFORMS.WINDOWS]),
  requiresService: false,
  detectProxy,
  readSnapshot,
  currentFromSnapshot: ({ ok: _ok, ...current }) => current,
  snapshotFor: ({ current }) => ({ ...current }),
  enableOperations,
  disableOperations,
  restoreOperations,
  tun
});
