# AIH Launch（Alt+Space 应用启动器）验收记录

日期：2026-11-26
实现：AWS 主机上的 AGY `gemini-4-neon-xhigh`（effort `xhigh`），分支 `launcher`，经 3 轮 senior review（P0/P1/P2）修复后合并回 `main`。

## 1. 需求核对

| 需求 | 状态 | 证据 |
| --- | --- | --- |
| Alt+Space（macOS ⌥Space）唤起 | 已实现 | macOS `CGEventTap`（吞键防 NBSP）+ `ShortcutRegistry` 回退；Windows `RegisterHotKey`，失败自动降级 `WH_KEYBOARD_LL`；Linux `XGrabKey`（BadAccess 时上报并支持 `aih launch toggle`） |
| 搜索应用 | 已实现 | Go 唯一排序真值（§6）+ 三端本地过滤（含 aliases 与 usage boost）；macOS 实时截图与离屏渲染、Linux 过滤截图 |
| 打开应用 | 已实现 | macOS/Windows 走管理 API（失败原生兜底）；Linux `gio launch → gtk-launch → Exec`，真实 fork 子进程（touch 探针） |
| 越用越好用 + 中英文（2026-11-26 追加） | ✅ 100% | frecency（14 天半衰期）驱动空查询与匹配加成；不再用 A–Z；macOS 读取 zh-Hans/zh_CN `InfoPlist.strings`，`微信`/`wechat` 均可命中（见 §4.1） |
| 单例（2026-11-26 追加） | ✅ 100% | helper 整机单实例 + 三端独立启动器锁；重复 show 窗口 id 不变、窗口数恒为 1；第二实例被拒（见 §4.2） |
| macOS / Windows / Linux 桌面 | 已实现 | macOS AppKit 面板、Windows WinForms 面板、Linux GTK4 面板 |
| UI 动画/交互顶级 | 已实现 | 见截图；弹簧缩放/淡入/stagger/选中高亮/圆角毛玻璃/自动隐藏滚动条 |
| 仅桌面系统可用 | 已实现 | headless Linux 不装配启动器运行时、不注册路由（实测 404）、不编译 GTK、不启动 launcherd；darwin/windows 的 launcherd 只编译 stub |
| 用 AWS agy gemini-4-neon-xhigh 完成开发 | 已完成 | `aih agy session` 常驻会话，模型 gemini-4-neon-xhigh、effort xhigh |

## 2. 构建验证

~~~text
go build ./...                                  # darwin arm64：通过
GOOS=windows GOARCH=amd64 go build ./...        # 通过
GOOS=linux   GOARCH=amd64 go build ./...        # 通过
xcrun swiftc -typecheck ...（全部 macSources）   # exit 0
gcc -O2 -Wall -Wextra ... main.c                # 0 warning（AWS 上实测）
dotnet publish（Windows 真机，self-contained）   # 成功，单文件 aih-translation.exe
~~~

## 3. 真机验收

### 3.1 macOS（本机）

- `aih launch status`：darwin、supported、74 个可见应用（`LSUIElement`/`LSBackgroundOnly` 后台 helper 已过滤）。
- `aih launch apps --q vsc` → Visual Studio Code；`--q calc` → Calculator；`aih launch open <id>` 真实启动 Calculator 并写入 usage。
- 私有 home 起 server：`POST /v1/management/launcher/show` 返回 200；AIH Launch 窗口真实创建（680×520，layer 3）；窗口级截图见下。
- 合并版 helper 编译并运行，面板渲染 74 个应用、圆角/无滚动条/筛选高亮正常。
- 截图：`docs/assets/launcher/macos-panel.png`（真实 AppKit 视图渲染，非设计稿）。

### 3.2 Linux（AWS / xvfb-run + openbox）

