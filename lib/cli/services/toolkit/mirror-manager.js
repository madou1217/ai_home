'use strict';

const { spawnSync } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');

/**
 * MirrorManager: manages npm and pip mirror registries.
 * Single Responsibility: Query, set, test speed, and maintain preset mirror endpoints.
 */

const NPM_PRESETS = [
  { id: 'npmmirror', name: '淘宝源 (npmmirror)', url: 'https://registry.npmmirror.com/', official: false },
  { id: 'npmjs', name: '官方源 (npmjs)', url: 'https://registry.npmjs.org/', official: true },
  { id: 'tencent', name: '腾讯云镜像', url: 'https://mirrors.cloud.tencent.com/npm/', official: false },
  { id: 'aliyun', name: '阿里云镜像', url: 'https://npm.aliyun.com/', official: false },
  { id: 'huawei', name: '华为云镜像', url: 'https://repo.huaweicloud.com/repository/npm/', official: false }
];

const PIP_PRESETS = [
  { id: 'tuna', name: '清华源 (TUNA)', url: 'https://pypi.tuna.tsinghua.edu.cn/simple', official: false },
  { id: 'pypi', name: '官方源 (PyPI)', url: 'https://pypi.org/simple', official: true },
  { id: 'aliyun', name: '阿里云镜像', url: 'https://mirrors.aliyun.com/pypi/simple/', official: false },
  { id: 'ustc', name: '中科大镜像', url: 'https://pypi.mirrors.ustc.edu.cn/simple/', official: false },
  { id: 'douban', name: '豆瓣镜像', url: 'https://pypi.doubanio.com/simple/', official: false },
  { id: 'tencent', name: '腾讯云镜像', url: 'https://mirrors.cloud.tencent.com/pypi/simple/', official: false }
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
 * Ping URL and return latency in ms
 */
function testEndpointLatency(targetUrl) {
  return new Promise((resolve) => {
    const start = Date.now();
    try {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request(
        parsed,
        { method: 'HEAD', timeout: 3000 },
        () => {
          resolve({ ok: true, latencyMs: Date.now() - start });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, latencyMs: -1, error: 'timeout' });
      });
      req.on('error', (err) => {
        resolve({ ok: false, latencyMs: -1, error: err.message });
      });
      req.end();
    } catch (e) {
      resolve({ ok: false, latencyMs: -1, error: e.message });
    }
  });
}

/**
 * Get current npm registry
 */
function getCurrentNpmRegistry() {
  const res = execCommand('npm', ['config', 'get', 'registry']);
  return res.ok ? res.stdout.replace(/\/+$/, '') : '';
}

/**
 * Set npm registry
 */
function setNpmRegistry(registryUrl) {
  const norm = String(registryUrl || '').trim();
  if (!norm) return { ok: false, error: 'invalid_url' };
  const res = execCommand('npm', ['config', 'set', 'registry', norm]);
  return { ok: res.ok, registry: getCurrentNpmRegistry(), error: res.stderr };
}

/**
 * Get current pip index-url
 */
function getCurrentPipIndexUrl() {
  const res = execCommand('pip', ['config', 'get', 'global.index-url']);
  if (res.ok && res.stdout) return res.stdout;
  const res3 = execCommand('pip3', ['config', 'get', 'global.index-url']);
  return res3.ok ? res3.stdout : '';
}

/**
 * Set pip index-url
 */
function setPipIndexUrl(indexUrl) {
  const norm = String(indexUrl || '').trim();
  if (!norm) return { ok: false, error: 'invalid_url' };
  const res = execCommand('pip', ['config', 'set', 'global.index-url', norm]);
  if (!res.ok) {
    const res3 = execCommand('pip3', ['config', 'set', 'global.index-url', norm]);
    return { ok: res3.ok, indexUrl: getCurrentPipIndexUrl(), error: res3.stderr };
  }
  return { ok: true, indexUrl: getCurrentPipIndexUrl(), error: res.stderr };
}

/**
 * Get all mirror configurations and status
 */
async function getMirrorsStatus() {
  const currentNpm = getCurrentNpmRegistry();
  const currentPip = getCurrentPipIndexUrl();

  return {
    ok: true,
    npm: {
      current: currentNpm,
      presets: NPM_PRESETS.map((p) => ({
        ...p,
        active: currentNpm ? currentNpm.includes(p.url.replace(/^https?:\/\//, '').replace(/\/$/, '')) : false
      }))
    },
    pip: {
      current: currentPip,
      presets: PIP_PRESETS.map((p) => ({
        ...p,
        active: currentPip ? currentPip.includes(p.url.replace(/^https?:\/\//, '').replace(/\/$/, '')) : false
      }))
    }
  };
}

module.exports = {
  NPM_PRESETS,
  PIP_PRESETS,
  getCurrentNpmRegistry,
  setNpmRegistry,
  getCurrentPipIndexUrl,
  setPipIndexUrl,
  testEndpointLatency,
  getMirrorsStatus
};
