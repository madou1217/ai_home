'use strict';

const path = require('node:path');
const { createCandidate, parseYaml, readText } = require('./scanner-kit');

const APP_DIR = 'io.github.clash-verge-rev.clash-verge-rev';
const descriptor = { id: 'clash-verge', name: 'Clash Verge Rev' };

/** 配置目录：macOS 在 Application Support，Windows 在 %APPDATA%，Linux 在 XDG data。 */
function profileDir({ hostHomeDir, env = {}, platform, path: p = path }) {
  if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim();
    return appData ? p.join(appData, APP_DIR) : '';
  }
  if (platform === 'darwin') {
    return hostHomeDir ? p.join(hostHomeDir, 'Library', 'Application Support', APP_DIR) : '';
  }
  const dataHome = String(env.XDG_DATA_HOME || '').trim()
    || (hostHomeDir ? p.join(hostHomeDir, '.local', 'share') : '');
  return dataHome ? p.join(dataHome, APP_DIR) : '';
}

/**
 * profiles.yaml 是索引：type=remote 的条目带订阅地址（url），file 是缓存下来的配置。
 * 本地 / merge / script / rules 条目不是订阅，跳过。
 */
function scan(context = {}) {
  const p = context.path || path;
  const dir = profileDir({ ...context, path: p });
  if (!dir) return { candidates: [], errors: [] };
  const document = parseYaml(readText(p.join(dir, 'profiles.yaml'), 2 * 1024 * 1024, context.fs));
  const items = document && Array.isArray(document.items) ? document.items : [];
  const candidates = items
    .filter((item) => item && item.type === 'remote' && item.url)
    .map((item) => createCandidate(descriptor, {
      name: item.name || item.file || '',
      url: item.url,
      file: p.join(dir, 'profiles', String(item.file || '')),
      updatedAt: Number(item.updated || 0) * 1000 || null
    }))
    .filter(Boolean);
  return { candidates, errors: [] };
}

module.exports = { id: descriptor.id, name: descriptor.name, scan, profileDir };
