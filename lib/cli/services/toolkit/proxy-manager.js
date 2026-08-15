'use strict';

const { spawnSync } = require('node:child_process');
const { testEndpointLatency } = require('./mirror-manager');

/**
 * ProxyManager: manages developer network, CLI proxy settings, and connectivity diagnostics.
 * Single Responsibility: Check env proxies, git/npm/pip proxy settings, and test upstream AI connectivity.
 */

const CONNECTIVITY_TARGETS = [
  { id: 'openai', name: 'OpenAI API', url: 'https://api.openai.com/v1/models', host: 'api.openai.com' },
  { id: 'anthropic', name: 'Anthropic Claude API', url: 'https://api.anthropic.com/v1/messages', host: 'api.anthropic.com' },
  { id: 'github', name: 'GitHub', url: 'https://api.github.com', host: 'api.github.com' },
  { id: 'npmmirror', name: '淘宝 npmmirror', url: 'https://registry.npmmirror.com', host: 'registry.npmmirror.com' },
  { id: 'pypi_tuna', name: '清华大学 PyPI', url: 'https://pypi.tuna.tsinghua.edu.cn', host: 'pypi.tuna.tsinghua.edu.cn' }
];

function execCommand(cmd, args = []) {
  try {
    const res = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true
    });
    return {
      ok: res.status === 0,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim()
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e.message };
  }
}

/**
 * Get environment variable proxies and tool proxy settings
 */
function getProxyStatus() {
  const env = process.env;
  const envProxies = {
    httpProxy: env.http_proxy || env.HTTP_PROXY || '',
    httpsProxy: env.https_proxy || env.HTTPS_PROXY || '',
    allProxy: env.all_proxy || env.ALL_PROXY || '',
    noProxy: env.no_proxy || env.NO_PROXY || ''
  };

  // Git proxy
  const gitHttpProxy = execCommand('git', ['config', '--global', 'http.proxy']).stdout;
  const gitHttpsProxy = execCommand('git', ['config', '--global', 'https.proxy']).stdout;

  // npm proxy
  const npmProxy = execCommand('npm', ['config', 'get', 'proxy']).stdout;
  const npmHttpsProxy = execCommand('npm', ['config', 'get', 'https-proxy']).stdout;

  return {
    ok: true,
    env: envProxies,
    tools: {
      git: {
        httpProxy: gitHttpProxy || '',
        httpsProxy: gitHttpsProxy || ''
      },
      npm: {
        httpProxy: npmProxy && npmProxy !== 'null' ? npmProxy : '',
        httpsProxy: npmHttpsProxy && npmHttpsProxy !== 'null' ? npmHttpsProxy : ''
      }
    }
  };
}

/**
 * Set Git global proxy
 */
function setGitProxy(proxyUrl) {
  const norm = String(proxyUrl || '').trim();
  if (!norm) {
    // Unset
    execCommand('git', ['config', '--global', '--unset', 'http.proxy']);
    execCommand('git', ['config', '--global', '--unset', 'https.proxy']);
    return { ok: true, git: { httpProxy: '', httpsProxy: '' } };
  }
  execCommand('git', ['config', '--global', 'http.proxy', norm]);
  execCommand('git', ['config', '--global', 'https.proxy', norm]);
  return { ok: true, git: { httpProxy: norm, httpsProxy: norm } };
}

/**
 * Set npm proxy
 */
function setNpmProxy(proxyUrl) {
  const norm = String(proxyUrl || '').trim();
  if (!norm) {
    // Unset
    execCommand('npm', ['config', 'delete', 'proxy']);
    execCommand('npm', ['config', 'delete', 'https-proxy']);
    return { ok: true, npm: { httpProxy: '', httpsProxy: '' } };
  }
  execCommand('npm', ['config', 'set', 'proxy', norm]);
  execCommand('npm', ['config', 'set', 'https-proxy', norm]);
  return { ok: true, npm: { httpProxy: norm, httpsProxy: norm } };
}

/**
 * Run connectivity tests to upstream AI & developer services
 */
async function testConnectivity() {
  const results = await Promise.all(
    CONNECTIVITY_TARGETS.map(async (target) => {
      const ping = await testEndpointLatency(target.url);
      return {
        id: target.id,
        name: target.name,
        url: target.url,
        host: target.host,
        reachable: ping.ok,
        latencyMs: ping.latencyMs,
        error: ping.error || null
      };
    })
  );

  return {
    ok: true,
    testedAt: Date.now(),
    results
  };
}

module.exports = {
  CONNECTIVITY_TARGETS,
  getProxyStatus,
  setGitProxy,
  setNpmProxy,
  testConnectivity
};
