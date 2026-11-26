# AIH Launch：Alt+Space 应用启动器（设计与实施）

日期：2026-11-25
状态：待实现（由 AWS 主机上的 AGY `gemini-4-neon-xhigh` 完成开发，本机/真机验收）
范围：macOS / Windows / Linux（桌面）三平台；只做「唤起 + 搜索应用 + 打开」。

## 1. 目标

做一个 uTools / Raycast / Alfred 形态的命令启动器，但只保留唯一能力：

- 全局快捷键 `Alt+Space`（macOS 显示为 `⌥Space`）随时唤起；
- 输入即搜索本机已安装应用（中英文、拼音无关的子序列匹配即可），↑↓ 选择、Enter 打开、Esc 关闭；
- 再次按快捷键可切换（显示/隐藏）；
- 三个桌面平台都有原生、流畅、可截图验收的 UI，动画与交互达到「顶级」标准；
- 应用目录、搜索排序、打开动作、使用频次都收敛在 Go 核心，不出现三份互相漂移的业务逻辑；
- 不依赖 WebUI 页面常开，也不要求翻译功能开启。

明确不做（本阶段非目标）：文件/计算器/网页/插件/剪贴板搜索、AI 对话、系统命令、窗口管理、自定义主题编辑器、应用卸载/管理、云同步、拼音首字母匹配（可后续加）。

桌面专属（2026-11-25 用户明确）：AIH Launch 只在桌面系统存在。无桌面会话的主机（如 headless Linux Server）**不装配启动器运行时、不注册启动器路由、不编译 GTK UI、不启动 launcherd/helper**；`aih launch` CLI 仍可在本机按需运行（本地扫描/打开，不依赖 Server）。

## 2. 交互规格（三平台一致）

1. 快捷键唤起：面板从屏幕上方 ~20% 处淡入 + 轻微上浮 + 0.96→1.0 弹性缩放（150–200ms），背景为暗色毛玻璃，边框带青色微光；无系统标题栏。
2. 搜索框自动聚焦（IME 可用）；输入即时过滤（本地过滤，零网络往返），选中项默认第 1 条。
3. 键盘：
   - `↑`/`↓`：移动选择，选中行高亮以 100–140ms 缓动滑过去；
   - `Enter`：打开选中应用，面板 120ms 淡出后关闭；
   - `Esc`：关闭；输入法有候选/组合态时 `Esc` 先交给输入法；
   - `Alt+Space`（再次按下）：关闭；
   - 点击某行：打开该应用；点击面板外：关闭；
   - 列表为空时显示行内空状态（不是整块 Alert）。
4. 视觉语言沿用 AIH HUD：背景 `#080b15`、面板 `#101727`、主色 `#62edff`、辅色 `#b18bff`、文字 `#e8edf8`、弱文字 `#8493ae`；等宽 eyebrow（`AIH LAUNCH`）、1px 分隔线只做控件边界，状态表达用背景、完整边框、图标和留白（遵守仓库 UI 约束：禁止大块 Alert、禁止左侧彩色竖条）。
5. 每行：36–40px 应用图标（圆角 9–10）、应用名（15–16px 半粗）、副标题（路径或「应用程序」，12px 弱色），选中行右侧显示 `↵`；匹配到的字符在名称中高亮。
6. 面板尺寸：macOS 680×520，Windows/Linux 720×540；多显示器时出现在鼠标所在屏幕。列表最多显示 8 条，超出滚动。
7. 首次唤起允许 100–300ms 应用目录扫描（仅在后台），期间先显示已缓存列表/加载行；之后随时缓存，5 分钟内不重复扫描。

## 3. 分层与文件

