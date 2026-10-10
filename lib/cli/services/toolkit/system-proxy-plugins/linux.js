'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand } = require('../proxy-target-plugins/proxy-command');
const { output, probeFailureStatus, runCommand } = require('./os-command');

function detectProxy(options, result) {
  result.source = 'gsettings';
  const modeProbe = execCommand('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], options);
  if (!modeProbe.ok) {
    result.probeStatus = probeFailureStatus(modeProbe);
    return result;
  }
  const httpMode = modeProbe.stdout;
  result.probeStatus = 'unset';
  if (httpMode.includes('manual')) {
    const hostProbe = execCommand('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'], options);
    const portProbe = execCommand('gsettings', ['get', 'org.gnome.system.proxy.http', 'port'], options);
    if (!hostProbe.ok || !portProbe.ok) {
      result.probeStatus = 'error';
      return result;
    }
    const host = hostProbe.stdout.replace(/'/g, '');
    const port = portProbe.stdout;
    if (host && port && port !== '0') {
      result.enabled = true;
      result.probeStatus = 'available';
      result.httpProxy = `http://${host}:${port}`;
    }
  }
  return result;
}

const tun = {
  probe(options) {
    return {
      interfaceOutput: output(runCommand(options, 'ip', ['-o', 'link', 'show', 'type', 'tun'])),
      routeOutput: output(runCommand(options, 'ip', ['rule', 'show'])),
      processOutput: output(runCommand(options, 'ps', ['-eo', 'pid=,command=']))
    };
  },
  interfaceDetected: ({ interfaceOutput }) => Boolean(interfaceOutput.trim()),
  routeDetected: ({ routeOutput }) => /(^|\n)\d+:/m.test(routeOutput)
};

module.exports = Object.freeze({
  id: 'linux',
  name: 'GNOME 系统代理（gsettings）',
  capability: 'toolkit.system-proxy',
  hostPlatform: 'linux',
  platforms: Object.freeze([CLIENT_PLATFORMS.LINUX]),
  detectProxy,
  tun
});
