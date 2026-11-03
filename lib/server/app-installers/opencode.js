'use strict';

const { createProviderInstaller } = require('./provider-factory');
const {
  buildPosixScriptPlan,
  buildPowerShellScriptPlan,
  buildCaskPlan,
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan,
  buildCommandPlan,
  buildWindowsExecutableInstallPlan,
  buildLinuxPackageInstallPlan,
  WINDOWS_NSIS_SILENT_ARGS,
  normalizePlatform
} = require('./official-install');
const {
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  isClientArchitectureSupported
} = require('../../runtime/client-platform');

// OpenCode 1 与 2 是**两个不同的安装器**（2026-10-22 对齐 2.1.2）：
//   - `https://opencode.ai/install` 是 v1 安装器，源码里写死了版本门禁 ——
//     「OpenCode ${version} is not an OpenCode 1 release, so this installer can't install it」，
//     不带 VERSION 时它也只从 `opencode-ai@latest` 与 GitHub 的 `v1.*` 标签里挑版本。
//     也就是说它**永远装不出 2.x**（这是刻意的：老客户端自我升级时不该被换成 2）。
//   - 2.x 走 `https://opencode.ai/v2/install`，装 `@opencode/cli-<target>` 到
//     `~/.opencode/bin`（并补一个 `opencode2` 兼容 shim）。
// aih 的会话读取、headless 入口、run/serve/db 三代布局表都已按 2.x 对齐，安装计划必须跟着走
// 2.x 线 —— 否则用户点「安装 OpenCode CLI」拿到的是我们已不作为主线的那一代。
const OPENCODE_CLI_INSTALL = 'https://opencode.ai/v2/install';
// v2 安装器默认会改写 shell 配置（往 ~/.zshrc / config.fish 追加 PATH，缺文件还会新建一个）。
// 安装作业是从常驻 server 进程里跑的：让后台进程去创建/改写用户的 rc 文件属于意外副作用，
// 而 PATH 本来就由 aih 自己管（collectCliPathEntries 已含 ~/.opencode/bin），所以显式关掉。
const OPENCODE_CLI_INSTALL_ARGS = ['--no-modify-path'];
// v1 的 npm 包是 `opencode-ai`（只含 OpenCode 1），2.x 的包名是 `@opencode/cli`
// （bin 暴露 `opencode` / `opencode2`，平台二进制走 optionalDependencies + postinstall 落位）。
const OPENCODE_CLI_NPM_PACKAGE = '@opencode/cli';
// 上一代的 npm 包名（声明成数据，由安装任务在跑计划前清理）。
//
// 为什么必须清（2026-10-29 真机事故）：两代**共用同一个 bin 名** `opencode`，而 npm 拒绝覆盖
// 别的包已占用的 bin —— 机器上还留着 `opencode-ai`（v1）时，toolkit 的「更新」跑
// `npm install --global @opencode/cli@latest` 会整体失败：
//   npm error code EEXIST / path /opt/homebrew/bin/opencode / File exists
// 于是「v1 → v2」这条升级路径在任何 v1 npm 安装上都必然红（手动 npm uninstall 一次就能过）。
// 清理必须是**安装前的一步**而不是计划列表里的一项：计划列表的语义是「第一个成功即结束」，
// 把清理塞进去会直接吃掉后面的安装计划。
const OPENCODE_CLI_LEGACY_NPM_PACKAGES = Object.freeze(['opencode-ai']);
// OpenCode 的下载页把稳定渠道映射到这些官方下载端点；端点本身不带
// 文件后缀，因此使用对应的安装器构造器补充本地临时文件类型。
const OPENCODE_DESKTOP_WINDOWS = 'https://dev.opencode.ai/download/stable/windows-x64-nsis';
const OPENCODE_DESKTOP_LINUX_DEB = 'https://dev.opencode.ai/download/stable/linux-x64-deb';
const OPENCODE_DESKTOP_LINUX_RPM = 'https://dev.opencode.ai/download/stable/linux-x64-rpm';

function collectCliPathEntries(options = {}) {
  const home = String(options.hostHomeDir || '').trim();
  const adapter = getClientPlatformAdapter(options);
  if (!home || !adapter) return [];
  const pathImpl = adapter.path;
  return [pathImpl.join(home, '.local', 'bin'), pathImpl.join(home, '.opencode', 'bin')];
}

function resolveCliInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const plans = [];
  if (platform === CLIENT_PLATFORMS.MACOS || platform === CLIENT_PLATFORMS.LINUX) {
    plans.push(buildCommandPlan(
      'homebrew_tap',
      'Homebrew 安装 OpenCode CLI（官方 tap）',
      'brew',
      ['install', 'anomalyco/tap/opencode']
    ));
  }
  const npm = buildNpmPlan(OPENCODE_CLI_NPM_PACKAGE, options);
  if (npm) plans.push(npm);
  const plan = platform === CLIENT_PLATFORMS.WINDOWS
    ? buildPowerShellScriptPlan({
      id: 'opencode_windows_official',
      label: 'OpenCode CLI 官方 Windows 安装器',
      url: OPENCODE_CLI_INSTALL,
      hosts: ['opencode.ai'],
      options
    })
    : buildPosixScriptPlan({
      id: 'opencode_posix_official',
      label: 'OpenCode CLI 官方 macOS/Linux 安装器',
      url: OPENCODE_CLI_INSTALL,
      hosts: ['opencode.ai'],
      scriptArgs: OPENCODE_CLI_INSTALL_ARGS,
      options
    });
  return [...plans, plan];
}

function resolveDesktopInstallPlans(options = {}) {
  const platform = normalizePlatform(options);
  const x64OnlyPlatform = platform === CLIENT_PLATFORMS.WINDOWS || platform === CLIENT_PLATFORMS.LINUX;
  if (x64OnlyPlatform && !isClientArchitectureSupported(options, [CLIENT_ARCHITECTURES.X64])) {
    return [];
  }
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    return [buildWindowsExecutableInstallPlan({
      id: 'opencode_desktop_windows_official',
      label: 'OpenCode 官方 Windows Desktop 稳定安装器',
      url: OPENCODE_DESKTOP_WINDOWS,
      hosts: ['dev.opencode.ai'],
      // 官方 Windows 安装包是 NSIS（windows-x64-nsis），/S 静默且为用户级安装。
      silentArgs: WINDOWS_NSIS_SILENT_ARGS,
      options
    })];
  }
  return [
    buildLinuxPackageInstallPlan({
      id: 'opencode_desktop_linux_deb',
      label: 'OpenCode 官方 Linux DEB 稳定安装器',
      url: OPENCODE_DESKTOP_LINUX_DEB,
      hosts: ['dev.opencode.ai'],
      packageType: 'deb'
    }),
    buildLinuxPackageInstallPlan({
      id: 'opencode_desktop_linux_rpm',
      label: 'OpenCode 官方 Linux RPM 稳定安装器',
      url: OPENCODE_DESKTOP_LINUX_RPM,
      hosts: ['dev.opencode.ai'],
      packageType: 'rpm'
    })
  ];
}

module.exports = createProviderInstaller({
  provider: 'opencode',
  cli: {
    resolveInstallPlans: resolveCliInstallPlans,
    resolveUpdatePlans: (options = {}) => [buildNpmUpdatePlan(OPENCODE_CLI_NPM_PACKAGE, options)].filter(Boolean),
    resolveUninstallPlans: (options = {}) => [buildNpmUninstallPlan(OPENCODE_CLI_NPM_PACKAGE, options)].filter(Boolean),
    collectPathEntries: collectCliPathEntries,
    binaryNames: ['opencode'],
    // 上一代 npm 包：与新一代共用 bin 名，安装前必须先摘掉（否则 npm EEXIST，见常量注释）。
    legacyNpmPackages: OPENCODE_CLI_LEGACY_NPM_PACKAGES,
    cleanupHomeFiles: ['.local/bin/opencode'],
    cleanupHomeTrees: ['.opencode/bin']
  },
  desktop: {
    macos: { plans: [buildCaskPlan('opencode-desktop', 'Homebrew 安装 OpenCode Desktop')] },
    windows: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      windowsDisplayNames: ['OpenCode']
    },
    linux: {
      resolveInstallPlans: resolveDesktopInstallPlans,
      linuxPackages: ['opencode', 'opencode-desktop']
    }
  }
});
