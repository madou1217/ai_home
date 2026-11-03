'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand, execCommandAsync, parseProxyUrl, summarizeOperations } = require('./proxy-command');

/**
 * 读 Git 代理配置：三次 git config 查询互不依赖，并发跑。
 * 同步串行版本在 WebUI 里要占住主线程 ~3 个进程的时间，见 proxy-command 的说明。
 */
async function readAsync(options = {}) {
  const [globalHttpProbe, globalHttpsProbe, allProxyProbe] = await Promise.all([
    execCommandAsync('git', ['config', '--global', 'http.proxy'], options),
    execCommandAsync('git', ['config', '--global', 'https.proxy'], options),
    execCommandAsync('git', ['config', '--global', '--get-regexp', 'proxy'], options)
  ]);
  return buildReadResult(globalHttpProbe, globalHttpsProbe, allProxyProbe);
}

function buildReadResult(globalHttpProbe, globalHttpsProbe, allProxyProbe) {
  const globalHttp = globalHttpProbe.stdout;
  const globalHttps = globalHttpsProbe.stdout;
  const allProxyLines = allProxyProbe.stdout;
  const scopedProxies = [];
  if (allProxyLines) {
    const lines = allProxyLines.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        scopedProxies.push({
          key: parts[0],
          value: parts.slice(1).join(' ')
        });
      }
    }
  }

  return {
    scope: 'global',
    source: 'git-config',
    probeStatus: globalHttp || globalHttps || scopedProxies.length ? 'available' : 'unset',
    httpProxy: globalHttp || '',
    httpsProxy: globalHttps || '',
    scopedProxies
  };
}

/**
 * Get detailed Git proxy configuration across all scopes and matchers
 */
function read(options = {}) {
  return buildReadResult(
    execCommand('git', ['config', '--global', 'http.proxy'], options),
    execCommand('git', ['config', '--global', 'https.proxy'], options),
    execCommand('git', ['config', '--global', '--get-regexp', 'proxy'], options)
  );
}

/**
 * Set Git global proxy
 */
function write(proxyUrl, options = {}) {
  const norm = String(proxyUrl || '').trim();
  if (norm && !parseProxyUrl(norm)) return { ok: false, error: 'invalid_proxy_url', operations: [] };
  const specs = norm
    ? [
        { key: 'http.proxy', args: ['config', '--global', 'http.proxy', norm] },
        { key: 'https.proxy', args: ['config', '--global', 'https.proxy', norm] }
      ]
    : [
        { key: 'http.proxy', args: ['config', '--global', '--unset', 'http.proxy'], allowMissing: true },
        { key: 'https.proxy', args: ['config', '--global', '--unset', 'https.proxy'], allowMissing: true }
      ];
  const operations = specs.map((spec) => {
    const result = execCommand('git', spec.args, options);
    return {
      key: spec.key,
      ok: Boolean(result.ok || (spec.allowMissing && result.status === 5)),
      exitCode: result.status,
      stderr: result.stderr
    };
  });
  const summary = summarizeOperations(operations);
  return { ...summary, git: read(options) };
}

module.exports = Object.freeze({
  id: 'git',
  capability: 'toolkit.proxy-target',
  name: 'Git',
  scopeLabel: '全局 http.proxy / https.proxy',
  platforms: Object.freeze([CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.WINDOWS, CLIENT_PLATFORMS.LINUX]),
  read,
  readAsync,
  write
});
