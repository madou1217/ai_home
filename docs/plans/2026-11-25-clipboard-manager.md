# AIH Clipboard：跨设备剪贴板管理器（Phase 1 设计）

日期：2026-11-25
状态：Phase 1 已实现并通过真机验证（2026-11-25）
范围：macOS / Windows / Linux 桌面采集；Server 终端 TUI 与 Vim 粘贴；WebUI 管理与加密同步。

## 1. 目标

用一套 Go 核心 + 平台薄适配，替代 macOS 的 Paste：

- 桌面端持续采集文本、链接、图片、文件引用（不做大二进制）；
- ⌘⌥V 唤起原生面板（macOS），Windows/Linux 用 aih clip ui 或桌面环境快捷键；
- 无桌面的 Server 上，SSH 终端里用 TUI 选择器、shell 组件（Ctrl-X Ctrl-V）或 Vim 插件粘贴；
- WebUI 有独立「剪贴板」页：历史、预览、置顶、删除、采集开关、同步开关与目标；
- 同步走 Server 中继（HTTPS）或 WireGuard/Tailscale 地址，负载用 AES-256-GCM 封包；
- 相同内容幂等：SHA-256 唯一，重复采集只更新 last_seen_at，不产生新条目；采集去抖。

明确不做：超过 8 MiB 的二进制、剪贴板富文本保真（HTML/RTF 只保留纯文本）、端到端加密（Server 需要为 WebUI 解密；本阶段只做传输封包 + 磁盘权限）。

## 2. 分层与文件

