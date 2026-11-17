'use strict';

// `aih zcode-scheme` —— 接管 / 归还 macOS 的 `zcode:` URL scheme。
//
// 为什么需要：aih 的 custom-scheme 登录依赖收到 `zcode://oauth/callback`。
// 该 scheme 默认由 ZCode Desktop 持有，aih 收不到。本命令让 aih 造一个极小的
// app 壳并成为默认处理器；**收到 URL 后由转发兜底判定归属**（见
// lib/runtime/url-scheme-handler.js 与 lib/server/zcode-url-callback.js）：
// aih 自己的登录任务处理，其它原样转交桌面端 —— 因此桌面端登录不受影响。
//
// 子命令：
//   status    当前 `zcode:` 的处理器是谁（aih / 桌面端 / 未知）
//   install   造 app 壳并注册为默认处理器（幂等）
//   uninstall 归还给 ZCode Desktop 并删除 app 壳（幂等）
//
// 平台：只有 macOS 支持（LSSetDefaultHandlerForURLScheme）。其它平台明确报不支持，
// 不做任何系统改动。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  AIH_APP_BUNDLE_ID,
  ZCODE_DESKTOP_BUNDLE_ID,
  ZCODE_URL_SCHEME,
  isUrlSchemeSupported,
  resolveAihAppPath,
  resolveAihAppExecutable,
  buildInfoPlist,
  buildHandlerScript,
  readCurrentHandler
} = require('../../runtime/url-scheme-handler');

const USAGE = [
  '用法: aih zcode-scheme <status|install|uninstall>',
  '',
  '  status     查看当前 zcode: 协议由谁处理',
  '  install    让 aih 接管 zcode: 协议（aih 自己的登录直接处理，其它转发给 ZCode Desktop）',
  '  uninstall  把 zcode: 协议归还给 ZCode Desktop，并删除 aih 的处理器 app',
  '',
  '说明：仅 macOS 支持。install 后桌面端登录不受影响 —— 非 aih 的回调会原样转发。'
].join('\n');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 让 LaunchServices 重新扫描指定 app（注册/注销后必须刷新，否则改动不生效）。 */
function registerWithLaunchServices(appPath) {
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  try {
    execFileSync(lsregister, ['-f', appPath], { stdio: 'ignore' });
    return true;
  } catch (_error) {
    return false;
  }
}

/** 设置 scheme 的默认处理器（经一次性 swift 脚本调 LSSetDefaultHandlerForURLScheme）。 */
function setDefaultHandler(scheme, bundleId) {
  const source = [
    'import CoreServices',
    'import Foundation',
    `let status = LSSetDefaultHandlerForURLScheme("${scheme}" as CFString, "${bundleId}" as CFString)`,
    'print(status == 0 ? "ok" : "err:\\(status)")'
  ].join('\n');
  const scriptPath = nodePath.join(require('node:os').tmpdir(), `aih-lsset-${process.pid}.swift`);
  try {
    nodeFs.writeFileSync(scriptPath, `${source}\n`, 'utf8');
    const out = execFileSync('/usr/bin/swift', [scriptPath], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000
    }).toString('utf8');
    return normalizeString(out) === 'ok';
  } catch (_error) {
    return false;
  } finally {
    try { nodeFs.unlinkSync(scriptPath); } catch (_error) { /* 清理失败不影响结果 */ }
  }
}

