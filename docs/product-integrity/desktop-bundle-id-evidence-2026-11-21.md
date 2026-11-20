# 桌面端 bundle 名称 / bundle id 取证（2026-11-21）

目的：在把 `cmd/aih/desktop.go` 与 `lib/server/desktop-launch/desktop-app-catalog.js`
的桌面应用事实收敛进 Provider manifest 之前，先确认每个 bundle 的**权威名称与
bundle id**。本文记录证据与结论；据此做的代码修正列在最后一节。

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

## 实装复核（2026-11-21）

为避免只靠 cask 元数据推断，直接在本机安装了两种 Kiro 产物并观察落点：

```sh
brew install --cask kiro-cli   # 3.4.0 → /opt/homebrew/bin/kiro-cli
brew install --cask kiro       # 1.4.215 → /Applications/Kiro.app
```

结果：

- `kiro-cli` 的 Caskroom 里只有 `kirocli/bin/kiro-cli`、`install.sh`、`README`、
  `BUILD-INFO`；`/Applications` 与 `~/Applications` 都没有新增 `.app`，
  LaunchServices 也没有新增注册项。安装脚本与 README 均说明「只安装一个二进制」，
  卸载方式是删除该二进制。
- `kiro` 装出 `/Applications/Kiro.app`，`CFBundleIdentifier = dev.kiro.desktop`，
  `CFBundleExecutable = Kiro`，LaunchServices 注册为 `dev.kiro.desktop`。
- `kiro-cli` 二进制内部仍能检出 `kiro_cli_desktop` 与 `com.amazon.codewhisperer`
  字符串，与安装脚本提到的「legacy bundled Kiro CLI」一致：那是**旧版随 CLI 分发的
  GUI 外壳**，当前发行物已不再包含。

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

### 2. Kiro：当前发行物没有 `Kiro CLI.app`，桌面端是 `Kiro.app`

- 官方 Kiro CLI 3.4.0 实装（cask）只落一个二进制；安装脚本与 README 明确说明
  卸载即删除二进制。3.5.0 的 zip 中央目录同样只有
  `kirocli/bin/kiro-cli`、`install.sh`、`README`、`BUILD-INFO`。
- `com.amazon.codewhisperer` 是**启动器/缓存/旧外壳**的身份：
  cask zap 路径里有 `LaunchAgents/com.amazon.codewhisperer.launcher.plist`、
  `Caches/com.amazon.codewhisperer`、`WebKit/com.amazon.codewhisperer`；
  CLI 偏好域另有 `dev.kiro.cli`；二进制里还能检出 `kiro_cli_desktop` 与
  `com.amazon.codewhisperer` 字符串。
- 桌面应用由 cask `kiro` 实装为 `Kiro.app` / `dev.kiro.desktop`。

结论：`Kiro CLI.app` 只应作为**旧安装的回落落点**保留，主落点必须是
`Kiro.app` / `dev.kiro.desktop`；否则只装 IDE 的机器会被 report 成未安装
（修正前实测就是 false）。

### 3. manifest 缺少两个已确认的 bundleId

- `zcode`：manifest 的 DesktopPlatform 没有 `bundleId`，实际为 `dev.zcode.app`。
- `kiro`：manifest 没有 `bundleId`；若统一到桌面 IDE，应为 `dev.kiro.desktop`。

## 据此执行的修正

1. manifest（`core/providers/builtins.go`，已重新生成 `contracts/providers/manifest.json`）：
   - `zcode` 补 `bundleId: dev.zcode.app`；
   - `kiro` 主落点改为 `Kiro.app` / `dev.kiro.desktop`，`Kiro CLI.app` 保留为
     旧安装回落；Windows 侧未改。
2. 桌面目录（Go 与 Node 同步）：
   - CodeBuddy 拆成 `codebuddy`（`CodeBuddy.app` / `com.tencent.codebuddy`）与
     `codebuddy-cn`（`CodeBuddy CN.app` / `com.tencent.codebuddycn`）；
   - Kiro 的查找顺序改为 `Kiro.app` 优先，`Kiro CLI.app` 回落。
3. 验证（本机真实 `aih desktop status --json`）：
   - 修正前：`kiro installed=false`（即使 `/Applications/Kiro.app` 已安装），
     `codebuddy` 一条同时承担两站；
   - 修正后：`kiro installed=true`、`bundleId=dev.kiro.desktop`、
     `path=/Applications/Kiro.app`；两张 CodeBuddy 条目分别报告；
   - 用一个只含 Info.plist 的假 `CodeBuddy CN.app` 验证：`codebuddy-cn` 命中并读出
     `com.tencent.codebuddycn` 与版本号，国际站条目保持未安装；验证后已删除假 bundle。

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