- headless：`/v1/management/launcher/status` → 404；无 `aih-launch-ui` 编译产物/进程。
- 桌面会话：`/status` → 200，`desktop.supported=true`；socket 目录 `0700`、socket `0600`。
- 交互：`aih launch toggle` 唤起；`xdotool type` 过滤（3/13）；↑↓/Enter 打开（真实 fork，`/tmp/aih-open-proof` 被创建）；Esc 隐藏；再次 Alt+Space/toggle 恢复。
- Alt+Space 被 openbox 占用时正确上报「Alt+Space 被窗口管理器占用，可用 aih launch toggle 绑定」；裸 Xvfb 下 XGrabKey 直接生效。
- 截图：`docs/assets/launcher/linux-panel.png`、`docs/assets/launcher/linux-filter.png`。

### 3.3 Windows（真机编译与最小运行）

- `dotnet publish` 成功（net8.0-windows / self-contained / 单文件）。
- 以协议输入真实启动 `aih-translation.exe`：收到 hello 后输出 ready/status；Alt+Space 在非交互 SSH 会话返回 1459，自动降级到 `WH_KEYBOARD_LL` 并上报 status（符合设计）。
- 限制：验收期间 Windows 控制台处于锁屏（`LockApp.exe` 在 session 1），无法进行 GUI 截图与热键真机交互；解锁后按下面步骤复验即可。

## 4. 评审闭环（AWS agy xhigh）

- 第一轮评审批次 P0×3、P1×10、P2×4，全部修复：Windows `ShellExecuteW` 替换 `cmd start`（消除元字符/%VAR% 注入）；launcherd stdin 关闭竞态与 Close/Run 生命周期；Linux open 取消不重复启动；socket umask/私有目录/非阻塞；API `limit`/`q` 上限；Windows TSF 组合态放行；Linux 去掉 350ms 提前隐藏；macOS 权限撤销销毁 tap、拒绝无修饰快捷键；`usage.json` 跨进程锁与 rename 重试；`Start()` 锁序；`--daemon` 去重；`launcher-show` 校验可用性；boost 三端一致；Windows 亚克力/Rune/焦点；Linux END 闪烁/Revealer。

## 4.1 Frecency 与中英文（2026-11-26 追加）

需求：越用越好用；常用/最近打开的排前，没打开过的排后；不使用 A–Z；中英文都能搜。

- 使用记录改为指数衰减热度（半衰期 14 天）：`score = score*exp(-Δt/14d)+1`；空查询按热度降序，未使用过的按 `ModifiedAtMs`（安装/更新时间）降序，最后按 ID；非空查询 `base + effectiveBoost`，其中 `effectiveBoost = min(rawBoost,150,999-base)`，保证名称全等永远第一、弱匹配不能越级压过前缀匹配。
- 三端 UI 使用 server 透传的 `rawBoost` 并按同一公式计算；空查询保持 server 顺序，同分按 serverIndex/ID，不再比较名称。
- macOS 增加 `zh_CN.lproj`/`zh-Hans.lproj/InfoPlist.strings`（UTF-16）解析：`WeChat` 的 alias 为 `微信`；`--q 微信` 与 `--q wechat` 都命中。
- 本机真实结果：临时 home 中 App Store 热度 10、Calculator 热度 3 → 空查询顺序 `App Store → Calculator → 其余（按 mtime）`；`q=app` 时 App Store（名称前缀 900+effectiveBoost 99=999）第一，Calculator（副标题 300+150=450）第二；`q=微信` 命中 WeChat（截图 `docs/assets/launcher/macos-wechat-alias.png`）。
- v1→v2 迁移验证：旧 `count:25` 读取即 boost 700；`aih launch open` 一次后磁盘升级为 `version:2, score≈21, count:26`；30 天未用 score 10 → boost 70（符合半衰期）。

## 4.2 单例（2026-11-26 追加）

要求：启动器必须单例，不能同时打开多个面板；重复触发只切换/置前。

