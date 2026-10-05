'use strict';

const { request: undiciRequest, ProxyAgent } = require('undici');
const { resolveClientPlatform } = require('../../../runtime/client-platform');
const { parseProxyUrl } = require('./proxy-target-plugins/proxy-command');
const { getProxyTargetPlugin, listProxyTargetPlugins } = require('./proxy-target-plugins');
const { getSystemProxyPlugin } = require('./system-proxy-plugins');

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

  const plugin = getSystemProxyPlugin(platform);
  if (!plugin) {
    result.source = 'none';
    return result;
  }
  return plugin.detectProxy(options, result);
}

// 网关转发上游时真正用的代理来自服务端配置（--proxy-url / server config），
// 不一定写在进程环境变量里；漏掉它会让诊断面误报「没有代理」。带账号密码的地址只回显打码值。
function getGatewayProxy(serverOptions) {
  const raw = String(serverOptions && serverOptions.proxyUrl || '').trim();
  let proxyUrl = raw;
  let redacted = false;
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.username || parsed.password) {
        parsed.username = '***';
        parsed.password = '';
        proxyUrl = parsed.toString().replace(/\/$/, '');
        redacted = true;
      }
    } catch (_error) {
      proxyUrl = '(无法解析的地址)';
      redacted = true;
    }
  }
  return {
    scope: 'aih-gateway-upstream',
    source: 'server-config',
    probeStatus: raw ? 'available' : 'unset',
    proxyUrl,
    redacted,
    noProxy: String(serverOptions && serverOptions.noProxy || '').trim()
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

  // 各工具（Git、npm…）的代理配置由代理目标插件读取
  const targets = listProxyTargetPlugins(resolveClientPlatform(options));
  const tools = Object.fromEntries(targets.map((plugin) => [plugin.id, plugin.read(options)]));

  // System level proxy
  const systemProxy = detectSystemProxy(options);

  return {
    ok: true,
    gateway: getGatewayProxy(options.serverOptions),
    env: envProxies,
    system: systemProxy,
    toolTargets: targets.map((plugin) => ({ id: plugin.id, name: plugin.name, scopeLabel: plugin.scopeLabel })),
    tools
  };
}

function setToolProxy(target, proxyUrl, options = {}) {
  const plugin = getProxyTargetPlugin(target);
  if (!plugin || !plugin.platforms.includes(resolveClientPlatform(options))) {
    return { ok: false, error: 'unsupported_proxy_target', operations: [] };
  }
  return plugin.write(proxyUrl, options);
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
  getDetailedGitProxy: getProxyTargetPlugin('git').read,
  getProxyStatus,
  setGitProxy: getProxyTargetPlugin('git').write,
  setNpmProxy: getProxyTargetPlugin('npm').write,
  setToolProxy,
  testConnectivity
};
