'use strict';

const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { request: undiciRequest } = require('undici');
const {
  closeDispatcher,
  createPinnedDispatcher,
  disposeResponseBody,
  enforceUrlPolicy
} = require('./proxy-pool/subscription-fetcher');

/**
 * MirrorManager: manages npm and pip mirror registries.
 * Single Responsibility: Query, set, test speed, maintain preset mirror endpoints, and provide cross-platform command guides.
 */

const NPM_PRESETS = [
  {
    id: 'npmmirror',
    name: '淘宝源 (npmmirror)',
    url: 'https://registry.npmmirror.com/',
    official: false,
    speed: '国内极速',
    desc: '国内主流镜像，阿里云同步，支持 npm / yarn / pnpm 快速下载'
  },
  {
    id: 'npmjs',
    name: '官方源 (npmjs)',
    url: 'https://registry.npmjs.org/',
    official: true,
    speed: '全球官方',
    desc: 'npm 官方主源，包更新最及时，海外或有代理时首选'
  },
  {
    id: 'tencent',
    name: '腾讯云镜像',
    url: 'https://mirrors.cloud.tencent.com/npm/',
    official: false,
    speed: '国内高速',
    desc: '腾讯云内外部加速源，稳定高可用'
  },
  {
    id: 'aliyun',
    name: '阿里云镜像',
    url: 'https://npm.aliyun.com/',
    official: false,
    speed: '国内高速',
    desc: '阿里云自建公共 npm 镜像'
  },
  {
    id: 'huawei',
    name: '华为云镜像',
    url: 'https://repo.huaweicloud.com/repository/npm/',
    official: false,
    speed: '国内高速',
    desc: '华为开源镜像站提供的 npm 缓存镜像'
  }
];

const PIP_PRESETS = [
  {
    id: 'tuna',
    name: '清华源 (TUNA)',
    url: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    official: false,
    speed: '国内极速',
    desc: '清华大学开源软件镜像站，国内最常用的 PyPI 镜像之一'
  },
  {
    id: 'pypi',
    name: '官方源 (PyPI)',
    url: 'https://pypi.org/simple',
    official: true,
    speed: '全球官方',
    desc: 'Python 官方 PyPI 软件源，包版本最全最新'
  },
  {
    id: 'aliyun',
    name: '阿里云镜像',
    url: 'https://mirrors.aliyun.com/pypi/simple/',
    official: false,
    speed: '国内高速',
    desc: '阿里云公共 PyPI 镜像源，CDN 节点丰富'
  },
  {
    id: 'ustc',
    name: '中科大镜像',
    url: 'https://pypi.mirrors.ustc.edu.cn/simple/',
    official: false,
    speed: '国内高速',
    desc: '中国科学技术大学 PyPI 镜像源'
  },
  {
    id: 'douban',
    name: '豆瓣镜像',
    url: 'https://pypi.doubanio.com/simple/',
    official: false,
    speed: '国内高速',
    desc: '老牌经典豆瓣 PyPI 源，速度稳定'
  },
  {
    id: 'tencent',
    name: '腾讯云镜像',
    url: 'https://mirrors.cloud.tencent.com/pypi/simple/',
    official: false,
    speed: '国内高速',
    desc: '腾讯云公共 PyPI 镜像源'
  }
];

/**
 * Cross-platform Command Guides & Cheatsheets
 */
const MIRROR_GUIDES = {
  npm: {
    title: 'npm / pnpm / yarn 镜像配置命令行指南',
    commands: [
      {
        platform: 'All Platforms (CLI)',
        label: 'npm 一键设为全局源',
        cmd: 'npm config set registry <URL>'
      },
      {
        platform: 'All Platforms (CLI)',
        label: 'pnpm 一键设为全局源',
        cmd: 'pnpm config set registry <URL>'
      },
      {
        platform: 'All Platforms (CLI)',
        label: 'yarn 一键设为全局源',
        cmd: 'yarn config set registry <URL>'
      },
      {
        platform: 'All Platforms (CLI)',
        label: '单次临时安装使用镜像',
        cmd: 'npm install <package> --registry=<URL>'
      },
      {
        platform: 'macOS / Linux (.npmrc)',
        label: '配置文件直接写入',
        cmd: "printf '%s\\n' registry=<URL> >> ~/.npmrc"
      },
      {
        platform: 'Windows (PowerShell)',
        label: 'PowerShell 写入 .npmrc',
        cmd: 'Add-Content -Path $HOME\\.npmrc -Value ("registry=" + <URL>)'
      }
    ]
  },
  pip: {
    title: 'Python pip 镜像配置命令行指南',
    commands: [
      {
        platform: 'All Platforms (CLI)',
        label: 'pip 一键设为全局源',
        cmd: 'pip config set global.index-url <URL>'
      },
      {
        platform: 'All Platforms (CLI)',
        label: 'pip 额外添加备用源 (extra-index-url)',
        cmd: 'pip config set global.extra-index-url <URL>'
      },
      {
        platform: 'All Platforms (CLI)',
        label: '单次临时安装使用镜像 (跳过信任警告)',
        cmd: 'pip install <package> -i <URL> --trusted-host <HOST>'
      },
      {
        platform: 'macOS / Linux (pip.conf)',
        label: '写入 pip.conf',
        cmd: "mkdir -p ~/.pip && printf '[global]\\nindex-url = %s\\n' <URL> > ~/.pip/pip.conf"
      },
      {
        platform: 'Windows (PowerShell)',
        label: 'Windows 写入 pip.ini',
        cmd: 'New-Item -ItemType Directory -Force -Path $env:APPDATA\\pip; Set-Content -Path $env:APPDATA\\pip\\pip.ini -Value ("[global]`nindex-url = " + <URL>)'
      }
    ]
  }
};

