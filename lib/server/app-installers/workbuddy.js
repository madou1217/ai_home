'use strict';

const { createProviderInstaller } = require('./provider-factory');

// WorkBuddy 桌面端（国内站 workbuddy.cn）安装源。
//
// 只声明桌面端：WorkBuddy 不对独立分发 CLI——它把 CodeBuddy Code runtime 内嵌在
// App 内（app.asar 里读取 CODEBUDDY_CONFIG_DIR），所以 Provider 合同里
// clients.cli=false，这里也就没有 cli 段。
//
// 国内/海外是两个 App（2026-09-14 核实 Homebrew 官方 cask）：
//   - `workbuddy-cn` → WorkBuddy.app     （https://www.workbuddy.cn/）
//   - `workbuddy-ai` → WorkBuddy AI.app  （https://www.workbuddy.ai/）
// 本机实际安装的是国内站（进程 env CODEBUDDY_INTERNET_ENVIRONMENT=internal），
// 本轮只覆盖它；国际站没有实机验证，按"未验证不声明"留作后续迭代。
module.exports = createProviderInstaller({
  provider: 'workbuddy',
  desktop: {
    macos: {
      // 官方 Homebrew cask `workbuddy-cn` 装 WorkBuddy.app
      // （bundle id com.tencent.workbuddy.mac，实测 5.5.6.38337834）。
      cask: 'workbuddy-cn',
      cleanupHomeTrees: ['Applications/WorkBuddy.app']
    },
    windows: {
      // 官方只提供浏览器下载页，没有可验证的免交互安装源（不伪造 URL）。
      hint: 'WorkBuddy 暂无 Windows 免交互安装源，请从 https://www.workbuddy.cn/ 下载安装后重试。',
      windowsDisplayNames: ['WorkBuddy']
    },
    linux: {
      hint: 'WorkBuddy 暂无 Linux 免交互安装源，请从 https://www.workbuddy.cn/ 下载安装后重试。'
    }
  }
});
