'use strict';

const { request: undiciRequest } = require('undici');
const { resolveClientPlatform } = require('../../../runtime/client-platform');
const { parseHttpUrl } = require('./mirror-plugins/mirror-command');
const { MIRROR_PLUGINS, getMirrorPlugin, listMirrorPlugins } = require('./mirror-plugins');
const {
  closeDispatcher,
  createPinnedDispatcher,
  disposeResponseBody,
  enforceUrlPolicy
} = require('./proxy-pool/subscription-fetcher');

/**
 * MirrorManager: 软件源管理引擎。具体软件源（npm、pip…）由 ./mirror-plugins 插件提供
 * 预置镜像、命令指南与读写实现；这里只负责聚合状态、按平台筛选指南、测速。
 */

function guideForPlatform(guide, platform) {
  return {
    title: guide.title,
    commands: guide.commands
      .filter((item) => !platform || !Array.isArray(item.platforms) || item.platforms.includes(platform))
      .map(({ platforms: _platforms, ...item }) => item)
  };
}

function materializeGuide(guide, targetUrl) {
  const parsed = parseHttpUrl(targetUrl);
  if (!parsed) return { ...guide, commands: [] };
  const commandUrl = parsed.toString().replace(/[!$'();`|<>]/g, (character) => (
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  ));
  const quotedUrl = JSON.stringify(commandUrl);
  const quotedHost = JSON.stringify(parsed.hostname);
  return {
    ...guide,
    sourceUrl: parsed.toString(),
    sourceHost: parsed.hostname,
    commands: guide.commands.map((item) => ({
      ...item,
      cmd: item.cmd
        .replace(/<URL>/g, quotedUrl)
        .replace(/<HOST>/g, quotedHost)
    }))
  };
}

async function defaultRequestAdapter({ url, method, timeoutMs }, options = {}) {
  const parsed = new URL(url);
  const addresses = await enforceUrlPolicy(parsed, {
    resolveHost: options.resolveHost,
    urlPolicy: options.urlPolicy
  });
  const dispatcher = (options.dispatcherFactory || createPinnedDispatcher)(addresses);
  try {
    const response = await (options.requestImpl || undiciRequest)(parsed.toString(), {
      method,
      dispatcher,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      maxRedirections: 0,
      headers: { 'user-agent': 'ai-home-toolkit-mirror-probe/1.0' }
    });
    await disposeResponseBody(response.body);
    return { statusCode: response.statusCode || 0 };
  } finally {
    await closeDispatcher(dispatcher);
  }
}

/**
 * Ping URL and return latency in ms
 */