~~~
application/clipboard/                 领域：Item/Kind/Settings/去重与限额规则；端口 Store/Clock
internal/adapters/clipboardstore/      aih.db 唯一实现（WAL、UNIQUE(sha256)）
internal/runtime/clipboardio/          平台剪贴板读写（darwin/windows/linux），纯命令/AppleScript，无 cgo
internal/runtime/clipboardruntime/     采集循环、缩略图、同步器（Server 内常驻）
internal/runtime/clippicker/           终端 TUI 选择器（复用 cmd/aih/session_picker.go 的按键风格）
internal/transport/http/webuiclipboardapi/  管理 API（/v1/management/clipboard/*）
internal/host/aihserver/webui_clipboard_routes.go  装配 + 路由
cmd/aih/clip.go                        CLI 入口与子命令
cmd/aih/clip_vim.go                    Vim 插件生成
web/src/pages/Clipboard.tsx            页面壳
web/src/features/clipboard/            页面组件、API、样式
native/clipboard/ClipboardPanel*.swift macOS 原生面板（编入现有 AIH Translation.app）
~~~

约束：核心不出现厂商分支；平台差异只在 clipboardio 的 _darwin.go/_windows.go/_linux.go 和 clipboardruntime 的能力探测里。不新增 JS 实现。

## 3. 数据模型（aih.db）

~~~sql
CREATE TABLE IF NOT EXISTS clipboard_items (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                -- text | link | image | file
  mime TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',     -- <= 256 KiB 的内联文本；更大时留空
  blob_path TEXT NOT NULL DEFAULT '',-- ~/.ai_home/clipboard/blobs/<sha256> 的相对路径
  byte_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  preview TEXT NOT NULL DEFAULT '',  -- 单行摘要（<= 240 字符）
  thumbnail BLOB,                    -- <= 64 KiB JPEG/PNG，供列表直接出图
  files_json TEXT NOT NULL DEFAULT '[]',
  source_device TEXT NOT NULL DEFAULT '',
  source_app TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  seen_count INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  synced_at_ms INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS clipboard_items_recent ON clipboard_items(deleted, pinned DESC, last_seen_at_ms DESC);
CREATE INDEX IF NOT EXISTS clipboard_items_kind ON clipboard_items(deleted, kind, last_seen_at_ms DESC);

CREATE TABLE IF NOT EXISTS clipboard_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
  last_seen_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clipboard_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clipboard_sync_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at_ms INTEGER NOT NULL
);
~~~

规则：
- 采集与同步统一走 Service.Ingest：算 SHA-256 → INSERT ... ON CONFLICT(sha256) DO UPDATE SET last_seen_at_ms=?, seen_count=seen_count+1, deleted=0；返回 {item, deduplicated}。重复内容永远不产生第二行。
- kind 由 MIME 派生：text/uri-list 或单行 http(s) → link；image/* → image；text/* → text；文件引用 → file。
- 限额：text 1 MiB（超出截断并在 preview 标注）、image 8 MiB、单次请求 12 MiB；超出直接跳过并记录诊断，不落库。
- 保留：默认 500 条 / 30 天；清理只删未置顶条目及其 blob。置顶不参与自动清理。
- 文本 <= 256 KiB 内联；图片与更大文本写 blob 文件（0600），删除时一并清理。

## 4. 采集（clipboardruntime.Capture）

- 仅在本机 Server 进程内运行，WebUI 开关控制；headless Linux 无 DISPLAY/WAYLAND_DISPLAY 时能力为 unsupported。
- 轮询间隔 700ms；读到快照后先算 hash，与上次相同或距上次 < 2s 则跳过（防抖）；连续相同内容不会重复入库。
- 顺序：先读图片（有图则忽略文本），再读文件引用，最后读文本。空内容跳过。
- macOS：pbpaste -Prefer txt 读文本；图片沿用 internal/runtime/sshbridge/clipboard.go 的 pngpaste/osascript 方案（提取为 clipboardio，禁止跨包引用 sshbridge）；文件用 AppleScript the clipboard as class furl。
- Windows：PowerShell Get-Clipboard -Format Text/Image/FileDropList（-STA、EncodedCommand，复用现有 utf16 方案）。
- Linux：Wayland 优先 wl-paste（text/plain、image/png、text/uri-list），X11 回退 xclip。
- 写入剪贴板（copy）：macOS pbcopy（文本）/osascript PNGf（图片）；Windows Set-Clipboard；Linux wl-copy 或 xclip。
- 缩略图：image 解码（含 webp 注册）后最近邻缩放到最长边 320px，JPEG 质量 80，>64 KiB 再降；失败保留原图不阻塞入库。

## 5. CLI

~~~text
aih clip ls [--limit 20] [--kind text|link|image|file] [--json]
aih clip show <id|#序号> [--json] [--raw]
aih clip paste [<id|#序号>] [--stdout]      # 默认最新一条，输出原始文本/文件路径
aih clip copy <id|#序号>                    # 写入本机剪贴板
aih clip pick [--kind] [--query] [--limit] [--stdout]   # TUI；--stdout 同时打印选中内容
aih clip ui                                 # pick 的别名
aih clip pin <id> [--off]
aih clip rm <id>... | clear [--yes]
aih clip status [--json]
aih clip enable|disable                     # 本机采集开关（写 settings 并通知 Server runtime）
aih clip sync [--once|--watch] [--server <profileId|名称>]
aih clip vim install|print
~~~

- 本地命令直接打开 aih.db（WAL，允许并发），不依赖 Server 在线；enable/disable 直接写 settings，Server 的热路径每 2s 读一次开关（或通过 POST 通知）。
- paste 对 image/file 输出 blob 路径或 --json；对文本原样输出，不做换行改写，便于管道/Vim :read。
- TUI：j/k 移动、/ 搜索、Enter 选中并复制、y 仅打印、p 置顶、d 删除（需确认）、Esc 退出；ASCII 无颜色回退。
- 完成：internal/runtime/completion 增加 clipboard 数据源；aih clip paste|copy|show|rm|pin <Tab> 返回最近 20 条 id（描述=preview 截断 60 字）。

## 6. 终端与 Vim

- aih shell apply 生成的片段追加剪贴板组件（不新增资产矩阵）：
  - zsh：aih-clip-paste 用 aih clip pick --stdout 取内容，插入 BUFFER 光标处，zle reset-prompt；绑定 ^X^V。
  - bash：bind -x 绑定 C-xC-v 到 aih-clip-paste，使用 READLINE_LINE/READLINE_POINT。
  - fish：commandline -i (aih clip pick --stdout)；绑定 cxcv。
  - 片段里检测 command -v aih，没有则跳过，不报错。
- Vim：aih clip vim install 写 ~/.vim/plugin/aih_clipboard.vim（幂等，带 managed 头）：
  - :AIHClipPaste 插入最新文本；
  - Ctrl-X Ctrl-V 调用 AIHClipPick()：aih clip ls --json --limit 50 → popup_menu 选择 → 按 kind 插入文本/路径；
  - 保留 :read !aih clip paste 的文档示例。

## 7. 管理 API（Management Key）

统一前缀 /v1/management/clipboard：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /items?limit=&before=&kind=&q=&includeDeleted= | 列表；不含大字段，含 thumbnail data URL |
| GET | /items/{id} | 详情（text 截断、files、元数据） |
| GET | /items/{id}/content | 原始内容（text/mime 或 blob） |
| POST | /items | 采集入库；body {kind,mime,text,dataBase64,files,sourceApp,deviceId}；返回 {item,deduplicated} |
| DELETE | /items/{id} | 软删除 |
| POST | /items/{id}/pin | body {pinned:bool} |
| GET/PATCH | /settings | captureEnabled/syncEnabled/syncTargetProfileId/retentionDays/maxItems/maxItemBytes |
| GET | /status | platform/capture/sync/deviceId/keyFingerprint/transports |
| POST | /sync/run | 手动触发一次同步 |
| GET/POST | /sync/key | 读取/写入同步密钥（仅服务端到服务端配对） |
| POST | /sync/items | 批量推送封包（<=50/批） |
| GET | /sync/items?since=&limit= | 拉取封包 |

- 列表 100ms 预算：只查索引列 + thumbnail；不 JOIN、不读 blob。
- /sync/* 用同一 Management Key；body 为 {items:[{sha256,sealed}]}，sealed=base64(nonce||AES-256-GCM(JSON payload))，AAD=sha256；payload 含 kind/mime/text/files/宽高/时间/来源。服务端解密后走同一 Ingest；返回 {ids:{sha256:id}}。
- 密钥 clipboard_settings['syncKey']：首次启用生成 32 字节随机；WebUI 只显示指纹（SHA-256 前 8 字节 hex）。目标 Server 无密钥时由源端 POST 写入；已有不同密钥时采用目标端密钥（源端日志记录指纹变化）。
- 拉取游标存 clipboard_sync_state['cursor.<profileId>'] = 目标库 last_seen_at_ms 最大值；拉到的条目 synced_at_ms=now、remote_id 记录来源，避免回推。

## 8. 同步器（clipboardruntime.Syncer）

- 触发：settings.syncEnabled && syncTargetProfileId 非空；启动时拉一次，之后 5s 循环（仅在后端，WebUI 不轮询）。
- 目标解析复用 webuicontrolplaneapi.ListProfiles（参考 requirement_server_profiles.go）。
- 推送：synced_at_ms=0 AND deleted=0 的条目，按 50 条分批；成功后写 synced_at_ms。
- 拉取：GET /sync/items?since=cursor，解密、Ingest；成功后推进游标。
- 失败退避 5s→30s→2min，状态写 clipboard_sync_state，/status 暴露 lastError/lastSyncAt。
- 传输：目标 endpoint 可以是 HTTPS、WireGuard 地址或 Tailscale 名称；/status.transports 通过本机 connector 状态只读展示（wireguard/tailscale 插件存在与否），不在核心写死厂商逻辑。

## 9. WebUI

- 路由 /clipboard，菜单「剪贴板」，图标 snippets。
- 顶部：本机采集开关（unsupported 时禁用并说明）、同步开关、目标 Server 下拉（来自现有 Server Profile 列表）、密钥指纹、设备列表。
- 主体：左侧历史列表（时间分组、kind 过滤、搜索、置顶优先）；右侧预览（文本等宽、图片、文件列表与打开提示）；操作：复制、置顶、删除。
- 复制：文本用 navigator.clipboard.writeText；图片用 ClipboardItem（失败提示用下载）。删除二次确认。
- 遵守仓库 UI 约束：不用大面积 Alert、不用左侧粗竖条；错误用行内文字。
- 数据加载：挂载/切换过滤/手动刷新/操作后刷新；禁止 setInterval。

## 10. macOS 原生面板

- 在现有 AIH Translation.app helper 内新增 ClipboardPanel（AppKit，无 SwiftUI），编入 internal/runtime/desktopbuild/mac.go 的 macSources。
- ShortcutRegistry 增加描述符 clipboard，默认 ⌘⌥V，与翻译/聊天快捷键同机制；冲突时只在状态里提示，不影响其它面板。
- 面板：搜索框 + 列表（最近 50 条，显示 preview/时间/kind 图标）+ 右侧预览；Enter 写 NSPasteboard 并关闭，Esc 关闭，↑↓ 选择；图片用 NSImage(data:) 渲染；文件显示路径。
- 数据来源：quickChatOrigin + quickChatKey（本机 Server），GET /v1/management/clipboard/items；打开面板时拉一次，输入搜索在前端过滤。
- configure 事件新增 clipboardEnabled（settings.captureEnabled||syncEnabled），关闭时不注册快捷键。

## 11. 平台矩阵与验收

| 能力 | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 文本/图片采集 | 实机验证 | 代码路径（PowerShell） | 代码路径（wl-paste/xclip） |
| 文件引用 | AppleScript furl | FileDropList | text/uri-list |
| ⌘⌥V 原生面板 | 实机验证 | 无（用 aih clip ui/桌面快捷键） | 无（同左） |
| aih clip ui TUI | 是 | 是 | 是 |
| shell/Vim 粘贴 | 是 | 是（PowerShell 片段不绑定） | 是 |
| WebUI 管理 | 是 | 是 | 是 |
| Server 中继同步 | 是 | 是 | 是 |

验收（本机真实验证，不写单测）：
1. 复制同一段文字 3 次 → 仅 1 条，seen_count>=3；
2. 复制图片 → 列表出现缩略图，复制回剪贴板后像素一致；
3. ⌘⌥V 唤起 → 键盘选择 → Enter 后剪贴板变为该条；
4. aih clip paste 输出与原文逐字节一致；
5. WebUI 开关切换后 /status 与采集行为同步变化；
6. 配置 AWS Server 为目标，启用同步后另一端出现同一条目且无重复；断开后本地继续可用。

## 12. 实施顺序（每个切片独立 scoped commit）

1. feat(clipboard): store and domain — store/service/API 骨架 + CLI ls/show/paste/copy。
2. feat(clipboard): capture and platform io — clipboardio + capture loop + 图片缩略图 + 开关。
3. feat(clipboard): terminal picker and shell/vim — TUI、completion、shell 片段、Vim 插件。
4. feat(clipboard): webui — 页面与 API 接线。
5. feat(clipboard): encrypted sync — key/envelope/syncer + 目标配置。
6. feat(clipboard): macos panel — Swift 面板 + 快捷键 + 构建接线。

## 13. 非目标 / 后续

- E2E（Server 不可读）需要浏览器 WebCrypto 与客户端密钥托管，Phase 2；
- 直接 P2P/局域网发现与配对，Phase 2；
- PDF/Office 正文抽取与缩略图，Phase 2（Phase 1 只存文件引用与元数据）；
- 富文本保真（HTML/RTF 样式），Phase 2。

## 14. 实现与验收记录（2026-11-25）

Phase 1 六个切片均已落地，并合并了 AWS 侧先行的 macOS 面板提交：

- `361b45a7` feat(clipboard): store and domain
- `fefc932c` feat(clipboard): capture and platform io
- `97d66b4b` feat(clipboard): terminal picker and shell/vim
- `78556abb` feat(clipboard): encrypted sync
- `0a6bacb1` feat(clipboard): webui
- `30c8766d` feat(clipboard): native macos panel with live capture toggle
- `f573b22d` feat(clipboard): redesign webui as a hud workspace
- `c42988a9` fix(clipboard): keep text utf-8 stable across capture and sync
- `d059985d` merge(clipboard): land aws macos panel history（AWS `dd89d02c` 作为父提交保留，其单文件面板由三文件面板取代）

本机真实验收：

1. 采集：文本、图片（PNG 1024×1024）、文件（`/etc/hosts`）均入库，图片生成缩略图；本机 headless 探针在 AWS 上报告 `supported=false`，符合预期。
2. 去重：同一段文本连续复制 3 次，数据库仅 1 行，`seen_count=1`（连续相同内容按防抖跳过）。
3. CLI：`aih clip ls/show/paste/copy/pin/rm/status` 全部实测；`paste --stdout` 与原文逐字节一致；图片 copy 回剪贴板后系统剪贴板含 PNGf/TIFF。
4. TUI：PTY 内启动 `aih clip pick --stdout`，回车选中 #1，stdout 仅输出内容、界面走 stderr、退出恢复屏幕。
5. Shell/Vim：`aih shell snippet --shell zsh` 含 Ctrl-X Ctrl-V 组件；`aih clip vim install` 两次分别返回 installed / up-to-date。
6. WebUI：真实页面驱动采集开关，`/status` 随开关即时变化；新复制内容出现在列表，文本预览逐字节一致；筛选计数随类型变化。
7. macOS 面板：⌘⌥V 唤起；筛选/搜索/缩略图/预览/粘贴/置顶/删除可用；Esc 关闭；关闭采集后快捷键立即失效，重新开启后立即恢复。
8. 加密同步：以 AWS（SSH 隧道 19527，AES-256-GCM 封包）为目标，55 条记录推送成功；在 AWS 侧新建文本后本地 pull 成功且无重复；密钥指纹两端一致。
9. 修复：跨平台桥接的 CP1252 文本此前在 JSON 封包中变成 U+FFFD 导致 `clipboard_sync_sha_mismatch`；现在入站统一转 UTF-8，旧的非 UTF-8 条目跳过同步而不阻塞批次，单条损坏封包也不会中断整轮拉取。

遗留（非 Phase 1 目标）：

- Windows/Linux 桌面没有原生窗口面板：使用 `aih clip ui`（终端选择器）或由桌面环境把快捷键绑到它；采集与 WebUI 均可用。
- Linux headless 无 DISPLAY/WAYLAND_DISPLAY 时采集不可用（如实报告）。
- PDF/Office 正文抽取、富文本保真、端到端（Server 不可读）加密仍按第 13 节留到 Phase 2。

## 15. 评审闭环（2026-11-25，AWS agy gemini-4-neon-xhigh）

第一次 xhigh 评审提出 6 个 blocker；修复后第二次评审确认多数已解决，并指出剩余项。最终修复包括：

- 同步线路上限提高到 20 MiB，拉取时跳过单条超限封包，限制 sourceApp/device/MIME 长度；
- 跨 OS 文件条目统一使用 `NormalizeSyncedFilePaths` 计算封包 SHA，发送端不再套用本机 `filepath.Abs`；
- 空页/短页游标持久化并继续翻页，接收条目用接收时间作为 last_seen；
- 超限剪贴板读取先取消子进程再 Wait（三个平台），ReadFiles 不再吞掉 ErrItemTooLarge；
- pbpaste/pbcopy 强制 LC_ALL/LC_CTYPE/LANG UTF-8；
- aih.db 建表后 chmod 0600（含 WAL/SHM），启动即 Prune，软删除条目不可再读详情/内容；
- 管理 API 缺 Authorizer 时失败关闭；关闭剪贴板时不向 helper 下发管理密钥；同步客户端拒绝重定向；
- helper 生命周期与剪贴板开关双向同步并串行化，关闭“系统翻译”不再误杀剪贴板 helper；
- 面板 IME/Esc/删除弹层处理、NSCache 上限、last_seen 时间、异步删除；
- WebUI 采集状态只信 running，活动直方图/快捷键/加载更多/服务切换重载，并避免抢走按钮与弹窗的 Enter。

真机复验补充：在 AWS 侧创建 `C:\Users\a.txt` 文件条目，本地拉取后 SHA-256 与 AWS 完全一致（`832e2c0d…`），证明跨 OS 文件同步不再触发 `clipboard_sync_sha_mismatch`；伪装 60000×60000 的 PNG 现在返回 413 `clipboard_item_too_large`。

测试中产生的探测条目已从本机与 AWS 两侧删除，同步开关恢复为关闭。

## 16. Paste Nexus 重做（2026-11-25，AWS agy gemini-4-neon-xhigh）

用户提供的 `paste-hud.html` 成为唯一视觉基准；第 9/10 节的传统列表页与原生表格面板不再保留。

架构调整：

- **WebUI / 工作区**：`web/public/paste/index.html` 1:1 保留原型的 CSS/DOM/动效，只替换数据层。页面从 `window.__AIH_CLIPBOARD__` 或同源 control-plane profile 取管理密钥，调用真实剪贴板 API；支持工作区与 `?mode=quick` 两种模式。Umi 的 `/clipboard` 路由重定向到 `/ui/paste/`。
- **桌面工作区窗口**：`native/clipboard/ClipboardWorkspaceWindow.swift` 用 WKWebView 加载 `/ui/paste/?mode=workspace&embed=desktop`，从状态栏菜单「打开剪贴板工作区」或 Dock 重开进入。
- **Quick Orbit**：`native/clipboard/QuickOrbitWindow.swift` 是透明无边框浮动面板，加载 `?mode=quick&embed=desktop&position=bottom|left|right`，尺寸 1520×438（参考图比例），从左下方向上滑入并淡入；⌘⌥V 或状态栏菜单切换。位置持久化在 `clipboard_settings.quickOrbitPosition`，经 configure 的 `quickOrbitPosition` 下发，也可在页面设置或状态栏「位置」菜单修改。
- **删除旧实现**：`ClipboardPanel*.swift` 三个文件移除，`desktopbuild/mac.go` 只编译两个新的 WebView 窗口。

AGY 产出提交（AWS `feature/paste-nexus`）：`ca259b99`（quickOrbitPosition + configure）、`90982870`（页面接真实 API + 双模式）、`48d1312d`（WKWebView 桌面窗口替换旧面板）、`00f005aa`（Quick Orbit 过滤器高度修复）。本地合并为 `681d5c39`，随后补了参考尺寸/密钥门槛（`573f8a9c`）与 438px 高度下页脚可见性（`7fc6c195`）。

真机/浏览器验收：

- 工作区 1440×900 显示 126 条真实记录，时间线、类型筛选、预览、Fusion stack、Quick orbit dock 与原型一致；
- `?mode=quick&embed=desktop` 在 1520×438 下显示 7 张卡片、过滤器单行、页脚与 Paste 按钮完整，和参考截图同构；
- 设置对话框读取真实 capture/sync/位置/指纹/设备/传输状态，位置切换写入后端；
- 状态栏菜单可打开工作区、切换 Quick Orbit、选择底部/左侧/右侧；QuickOrbit 面板 1520×438 透明浮动。
