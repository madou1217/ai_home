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
async function getMirrorsStatus(options = {}) {
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
  return plugin.write(url, options);
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
