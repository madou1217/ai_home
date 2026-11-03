'use strict';

// 本机装了哪些代理客户端：按 URL Scheme 问系统谁来处理（与装在哪个目录无关）。
//   macOS   NSWorkspace URLForApplicationToOpenURL（osascript JXA，一次查完）
//   Windows HKEY_CLASSES_ROOT\<scheme>\shell\open\command（PowerShell，一次查完）
//   Linux   xdg-mime query default x-scheme-handler/<scheme>
// 结果缓存 5 分钟；只在 WebUI 与服务在同一台机器上时有意义，调用方负责判断。

const { execFile } = require('node:child_process');
const path = require('node:path');

const CACHE_TTL_MS = 5 * 60 * 1000;
const RUN_TIMEOUT_MS = 8000;

function runCommand(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: RUN_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || ''));
    });
  });
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(String(text || '').trim() || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (_error) {
    return {};
  }
}

/** /Applications/Clash Verge.app → Clash Verge。 */
function macAppName(appPath) {
  return path.basename(String(appPath || ''), '.app') || null;
}

/** "C:\Program Files\FlClash\FlClash.exe" "%1" → FlClash。 */
function windowsAppName(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  const executable = text.startsWith('"') ? text.slice(1, text.indexOf('"', 1)) : text.split(/\s+/)[0];
  return path.win32.basename(executable).replace(/\.exe$/i, '') || null;
}

async function detectMac(schemes, run) {
  const script = [
    "ObjC.import('AppKit');",
    'var ws = $.NSWorkspace.sharedWorkspace; var out = {};',
    `${JSON.stringify(schemes)}.forEach(function (s) {`,
    "  var url = $.NSURL.URLWithString(s + '://import');",
    '  var app = url.isNil() ? null : ws.URLForApplicationToOpenURL(url);',
    '  out[s] = app && !app.isNil() ? ObjC.unwrap(app.path) : null;',
    '});',
    'JSON.stringify(out);'
  ].join('\n');
  const result = parseJsonObject(await run('osascript', ['-l', 'JavaScript', '-e', script]));
  return Object.fromEntries(schemes.map((scheme) => [scheme, macAppName(result[scheme])]));
}

async function detectWindows(schemes, run) {
  const list = schemes.map((scheme) => `'${scheme.replace(/'/g, "''")}'`).join(',');
  const script = [
    '$r = @{}',
    `foreach ($s in @(${list})) {`,
    '  $k = "Registry::HKEY_CLASSES_ROOT\\$s\\shell\\open\\command"',
    "  $v = (Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue).'(default)'",
    '  $r[$s] = $v',
    '}',
    '$r | ConvertTo-Json -Compress'
  ].join('\n');
  const result = parseJsonObject(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
  return Object.fromEntries(schemes.map((scheme) => [scheme, windowsAppName(result[scheme])]));
}

async function detectLinux(schemes, run) {
  const entries = await Promise.all(schemes.map(async (scheme) => {
    const desktopFile = (await run('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`])).trim();
    return [scheme, desktopFile ? desktopFile.replace(/\.desktop$/, '') : null];
  }));
  return Object.fromEntries(entries);
}

const DETECTORS = Object.freeze({ darwin: detectMac, win32: detectWindows, linux: detectLinux });

class LocalClientDetector {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.run = options.run || runCommand;
    this.now = options.now || Date.now;
    this.cache = null;
  }

  /** → { [scheme]: 处理它的应用名 | null }；不支持的平台返回全 null。 */
  async detect(schemes) {
    const key = schemes.join(',');
    if (this.cache && this.cache.key === key && this.now() - this.cache.at < CACHE_TTL_MS) return this.cache.result;
    const detector = DETECTORS[this.platform];
    const result = detector
      ? await detector(schemes, this.run)
      : Object.fromEntries(schemes.map((scheme) => [scheme, null]));
    this.cache = { key, at: this.now(), result };
    return result;
  }
}

/** 请求是否来自本机（loopback）：只有这时「本机安装检测」说的才是用户眼前这台电脑。 */
function isLoopbackAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  return value === '::1' || /^127\./.test(value) || /^::ffff:127\./.test(value);
}

module.exports = {
  CACHE_TTL_MS,
  LocalClientDetector,
  isLoopbackAddress,
  macAppName,
  windowsAppName
};