- 机制：桌面 helper 本身已有整机单实例锁（剪贴板 Quick Orbit 的 `~/.ai_home/run/desktop-translation/helper.lock`，第二个 helper 退出）；启动器再加第二层锁——macOS `~/Library/Application Support/AIH/launcher.lock`（fcntl 记录锁，目录 0700/文件 0600，失败 250ms×5s 重试）、Windows `Local\AIH-Launcher-Singleton-v1` 命名互斥体、Linux `<socket>.lock` + socket probe；`show()` 已可见时仅置前。
- macOS 实测：唯一 helper（pid 81111）持有 `launcher.lock`（`lsof` 可见 fd）；连续两次 `POST /launcher/show` 后窗口 id 仍为 `17362`、`AIH Launch` 窗口数 = 1；另起私有 home 的第二个 helper 因 helper 单例直接退出，其 `/show` 返回 501，窗口数仍为 1。
- Windows 实测（session 0）：A 持锁时 B 在 5s 后输出 `启动器已在另一个 AIH 桌面实例中运行（单例）` 且保持翻译 helper 运行；A 退出后新实例 C 正常取得 `Alt+Space`（无单例错误）。
- Linux 实测（AWS，xvfb+openbox）：`show` 两次窗口 id 均为 `4194309`、count=1；第二次 `aih launch ui --daemon`、前台 `aih launch ui`、手工再起 `aih-launch-ui` 均退出 0 且窗口仍为 1；杀掉主实例后新实例可成为新单例并正常 `show`。
- 备注：单例实现中 Swift 的 `flock` 与 `struct flock` 同名，实际使用 `fcntl(F_SETLK)` 记录锁（commit `73ecc8d7`）。

## 4.3 Windows 正式 Server 与目录完整性（2026-11-26 追加）

