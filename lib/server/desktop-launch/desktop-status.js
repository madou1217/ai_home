'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');
const { listDesktopApps, readBundleInfo, resolveInstalledApp } = require('./desktop-app-catalog');
const { looksProjectedHome, resolveAppHomeDir } = require('./desktop-host-home');

// 桌面端版本现状采集（P0：只读，不改任何东西）。
//
// 要回答的问题是「我 5 个账号现在各自会跑哪个版本」——但账号本身不决定版本：
// 版本由 canonical app 决定，运行中的实例则可能是旧影子。所以采集三段事实：
//   1) canonical：/Applications 或 <宿主>/Applications 里的那份
//   2) 影子副本：run/<family>-shadow/<指纹>/（按版本各存一份）
//   3) 运行中实例：ps 里带 .app/Contents/MacOS 的进程 → 版本 → 属于 canonical 还是影子
// 漂移 = 运行中的版本 ≠ canonical 版本。

// 取「最外层」.app：zcode 的 helper 是 <主 bundle>.app/Contents/Frameworks/<Helper>.app/Contents/MacOS/...，
// 贪婪匹配会抓到 helper，非贪婪从行首开始就停在主 bundle 上。
const APP_PATH_PATTERN = /(\S*?\.app)\/Contents\//;

function defaultListProcesses() {
  try {
    return String(nodeExecFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
      .split('\n');
  } catch (_error) {
    return [];
  }
}

function readdirSafe(fs, dirPath) {
  try { return fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_error) { return []; }
}

function statMs(fs, filePath) {
  try { return fs.statSync(filePath).mtimeMs || 0; } catch (_error) { return 0; }
}

function collectShadows(options, apps) {
  const { fs, path } = options;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  if (!aiHomeDir) return [];
  const shadows = [];
  for (const app of apps) {
    if (!app.shadowDirName) continue;
    const shadowRoot = path.join(aiHomeDir, 'run', app.shadowDirName);
    for (const entry of readdirSafe(fs, shadowRoot)) {
      if (!entry.isDirectory() || entry.name.startsWith('.prepare-')) continue;
      const fingerprintDir = path.join(shadowRoot, entry.name);
      let bundlePath = '';
      for (const bundleName of app.bundleNames || []) {
        const candidate = path.join(fingerprintDir, bundleName);
        try { if (fs.statSync(candidate).isDirectory()) { bundlePath = candidate; break; } } catch (_error) { /* 下一个 */ }
      }
      const info = bundlePath ? readBundleInfo(fs, path, bundlePath) : { version: '' };
      shadows.push({
        key: app.key,
        providers: app.providers.slice(),
        fingerprint: entry.name,
        path: bundlePath || fingerprintDir,
        version: info.version || '',
        lastUsedAt: statMs(fs, path.join(fingerprintDir, 'manifest.json'))
      });
    }
  }
  return shadows;
}

function collectRunning(options) {
  const { fs, path } = options;
  const lines = typeof options.listProcesses === 'function' ? options.listProcesses() : defaultListProcesses();
  const byBundle = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const match = APP_PATH_PATTERN.exec(String(line || ''));
    if (!match) continue;
    const bundlePath = match[1];
    const pidMatch = /^\s*(\d+)\s/.exec(line);
    const pid = pidMatch ? Number(pidMatch[1]) : 0;
    const existing = byBundle.get(bundlePath);
    if (existing) {
      existing.count += 1;
      if (pid) existing.pids.push(pid);
      continue;
    }
    byBundle.set(bundlePath, { path: bundlePath, count: 1, pids: pid ? [pid] : [] });
  }
  return Array.from(byBundle.values()).map((item) => ({
    ...item,
    version: readBundleInfo(fs, path, item.path, { execFileSync: options.execFileSync }).version || ''
  }));
}

function attributeRunning(running, apps, shadows) {
  return running.map((item) => {
    const app = apps.find((candidate) => candidate.installed && candidate.path === item.path);
    if (app) return { ...item, key: app.key, providers: app.providers.slice(), source: 'canonical' };
    const shadow = shadows.find((candidate) => candidate.path === item.path);
    if (shadow) return { ...item, key: shadow.key, providers: shadow.providers.slice(), source: 'shadow' };
    // 只认 aih 管理的桌面端：ps 里还有大量系统/第三方 .app，全部计入会把输出淹掉。
    return null;
  }).filter(Boolean);
}

// Electron 主进程会改写进程名（zcode 实测 comm 变成 ZCode-<hash>），靠 cmdline 数「实例数」不可靠；
// 这里按 (key, version, source) 合并，count 明确是**进程数（含 helper）**，只用来判断「有没有在跑」。
function groupRunning(items) {
  const groups = new Map();
  for (const item of items) {
    const groupKey = item.key + '|' + item.version + '|' + item.source;
    const existing = groups.get(groupKey);
    if (existing) { existing.count += item.count; existing.pids.push(...item.pids); continue; }
    groups.set(groupKey, { ...item, pids: item.pids.slice() });
  }
  return Array.from(groups.values());
}

function buildDrift(apps, shadows, running) {
  const drift = [];
  for (const app of apps) {
    if (!app.installed) continue;
    const sameApp = running.filter((item) => item.key === app.key);
    const behind = sameApp.filter((item) => item.version && item.version !== app.version);
    const staleShadows = shadows
      .filter((item) => item.key === app.key && item.version && item.version !== app.version)
      .map((item) => ({ fingerprint: item.fingerprint, version: item.version, lastUsedAt: item.lastUsedAt }));
    if (behind.length === 0 && staleShadows.length === 0) continue;
    drift.push({
      key: app.key,
      providers: app.providers.slice(),
      canonicalVersion: app.version,
      runningBehind: behind.map((item) => ({ version: item.version, source: item.source, count: item.count })),
      staleShadows
    });
  }
  return drift;
}

function collectDesktopStatus(options = {}) {
  const fs = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const platform = String(options.platform || process.platform || '').trim().toLowerCase();
  const base = {
    fs,
    path: pathImpl,
    aiHomeDir: options.aiHomeDir,
    hostHomeDir: options.hostHomeDir,
    platform,
    listProcesses: options.listProcesses
  };
  const appHomeDir = resolveAppHomeDir({ hostHomeDir: options.hostHomeDir, osImpl: options.os });
  const apps = listDesktopApps().map((entry) => ({
    ...resolveInstalledApp(entry, { fs, path: pathImpl, platform, homeDir: appHomeDir }),
    shadowDirName: entry.shadowDirName || '',
    bundleNames: entry.bundleNames.slice()
  }));
  // aiHomeDir 同样可能是投影里的路径（沙箱内跑 CLI 时）：投影里的 .ai_home 看不到真实影子副本。
  const appHomeDirForData = resolveAppHomeDir({ hostHomeDir: options.hostHomeDir, osImpl: options.os });
  const effectiveAiHomeDir = looksProjectedHome(base.aiHomeDir) && appHomeDirForData
    ? pathImpl.join(appHomeDirForData, '.ai_home')
    : base.aiHomeDir;
  const shadows = collectShadows({ ...base, aiHomeDir: effectiveAiHomeDir }, apps);
  const running = groupRunning(attributeRunning(collectRunning(base), apps, shadows));
  const drift = buildDrift(apps, shadows, running);
  return {
    checkedAt: new Date().toISOString(),
    platform,
    apps: apps.map(({ shadowDirName, bundleNames, ...rest }) => rest),
    shadows,
    running,
    drift
  };
}

module.exports = { collectDesktopStatus, defaultListProcesses };
