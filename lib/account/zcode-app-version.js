'use strict';

// ZCode app_version 的**唯一解析点**。
//
// 为什么不能写死（2026-10-24 真机实测）：`billing/preview` 对 app_version 做版本门槛，
// 且失败方式是**假阴性**：
//   app_version=3.15.3 → {"code":0,"data":{"plans":[]}}      ← 看起来「暂无可领」
//   app_version=3.16.3 → {"code":0,"data":{"plans":[…1024…]}} ← 真实有套餐
// 写旧版本不报错，只会让真实存在的可领套餐消失，且 code:0 让调用方无法与
// 历史上这里写过 3.15.3，直接导致「领臭鸡蛋」显示
// 「当前没有开放中的活动」。
//
// 解析优先级：本机安装版 → 本地缓存 → 在线抓官方最新版 → 常量种子。

const nodePath = require('node:path');

const ZCODE_DOWNLOAD_PAGE = 'https://zcode.z.ai/en/docs/install';
const ZCODE_DOWNLOAD_HOST = 'cdn-zcode.z.ai';
const ZCODE_RELEASE_PATH_PATTERN = /\/zcode\/electron\/releases\/(\d+\.\d+\.\d+)\//;
const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VERSION_FETCH_TIMEOUT_MS = 8_000;
const CACHE_RELATIVE_PATH = ['run', 'zcode-app-version.json'];
// 种子值：仅「首次运行且完全拿不到真实版本」时使用，会被 1/2/3 覆盖。
const SEED_ZCODE_APP_VERSION = '3.16.3';

function normalizeVersion(value) {
  const text = String(value || '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+$/.test(text) ? text : '';
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split('.').map(Number);
  const b = normalizeVersion(right).split('.').map(Number);
  if (a.length !== 3 || b.length !== 3) return 0;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function readPlistValue(fs, file, key) {
  if (!fs || typeof fs.readFileSync !== 'function') return '';
  try {
    const source = String(fs.readFileSync(file, 'utf8') || '');
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(source);
    return normalizeVersion(match && match[1]);
  } catch (_error) { return ''; }
}

function readJsonVersion(fs, file) {
  if (!fs || typeof fs.readFileSync !== 'function') return '';
  try {
    const parsed = JSON.parse(String(fs.readFileSync(file, 'utf8') || ''));
    return normalizeVersion(parsed && parsed.version);
  } catch (_error) { return ''; }
}

/** 本机已安装桌面端的真实版本（macOS 走 Info.plist，其它平台走打包的 package.json）。 */
function readInstalledZcodeAppVersion(fs, home, options = {}) {
  if (!fs || !home) return '';
  const platform = String(options.platform || '').trim();
  const roots = [];
  if (!platform || platform === 'darwin') {
    roots.push(nodePath.join(home, 'Applications', 'ZCode.app', 'Contents', 'Info.plist'));
    if (options.allowSystemApplications === true) roots.push('/Applications/ZCode.app/Contents/Info.plist');
  }
  for (const file of [...new Set(roots)]) {
    const version = readPlistValue(fs, file, 'CFBundleShortVersionString');
    if (version) return version;
  }
  for (const file of [
    nodePath.join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'app', 'package.json'),
    nodePath.join(home, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'package.json')
  ]) {
    const version = readJsonVersion(fs, file);
    if (version) return version;
  }
  return '';
}

function resolveVersionCachePath(pathImpl, aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  if (!root) return '';
  return pathImpl.join(root, ...CACHE_RELATIVE_PATH);
}

function readCachedZcodeAppVersion(fs, pathImpl, aiHomeDir) {
  const file = resolveVersionCachePath(pathImpl, aiHomeDir);
  if (!file || !fs || typeof fs.readFileSync !== 'function') return { version: '', fetchedAtMs: 0 };
  try {
    const parsed = JSON.parse(String(fs.readFileSync(file, 'utf8') || ''));
    return { version: normalizeVersion(parsed && parsed.version), fetchedAtMs: Number(parsed && parsed.fetchedAtMs) || 0 };
  } catch (_error) { return { version: '', fetchedAtMs: 0 }; }
}

function writeCachedZcodeAppVersion(fs, pathImpl, aiHomeDir, version, nowMs) {
  const file = resolveVersionCachePath(pathImpl, aiHomeDir);
  const normalized = normalizeVersion(version);
  if (!file || !normalized || !fs || typeof fs.writeFileSync !== 'function') return false;
  try {
    fs.mkdirSync(pathImpl.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: normalized, fetchedAtMs: Number(nowMs) || Date.now() }, null, 2)}\n`, 'utf8');
    return true;
  } catch (_error) { return false; }
}

/** 从官方安装页解析最新版本（与 app-installers/zcode.js 同一来源，两边不会漂移）。 */
function parseZcodeAppVersionFromInstallPage(html) {
  const source = String(html || '');
  if (!source) return '';
  const hosted = source.match(
    new RegExp(`https://${ZCODE_DOWNLOAD_HOST.replace(/\./g, '\\.')}/zcode/electron/releases/(\\d+\\.\\d+\\.\\d+)/`)
  );
  if (hosted) return normalizeVersion(hosted[1]);
  const generic = ZCODE_RELEASE_PATH_PATTERN.exec(source);
  return generic ? normalizeVersion(generic[1]) : '';
}

/** 异步刷新缓存（失败静默，不阻断调用方）。 */
async function refreshZcodeAppVersion(options = {}) {
  const {
    fs, path: pathImpl = nodePath, aiHomeDir,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    nowMs = Date.now(), force = false,
    timeoutMs = VERSION_FETCH_TIMEOUT_MS
  } = options;
  const cached = readCachedZcodeAppVersion(fs, pathImpl, aiHomeDir);
  if (!force && cached.version && cached.fetchedAtMs && nowMs - cached.fetchedAtMs < VERSION_CACHE_TTL_MS) {
    return cached.version;
  }
  if (typeof fetchImpl !== 'function') return cached.version;
  let timer = null;
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || VERSION_FETCH_TIMEOUT_MS));
    const response = await fetchImpl(ZCODE_DOWNLOAD_PAGE, {
      headers: { accept: 'text/html' },
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response || response.ok === false) return cached.version;
    const fetched = parseZcodeAppVersionFromInstallPage(await response.text());
    if (!fetched) return cached.version;
    writeCachedZcodeAppVersion(fs, pathImpl, aiHomeDir, fetched, nowMs);
    return fetched;
  } catch (_error) {
    return cached.version;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 同步解析：显式入参 → 本机安装版 → 缓存 → 种子值。 */
function resolveZcodeAppVersionSync(options = {}) {
  const explicit = normalizeVersion(options.appVersion);
  if (explicit) return explicit;
  const installed = readInstalledZcodeAppVersion(options.fs, options.home, options);
  if (installed) return installed;
  const cached = readCachedZcodeAppVersion(options.fs, options.path || nodePath, options.aiHomeDir);
  if (cached.version && compareVersions(cached.version, SEED_ZCODE_APP_VERSION) >= 0) return cached.version;
  return cached.version || SEED_ZCODE_APP_VERSION;
}

module.exports = {
  ZCODE_DOWNLOAD_PAGE,
  VERSION_CACHE_TTL_MS,
  SEED_ZCODE_APP_VERSION,
  normalizeVersion,
  compareVersions,
  readInstalledZcodeAppVersion,
  resolveVersionCachePath,
  readCachedZcodeAppVersion,
  writeCachedZcodeAppVersion,
  parseZcodeAppVersionFromInstallPage,
  refreshZcodeAppVersion,
  resolveZcodeAppVersionSync
};
