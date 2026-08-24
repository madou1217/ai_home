'use strict';

const { spawnSync } = require('node:child_process');
const { detectSystemProxy } = require('./proxy-manager');

function command(options, commandName, args = []) {
  if (typeof options.execCommand === 'function') return options.execCommand(commandName, args);
  try {
    const run = options.spawnSync || spawnSync;
    return run(commandName, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
  } catch (error) {
    return { status: null, stdout: '', stderr: error.message };
  }
}

function output(result) {
  return String(result?.stdout || '');
}

function detectTunProcess(text) {
  const lower = String(text || '').toLowerCase();
  if (/clash[- ]?verge/u.test(lower)) {
    return { active: true, owner: 'clash-verge', evidence: ['process:clash-verge'] };
  }
  if (/clash-meta/u.test(lower)) {
    return { active: true, owner: 'clash', evidence: ['process:clash'] };
  }
  if (/sing-box|singbox/u.test(lower)) {
    return { active: true, owner: 'sing-box', evidence: ['process:sing-box'] };
  }
  return { active: false, owner: null, evidence: [] };
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
    interfaceOutput = output(command(options, 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-NetAdapter | Select-Object Name,Status,InterfaceDescription | ConvertTo-Json -Compress'
    ]));
    routeOutput = output(command(options, 'route.exe', ['print']));
    processOutput = output(command(options, 'powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-Process | Select-Object Name,Id | ConvertTo-Json -Compress'
    ]));
  }

  const processObservation = detectTunProcess(processOutput);
  const interfaceDetected = platform === 'darwin'
    ? /(?:^|\n)utun\d+:/mu.test(interfaceOutput)
    : platform === 'linux'
      ? Boolean(interfaceOutput.trim())
      : /wintun|wireguard|tap|tun/iu.test(interfaceOutput);
  const routeDetected = platform === 'darwin'
    ? /utun\d+/iu.test(routeOutput)
    : platform === 'linux'
      ? /(^|\n)\d+:/mu.test(routeOutput)
      : /wintun|wireguard|0\.0\.0\.0\s+0\.0\.0\.0/iu.test(`${interfaceOutput}\n${routeOutput}`);
  const active = Boolean(interfaceDetected && (routeDetected || processObservation.active));
  return {
    state: active ? 'active' : (interfaceDetected || routeDetected ? 'unknown' : 'inactive'),
    owner: active ? (processObservation.owner || 'external') : null,
    interfaceDetected,
    routeDetected,
    evidence: [...new Set([
      ...(interfaceDetected ? ['interface'] : []),
      ...(routeDetected ? ['route'] : []),
      ...processObservation.evidence
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
  const externalTun = tun.state === 'active';
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

module.exports = {
  detectNetworkLayer,
  detectTun
};
