'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand } = require('../proxy-target-plugins/proxy-command');
const { output, probeFailureStatus, runCommand } = require('./os-command');

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
  tun
});
