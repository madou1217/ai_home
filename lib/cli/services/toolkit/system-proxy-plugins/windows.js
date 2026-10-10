'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { readWindowsSystemProxy } = require('../../../../runtime/windows-system-proxy');
const { output, runCommand } = require('./os-command');

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
  detectProxy,
  tun
});
