'use strict';

const { createProviderInstaller } = require('./provider-factory');

// WorkBuddy **国内站**（workbuddy.cn）桌面端安装源。
//
// 只声明桌面端：WorkBuddy 不对外分发独立 CLI——它把 CodeBuddy Code runtime 内嵌在
// App 内，所以 Provider 合同里 clients.cli=false，这里没有 cli 段。
//
// 不过那份内嵌 CLI 不是闲置的：它以**国内站**身份运行（product.json 的
// authentication.id = workbuddy-desktop），因此国内站 CLI（codebuddycn）把它当作
// 零安装 CLI 来源（lib/server/app-installers/codebuddy-bundle-cli.js），并复用它与
// 桌面端共享的同一份主站登录态（provider-storage-policy 的
// CODEBUDDY_CN_SHARED_AUTH_PATH）。二者共同构成国内侧的安装 + 登录闭环。
//
// 与国际站是两个 App（2026-09-15 复核 Homebrew 官方 cask 与实机安装）：
//   - `workbuddy-cn` → WorkBuddy.app   （https://www.workbuddy.cn/，
//     bundle id com.tencent.workbuddy.mac，数据根 ~/.workbuddy）← 本条
//   - `workbuddy-ai` → WorkBuddy AI.app（https://www.workbuddy.ai/，
//     bundle id com.workbuddy.workbuddy-ai，数据根 ~/.workbuddy-ai）→ workbuddy.js
module.exports = createProviderInstaller({
  provider: 'workbuddycn',
  desktop: {
    macos: {
      // 官方 Homebrew cask `workbuddy-cn` 装 WorkBuddy.app
      // （实测 5.5.6.38337834-5f969292）。
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
