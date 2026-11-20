# 桌面端 bundle 名称 / bundle id 取证（2026-11-21）

目的：在把 `cmd/aih/desktop.go` 与 `lib/server/desktop-launch/desktop-app-catalog.js`
的桌面应用事实收敛进 Provider manifest 之前，先确认每个 bundle 的**权威名称与
bundle id**。本文只记录证据与结论，不改代码。

## 方法

1. 本机已安装应用：读 `Contents/Info.plist`（`PlistBuddy`）。
2. Homebrew Caskroom 里保留的安装产物与 symlink 目标。
3. Homebrew Cask API 元数据（`formulae.brew.sh/api/cask/<token>.json`）：
   `uninstall quit`、`zap trash` 里的 bundle id 与偏好域，以及 cask 的官方下载
   `url` / `homepage`（用来确认 cask 对应哪个站点）。
4. LaunchServices 注册库（`lsregister -dump`）。
5. 官方 Kiro CLI 安装包（cask 使用的 zip）中央目录清单。

## 结论

| 产品 | Bundle 名称 | Bundle ID | 证据 |
| --- | --- | --- | --- |
| ChatGPT（codex 桌面） | `ChatGPT.app` | `com.openai.codex` | cask `chatgpt`：`uninstall quit: "com.openai.codex"`；lsregister 有 `com.openai.codex` |
| Claude | `Claude.app` | `com.anthropic.claudefordesktop` | cask `claude`：`uninstall quit` 同时列主/helper；zap 有 `...claudefordesktop.ShipIt`；lsregister 命中 |
| CodeBuddy 国际站 | `CodeBuddy.app` | `com.tencent.codebuddy` | cask `codebuddy`：homepage `codebuddy.ai/ide`；zap 路径 `com.tencent.codebuddy.plist` / `.sfl` / `.ShipIt` |
| CodeBuddy 国内站 | `CodeBuddy CN.app` | `com.tencent.codebuddycn` | cask `codebuddy-cn`：homepage `copilot.tencent.com/ide`；zap 路径 `com.tencent.codebuddycn*` |
| WorkBuddy 国际站 | `WorkBuddy AI.app` | `com.workbuddy.workbuddy-ai` | cask `workbuddy-ai`：`uninstall quit`；lsregister 有 `com.workbuddy.workbuddy-ai`（含 helper） |
| WorkBuddy 国内站 | `WorkBuddy.app` | `com.tencent.workbuddy.mac` | 本机已安装 `/Applications/WorkBuddy.app` 的 Info.plist；cask `workbuddy-cn`；Caskroom 保留产物同一值 |
| ZCode | `ZCode.app` | `dev.zcode.app` | 本机 `/Users/model/Applications/ZCode.app`（3.18.2）Info.plist；cask `zcode` |
| Kiro IDE | `Kiro.app` | `dev.kiro.desktop` | cask `kiro`：`uninstall quit: "dev.kiro.desktop"`；zap 有 `Preferences/dev.kiro.desktop.plist` |

## 与现有代码的差异

### 1. CodeBuddy 国内站被错误地合并进国际站 bundle

- `cmd/aih/desktop.go`：一个 `Key: "codebuddy"` 条目同时服务 `codebuddy` 与
  `codebuddycn`，BundleIDs 只有 `com.tencent.codebuddy`。
- `lib/server/desktop-launch/desktop-app-catalog.js`：同样的合并。
- manifest（`core/providers/builtins.go` / `contracts/providers/manifest.json`）
  是正确的：国内站是独立 App，`CodeBuddy CN.app` / `com.tencent.codebuddycn`，
  官方 cask 也分成 `codebuddy` 与 `codebuddy-cn`。

影响：只装国内站 App 的机器上，`desktop status` 会显示未安装；两站都装时，
国内站账号会绑定到国际站 App。

### 2. Kiro 的 `Kiro CLI.app` / `com.amazon.codewhisperer` 证据不足

- 官方 Kiro CLI 3.5.0 安装包（cask 使用的
  `kirocli-universal-darwin.zip`）中央目录只有 6 个条目：
  `kirocli/bin/kiro-cli`、`install.sh`、`README`、`BUILD-INFO` 等，
  **没有任何 `.app`**。
- `com.amazon.codewhisperer` 只在 cask 的 zap 路径里作为「启动器/缓存身份」出现：
  `~/Library/LaunchAgents/com.amazon.codewhisperer.launcher.plist`、
  `~/Library/Caches/com.amazon.codewhisperer`、
  `~/Library/WebKit/com.amazon.codewhisperer`。
  CLI 的偏好域另有 `dev.kiro.cli`。
- Kiro 的桌面应用由 cask `kiro` 安装：`Kiro.app` / `dev.kiro.desktop`。
- manifest 同时列了 `/Applications/Kiro CLI.app` 与 `/Applications/Kiro.app`
  两条安装路径；目前只有后者有可复现证据。

结论：`Kiro CLI.app` + `com.amazon.codewhisperer` 作为**应用 bundle** 不成立；
如果产品仍要支持「Kiro CLI 桌面外壳」，需要拿到真实安装包再登记，否则应删掉该条目。

### 3. manifest 缺少两个已确认的 bundleId

- `zcode`：manifest 的 DesktopPlatform 没有 `bundleId`，实际为 `dev.zcode.app`。
- `kiro`：manifest 没有 `bundleId`；若统一到桌面 IDE，应为 `dev.kiro.desktop`。

## 建议的后续改动（尚未执行）

1. manifest：给 `zcode` 补 `bundleId: dev.zcode.app`；给 `kiro` 补
   `bundleId: dev.kiro.desktop`，并决定 `Kiro CLI.app` 路径的去留。
2. 桌面目录：把 CodeBuddy 拆成国际/国内两条（名称与 id 分别对应），
   Kiro 改用 `Kiro.app` / `dev.kiro.desktop`；Node 目录与 Go 目录必须同步，
   否则两侧 `desktop status` 会给出不同答案。
3. 验收：本机有 WorkBuddy 国内站与 ZCode 可用于真实 `aih desktop status --json`；
   CodeBuddy 两站需要安装真实 App（或至少造一个只含 Info.plist 的假 bundle）
   才能验证查找路径。

## 复现命令（摘要）

```sh
# 已安装 App 的 bundle id
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  /Applications/WorkBuddy.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$HOME/Applications/ZCode.app/Contents/Info.plist"

# Homebrew cask 的官方产物与 bundle 身份
curl -s https://formulae.brew.sh/api/cask/codebuddy.json
curl -s https://formulae.brew.sh/api/cask/codebuddy-cn.json
curl -s https://formulae.brew.sh/api/cask/kiro-cli.json
curl -s https://formulae.brew.sh/api/cask/kiro.json
# 关注字段：url（厂商域名）、artifacts[].app / uninstall.quit / zap.trash

# LaunchServices 已注册的 bundle id
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump \
  | grep -E 'com\.openai\.codex|com\.anthropic\.claudefordesktop|dev\.zcode\.app|com\.workbuddy\.workbuddy-ai'

# 官方 Kiro CLI 安装包内容（无需整包下载：读 zip 中央目录）
# 结果：仅 kirocli/bin/kiro-cli、install.sh、README、BUILD-INFO，无 .app
```

