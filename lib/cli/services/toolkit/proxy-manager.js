'use strict';

const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { request: undiciRequest, ProxyAgent } = require('undici');
const { readWindowsSystemProxy } = require('../../../runtime/windows-system-proxy');

/**
 * ProxyManager: manages developer network, CLI proxy settings, system proxy detection, and connectivity diagnostics.
 * Single Responsibility: Check environment proxies, system proxies (macOS/Windows/Linux), tool proxies (Git/npm), and test AI endpoints.
 */

const CONNECTIVITY_TARGETS = [
  { id: 'openai', name: 'OpenAI API', url: 'https://api.openai.com/v1/models', host: 'api.openai.com', group: 'ai' },
  { id: 'anthropic', name: 'Anthropic Claude API', url: 'https://api.anthropic.com/v1/messages', host: 'api.anthropic.com', group: 'ai' },
  { id: 'gemini', name: 'Google Gemini API', url: 'https://generativelanguage.googleapis.com/v1beta/models', host: 'generativelanguage.googleapis.com', group: 'ai' },
  { id: 'grok', name: 'xAI Grok API', url: 'https://api.x.ai/v1/models', host: 'api.x.ai', group: 'ai' },
  { id: 'github', name: 'GitHub', url: 'https://api.github.com', host: 'api.github.com', group: 'dev' },
  { id: 'huggingface', name: 'HuggingFace', url: 'https://huggingface.co/api/models', host: 'huggingface.co', group: 'ai' },
  { id: 'npmmirror', name: '淘宝 npmmirror', url: 'https://registry.npmmirror.com', host: 'registry.npmmirror.com', group: 'cn' },
  { id: 'pypi_tuna', name: '清华大学 PyPI', url: 'https://pypi.tuna.tsinghua.edu.cn', host: 'pypi.tuna.tsinghua.edu.cn', group: 'cn' }
];

function execCommand(cmd, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSync || nodeSpawnSync;
  try {
    const res = spawnSyncImpl(cmd, args, {
      encoding: 'utf8',
      timeout: options.commandTimeoutMs || 4000,
      windowsHide: true
    });
    return {
      ok: Boolean(res) && res.status === 0,
      status: res && Number.isInteger(res.status) ? res.status : null,
      stdout: String(res && res.stdout || '').trim(),
      stderr: String(res && res.stderr || '').trim()
    };
  } catch (e) {
    return { ok: false, status: null, stdout: '', stderr: e.message };
  }
}

function probeFailureStatus(result) {
  if (result.status === 127 || /not found|not recognized|enoent/i.test(result.stderr)) return 'unsupported';
  return 'error';
}

function parseMacBypassList(output) {
  const block = String(output || '').match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/i);
  if (!block) return [];
  return Array.from(block[1].matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm), (match) => match[1].trim()).filter(Boolean);
}

/**
 * Detect System Proxy on macOS (scutil --proxy), Windows (Registry), or Linux (gsettings/env)
 */
function detectSystemProxy(options = {}) {
  const processObj = options.processObj || process;
  const platform = options.platform || processObj.platform;
  const result = {
    platform,
    scope: 'operating-system',
    source: '',
    probeStatus: 'unsupported',
    enabled: false,
    httpProxy: '',
    httpsProxy: '',
    socksProxy: '',
    bypassList: []
  };

  if (platform === 'darwin') {
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
  } else if (platform === 'win32') {
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
  } else if (platform === 'linux') {
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
  } else {
    result.source = 'none';
  }

  return result;
}

/**
 * Get detailed Git proxy configuration across all scopes and matchers
 */