~~~text
application/launcher/                 领域：App/Query/Rank/Usage；端口 Catalog、Launcher、UsageStore
internal/runtime/appcatalog/          平台应用目录（darwin/windows/linux + 共享缓存与去重）
internal/runtime/applaunch/           平台打开动作（darwin/windows/linux）
internal/adapters/launcherstore/      使用频次（~/.ai_home/run/launcher/usage.json，原子写）
internal/transport/http/webuilauncherapi/  管理 API（/v1/management/launcher/*）
internal/host/aihserver/webui_launcher_routes.go  装配 + 路由
cmd/aih/launch.go                     CLI（apps/open/catalog/toggle/ui/enable/disable）
native/launcher/LauncherPanel.swift   macOS 原生面板（编入现有 AIH Translation.app）
native/launcher/LauncherPanelModel.swift
native/launcher/LauncherPanelViews.swift
internal/runtime/launcherd/ui/main.c  Linux GTK4 启动器（//go:embed 嵌入，内联 CSS，走 stdio 协议）
internal/runtime/launcherd/           Linux 桌面监督器（构建 + 启动 GTK 进程、X11/Wayland 能力探测）
~~~

约束：

- `application/launcher` 不 import 平台代码；平台差异只出现在 `appcatalog`/`applaunch` 的 `_darwin.go`、`_windows.go`、`_linux.go`。
- 不新增第三方 Go 依赖（不引入 plist/JSON 库；原生 plist 自行解析 XML，二进制 plist 回退文件名）。
- 不新增测试文件（用户明确：真实测试，不写用例）。
- 所有跨平台 UI 的过滤算法按第 6 节规格实现，三端行为一致；排序真值在 Go（CLI/API 使用），UI 端本地过滤仅用于零延迟输入。

## 4. 数据模型与使用频次

不新建 SQLite 表，避免与业务库迁移纠缠：

`~/.ai_home/run/launcher/usage.json`

~~~json
{"version":2,"apps":{"<appId>":{"openedAtMs":1764000000000,"count":7,"score":4.82,"updatedAtMs":1764000000000}}}
~~~

- 打开成功后 UPSERT：先按 `exp(-Δt / HALF_LIFE)` 衰减旧 `score` 再 `+1`，`count+1`、`openedAtMs=now`、`updatedAtMs=now`；兼容读取 v1（`score=min(count,20)`、`updatedAtMs=openedAtMs`，下次写入时升级到 v2）；
- 只保留最近 500 条（按 openedAtMs），原子写（临时文件 + rename，0600）；
- 目录刷新/应用消失不影响记录，仅排序时查不到对应应用就忽略。

应用 ID：`sha256(platform + "\x00" + sourceKey)` 前 16 字节 hex（sourceKey 分别为 bundle 路径 / .lnk 路径或 AUMID / desktop file ID）。同一应用跨扫描稳定。

## 5. 管理 API

前缀 `/v1/management/launcher`，沿用现有 Management Key authorizer（参考 clipboard handler 的 `webuiclipboardapi`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/apps?q=&refresh=1&limit=` | 返回 `{platform, generatedAt, apps:[...], truncated}`；`q` 最多 256 个字符（超出返回 400 `invalid_query`）；`q` 为空时按第 6 节 frecency（再 `ModifiedAtMs` → ID，不用名称 A–Z）排序，`q` 非空时按第 6 节排序；`limit` 钳制在 `1..2000`（默认 2000）；`refresh=1` 强制重扫 |
| POST | `/open` | body `{id}`；打开成功记录 usage 并返回 `{ok:true}`；失败返回 4xx/5xx 与 `{error, message}` |
| POST | `/show` | 让桌面面板显示（Server 向 helper 下发 `{"type":"launcher-show"}`；Linux 走 launcherd socket）；无桌面面板时 501 |
| GET | `/status` | `{platform, supported, count, generatedAt, lastError, desktop?}`；Linux 桌面附带 `desktop:{supported, built, binaryPath, pid, desktopError, autostart}` |

> 非桌面系统（如 headless Linux 服务器，无 `DISPLAY`/`WAYLAND_DISPLAY`）在 Server 装配阶段直接跳过启动器，不注册 `/v1/management/launcher/*`（请求返回 404），不构建也不拉起 UI 进程；`darwin`/`windows` 构建仅编译 `launcherd` stub，不嵌入 GTK C 源码。

`App` JSON 字段：

~~~json
{"id":"…","name":"Visual Studio Code","subtitle":"/Applications/Visual Studio Code.app",
 "path":"/Applications/Visual Studio Code.app","kind":"app|uwp|flatpak|snap|desktop",
 "icon":"/Applications/Visual Studio Code.app","terminal":false,
 "aliases":["Code"],"boost":35}
~~~

- `icon`：macOS 为 .app 路径；Windows 为 .lnk/.exe 路径（UWP 为空，UI 用通用图标）；Linux 为 `Icon=` 值（主题名或绝对路径）。
- `subtitle` 截断 160 字符；`name` 截断 120 字符；`boost` 为查询时动态计算的 §6 frecency 使用加成（`clamp(round(frecency*60), 0, 700)`），仅用于三端本地打分对齐，不参与 ID 计算或持久化。
- 列表上限默认且最大为 2000，超出时 `truncated=true`。

## 6. 搜索与排序（唯一规格）

输入归一化：`strings.TrimSpace` → 小写（保留 CJK）。字段：`name`（主）、`subtitle`（辅）。

对每个应用取最高分：

- 名称全等：1000
- 名称前缀匹配：900 −(名称长度−查询长度，上限 50)
- 任一词（按空白/`-_/`切分）前缀：800
- 词首缩写（`vsc` → Visual Studio Code）：750
- 名称子串：700 − 位置（上限 100）
- 名称子序列（按序、不连续）：600 − 间隔总数（上限 150）
- 任一 alias（`Aliases`，macOS/Linux 中英文别名等）前缀/词前缀/缩写/子串/子序列命中：650（不与名称分叠加，取最大值）
- 仅副标题命中：300

CJK 查询同样按「前缀/子串/子序列」处理（不做拼音）。

加成（**frecency，2026-11-26 用户明确：越用越好用，不使用 A–Z**）：
- 使用记录不再只存 count/最近时间，而是存**指数衰减热度**：`score = score*exp(-Δt/ HALF_LIFE) + 1`，`HALF_LIFE = 14 天`；每次通过启动器打开（UI/CLI/API）都更新。
- 计算时按当前时间再次衰减，得到 `frecency`；对外透传 `rawBoost = clamp(round(frecency*60), 0, 700)`。
- 查询非空：实际计分使用 `effectiveBoost = min(rawBoost, 150, max(0, 999 - base))`，`总分 = base + effectiveBoost`；名称全等（`base=1000`）永远排第一，常用前缀匹配最高 `999` 不压过全等，子序列（最高 `600+150=750`）不越级压过未使用前缀（`850..900`）。同分时按 `rawBoost` 高者优先，再按安装/更新时间（`ModifiedAtMs`）新者优先，最后 ID；**不再按名称 A–Z 排序**。
- 空查询：仍按 `frecency` 原始值降序（不受 150 限制）；从未打开过的（frecency=0）排后，按 `ModifiedAtMs` 降序（最近安装/更新优先），最后 ID。**不使用名称字典序**。
- Server 在 `/apps` 的 `boost` 字段与 Linux `LAUNCH1` 第 10 列透传 `rawBoost`；三端本地过滤按同一 `effectiveBoost` 计分，且空查询保持 Server 顺序、同分只以 server 顺序/ID 作最终 tiebreak。
- 迁移：旧 `usage.json`（只有 count/openedAtMs）读取时按 `score = min(count,20)`、`updatedAt = openedAtMs` 初始化，之后正常衰减。

以上常量只出现在 Go 的一处（`application/launcher/rank.go`）；三端 UI 的本地区间过滤必须按相同规则实现，常量在各自源码中明确注明「与 rank.go 同步」。

## 7. 应用目录（平台细节）

### macOS（appcatalog darwin）

- 扫描：`/Applications`、`/System/Applications`、`/System/Applications/Utilities`、`~/Applications`（递归 3 层），收集 `*.app`。
- 名称：**目录名去 `.app`** 作为主名称（用户在 Finder/终端里看到的就是它，例如 `Visual Studio Code` 而不是 plist 里的 `Code`）；解析 `Contents/Info.plist`（XML）得到的 `CFBundleDisplayName`/`CFBundleName` 作为 `aliases`（最多 4 个），仅用于搜索匹配。
- 中英文：额外读取 `Contents/Resources/zh_CN.lproj/InfoPlist.strings`（依次回退 `zh-Hans.lproj`、`zh.lproj`，支持 UTF-16LE/BE BOM、UTF-8 与 XML/二进制 plist）中的 `CFBundleDisplayName`/`CFBundleName` 作为中文 alias（例如 `WeChat` → `微信`），使中文与英文查询都能命中同一应用；`.strings` 解析失败不影响主流程。
- 去重：同一真实路径只保留一条（`filepath.EvalSymlinks`，失败用原路径）。
- 打开：`open -a <path>`（`exec.Command`，无 shell）。
- 备注：系统应用（Safari 等）名称可能为英文目录名，属可接受回退。

### Windows（appcatalog windows）

- 扫描开始菜单：`%ProgramData%\Microsoft\Windows\Start Menu\Programs`、`%APPDATA%\Microsoft\Windows\Start Menu\Programs` 递归收集 `*.lnk`（跳过 `Startup` 目录）。
- UWP：执行 PowerShell `Get-StartApps | ConvertTo-Json -Compress`（超时 8s，失败静默）；每项 `Name` + `AppID` → `kind:"uwp"`，`path:"shell:AppsFolder\\<AppID>"`。
- 去重：同 .lnk 路径唯一；UWP 以 AppID 唯一；名称与 .lnk 重名时都保留（不同来源）。
- 打开：.lnk 用 `cmd /c start "" "<path>"`（`SysProcAttr{HideWindow:true}`）；UWP 用 `explorer.exe shell:AppsFolder\<AppID>`。
- 图标：UI 用 `Icon.ExtractAssociatedIcon(path)`；UWP 用通用方块图标。

### Linux（appcatalog linux）

- 扫描目录：`$XDG_DATA_HOME/applications`（默认 `~/.local/share/applications`）、`$XDG_DATA_DIRS` 各项（默认 `/usr/local/share:/usr/share`）的 `applications`、`/var/lib/flatpak/exports/share/applications`、`~/.local/share/flatpak/exports/share/applications`、`/var/lib/snapd/desktop/applications`。递归一层。
- 解析 `*.desktop` INI 的 `[Desktop Entry]`：`Type=Application`、`Hidden=true`/`NoDisplay=true` 跳过；`Name`（`Name[zh_CN]` 优先，再 `Name[zh]`，再 `Name`，并将英文名/本地化名互为 `aliases`，最多 4 个）；`Exec`、`Icon`、`Terminal`、`StartupWMClass` 忽略；使用 `.desktop` 文件 mtime 填充 `ModifiedAtMs`。
- 去重：Desktop ID（相对 applications 的路径，`/`→`-`）。
- 打开：优先 `gio launch <desktop 文件>`；失败或不存在时 `gtk-launch <desktop-id>`；再失败则解析 `Exec`（去掉 `%f %F %u %U %i %c %k` 等字段）直接 `exec.Command`（终端应用用 `x-terminal-emulator -e …` 或 GNOME Terminal）。
- 图标：`Icon=` 原样返回。

## 8. 桌面壳接入

### 8.0 单例（2026-11-26 用户明确）

启动器必须是**单例**：同一登录会话最多一个面板，重复触发只切换/置前，不能叠出第二个窗口；多实例竞争时只允许一个实例拥有启动器，其余实例保留翻译/剪贴板但不注册启动器快捷键。

- macOS：helper 内用 `flock(LOCK_EX|LOCK_NB)` 竞争 `~/Library/Application Support/AIH/launcher.lock`（目录 0700、文件 0600）；首次失败先每 250ms 异步重试最多 5s（避免重启交接瞬间误判），5s 仍失败才禁用 launcher（销毁 CGEventTap、不注册快捷键）并上报 status「启动器已在另一个 AIH 桌面实例中运行（单例）」，之后每次 `configure(enabled=true)` 再尝试一次（已持有则跳过）；翻译/剪贴板不受影响，锁 fd 在禁用/退出时释放。
- Windows：`CreateMutexW(NULL, TRUE, "Local\\AIH-Launcher-Singleton-v1")`；`ERROR_ALREADY_EXISTS` 时立即关闭句柄，首次失败每 250ms 异步重试最多 5s，5s 仍失败才禁用 launcher（不注册热键/钩子）并上报 status，之后每次 `configure(enabled=true)` 再尝试一次（已持有则跳过）；进程退出/禁用时 `ReleaseMutex` + `CloseHandle`。
- Linux：GTK 进程在 bind socket 前用 `flock` 竞争 `<socket>.lock`；失败则尝试向现有 socket 发送 `show` 后退出 0，绝不 unlink 他人 socket。launcherd 的 `Start/Run/StartDetached` 都先 `ProbeSocket`：已有实例时复用（不 Build、不 spawn），`/show` 直接走 socket。
- 幂等：`show()` 在面板已可见时只置前/聚焦，不重放进场动画；`launcher-show`/`Alt+Space` 重复触发只 toggle 或保持单窗口。
- 叠加保证：桌面 helper 本身已有整机单实例（剪贴板 Quick Orbit 的 `~/.ai_home/run/desktop-translation/helper.lock`，第二个 helper 直接退出），因此正常产品路径下不可能出现两个面板；launcher 自己的锁是防御性第二层，覆盖未来 helper 锁被放宽或多 home 并存的场景。

### 8.1 Go：让启动器独立于翻译开关

- `desktoptranslation.Options` 增加 `LauncherEnabled func() bool`、`LauncherOrigin` 复用本地 origin；默认实现返回 `true`（macOS/Windows 桌面）。
- `Service.Start`/`ReconcileClipboard`（改名或新增 `ReconcileDesktopFeatures`）把「翻译开启 || 剪贴板开启 || 启动器开启」作为 helper 存活条件；
- `configure` 事件新增：`launcherShortcut`（默认 `⌥Space`/`Alt+Space`）、`launcherEnabled`、`launcherOrigin`、`launcherKey`（仅 launcherEnabled 时下发管理密钥）；
- `internal/runtime/desktopprotocol/message.go` 的允许字段列表加入上述键；
- macOS/Windows 的 helper 被关闭（用户禁用所有能力）时才 Stop。

### 8.2 macOS 面板（native/launcher/*.swift）

- `ShortcutRegistry`：
  - 新增 `defaultLauncherShortcut = "⌥Space"`；
  - `keyCode(for:)` 支持 `space`（49）；
  - `charactersIgnoringModifiers` 不作为匹配依据，现有 keyCode 方案不变。
- 事件吞噬：`NSEvent` 全局 monitor **不能**吞掉按键，Option+Space 会把不换行空格（NBSP）打进当前输入框。启动器快捷键必须优先用 `CGEventTap`（`.cgSessionEventTap`，keyDown，匹配 keyCode 49 + option）返回 `nil` 吞掉事件；权限不足或 tap 创建失败时回退到 `ShortcutRegistry` 的全局 monitor（此时允许 NBSP 泄漏，并在 status 里说明）。tap 与启动器生命周期绑定（禁用/关闭时销毁）。
- `main.swift`：
  - 创建 `LauncherPanel`；
  - `registerShortcuts` 增加 descriptor `id:"launcher"`（显示名「启动器」）；
  - `configure` 分支读取 `launcherEnabled/launcherShortcut/launcherOrigin/launcherKey`；`launcherEnabled` 且 origin+key 非空时可用；
  - 全局 Esc 处理优先级：现有面板不变，启动器面板 key 时由启动器消费；
  - 面板窗口关闭时恢复前台应用（remember frontmost app，打开后 activate）。
- 面板实现要求：
  - `NSPanel`，`styleMask [.titled, .fullSizeContentView, .nonactivatingPanel]`，`titleVisibility .hidden`，`titlebarAppearsTransparent`，`level .floating`，`collectionBehavior [.canJoinAllSpaces, .fullScreenAuxiliary]`，`hidesOnDeactivate false`；
  - 背景：`NSVisualEffectView`（`.hudWindow`, `.behindWindow`）+ 自定义圆角裁剪 + 1px 青边（用 `CALayer` 组合，不用左侧竖条）；
  - 顶部 eyebrow `AIH LAUNCH`、右侧结果计数；搜索行 22pt 输入；列表 `NSTableView` 自绘行（不用系统 selection）；底部 kbd 提示；滚动条必须 `.overlay` + 自动隐藏（结果不足一屏时不显示），避免常驻滚动条破坏 HUD 观感；
  - 动画：使用 `NSAnimationContext` + `CALayer`：进场 alpha 0→1、transform.scale 0.96→1（`CASpringAnimation` damping 18/stiffness 220/mass 0.8）、y 偏移 10→0；退场 120ms ease-in；选中行高亮用独立 layer 的圆角背景做位置/透明度动画（`CABasicAnimation` 120ms）；
  - 列表 diff：过滤结果更新时用 `NSAnimationContext` 的 `reloadData` + 首屏行 stagger（每行延迟 12ms、上移 6px 淡入，最多 8 行）；
  - 数据：首次 show 时 GET `launcherOrigin + /v1/management/launcher/apps`（Header `Authorization: Bearer <launcherKey>`，参考 ClipboardPanel 的请求方式），缓存内存；过期 5 分钟在后台刷新；失败时显示行内弱提示并回退上一次缓存；
  - 本机过滤按第 6 节规格（Swift 版），Enter 时 POST `/open`；POST 失败则原生 `NSWorkspace.shared.openApplication` 兜底；
  - 图标：`NSWorkspace.shared.icon(forFile:)`，缓存（NSCache，64MB 上限），列表异步加载不阻塞主线程；
  - 打开后记录前台 app（`NSWorkspace.shared.frontmostApplication`），隐藏面板后 `activate` 它。
- `desktopbuild/mac.go` 的 `macSources` 加入三个 Swift 文件。

### 8.3 Windows 面板（native/translation/windows/Program.cs）

- 新增 `LauncherWindow : Form`（无边框、圆角、acrylic）与 `LauncherModel`：
  - `FormBorderStyle.None`、`ShowInTaskbar=false`、`TopMost=true`、`StartPosition=Manual`、`DoubleBuffered=true`；
  - 圆角：`DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE=33, 2)`；acrylic：`SetWindowCompositionAttribute(ACCENT_ENABLE_ACRYLICBLURBEHIND)`，失败回退半透明画刷；
  - 自绘（GDI+，`SmoothingMode.AntiAlias`）：面板背景圆角矩形渐变、1px 青边、eyebrow、搜索框（真实 `TextBox`，无边框，20pt，启用 IME）、行列表（图标 36px、名称、副标题、选中行圆角高亮、`↵`）、底部提示；
  - 动画：`System.Windows.Forms.Timer` 16ms 驱动 180ms 进场（`Opacity` 0→1、`Top` +10→目标、选中高亮宽度/透明度缓动）；`easeOutCubic`；关闭 110ms 淡出；行 stagger 12ms；
  - 图标：`Icon.ExtractAssociatedIcon(path)` → `ToBitmap()`，`ImageList`/字典缓存；UWP 用绘制方块；
  - 键盘：`KeyDown` 处理 ↑↓/Enter/Esc；点击外部 `Deactivate` 关闭；
  - 数据：`HttpClient`（超时 5s）GET `/v1/management/launcher/apps`，Bearer `launcherKey`；缓存 + 5 分钟过期；本地过滤按第 6 节；Enter POST `/open`，失败用 `Process.Start(new ProcessStartInfo(path){UseShellExecute=true})` 兜底。
- 全局快捷键：
  - 现有 `HotKeyWindow` 扩展支持第二个 id（launcher）；`Configure` 中解析 `launcherShortcut`（默认 `Alt+Space`）；
  - `RegisterHotKey` 失败（Alt+Space 可能被系统菜单占用）时安装 `WH_KEYBOARD_LL` 低级键盘钩子拦截 Alt+Space（吞掉事件）并回报状态；钩子失败则报告明确状态，不影响翻译快捷键。
- `TranslationApplicationContext`：新增 LauncherWindow 生命周期；`Configure` 中处理 launcher 字段；helper 退出时释放钩子。

### 8.4 Linux 运行时（internal/runtime/launcherd + embedded ui/main.c）

- GTK4 纯视图进程（C，`gcc $(pkg-config --cflags --libs gtk4)`）：
  - 无边框窗口 720×540，CSS 主题（第 2 节色板），`GtkRevealer` 进场（slide-down + crossfade）、`GtkSearchEntry`、`GtkListBox` 行（图标 + 名称 + 副标题）、选中行 CSS 渐变高亮、底部 kbd 提示；
  - 图标：`Icon=` 绝对路径 → `gtk_image_new_from_file`；主题名 → `gtk_icon_theme_load_icon`（48px）；失败用 `application-x-executable`；
  - 目录与打开走 **stdio 协议**（与 macOS/Windows helper 同构，GTK 进程只由 launcherd 拉起）：
    - app→launcherd：`refresh\n`、`open\t<id>\n`、`hide\n`、`quit\n`；
    - launcherd→app：`LAUNCH1\t<base64 id>\t<base64 name>\t<base64 subtitle>\t<base64 icon>\t<base64 kind>\t<0|1 terminal>\t<base64 path>[\t<base64 aliases>[\t<boost>]]\n…END\n`；
    - 启动时与每次 show 前发 `refresh`；`open` 由 Go 打开并记录 usage，成功回 `open-ok\t<base64 id>`、失败回 `open-error\t<base64 message>`（GTK 等待回复并设 8s 安全超时）；
    - `aih launch catalog --wire` 输出同一 TSV 格式，仅供调试/脚本使用；GTK 进程不依赖 PATH 里的 `aih`。
  - 打开失败时 GTK 显示行内错误，面板不关闭；
  - 快捷键：X11 用 `gdk_x11_display_get_xdisplay` + `XGrabKey(Alt+Space)`，抓取失败（WM 已占用）在状态里回报，并保留 socket 触发；Wayland 下不做 XGrabKey；
  - 控制 socket：`$AIH_LAUNCH_SOCKET` → 归属当前用户的 `$XDG_RUNTIME_DIR/aih-launch.sock` → `<aiHome>/run/launcher/linux/aih-launch.sock`（不落 `/tmp`，`umask(0077)` + `0600`，非阻塞 `accept4`），接收 `toggle|show|hide|ping` 一行命令；`aih launch toggle` 连接并发送；用于桌面环境自行绑定 Alt+Space 的兜底。
- `launcherd`（Go，linux）：
  - 探测 `DISPLAY`/`WAYLAND_DISPLAY`，无桌面 → `DesktopAvailable()=false`（Server 不装配启动器）；
  - 首次运行缓存构建嵌入的 `ui/main.c` 到 `~/.ai_home/run/launcher/linux/<fingerprint>/aih-launch-ui`（`gcc` + `pkg-config --exists gtk4`；缺失时 status 给出安装提示，不阻塞 Server）；
  - 启动进程（`env AIH_LAUNCHER=1`），进程退出记录状态并按 `1s→5s→15s→30s` 退避重启；Server 关闭时终止；
  - `aih launch ui [--daemon]` 手动启动（前台/后台）；`aih launch enable|disable` 写 `~/.config/autostart/aih-launch.desktop`（`Exec=<aih> launch ui --daemon`）。
- Server 装配：平台为 linux 且 `LauncherEnabled` 且存在桌面会话时启动 launcherd；失败只记 status，不影响 Server。

## 9. CLI

~~~text
aih launch apps [--json] [--q <关键词>] [--refresh]
aih launch open <id|#序号>
aih launch catalog [--wire]        # --wire：base64 TSV（Linux GTK 消费）；默认 JSON
aih launch status [--json]
aih launch show                    # 请求桌面面板显示（macOS/Windows 走 Server→helper 事件；Linux 走 launcherd）
aih launch ui [--daemon]           # Linux：构建并前台运行 launcherd + GTK 面板（--daemon 后台常驻）
aih launch toggle                  # Linux：通过 socket 切换面板
aih launch enable|disable          # Linux：XDG autostart 开关（Exec=<aih> launch ui --daemon）
~~~

- `aih launch open` 直接打开 aih.db（无 Server 依赖）；`apps` 同样本地扫描（Server 与管理 API 是同一份 `internal/runtime/appcatalog`）。
- `--wire` 输出每行：`LAUNCH1\t<base64 id>\t<base64 name>\t<base64 subtitle>\t<base64 icon>\t<base64 kind>\t<0|1 terminal>\t<base64 path>`；base64 为标准编码、无换行。

## 10. 行为与错误

- 目录扫描失败：`/status.lastError` 记录，UI 显示行内弱提示（不弹块）；空列表显示「没有找到应用」。
- 打开失败：UI 行内提示「无法打开 <name>」1.8s 后消失，面板保持打开。
- 快捷键冲突：不静默失败——macOS 写 status detail；Windows 用钩子兜底并在 status 说明；Linux 回报 grab 失败与 socket 兜底方式。
- 管理密钥缺失（Server 未初始化）：helper 不启用启动器（`launcherEnabled=false` 实时下发），避免空 key 请求。

## 11. 构建与发布

- macOS：`macSources` 增加 `native/launcher/*.swift`；`desktopbuild.Build` 不变（仍然 swiftc 一次编译）。
- Windows：`native/translation/windows/Program.cs` 单文件工程无需改 csproj（仍 WinForms、self-contained、单文件）。
- Linux：不进入现有 `desktopbuild.Build`（该函数对 linux 返回 unsupported，保持不动）；由 `internal/runtime/launcherd` 独立构建缓存，避免影响翻译 helper 的平台契约。
- 不改 `web/`（本阶段无 WebUI 页面）。

## 12. 真机验收矩阵

| 项 | macOS（本机） | Windows（MeaDeo） | Linux（desired.cn 22008，Xvfb 桌面） |
| --- | --- | --- | --- |
| `aih launch apps` 目录数量/名称/去重 | 实机 | 实机 | 实机 |
| Alt+Space 唤起/再次关闭 | 实机（⌥Space） | 实机 | X11 grab 下实机（虚拟显示） |
| 搜索过滤（中英文、子序列） | 实机 | 实机 | 实机 |
| ↑↓/Enter/Esc/点击外部 | 实机 | 实机 | 实机 |
| 打开应用（真实启动进程/窗口） | 实机 | 实机 | 实机（启动 xterm/gtk 应用） |
| 动画（录屏/截图逐帧） | 实机截图 | 实机截图 | 截图 |
| 目录缓存/5 分钟刷新/refresh=1 | 实机 | 实机 | 实机 |
| usage 排序（最近使用优先） | 实机 | 实机 | 实机 |
| 与翻译/剪贴板快捷键共存、冲突提示 | 实机 | 实机 | 状态回报 |
| Server 关闭时 UI 行内报错、CLI 仍可用 | 实机 | 实机 | 实机 |

验收只做真实运行与截图，不新增自动化测试文件。

## 13. 实施切片（AWS agy 交付，每片 scoped commit）

1. `feat(launcher): catalog, rank and management api` — `application/launcher` + 三个平台目录/打开 + `webuilauncherapi` + composition 路由 + CLI `apps/open/catalog/status`。
2. `feat(launcher): desktop helper lifecycle and shortcut plumbing` — desktoptranslation 的 LauncherEnabled/configure 字段/允许列表 + helper 存活条件。
3. `feat(launcher): macos panel` — Swift 面板 + 快捷键空格支持 + macSources。
4. `feat(launcher): windows panel` — WinForms 面板 + Alt+Space 热键/钩子 + 数据接线。
5. `feat(launcher): linux gtk panel and launcherd` — GTK4 源码 + launcherd + CLI ui/toggle/enable + autostart。
6. `docs(launcher): acceptance record` — 真机验收结果与截图清单。

要求：提交一律 `git commit -m <msg> -- <显式路径...>`；不得把仓库里其它并行会话的未提交改动带入；每片完成后 `go build ./...` 通过（macOS/Windows 原生源码由本机与真机编译验收）。

## 14. 风险与回退

- Windows `Alt+Space` 被系统窗口菜单占用：自动降级到低级键盘钩子；仍失败时在 status 明确说明并建议改用 `Ctrl+Space`（CLI `aih launch` 仍可用）。
- Linux 桌面缺 GTK4 开发包：status 给出 `sudo apt install libgtk-4-dev` 提示；不影响 Server 与 CLI。
- macOS 全局快捷键需要辅助功能授权（helper 既有约束）；未授权时 status 明确说明。
- 目录扫描在异常大的机器上超过 2s：缓存 + `limit` 截断，UI 不阻塞。