- 部署：用最新 `aih-server.exe` 替换 `%USERPROFILE%\.ai_home\bin\aih-server.exe`（原 1.0.8 包不认识 `launch`），原生源码放在 `%USERPROFILE%\.ai_home\native\translation\`（`main.swift` 标记 + `windows/{Program.cs,AihTranslation.csproj,app.manifest}`）供 server 按指纹构建 helper；`AihServerWindows` 计划任务启动，server/helper 均运行在交互 session 1。
- 修复的真实 Bug：`Get-StartApps` 的 **子 powershell.exe 在该计划任务上下文会卡住**，导致 `scanWindowsStartApps` 超时后静默返回空，所有 UWP/Store 应用（Calculator、Settings、Terminal、Microsoft Store、截图工具等）缺失。现改为通过临时 VBS + `cscript` 枚举 `shell:AppsFolder`（UTF-16LE 文件输出，无控制台编码依赖），`.lnk` 扫描仅作兜底。
- 去重：以 AppsFolder 为唯一来源，按显示名与小写可执行路径去重，避免 `.lnk` 与 AppsFolder 合并产生的跨语言重复（如 `Chrome Remote Desktop` / `Chrome 远程桌面`）。
- 真机结果：`GET /v1/management/launcher/apps` → **199** 条；系统 `Get-StartApps` 199 条；缺失 0、重复 0；`Calculator`（`shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`）通过 `POST /open` 真实拉起（CalculatorApp 进程）。
- 面板：真实 `Alt+Space` 唤起显示「199 个应用」，排序按 frecency/mtime，非 A–Z；截图见会话记录。

## 4.4 Toolkit 卸载残留快捷方式（2026-11-26 追加）

- 现象：Toolkit 卸载（如 Antigravity）后，开始菜单/桌面仍保留指向已删除目录的 `.lnk`。
- 修复：新增 `internal/runtime/winshell`（VBS + cscript 枚举 `.lnk` 并解析 WScript.Shell TargetPath，UTF-16LE 文件输出，避免子 powershell 在任务上下文卡住）；`internal/runtime/toolkit/apps/shortcut_cleanup*` 按 provider 的客户端名与安装根匹配：
  - 目标在安装根下，或目标不存在且快捷方式名等于/以 `<客户端名> ` 开头 → 删除；
  - 其它断链只放进 `keptBroken` 展示，不删除；只处理 `.lnk`，删除后仅清理 Start Menu 下变空的父目录。
- 入口：卸载成功后自动执行；另提供 `POST /v1/management/webui/toolkit/apps/cleanup`（`{}` 或 `{"provider":"agy"}`）与 `aih toolkit cleanup-residue [--provider] [--json]`。
- Windows 真机：清理 agy 删除 3 个残留（`Antigravity.lnk`、`Antigravity IDE\Antigravity IDE.lnk`、OneDrive 桌面 `Antigravity.lnk`）与空目录；`HONOR WorkStation.lnk` 等无关断链保留；二次执行 `removed=[]`；启动器目录回归仍 **199/199，missing=0**。

## 4.5 卸载即自动清理（快捷方式 + 注册表，2026-11-27 追加）

- 用户要求：清理必须是**卸载动作内部的自动步骤**，包括注册表，不是手动再点“清理残留”。
- 实现：`internal/runtime/toolkit/apps` 的 Windows 卸载成功路径（desktop 与 cli）在 finalize 前自动执行组合清理：
  - 快捷方式：Start Menu\Programs（用户/机器）与 Desktop（用户/公共）；
  - 注册表：HKCU Uninstall / App Paths / Run / RunOnce（HKLM 只读探测，命中仅提示需管理员）；
  - 匹配：目标在 Provider 安装根下，或（目标失效且名称等于/以 `<客户端名> ` 开头）；无关断链只报告不删；作业结果含 `removedShortcuts` / `removedRegistry`。
- 顺带修复检测 Bug：Windows 桌面应用探测原先用子 `powershell.exe` 查询卸载注册表，在服务任务上下文中会卡住，导致已安装应用显示未安装、卸载计划无法解析；改为 `golang.org/x/sys/windows/registry` 直接读取（与清理共用）。
- Windows 真机端到端（9541 验证 Server + 真实 OpenCode Desktop）：
  1. 通过 Toolkit 安装 `opencode-desktop`，检测 `installed=true`；
  2. 通过 Toolkit 卸载，作业 `status=succeeded`，attempts 依次为 `windows_registered_app_uninstall` → `opencode_managed_desktop_uninstall` → `windows_residue_cleanup`；
  3. 自动删除 3 个快捷方式（`OpenCode Test.lnk`、`OpenCode.lnk`、OneDrive 桌面 `OpenCode.lnk`）与 4 个注册表项（`App Paths\OpenCode.exe`、`Run::OpenCode`、`Uninstall\AIH-OpenCode-Test`、应用自身残留的 `Uninstall\d074f30d-…`）；
  4. HONOR 的卸载键/App Paths/Run/桌面快捷方式全部保留；
  5. 清理后启动器目录 `196/196，missing=0`（与系统 Start 项一致）。
## 4.6 1.0.10 发行包部署（2026-11-27 追加）

- 1.0.9 发行包构建早于本轮修复；将版本升至 **1.0.10**（commit `58b8df51`，已推送 `origin/main`），用 `scripts/deploy-server.js --ref origin/main --target win32-x64` 从 `origin/main` 构建并安装。
- 产物：`aih-1.0.10-win32-x64.exe`（57.0 MiB，SFX payload `56f651a5c1d7`）、`aih-1.0.10-win32-x64.zip`（87.8 MiB，`de775074e8ca6d77`）；安装输出「安装完成，账号、配置和会话数据已保留（1.0.10）」。
- Windows 真机核验：
  - 运行进程 `C:\Users\madou\.ai_home\pkg\1.0.10-win32-x64-56f651a5\bin\native\win32-x64\aih-server.exe`（pid 52512，08:44:51 启动）；旧 `1.0.9-win32-x64-91a25405` 作为回滚备份保留。
  - `GET /readyz` 200、`GET /ui/` 200。
  - `/v1/management/launcher/status` → `platform=windows, supported=true, count=196, lastError=""`；目录 `196/196，missing=0`（与 `Get-StartApps` 一致）。
  - Toolkit 应用列表 30 项；桌面客户端探测经原生注册表路径识别出 `codex-desktop / claude-desktop / qoder-desktop / qodercn-desktop / kimi-desktop / kiro-desktop / zcode-desktop / vscode`（不再依赖会卡住的子 PowerShell）。
  - 二进制符号核对：`findWindowsRegisteredDesktopClientNative`、`cleanupProviderResidueAfterUninstall`、`RegistryResidue`、`scanWindowsShellApps` 均存在（1.0.10 包含原生卸载检测与自动残留清理）。
  - helper（pid 45180，08:44:53）由新源码指纹目录 `run/desktop-translation/windows/helper/7d1dd4aa…` 重新构建。
  - 真实唤起：`POST /v1/management/launcher/show` 返回 200，交互会话截图中面板实际渲染（Calculator、百度网盘、迅雷、Python 3.14 Manuals、Python 3.14、PhpStorm、WebStorm、DataGrip…）；面板为无标题栏工具窗口，`MainWindowTitle` 枚举不到属正常。

## 4.7 Windows 中英文搜索与搜索框配色（2026-11-27 追加）

- 用户反馈：Windows 上中英文不能都筛到应用；搜索框颜色与面板割裂。
- 实现：
  - `internal/runtime/appcatalog/windows_search_aliases.go`（新）：Windows Shell 只返回当前显示语言的名称，因此为每个目录项生成双向 aliases——内置中英别名表（Calculator↔计算器、Settings↔设置、WeChat↔微信、百度网盘↔Baidu Netdisk、钉钉↔DingTalk 等）+ 从 exe 名/包标识/路径推导英文名（`Weixin.exe`→Weixin、`BaiduNetdisk.exe`→BaiduNetdisk/Baidu Netdisk、`QuarkClouddrive_…`→QuarkClouddrive）；协议目标（`steamchina://`）不参与推导，`http(s)` 文档快捷方式只取主机名。
  - `scan_windows.go` 为每个条目写入 aliases，并过滤开始菜单里的卸载快捷方式（187 条，避免卸载器继承产品别名）。
  - `native/translation/windows/Program.cs`：Win11 acrylic 会给整窗叠加材质色，使真实 `TextBox` 背景比自绘搜索胶囊更亮；移除 acrylic，统一不透明深色渐变。