async function testEndpointLatency(targetUrl, options = {}) {
  const parsed = parseHttpUrl(targetUrl);
  if (!parsed) {
    return {
      ok: false,
      latencyMs: -1,
      statusCode: null,
      measurement: 'ttfb',
      route: 'direct',
      error: 'invalid_url'
    };
  }

  const now = options.now || Date.now;
  const requestAdapter = options.requestAdapter || ((requestOptions) => defaultRequestAdapter(requestOptions, options));
  const timeoutMs = Math.min(Math.max(Number(options.requestTimeoutMs) || 3000, 250), 15000);
  const start = now();
  let timer;
  try {
    const response = await Promise.race([
      requestAdapter({
        url: parsed.toString(),
        method: 'HEAD',
        timeoutMs,
        maxResponseBytes: 0,
        route: 'direct',
        proxyUrl: null
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      })
    ]);
    const statusCode = Number(response && response.statusCode) || 0;
    const ok = statusCode >= 200 && statusCode < 400;
    return {
      ok,
      latencyMs: now() - start,
      statusCode: statusCode || null,
      measurement: 'ttfb',
      route: 'direct',
      error: ok ? null : `http_status_${statusCode || 'unknown'}`
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: -1,
      statusCode: null,
      measurement: 'ttfb',
      route: 'direct',
      error: String(error && error.message || error)
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isActivePreset(current, preset) {
  return current ? current.includes(preset.url.replace(/^https?:\/\//, '').replace(/\/$/, '')) : false;
}

function describeMirror(plugin, platform, options = {}) {
  const current = plugin.read(options);
  const guide = guideForPlatform(plugin.guide, platform);
  const guideUrl = parseHttpUrl(current) ? current : plugin.presets[0].url;
  return {
    current,
    presets: plugin.presets.map((preset) => ({
      ...preset,
      active: isActivePreset(current, preset),
      guides: materializeGuide(guide, preset.url)
    })),
    guides: materializeGuide(guide, guideUrl)
  };
}

/**
 * 聚合所有适用于当前平台的软件源插件状态。
 * 兼容旧形状：每个插件仍以 id 为键（npm / pip），另附 kinds 有序列表供界面动态渲染。
 */
// 镜像状态要读 npm / pip 的配置（每个都是一次子进程，实测冷态 350ms+）。
// 这些配置秒级内不会变，而 WebUI 每次进工具页都会问一次。
// 策略：有旧值先回旧值（附 stale）并后台刷新；从没探测过才等真实结果。
// setMirror 写入后调 clearMirrorsStatusCache()，不会读到过期配置。
const MIRRORS_STATUS_TTL_MS = 15 * 1000;
let mirrorsStatusCache = null;
let mirrorsStatusInFlight = null;

function clearMirrorsStatusCache() {
  mirrorsStatusCache = null;
  mirrorsStatusInFlight = null;
}

function refreshMirrorsStatus(options = {}) {
  if (mirrorsStatusInFlight) return mirrorsStatusInFlight;
  const request = buildMirrorsStatus(options)
    .then((value) => {
      mirrorsStatusCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (mirrorsStatusInFlight === request) mirrorsStatusInFlight = null;
    });
  mirrorsStatusInFlight = request;
  return request;
}

// 只有「不带注入」��常规调用才走缓存。
// 测试与嵌入方会注入 spawnSync / fs / env 来构造特定环境，那些调用的结果与进程级
// 缓存无关，复用会串味（实测会让注入不同 registry 的用例互相污染）。
function isCacheableCall(options = {}) {
  return options.forceRefresh !== true
    && !options.spawnSync
    && !options.execCommand
    && !options.processObj
    && !options.env;
}

async function getMirrorsStatus(options = {}) {
  if (options.forceRefresh === true) return refreshMirrorsStatus(options);
  if (!isCacheableCall(options)) return buildMirrorsStatus(options);
  const cached = mirrorsStatusCache;
  if (cached) {
    const stale = Date.now() - cached.at >= MIRRORS_STATUS_TTL_MS;
    if (stale && !mirrorsStatusInFlight) refreshMirrorsStatus(options).catch(() => {});
    return stale ? { ...cached.value, stale: true } : cached.value;
  }
  return refreshMirrorsStatus(options);
}

async function buildMirrorsStatus(options = {}) {
  const platform = resolveClientPlatform(options);
  const plugins = listMirrorPlugins(platform);
  const result = {
    ok: true,
    platform,
    kinds: plugins.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      label: plugin.label,
      settingLabel: plugin.settingLabel
    }))
  };
  for (const plugin of plugins) result[plugin.id] = describeMirror(plugin, platform, options);
  return result;
}

function setMirror(type, url, options = {}) {
  const plugin = getMirrorPlugin(type);
  if (!plugin || !plugin.platforms.includes(resolveClientPlatform(options))) {
    return { ok: false, error: 'unsupported_mirror_type' };
  }
  const result = plugin.write(url, options);
  // 刚写进去的配置必须立刻反映到下一次读取，不能等 TTL。
  clearMirrorsStatusCache();
  return result;
}

const npmMirror = getMirrorPlugin('npm');
const pipMirror = getMirrorPlugin('pip');

module.exports = {
  MIRROR_PLUGINS,
  NPM_PRESETS: npmMirror.presets,
  PIP_PRESETS: pipMirror.presets,
  MIRROR_GUIDES: Object.freeze({ npm: npmMirror.guide, pip: pipMirror.guide }),
  getCurrentNpmRegistry: npmMirror.read,
  setNpmRegistry: npmMirror.write,
  getCurrentPipIndexUrl: pipMirror.read,
  setPipIndexUrl: pipMirror.write,
  setMirror,
  testEndpointLatency,
  getMirrorsStatus
};
