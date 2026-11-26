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