- Windows 真机（1.0.11/1.0.12 发行包，API + 面板截图）：
  - `微信`→微信输入法/微信开发者工具/**WeChat**；`计算器`→Calculator；`设置`→Settings；`百度`/`baidu`→百度网盘；`迅雷`/`thunder`→迅雷；`钉钉`/`dingtalk`→钉钉；`火绒`/`huorong`→火绒安全软件；`夸克`/`quark`→夸克网盘；`终端`/`terminal`→Terminal；`商店`→Microsoft Store；`截图`→Snipping Tool；`资源管理器`/`explorer`→File Explorer；`哔哩哔哩`/`bilibili`→哔哩哔哩；`刀塔`/`dota`→Dota 2 刀塔；`我的世界`/`minecraft`→我的世界；`腾讯`→QQ/TIM。
  - 面板实际粘贴 `微信` → 3 / 187，命中微信输入法、微信开发者工具、WeChat；搜索框、胶囊与面板同色。

## 4.8 Windows 后台服务不再显示终端（2026-11-27 追加）

- 用户反馈：Windows 启动后前置一个空终端（Windows Terminal 标题 `kimi-code`），关闭后 AIH 功能异常。
- 根因：`autostart.installWindows` 的 ONLOGON 计划任务把 `.cmd` 直接作为 action，Task Scheduler 以可见控制台启动 `cmd.exe`；Win11 默认终端接管后出现空白终端窗口，关闭即杀掉 Server 进程树。
- 修复：`<home>\run\aih-server-launch.vbs`（`WScript.Shell.Run "<comspec> /d /s /c "<serve.cmd>"", 0, False`）；任务 action 改为 `wscript.exe //nologo <vbs>`；Startup 兜底也写 VBS（删除旧 `.cmd`）；WMI 重启路径复用同一 VBS；`serviceFiles` 纳入备份/回滚。
- 真机：按同一逻辑改造任务并重启后 `readyz=200`；server 与 helper `MainWindowHandle=0`；交互会话窗口枚举不再出现该终端（仅剩用户自己的 PowerShell 终端），server 父进程 `cmd.exe` 命令行正确且无窗口。
- 首个发行验证暴露的第二个缺陷：`installWindows` 把 `/TR` 的值又包了一层 `windowsQuote`，schtasks 最终存成 `Execute=wscript.exe //nologo "` + 分离的参数字符串，任务实际不执行；安装器的 90 秒启动验证因此报 `readyz connection refused`，回滚也超时（1.0.14/1.0.15）。修复：`/TR` 直接传单个 argv（由 Go 负责 CreateProcess 转义），并用 `New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd` 覆盖 schtasks 默认的电池/空闲停止策略。
- 真机复验（`com.meadeo.ai_home.probe` 任务）：action 为 `wscript.exe` + `//nologo "…\aih-server-launch.vbs"`，`battery_disallow=False`、`idle_stop=False`，任务启动后 `readyz=yes`，server 来自目标发行包。
- 发行状态：代码提交 `3982d2cb`（引号修复）、`7948e61a`（1.0.16）；1.0.13 曾因并行会话未提交文件 `cmd/aih/global_sessions_native.go` 无法构建，main 恢复后发布 1.0.16。
- 1.0.16 真机验收：安装到 `pkg\\1.0.16-win32-x64-f1a60056`；任务 `com.meadeo.ai_home` = `wscript.exe` + `//nologo "…\\run\\aih-server-launch.vbs"`（ONLOGON / madou / Interactive），`battery_disallow=False`、`stop_on_battery=False`、`idle_stop=False`；`readyz` 为 `ready:true`（64 模型 / 126 路由）；优雅停止后经任务重启仍 `ready`，server `MainWindowHandle=0`，交互会话窗口枚举只剩用户自己的 PowerShell 终端；启动器目录 187 条，`微信/计算器/百度/thunder/dingtalk/终端/商店/截图/资源管理器/刀塔/腾讯` 等中英查询正常。

## 5. 已知限制 / 复验步骤

- Windows 锁屏：解锁后执行
  1) 启动 AIH Server（计划任务或 `aih server start`）；
  2) 确认 `%LOCALAPPDATA%\aih\aih.exe server status` 与桌面 helper 运行；
  3) 按 Alt+Space 唤起、输入关键字、↑↓/Enter/Esc，截图。
- macOS 全局热键需要辅助功能授权（helper 既有约束）；未授权时 status 会说明。
- Linux Wayland 下 XGrabKey 不可用，使用桌面环境把快捷键绑定到 `aih launch toggle`（或启动器 socket）。
- 从源码部署到已有 Server：正常重启 Server 后，helper 会按新源码重建并启用 ⌥Space/Alt+Space。

## 6. 代码入口

- Go：`application/launcher`、`internal/runtime/appcatalog`、`internal/runtime/applaunch`、`internal/adapters/launcherstore`、`internal/transport/http/webuilauncherapi`、`internal/runtime/launcherd`、`cmd/aih/launch.go`。
- macOS：`native/launcher/*.swift`（编入现有 AIH Translation helper）。
- Windows：`native/translation/windows/Program.cs`。
- Linux：`internal/runtime/launcherd/ui/main.c`（`//go:embed`，桌面会话才编译）。