function getDetailedGitProxy(options = {}) {
  const globalHttpProbe = execCommand('git', ['config', '--global', 'http.proxy'], options);
  const globalHttpsProbe = execCommand('git', ['config', '--global', 'https.proxy'], options);
  const globalHttp = globalHttpProbe.stdout;
  const globalHttps = globalHttpsProbe.stdout;

  // Check specific domain proxies like http.https://github.com.proxy
  const allProxyProbe = execCommand('git', ['config', '--global', '--get-regexp', 'proxy'], options);
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
 * Get environment variable proxies and tool proxy settings
 */
function getProxyStatus(options = {}) {
  const processObj = options.processObj || process;
  const env = options.env || processObj.env || {};
  const envProxies = {
    scope: 'aih-server-process',
    source: 'process.env',
    probeStatus: env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY || env.all_proxy || env.ALL_PROXY
      ? 'available'
      : 'unset',
    httpProxy: env.http_proxy || env.HTTP_PROXY || '',
    httpsProxy: env.https_proxy || env.HTTPS_PROXY || '',
    allProxy: env.all_proxy || env.ALL_PROXY || '',
    noProxy: env.no_proxy || env.NO_PROXY || ''
  };

  // Detailed Git proxy
  const gitProxy = getDetailedGitProxy(options);

  // npm proxy
  const npmProxyProbe = execCommand('npm', ['config', 'get', 'proxy'], options);
  const npmHttpsProxyProbe = execCommand('npm', ['config', 'get', 'https-proxy'], options);
  const npmProxy = npmProxyProbe.stdout;
  const npmHttpsProxy = npmHttpsProxyProbe.stdout;

  // System level proxy
  const systemProxy = detectSystemProxy(options);

  return {
    ok: true,
    env: envProxies,
    system: systemProxy,
    tools: {
      git: gitProxy,
      npm: {
        scope: 'user-config',
        source: 'npm-config',
        probeStatus: (npmProxy && npmProxy !== 'null') || (npmHttpsProxy && npmHttpsProxy !== 'null') ? 'available' : 'unset',
        httpProxy: npmProxy && npmProxy !== 'null' ? npmProxy : '',
        httpsProxy: npmHttpsProxy && npmHttpsProxy !== 'null' ? npmHttpsProxy : ''
      }
    }
  };
}

function parseProxyUrl(proxyUrl, { localHttpOnly = false } = {}) {
  const raw = String(proxyUrl || '').trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw);
    const protocols = localHttpOnly ? ['http:', 'https:'] : ['http:', 'https:', 'socks:', 'socks4:', 'socks5:'];
    if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (localHttpOnly) {
      const host = parsed.hostname.toLowerCase();
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return null;
      if (!parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function summarizeOperations(operations) {
  const failed = operations.find((operation) => !operation.ok);
  return {
    ok: !failed,
    error: failed ? 'proxy_config_failed' : null,
    message: failed ? (failed.stderr || `${failed.key} 配置失败`) : '',
    operations
  };
}

/**
 * Set Git global proxy
 */
function setGitProxy(proxyUrl, options = {}) {
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
  return { ...summary, git: getDetailedGitProxy(options) };
}

/**
 * Set npm user proxy configuration.
 */
function setNpmProxy(proxyUrl, options = {}) {
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

async function defaultConnectivityRequest({ url, route, proxyUrl, timeoutMs }) {
  const dispatcher = route === 'proxy' ? new ProxyAgent(proxyUrl) : undefined;
  try {
    const response = await undiciRequest(url, {
      method: 'HEAD',
      dispatcher,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      headers: { 'user-agent': 'ai-home-toolkit-connectivity/1.0' }
    });
    await response.body.dump();
    return { statusCode: response.statusCode };
  } finally {
    if (dispatcher) await dispatcher.close();
  }
}

/**
 * Run connectivity tests to upstream AI & developer services
 */
async function testConnectivity(config = {}, options = {}) {
  const route = String(config.route || 'direct').trim().toLowerCase();
  if (!['direct', 'proxy'].includes(route)) {
    return { ok: false, error: 'invalid_route', route, proxyUsed: null, results: [] };
  }
  const proxy = route === 'proxy' ? parseProxyUrl(config.proxyUrl, { localHttpOnly: true }) : null;
  if (route === 'proxy' && !proxy) {
    return { ok: false, error: 'invalid_local_http_proxy', route, proxyUsed: null, results: [] };
  }

  const targets = options.connectivityTargets || CONNECTIVITY_TARGETS;
  const requestAdapter = options.requestAdapter || defaultConnectivityRequest;
  const timeoutMs = Math.min(Math.max(Number(options.requestTimeoutMs) || 5000, 250), 15000);
  const now = options.now || Date.now;
  const proxyUsed = proxy ? proxy.toString() : null;
  const results = await Promise.all(
    targets.map(async (target) => {
      const startedAt = now();
      let timer;
      try {
        const response = await Promise.race([
          requestAdapter({
            url: target.url,
            method: 'HEAD',
            route,
            proxyUrl: proxyUsed,
            timeoutMs,
            maxResponseBytes: 0
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          })
        ]);
        const statusCode = Number(response && response.statusCode) || 0;
        return {
          id: target.id,
          name: target.name,
          url: target.url,
          host: target.host,
          group: target.group,
          route,
          proxyUsed,
          reachable: statusCode >= 100 && statusCode < 600,
          latencyMs: now() - startedAt,
          statusCode: statusCode || null,
          error: statusCode ? null : 'missing_http_status'
        };
      } catch (error) {
        return {
          id: target.id,
          name: target.name,
          url: target.url,
          host: target.host,
          group: target.group,
          route,
          proxyUsed,
          reachable: false,
          latencyMs: -1,
          statusCode: null,
          error: String(error && error.message || error)
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    })
  );

  return {
    ok: true,
    testedAt: now(),
    route,
    proxyUsed,
    results
  };
}

module.exports = {
  CONNECTIVITY_TARGETS,
  detectSystemProxy,
  getDetailedGitProxy,
  getProxyStatus,
  setGitProxy,
  setNpmProxy,
  testConnectivity
};
