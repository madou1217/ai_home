'use strict';

const { createProviderInstaller } = require('./provider-factory');

// WorkBuddy **国际站**（workbuddy.ai）桌面端安装源。
//
// 只声明桌面端：WorkBuddy 不对外分发独立 CLI——它把 CodeBuddy Code runtime 内嵌在
// App 内（app.asar 里读取 CODEBUDDY_CONFIG_DIR），所以 Provider 合同里
// clients.cli=false，这里也就没有 cli 段。
//
// 国内/海外是两个 App（2026-09-15 复核 Homebrew 官方 cask 与实机安装）：
//   - `workbuddy-ai` → WorkBuddy AI.app（https://www.workbuddy.ai/，
//      bundle id com.workbuddy.workbuddy-ai，数据根 ~/.workbuddy-ai）
//   - `workbuddy-cn` → WorkBuddy.app   （https://www.workbuddy.cn/，
//     bundle id com.tencent.workbuddy.mac，数据根 ~/.workbuddy）→ 见 workbuddycn.js
// 本条覆盖国际站；国内站是独立 Provider（builtinWorkbuddyCN / workbuddycn.js）。
//
// 国内侧的零安装 CLI 来源是**国内站的 WorkBuddy.app**（见 codebuddy-bundle-cli.js），
// 与这里的国际站 App 不是同一个 bundle，因此不在这里声明。
module.exports = createProviderInstaller({
  provider: 'workbuddy',
  desktop: {
    macos: {
      // 官方 Homebrew cask `workbuddy-ai` 装 WorkBuddy AI.app
      // （实测 5.5.2.37849279-910352f0）。
      cask: 'workbuddy-ai',
      cleanupHomeTrees: ['Applications/WorkBuddy AI.app']
    },
    windows: {
      // 官方只提供浏览器下载页，没有可验证的免交互安装源（不伪造 URL）。
      hint: 'WorkBuddy AI 暂无 Windows 免交互安装源，请从 https://www.workbuddy.ai/ 下载安装后重试。',
      windowsDisplayNames: ['WorkBuddy AI']
    },
    linux: {
      hint: 'WorkBuddy AI 暂无 Linux 免交互安装源，请从 https://www.workbuddy.ai/ 下载安装后重试。'
    }
  }
});
