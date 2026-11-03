'use strict';

// mmdb 数据文件的**定位**（Node 侧；Go 侧 internal/geo 有同构实现）。
//
// 两类位置：
//   ① AIH 托管：<aiHome>/geo/*.mmdb —— 由工具箱的「GeoIP 数据」插件下载/更新（用户可视化管理）；
//   ② 本机已有客户端自带的库：Surge / Clash Verge / MonoProxy 等装了就有。
// 规则（用户要求）：**有则复用，没有就不用** —— 不复制、不移动别人的文件，只读。
//
// 为什么要复用客户端的库：这些库体积大（Country 8-9MB、ASN 12MB），
// 用户机器上往往已经有一份，没必要让 AIH 再下一份完全相同的。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

// 本机已装客户端自带的 geo 库（macOS 为主；这些应用同时提供 Country 与 ASN 两份）。
// 每条：{ path, kind }，kind = country | asn | city（决定它能提供哪些字段）。
const CLIENT_BUNDLED_SOURCES = Object.freeze([
  // Surge：同时有 Country 与 ASN，且是 mmdb。
  { path: '/Applications/Surge.app/Contents/Resources/GeoLite2-Country.mmdb', kind: 'country' },
  { path: '/Applications/Surge.app/Contents/Resources/GeoLite2-ASN.mmdb', kind: 'asn' },
  // Surge 的用户目录副本（版本可能更新）。
  { path: '~/Library/Application Support/com.nssurge.surge-mac/GeoLite2-Country.mmdb', kind: 'country' },
  // Clash Verge / mihomo 系：Country.mmdb（只有国家）。
  { path: '~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/Country.mmdb', kind: 'country' },
  // MonoProxy（Surge 作者的另一个应用）。
  { path: '/Applications/MonoProxyMac.app/Contents/Resources/GeoLite2-Country.mmdb', kind: 'country' },
  // ClashX / ClashX Meta / Mihomo Party（装了就有，没有就跳过）。
  { path: '~/Library/Application Support/ClashX/Country.mmdb', kind: 'country' },
  { path: '~/Library/Application Support/ClashX Meta/Country.mmdb', kind: 'country' },
  { path: '~/Library/Application Support/mihomo-party/Country.mmdb', kind: 'country' }
]);

// AIH 托管的文件名（工具箱下载到这里）。命名沿用上游，便于人工核对。
const MANAGED_FILES = Object.freeze({
  country: 'GeoLite2-Country.mmdb',
  asn: 'GeoLite2-ASN.mmdb',
  city: 'GeoLite2-City.mmdb',
  'dbip-city': 'dbip-city-lite.mmdb'
});

function expandHome(value, homeDir) {
  const text = String(value || '');
  if (!text.startsWith('~/')) return text;
  return homeDir ? nodePath.join(homeDir, text.slice(2)) : text;
}

function isReadableFile(fs, filePath) {
  try {
    const stat = fs.statSync(filePath);
    // 0 字节占位文件不能当数据（客户端有时会留空文件）。
    return stat.isFile() && stat.size > 0;
  } catch (_error) {
    return false;
  }
}

/** AIH 托管目录：<aiHome>/geo。 */
function managedGeoDir(aiHomeDir) {
  return aiHomeDir ? nodePath.join(aiHomeDir, 'geo') : '';
}

/** 找一个可用文件：先 AIH 托管，再本机客户端自带。返回 { path, source: 'managed'|'client' } 或 null。 */
function resolveGeoFile(kind, options = {}) {
  const fs = options.fs || nodeFs;
  const homeDir = options.homeDir || require('node:os').homedir();
  const dir = managedGeoDir(options.aiHomeDir);
  const fileName = MANAGED_FILES[kind];
  if (dir && fileName) {
    const managed = nodePath.join(dir, fileName);
    if (isReadableFile(fs, managed)) return { path: managed, source: 'managed' };
  }
  for (const candidate of CLIENT_BUNDLED_SOURCES) {
    if (candidate.kind !== kind) continue;
    const filePath = expandHome(candidate.path, homeDir);
    if (isReadableFile(fs, filePath)) return { path: filePath, source: 'client' };
  }
  return null;
}

/** 列出所有可见的 geo 文件（工具箱与诊断用）。 */
function listGeoFiles(options = {}) {
  const fs = options.fs || nodeFs;
  const homeDir = options.homeDir || require('node:os').homedir();
  const found = [];
  for (const [kind, fileName] of Object.entries(MANAGED_FILES)) {
    const dir = managedGeoDir(options.aiHomeDir);
    if (!dir) break;
    const filePath = nodePath.join(dir, fileName);
    if (isReadableFile(fs, filePath)) found.push({ kind, path: filePath, source: 'managed' });
  }
  for (const candidate of CLIENT_BUNDLED_SOURCES) {
    const filePath = expandHome(candidate.path, homeDir);
    if (isReadableFile(fs, filePath)) found.push({ kind: candidate.kind, path: filePath, source: 'client' });
  }
  return found;
}

module.exports = {
  CLIENT_BUNDLED_SOURCES,
  MANAGED_FILES,
  listGeoFiles,
  managedGeoDir,
  resolveGeoFile
};
