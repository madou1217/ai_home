'use strict';

const { normalizePlatform } = require('./official-install');
const { resolvePlatformPath } = require('../../runtime/platform-path');
const { CLIENT_PLATFORMS } = require('../../runtime/client-platform');

// WorkBuddy.app（国内站，bundle id com.tencent.workbuddy.mac）把 CodeBuddy Code
// runtime 内嵌在 App 内，位置固定：
//   <WorkBuddy.app>/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy
//
// 该二进制的 product.json 是 productName=WorkBuddy / endpoint=copilot.tencent.com /
// authentication.id=`workbuddy-desktop`，因此它读的就是桌面端写入的那份
// `…/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`。这就是国内侧
// 零安装闭环的来源：机器上装了 WorkBuddy 就不需要再装一份 CLI，也不需要第二份
// 凭据（共享面的声明见 provider-storage-policy 的 CODEBUDDY_CN_SHARED_AUTH_PATH）。
//
// ⚠️ 不要把它当成"和 npm 包等价"：独立分发的 @tencent-ai/codebuddy-code 是同一个
// runtime，但 product.json 里 authentication.id = `Tencent-Cloud.coding-copilot`，
// 读的是**另一个** .info（且与国际站同 id）。两者的可执行性可以互换，凭据文件不能。
//
// 只声明 macOS 路径：WorkBuddy 没有可验证的 Windows/Linux 分发源，不伪造路径
// （与 workbuddy.js 的桌面安装计划口径一致）。
const WORKBUDDY_APP_BUNDLE_TOKENS = Object.freeze([
  '/Applications/WorkBuddy.app',
  '{hostHomeDir}/Applications/WorkBuddy.app'
]);

// App bundle 内 CLI bin 目录的相对段。
const WORKBUDDY_BUNDLED_CLI_SUBPATH = Object.freeze([
  'Contents',
  'Resources',
  'app.asar.unpacked',
  'cli',
  'bin'
]);

// bundle 内实际存在的可执行名（实测 5.5.6：bin/ 下只有 codebuddy 与 cbc-prewarm）。
const WORKBUDDY_BUNDLED_CLI_NAMES = Object.freeze(['codebuddy']);

/**
 * 展开 bundle token（`{hostHomeDir}` 由调用方注入，未知 token 原样保留）。
 *
 * @param {string} token
 * @param {string} hostHomeDir
 * @returns {string}
 */
function resolveBundleToken(token, hostHomeDir) {
  return String(token || '').trim().replace('{hostHomeDir}', hostHomeDir);
}

/**
 * 收集内嵌 CLI 的 bin 目录（可直接进 PATH 的搜索根）。
 *
 * @param {object} [options]
 * @param {string} [options.hostHomeDir] 宿主 HOME；缺失时只返回 /Applications 候选
 * @returns {string[]}
 */
function collectBundledCliPathEntries(options = {}) {
  const platform = normalizePlatform(options);
  if (platform !== CLIENT_PLATFORMS.MACOS) return [];

  const pathImpl = resolvePlatformPath(platform, options.path || require('node:path'));
  if (!pathImpl) return [];
  const hostHomeDir = String(options.hostHomeDir || '').trim();

  return WORKBUDDY_APP_BUNDLE_TOKENS
    .map((token) => resolveBundleToken(token, hostHomeDir))
    .filter((bundlePath) => bundlePath)
    .map((bundlePath) => pathImpl.join(bundlePath, ...WORKBUDDY_BUNDLED_CLI_SUBPATH));
}

module.exports = {
  WORKBUDDY_APP_BUNDLE_TOKENS,
  WORKBUDDY_BUNDLED_CLI_SUBPATH,
  WORKBUDDY_BUNDLED_CLI_NAMES,
  collectBundledCliPathEntries
};
