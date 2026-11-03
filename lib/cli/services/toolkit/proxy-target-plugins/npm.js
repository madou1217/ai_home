'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand, execCommandAsync, parseProxyUrl, summarizeOperations } = require('./proxy-command');

function buildReadResult(npmProxy, npmHttpsProxy) {
  return {
    scope: 'user-config',
    source: 'npm-config',
    probeStatus: (npmProxy && npmProxy !== 'null') || (npmHttpsProxy && npmHttpsProxy !== 'null') ? 'available' : 'unset',
    httpProxy: npmProxy && npmProxy !== 'null' ? npmProxy : '',
    httpsProxy: npmHttpsProxy && npmHttpsProxy !== 'null' ? npmHttpsProxy : ''
  };
}

/** 两次 npm config get 并发跑，不占主线程。 */
async function readAsync(options = {}) {
  const [proxyProbe, httpsProbe] = await Promise.all([
    execCommandAsync('npm', ['config', 'get', 'proxy'], options),
    execCommandAsync('npm', ['config', 'get', 'https-proxy'], options)
  ]);
  return buildReadResult(proxyProbe.stdout, httpsProbe.stdout);
}

function read(options = {}) {
  return buildReadResult(
    execCommand('npm', ['config', 'get', 'proxy'], options).stdout,
    execCommand('npm', ['config', 'get', 'https-proxy'], options).stdout
  );
}

/**
 * Set npm user proxy configuration.
 */
function write(proxyUrl, options = {}) {
  const norm = String(proxyUrl || '').trim();
  if (norm && !parseProxyUrl(norm)) return { ok: false, error: 'invalid_proxy_url', operations: [] };
  const specs = norm
    ? [
        { key: 'proxy', args: ['config', 'set', 'proxy', norm] },
        { key: 'https-proxy', args: ['config', 'set', 'https-proxy', norm] }
      ]
    : [
        { key: 'proxy', args: ['config', 'delete', 'proxy'] },
        { key: 'https-proxy', args: ['config', 'delete', 'https-proxy'] }
      ];
  const operations = specs.map((spec) => {
    const result = execCommand('npm', spec.args, options);
    return { key: spec.key, ok: result.ok, exitCode: result.status, stderr: result.stderr };
  });
  const summary = summarizeOperations(operations);
  return {
    ...summary,
    npm: summary.ok
      ? { httpProxy: norm, httpsProxy: norm }
      : {
          httpProxy: execCommand('npm', ['config', 'get', 'proxy'], options).stdout.replace(/^null$/, ''),
          httpsProxy: execCommand('npm', ['config', 'get', 'https-proxy'], options).stdout.replace(/^null$/, '')
        }
  };
}

module.exports = Object.freeze({
  id: 'npm',
  capability: 'toolkit.proxy-target',
  name: 'npm',
  scopeLabel: '用户级 proxy / https-proxy',
  platforms: Object.freeze([CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.WINDOWS, CLIENT_PLATFORMS.LINUX]),
  read,
  readAsync,
  write
});