function execCommand(cmd, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSync || nodeSpawnSync;
  try {
    const res = spawnSyncImpl(cmd, args, {
      encoding: 'utf8',
      timeout: options.commandTimeoutMs || 5000,
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

function parseHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
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

/**
 * Get current npm registry
 */
function getCurrentNpmRegistry(options = {}) {
  const res = execCommand('npm', ['config', 'get', 'registry'], options);
  return res.ok ? res.stdout.replace(/\/+$/, '') : '';
}

/**
 * Set npm registry
 */
function setNpmRegistry(registryUrl, options = {}) {
  const parsed = parseHttpUrl(registryUrl);
  if (!parsed) return { ok: false, error: 'invalid_url' };
  const norm = parsed.toString();
  const res = execCommand('npm', ['config', 'set', 'registry', norm], options);
  return {
    ok: res.ok,
    registry: res.ok ? getCurrentNpmRegistry(options) : '',
    error: res.ok ? null : (res.stderr || 'npm_config_failed'),
    exitCode: res.status
  };
}

/**
 * Get current pip index-url
 */
function getCurrentPipIndexUrl(options = {}) {
  const res = execCommand('pip', ['config', 'get', 'global.index-url'], options);
  if (res.ok && res.stdout) return res.stdout;
  const res3 = execCommand('pip3', ['config', 'get', 'global.index-url'], options);
  return res3.ok ? res3.stdout : '';
}

/**
 * Set pip index-url
 */
function setPipIndexUrl(indexUrl, options = {}) {
  const parsed = parseHttpUrl(indexUrl);
  if (!parsed) return { ok: false, error: 'invalid_url' };
  const norm = parsed.toString();
  const res = execCommand('pip', ['config', 'set', 'global.index-url', norm], options);
  if (!res.ok) {
    const unavailable = res.status === null || res.status === 127 || /not found|not recognized|enoent/i.test(res.stderr);
    if (!unavailable) {
      return {
        ok: false,
        indexUrl: '',
        error: res.stderr || 'pip_config_failed',
        exitCode: res.status,
        attempts: [res]
      };
    }
    const res3 = execCommand('pip3', ['config', 'set', 'global.index-url', norm], options);
    return {
      ok: res3.ok,
      indexUrl: res3.ok ? getCurrentPipIndexUrl(options) : '',
      error: res3.ok ? null : (res3.stderr || res.stderr || 'pip_config_failed'),
      exitCode: res3.status,
      attempts: [res, res3]
    };
  }
  return { ok: true, indexUrl: getCurrentPipIndexUrl(options), error: null, exitCode: res.status };
}

/**
 * Get all mirror configurations and status
 */
async function getMirrorsStatus(options = {}) {
  const currentNpm = getCurrentNpmRegistry(options);
  const currentPip = getCurrentPipIndexUrl(options);
  const npmGuideUrl = parseHttpUrl(currentNpm) ? currentNpm : NPM_PRESETS[0].url;
  const pipGuideUrl = parseHttpUrl(currentPip) ? currentPip : PIP_PRESETS[0].url;

  return {
    ok: true,
    npm: {
      current: currentNpm,
      presets: NPM_PRESETS.map((p) => ({
        ...p,
        active: currentNpm ? currentNpm.includes(p.url.replace(/^https?:\/\//, '').replace(/\/$/, '')) : false,
        guides: materializeGuide(MIRROR_GUIDES.npm, p.url)
      })),
      guides: materializeGuide(MIRROR_GUIDES.npm, npmGuideUrl)
    },
    pip: {
      current: currentPip,
      presets: PIP_PRESETS.map((p) => ({
        ...p,
        active: currentPip ? currentPip.includes(p.url.replace(/^https?:\/\//, '').replace(/\/$/, '')) : false,
        guides: materializeGuide(MIRROR_GUIDES.pip, p.url)
      })),
      guides: materializeGuide(MIRROR_GUIDES.pip, pipGuideUrl)
    }
  };
}

module.exports = {
  NPM_PRESETS,
  PIP_PRESETS,
  MIRROR_GUIDES,
  getCurrentNpmRegistry,
  setNpmRegistry,
  getCurrentPipIndexUrl,
  setPipIndexUrl,
  testEndpointLatency,
  getMirrorsStatus
};
