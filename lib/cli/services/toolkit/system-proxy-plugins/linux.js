'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand } = require('../proxy-target-plugins/proxy-command');
const { output, probeFailureStatus, runCommand, succeeded } = require('./os-command');

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

function unquoteGsettings(value) {
  return String(value || '').trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

function readSnapshot(_service, options = {}) {
  const run = (args) => runCommand(options, 'gsettings', args);
  const modeResult = run(['get', 'org.gnome.system.proxy', 'mode']);
  if (!succeeded(modeResult)) return { ok: false, error: 'system_proxy_snapshot_unavailable' };
  const mode = unquoteGsettings(output(modeResult));
  const read = (schema, key) => unquoteGsettings(output(run(['get', schema, key])));
  return {
    ok: true,
    mode: mode || 'none',
    http: { host: read('org.gnome.system.proxy.http', 'host'), port: Number(read('org.gnome.system.proxy.http', 'port')) || 0 },
    https: { host: read('org.gnome.system.proxy.https', 'host'), port: Number(read('org.gnome.system.proxy.https', 'port')) || 0 },
    socks: { host: read('org.gnome.system.proxy.socks', 'host'), port: Number(read('org.gnome.system.proxy.socks', 'port')) || 0 },
    autoconfigUrl: read('org.gnome.system.proxy', 'autoconfig-url')
  };
}

function enableOperations({ proxy }) {
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

function disableOperations() {
  return [{ key: 'linux-mode-none', command: 'gsettings', args: ['set', 'org.gnome.system.proxy', 'mode', 'none'] }];
}

function restoreOperations({ current = {} }) {
  const mode = ['none', 'manual', 'auto'].includes(current.mode) ? current.mode : 'none';
  const operations = [{ key: 'linux-mode-restore', command: 'gsettings', args: ['set', 'org.gnome.system.proxy', 'mode', mode] }];
  if (mode === 'manual') {
    for (const [schema, value] of [
      ['org.gnome.system.proxy.http', current.http],
      ['org.gnome.system.proxy.https', current.https],
      ['org.gnome.system.proxy.socks', current.socks]
    ]) {
      if (!value) continue;
      operations.push({ key: `linux-${schema}-host-restore`, command: 'gsettings', args: ['set', schema, 'host', String(value.host || '')] });
      operations.push({ key: `linux-${schema}-port-restore`, command: 'gsettings', args: ['set', schema, 'port', String(Number(value.port) || 0)] });
    }
  }
  if (mode === 'auto' && current.autoconfigUrl) {
    operations.push({ key: 'linux-autoconfig-restore', command: 'gsettings', args: ['set', 'org.gnome.system.proxy', 'autoconfig-url', String(current.autoconfigUrl)] });
  }
  return operations;
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
