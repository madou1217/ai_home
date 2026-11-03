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

/**
 * 异步版系统代理探测：WebUI 读路径用。
 * 插件实现了 detectProxyAsync 就走它（内部并发跑命令），否则回落到同步实现。
 */
async function detectSystemProxyAsync(options = {}) {
  const processObj = options.processObj || process;
  const platform = options.platform || processObj.platform;
  const plugin = getSystemProxyPlugin(platform);
  if (!plugin) {
    return {
      platform,
      scope: 'operating-system',
      source: 'none',
      probeStatus: 'unsupported',
      enabled: false,
      httpProxy: '',
      httpsProxy: '',
      socksProxy: '',
      bypassList: []
    };
  }
  if (typeof plugin.detectProxyAsync === 'function') return plugin.detectProxyAsync(options);
  return detectSystemProxy(options);
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
function buildEnvProxies(options = {}) {
  const processObj = options.processObj || process;
  const env = options.env || processObj.env || {};
  return {
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
}

function buildProxyStatusPayload(options = {}, envProxies, targetResults, systemProxy) {
  const targets = listProxyTargetPlugins(resolveClientPlatform(options));
  const tools = Object.fromEntries(
    targets.map((plugin, index) => [plugin.id, targetResults[index]]).filter(([, value]) => value)
  );
  return {
    ok: true,
    gateway: getGatewayProxy(options.serverOptions),
    env: envProxies,
    system: systemProxy,
    toolTargets: targets.map((plugin) => ({ id: plugin.id, name: plugin.name, scopeLabel: plugin.scopeLabel })),
    tools
  };
}

/**
 * Get environment variable proxies and tool proxy settings
 */
function getProxyStatus(options = {}) {
  const envProxies = buildEnvProxies(options);
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

/**
 * 异步版 getProxyStatus：系统代理、各工具代理插件全部并发读。
 * WebUI 的 GET /v0/webui/toolkit/proxy 走这条，不再让 spawnSync 占住主线程。
 */
// 代理状态要跑 scutil、每个网络服务的 4 条 networksetup、以及 git/npm 的配置查询，
// 实测冷态 400~900ms。这些配置秒级内不会变，而 WebUI 每次进诊断面板都会问一次，
// 所以按 stale-while-revalidate 缓存：有旧值先回旧值（附 stale 标记）并在后台刷新，
// 只有进程内从没探测过才等真实结果。`?refresh=1` 表示用户主动重测，绕过缓存。
const PROXY_STATUS_TTL_MS = 15 * 1000;
let proxyStatusCache = null;
let proxyStatusInFlight = null;

function clearProxyStatusCache() {
  proxyStatusCache = null;
  proxyStatusInFlight = null;
}

function refreshProxyStatusAsync(options = {}) {
  if (proxyStatusInFlight) return proxyStatusInFlight;
  const request = buildProxyStatusAsync(options)
    .then((value) => {
      proxyStatusCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (proxyStatusInFlight === request) proxyStatusInFlight = null;
    });
  proxyStatusInFlight = request;
  return request;
}

async function buildProxyStatusAsync(options = {}) {
  const envProxies = buildEnvProxies(options);
  const targets = listProxyTargetPlugins(resolveClientPlatform(options));
  const [systemProxy, targetResults] = await Promise.all([
    detectSystemProxyAsync(options),
    Promise.all(targets.map((plugin) => (typeof plugin.readAsync === 'function'
      ? plugin.readAsync(options)
      : Promise.resolve(plugin.read(options)))))
  ]);
  return buildProxyStatusPayload(options, envProxies, targetResults, systemProxy);
}

// 只有不带注入的常规调用才走缓存：测试/嵌入方注入 processObj、env、spawnSync 等
// 构造特定环境，那些结果与进程级缓存无关，复用会串味。
// 只有「真的在探测本机」的常规调用才走缓存。
//
// 判定不能只看 options 上有没有这些键：WebUI 路由把整个请求上下文展开传进来
// （buildToolkitOptions 里 `...ctx, ...deps`），ctx 上本来就带 processObj / spawn 等字段，
// 按「键是否存在」判断会让生产环境的缓存永远不生效（实测每次都走真实探测，
// 返回体里连 stale 标记都没有）。
// 所以只认「显式注入的非本机实现」：有它才算注入式调用。
function isCacheableProxyCall(options = {}) {
  if (options.forceRefresh === true) return false;
  const { spawn, spawnSync } = require('node:child_process');
  if (options.spawnSync && options.spawnSync !== spawnSync) return false;
  if (options.spawn && options.spawn !== spawn) return false;
  if (options.processObj && options.processObj !== process) return false;
  if (options.env && options.env !== process.env) return false;
  return true;
}

async function getProxyStatusAsync(options = {}) {
  if (options.forceRefresh === true) return refreshProxyStatusAsync(options);
  if (!isCacheableProxyCall(options)) return buildProxyStatusAsync(options);
  const cached = proxyStatusCache;
  if (cached) {
    const stale = Date.now() - cached.at >= PROXY_STATUS_TTL_MS;
    if (stale && !proxyStatusInFlight) refreshProxyStatusAsync(options).catch(() => {});
    return stale ? { ...cached.value, stale: true } : cached.value;
  }
  return refreshProxyStatusAsync(options);
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

// ── 连通性诊断的缓存 ────────────────────────────────────────────────────────
// 每个目标都是一次真实外部 HEAD（实测 gemini 3.4s、pypi 2.7s），一次全量探测
// 稳定在 3s 以上。界面进入诊断面板时立刻要结果，所以按 stale-while-revalidate：
// 有上一次结果就先回它（带 stale 标记与 testedAt），同时在后台重测；
// 只有「第一次、且没有任何历史结果」才会等一轮真实探测。
const CONNECTIVITY_TTL_MS = 60 * 1000;
const connectivityCache = new Map(); // key: route|proxyUrl
const connectivityInFlight = new Map();

function connectivityKey(config = {}) {
  return `${String(config.route || 'direct').toLowerCase()}|${String(config.proxyUrl || '').trim()}`;
}

function clearConnectivityCache() {
  connectivityCache.clear();
  connectivityInFlight.clear();
}

function refreshConnectivity(config = {}, options = {}) {
  const key = connectivityKey(config);
  const existing = connectivityInFlight.get(key);
  if (existing) return existing;
  const request = testConnectivity(config, options)
    .then((value) => {
      // 失败（invalid_route 等）不缓存，避免把一次配置错误钉死一分钟。
      if (value && value.ok) connectivityCache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      if (connectivityInFlight.get(key) === request) connectivityInFlight.delete(key);
    });
  connectivityInFlight.set(key, request);
  return request;
}

/**
 * 带缓存的连通性诊断：先回旧结果并后台刷新；从没有过结果时才等待真实探测。
 */
async function getConnectivityCached(config = {}, options = {}) {
  const key = connectivityKey(config);
  const cached = connectivityCache.get(key);
  if (cached) {
    const stale = Date.now() - cached.at >= CONNECTIVITY_TTL_MS;
    if (stale && !connectivityInFlight.has(key)) refreshConnectivity(config, options).catch(() => {});
    return { ...cached.value, cached: true, stale, cachedAt: cached.at };
  }
  const value = await refreshConnectivity(config, options);
  return { ...value, cached: false, stale: false, cachedAt: 0 };
}

module.exports = {
  CONNECTIVITY_TARGETS,
  clearConnectivityCache,
  getConnectivityCached,
  refreshConnectivity,
  detectSystemProxy,
  detectSystemProxyAsync,
  clearProxyStatusCache,
  getProxyStatusAsync,
  refreshProxyStatusAsync,
  getDetailedGitProxy: getProxyTargetPlugin('git').read,
  getProxyStatus,
  setGitProxy: getProxyTargetPlugin('git').write,
  setNpmProxy: getProxyTargetPlugin('npm').write,
  setToolProxy,
  testConnectivity
};
