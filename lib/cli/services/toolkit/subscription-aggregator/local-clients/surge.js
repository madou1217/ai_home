'use strict';

const path = require('node:path');
const { createCandidate, listFiles, readText, surgeManagedUrls } = require('./scanner-kit');

const descriptor = { id: 'surge', name: 'Surge' };
// Surge Mac 与 iOS 同步过来的配置都在 Profiles 下；.managed 是托管订阅的缓存副本。
const PROFILE_ROOTS = [
  ['Library', 'Application Support', 'Surge', 'Profiles'],
  ['Library', 'Application Support', 'com.nssurge.surge-mac', 'Profiles']
];

function profileDirs({ hostHomeDir, platform, path: p = path }) {
  if (platform !== 'darwin' || !hostHomeDir) return [];
  return PROFILE_ROOTS.flatMap((segments) => {
    const root = p.join(hostHomeDir, ...segments);
    return [root, p.join(root, '.managed')];
  });
}

/**
 * `#!MANAGED-CONFIG <url>` 是托管订阅本身。
 * `[Proxy]` / `[Proxy Group]` 里的 `#!include <url>` 才是订阅节点；`[Rule]` 的 include 是规则集，
 * 当订阅导入会拉回一堆规则文本，必须排除。
 */
function scanProfile(text) {
  const found = [];
  const managed = String(text).match(/^#!MANAGED-CONFIG\s+(\S+)/im);
  if (managed) found.push(managed[1]);
  let section = '';
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    if (section !== 'proxy' && section !== 'proxy group') continue;
    const include = trimmed.match(/^#!include\s+(\S+)/i);
    if (include) found.push(include[1]);
  }
  return found;
}

function scan(context = {}) {
  const p = context.path || path;
  const candidates = [];
  const seen = new Set();
  for (const dir of profileDirs({ ...context, path: p })) {
    for (const file of listFiles(dir, /\.conf$/i, { fsImpl: context.fs, pathImpl: p })) {
      const text = readText(file.path, 2 * 1024 * 1024, context.fs);
      if (!text) continue;
      const name = p.basename(file.name, p.extname(file.name));
      for (const url of scanProfile(text)) {
        const candidate = createCandidate(descriptor, { name, url, file: file.path, updatedAt: file.mtimeMs });
        if (!candidate || seen.has(candidate.url)) continue;
        seen.add(candidate.url);
        candidates.push(candidate);
      }
    }
  }
  return { candidates, errors: [] };
}

module.exports = { id: descriptor.id, name: descriptor.name, profileDirs, scan, scanProfile };
