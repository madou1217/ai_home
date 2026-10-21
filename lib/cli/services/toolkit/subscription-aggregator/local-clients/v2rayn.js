'use strict';

const path = require('node:path');
const { createCandidate, parseJson, readText } = require('./scanner-kit');

const descriptor = { id: 'v2rayn', name: 'v2rayN' };

/** v2rayN 是 Windows 客户端；订阅列表在 %APPDATA%\v2rayN\guiNConfig.json 的 subItem。 */
function configPaths({ hostHomeDir, env = {}, platform, path: p = path }) {
  if (platform !== 'win32') return [];
  const appData = String(env.APPDATA || '').trim()
    || (hostHomeDir ? p.join(hostHomeDir, 'AppData', 'Roaming') : '');
  return appData ? [p.join(appData, 'v2rayN', 'guiNConfig.json')] : [];
}

function subscriptionItems(document) {
  if (!document || typeof document !== 'object') return [];
  const list = Array.isArray(document.subItem) ? document.subItem
    : Array.isArray(document.subscriptions) ? document.subscriptions
      : [];
  return list.filter((item) => item && typeof item === 'object' && item.url);
}

function scan(context = {}) {
  const p = context.path || path;
  const candidates = [];
  const seen = new Set();
  for (const file of configPaths({ ...context, path: p })) {
    const document = parseJson(readText(file, 4 * 1024 * 1024, context.fs));
    for (const item of subscriptionItems(document)) {
      const candidate = createCandidate(descriptor, {
        name: item.remarks || item.name || '',
        url: item.url,
        file
      });
      if (!candidate || seen.has(candidate.url)) continue;
      seen.add(candidate.url);
      candidates.push(candidate);
    }
  }
  return { candidates, errors: [] };
}

module.exports = { id: descriptor.id, name: descriptor.name, configPaths, scan, subscriptionItems };