/** 造 aih 的协议处理器 app 壳（幂等：已存在则覆盖内容）。 */
function writeHandlerApp(options = {}) {
  const fs = options.fs || nodeFs;
  const appPath = options.appPath;
  const executable = resolveAihAppExecutable(appPath, options.path || nodePath);
  fs.mkdirSync(nodePath.dirname(executable), { recursive: true });
  fs.writeFileSync(nodePath.join(appPath, 'Contents', 'Info.plist'), buildInfoPlist(), 'utf8');
  fs.writeFileSync(executable, buildHandlerScript(options.aihBinPath), { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return { appPath, executable };
}

function runZcodeSchemeCommand(args = [], deps = {}) {
  const consoleImpl = deps.consoleImpl || console;
  const fs = deps.fs || nodeFs;
  const platform = deps.platform || process.platform;
  const sub = normalizeString(args[0]).toLowerCase();

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    consoleImpl.log(USAGE);
    return 0;
  }
  if (!['status', 'install', 'uninstall'].includes(sub)) {
    consoleImpl.error(`\x1b[31m[aih] 未知子命令: ${sub}\x1b[0m`);
    consoleImpl.log(USAGE);
    return 1;
  }
  if (!isUrlSchemeSupported(platform)) {
    consoleImpl.error(`\x1b[31m[aih] ${ZCODE_URL_SCHEME}: 协议接管只支持 macOS（当前 ${platform}）\x1b[0m`);
    return 1;
  }

  const aiHomeDir = normalizeString(deps.aiHomeDir);
  const appPath = resolveAihAppPath(aiHomeDir, deps.path || nodePath);

  if (sub === 'status') {
    const current = readCurrentHandler();
    const owner = current === AIH_APP_BUNDLE_ID
      ? 'aih（本机登录直接处理，其它转发给 ZCode Desktop）'
      : (current === ZCODE_DESKTOP_BUNDLE_ID ? 'ZCode Desktop' : (current || '未知'));
    consoleImpl.log(`  ${ZCODE_URL_SCHEME}: 当前处理器 = ${owner}`);
    consoleImpl.log(`  aih 处理器 app: ${fs.existsSync(appPath) ? appPath : '(未安装)'}`);
    return 0;
  }

  if (sub === 'install') {
    const aihBinPath = normalizeString(deps.aihBinPath);
    if (!aihBinPath) {
      consoleImpl.error('\x1b[31m[aih] 无法定位 aih 可执行文件，接管已取消。\x1b[0m');
      return 1;
    }
    try {
      writeHandlerApp({ fs, path: deps.path, appPath, aihBinPath });
    } catch (error) {
      consoleImpl.error(`\x1b[31m[aih] 写入处理器 app 失败: ${(error && error.message) || error}\x1b[0m`);
      return 1;
    }
    registerWithLaunchServices(appPath);
    if (!setDefaultHandler(ZCODE_URL_SCHEME, AIH_APP_BUNDLE_ID)) {
      consoleImpl.error('\x1b[31m[aih] 注册默认处理器失败（LaunchServices 拒绝了请求）。\x1b[0m');
      return 1;
    }
    const now = readCurrentHandler();
    if (now !== AIH_APP_BUNDLE_ID) {
      consoleImpl.error(`\x1b[31m[aih] 注册后读回的处理器仍是 ${now || '空'}，接管未生效。\x1b[0m`);
      return 1;
    }
    consoleImpl.log(`  ✅ aih 已接管 ${ZCODE_URL_SCHEME}: 协议`);
    consoleImpl.log('     aih 自己的登录直接处理；其它 zcode:// 回调会原样转发给 ZCode Desktop。');
    consoleImpl.log(`     归还：aih zcode-scheme uninstall`);
    return 0;
  }

  // uninstall：先归还，再删 app 壳（顺序反了会让 scheme 悬空）。
  const restored = setDefaultHandler(ZCODE_URL_SCHEME, ZCODE_DESKTOP_BUNDLE_ID);
  try {
    fs.rmSync(appPath, { recursive: true, force: true });
  } catch (error) {
    consoleImpl.error(`\x1b[31m[aih] 删除处理器 app 失败: ${(error && error.message) || error}\x1b[0m`);
    return 1;
  }
  if (!restored) {
    consoleImpl.error(`\x1b[31m[aih] 归还给 ZCode Desktop 失败，请手动设置 ${ZCODE_URL_SCHEME}: 的默认应用。\x1b[0m`);
    return 1;
  }
  consoleImpl.log(`  ✅ ${ZCODE_URL_SCHEME}: 已归还给 ZCode Desktop，aih 处理器 app 已删除`);
  return 0;
}

module.exports = {
  USAGE,
  registerWithLaunchServices,
  setDefaultHandler,
  writeHandlerApp,
  runZcodeSchemeCommand
};
