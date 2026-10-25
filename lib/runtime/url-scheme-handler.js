'use strict';

// macOS URL scheme（`zcode:`）的注册与**转发兜底**。
//
// 为什么需要：ZCode 的自定义协议回调 `zcode://oauth/callback` 是本机唯一被上游
// 注册为合法 redirect_uri 的自定义协议路径（另一条是官方 HTTPS 回调）。默认情况下
// `zcode:` 由 ZCode Desktop 持有（Info.plist 的 CFBundleURLTypes），aih 收不到任何东西。
//
// 让 aih 接管它会**抢走桌面端的回调** —— 因此本模块的核心不是「抢」，而是
// **接管 + 转发兜底**：收到 `zcode://` 时先判断是不是 aih 自己发起的登录
// （按 state 匹配在途任务），不是就原样转交给 ZCode Desktop。
// 这样两条链路（aih 与桌面端）都能正常完成授权。
//
// 平台边界：`LSSetDefaultHandlerForURLScheme` 只有 macOS 有，且要求目标是一个
// **已注册的 app bundle**（裸可执行文件不行）。因此 aih 需要造一个极小的
// AIH.app 壳（无窗口、无 UI，只声明 scheme 并把 URL 交给 aih 处理）。
// 其它平台本模块一律返回 unsupported，不做任何系统改动。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { execFileSync } = require('node:child_process');

// aih 自己的 app bundle 标识与位置。放在 aiHome 下，卸载即删目录，不污染 /Applications。
const AIH_APP_BUNDLE_ID = 'dev.aih.urlhandler';
const AIH_APP_NAME = 'AIH URL Handler.app';
// ZCode Desktop 的 bundle id（转发目标）——它是 `zcode:` 的原始持有者。
const ZCODE_DESKTOP_BUNDLE_ID = 'dev.zcode.app';
const ZCODE_URL_SCHEME = 'zcode';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 该平台是否支持本机制（只有 macOS 有 LSSetDefaultHandlerForURLScheme）。 */
function isUrlSchemeSupported(platform = process.platform) {
  return String(platform || '').trim() === 'darwin';
}

/** aih app 壳的位置（aiHome 下，便于随 aih 数据一起卸载）。 */
function resolveAihAppPath(aiHomeDir, pathImpl = nodePath) {
  const root = normalizeString(aiHomeDir);
  if (!root) return '';
  return pathImpl.join(root, 'tools', AIH_APP_NAME);
}

/** app 壳里的可执行文件（协议处理器实际被调用的入口）。 */
function resolveAihAppExecutable(appPath, pathImpl = nodePath) {
  const base = normalizeString(appPath);
  if (!base) return '';
  return pathImpl.join(base, 'Contents', 'MacOS', 'aih-url-handler');
}

function buildInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${AIH_APP_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>AIH URL Handler</string>
  <key>CFBundleExecutable</key><string>aih-url-handler</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>CFBundleURLName</key><string>AIH ZCode OAuth</string>
      <key>CFBundleURLSchemes</key>
      <array><string>${ZCODE_URL_SCHEME}</string></array>
    </dict>
  </array>
</dict>
</plist>
`;
}

/**
 * app 壳的可执行脚本：把收到的 URL 交给 aih 处理。
 * macOS 调用协议处理器时把 URL 作为 argv[1] 传入。
 */
function buildHandlerScript(aihBinPath) {
  const bin = normalizeString(aihBinPath);
  return `#!/bin/sh
# AIH URL Handler —— 由 aih 自动生成，不要手改。
# macOS 把 zcode://… 作为第一个参数传进来；交给 aih 判定（自己的登录 or 转发桌面端）。
exec "${bin}" zcode-url "$@"
`;
}

/** 把 URL 交给 ZCode Desktop（转发兜底）。 */
function forwardToZcodeDesktop(url, deps = {}) {
  const open = typeof deps.open === 'function' ? deps.open : null;
  const target = normalizeString(url);
  if (!target) return false;
  try {
    if (open) { open(['-b', ZCODE_DESKTOP_BUNDLE_ID, target]); return true; }
    execFileSync('/usr/bin/open', ['-b', ZCODE_DESKTOP_BUNDLE_ID, target], { stdio: 'pipe' });
    return true;
  } catch (_error) {
    // 桌面端没装 / 转发失败：不影响 aih 自己的流程。
    return false;
  }
}

/**
 * 当前 scheme 的默认处理器 bundle id。
 *
 * 用 LaunchServices 的 LSCopyDefaultHandlerForURLScheme（唯一权威来源）；
 * 它只有 C/Swift API，Node 里通过一次性编译的 swift 脚本调用。
 * 不用 `lsregister -dump` 解析文本：那是调试输出，格式随系统版本变（实测读不到）。
 */
function readCurrentHandler(scheme = ZCODE_URL_SCHEME) {
  const target = normalizeString(scheme) || ZCODE_URL_SCHEME;
  if (!isUrlSchemeSupported()) return '';
  const source = `import CoreServices\nimport Foundation\nif let h = LSCopyDefaultHandlerForURLScheme("${target}" as CFString) { print(h.takeRetainedValue() as! String) } else { print("") }\n`;
  const scriptPath = nodePath.join(require('node:os').tmpdir(), `aih-lscheck-${process.pid}.swift`);
  try {
    nodeFs.writeFileSync(scriptPath, source, 'utf8');
    // swift 编译器的告警走 stderr，stdout 只有我们要的那一行 —— 直接取 stdout。
    const out = execFileSync('/usr/bin/swift', [scriptPath], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000
    }).toString('utf8');
    return normalizeString(out);
  } catch (_error) {
    return '';
  } finally {
    try { nodeFs.unlinkSync(scriptPath); } catch (_error) { /* 清理失败不影响结果 */ }
  }
}

module.exports = {
  AIH_APP_BUNDLE_ID,
  AIH_APP_NAME,
  ZCODE_DESKTOP_BUNDLE_ID,
  ZCODE_URL_SCHEME,
  isUrlSchemeSupported,
  resolveAihAppPath,
  resolveAihAppExecutable,
  buildInfoPlist,
  buildHandlerScript,
  forwardToZcodeDesktop,
  readCurrentHandler
};
