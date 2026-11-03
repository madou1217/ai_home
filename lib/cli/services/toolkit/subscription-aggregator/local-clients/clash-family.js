'use strict';

const path = require('node:path');
const { createCandidate, listFiles, parseYaml, proxyProviderEntries, readText } = require('./scanner-kit');

const descriptor = { id: 'clash-family', name: 'Clash 系' };

/** 各 Clash 客户端（ClashX / FlClash / mihomo party / Nyanpasu）的配置目录。 */
function appDirs({ hostHomeDir, env = {}, platform, path: p = path }) {
  if (!hostHomeDir) return [];
  if (platform === 'darwin') {
    return [
      p.join(hostHomeDir, '.config', 'clash'),
      p.join(hostHomeDir, '.config', 'mihomo'),
      p.join(hostHomeDir, 'Library', 'Application Support', 'ClashX'),
      p.join(hostHomeDir, 'Library', 'Application Support', 'ClashX Meta'),
      p.join(hostHomeDir, 'Library', 'Application Support', 'FlClash'),
      p.join(hostHomeDir, 'Library', 'Application Support', 'mihomo-party')
    ];
  }
  if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim();
    return appData
      ? [p.join(appData, 'FlClash'), p.join(appData, 'mihomo-party'), p.join(appData, 'clash-nyanpasu'), p.join(hostHomeDir, '.config', 'clash')]
      : [p.join(hostHomeDir, '.config', 'clash')];
  }
  const dataHome = String(env.XDG_DATA_HOME || '').trim() || p.join(hostHomeDir, '.local', 'share');
  const configHome = String(env.XDG_CONFIG_HOME || '').trim() || p.join(hostHomeDir, '.config');
  return [
    p.join(configHome, 'clash'),
    p.join(configHome, 'mihomo'),
    p.join(dataHome, 'FlClash'),
    p.join(configHome, 'FlClash'),
    p.join(configHome, 'mihomo-party'),
    p.join(configHome, 'clash-nyanpasu')
  ];
}

/** 只取 proxy-providers 里的远程订阅地址（机场订阅在本地的常见落点）。 */
function scan(context = {}) {
  const p = context.path || path;
  const candidates = [];
  const seen = new Set();
  for (const dir of appDirs({ ...context, path: p })) {
    for (const file of listFiles(dir, /\.(ya?ml|conf)$/i, { fsImpl: context.fs, pathImpl: p })) {
      const document = parseYaml(readText(file.path, 2 * 1024 * 1024, context.fs));
      for (const provider of proxyProviderEntries(document)) {
        const candidate = createCandidate(descriptor, { name: provider.name, url: provider.url, file: file.path });
        if (!candidate || seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        candidates.push(candidate);
      }
    }
  }
  return { candidates, errors: [] };
}

module.exports = { id: descriptor.id, name: descriptor.name, scan, appDirs };
