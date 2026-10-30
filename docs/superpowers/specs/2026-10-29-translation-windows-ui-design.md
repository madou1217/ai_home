# 翻译桌面跨平台与工作台体验设计

## 目标

本设计把翻译能力拆成两个可以独立回滚的产品边界：

1. macOS 保留现有 Swift 桌面 helper，并把桌面运行时改成平台适配器注册表；Windows 增加真正的桌面 helper，Linux 保持明确的“桌面版暂未提供”状态。
2. WebUI 翻译工作台沿用现有翻译执行、历史、整页翻译和悬浮选区能力，重做首屏层级、状态反馈、设置入口和响应式布局，不改变翻译请求语义。

目标状态是：同一套桌面 JSONL 协议和 Node 服务生命周期可以承载不同平台的 helper；WebUI 根据服务端返回的能力渲染正确的入口、快捷键、权限说明和降级文案；用户在输入、等待、流式输出、取消、失败、复制、整页任务和撤回之间始终能看到明确的下一步。

## 当前问题证据

- `lib/desktop/translation/service.js` 的适配器表只有 `darwin`，其它平台在构造服务时直接得到 `unsupported`。
- `lib/desktop/translation/macos-build.js` 把 Swift 源码、AppKit、ApplicationServices、`.app` 元数据和 macOS Services 注册绑定在一起，不能被 Windows 复用。
- `native/translation/main.swift` 同时承担辅助功能选区读取、全局事件监听、Services、面板和快捷键，平台边界没有被抽象出来。
- `web/src/features/translation/SystemTranslationControl.tsx` 的系统取词说明写死“macOS 全局选词、右键入口和辅助功能授权”。
- `TranslationWorkspace.tsx` 已有完整业务链路，但首屏把语言、模型、复制、整页翻译、高级设置和双栏工作区连续堆叠，主任务层级不够突出。

## 方案与边界

### 共享层

`lib/desktop/runtime/desktop-protocol.js` 和 `lib/desktop/runtime/desktop-launcher.js` 继续作为跨平台共享层，负责：

- 版本握手、JSONL 事件白名单、请求/代际标识、错误规范化和敏感字段过滤。
- helper 启动、握手超时、父进程存活、自动重启、停止竞态和事件代际过滤。
- helper 只处理桌面输入与渲染，不持有凭据、不监听 HTTP；翻译请求仍由 Node 的执行端口负责。

新增 `lib/desktop/translation/platform-adapter.js` 作为平台门面。它按平台返回一个描述符，描述符包含 `id`、`supported`、`build`、`captureModes`、`permission`、`shortcut` 和 `statusText`。服务层只依赖描述符，不在请求流程中散落平台判断。

### macOS 适配器

现有 `macos-build.js` 作为 macOS 适配器实现继续使用，现有 Services、辅助功能授权、悬浮面板和 full-app 行为保持不变。只把构建函数和能力描述注册到平台门面，避免行为漂移。

### Windows 适配器

新增 `native/translation/windows/` 的独立 helper 和 `lib/desktop/translation/windows-build.js`：

- helper 使用 Win32 全局快捷键注册和前台窗口选区捕获；首期以快捷键触发“保存原剪贴板 → 发送 Ctrl+C → 读取选区 → 恢复剪贴板”的方式覆盖没有统一 UI Automation 选区接口的桌面应用。
- helper 通过 stdin/stdout 复用现有 JSONL 协议，支持 `hello`、`ready`、`configure`、`status`、`translate-intent`、`cancel`、`delta`、`done`、`error`、`settings` 和 `request-permission`。
- full-app 模式显示独立的 Windows 翻译窗口；helper 模式只显示悬浮翻译面板并受 Node 父进程生命周期管理。
- 快捷键解析接受现有 macOS 符号和 Windows 文本写法，默认展示使用平台符号；已有用户设置不被覆盖。
- 构建使用 Windows 上可用的 .NET SDK，输出写入 AIH 运行目录，采用临时文件加原子替换，不把构建产物提交进仓库。非 Windows 主机只验证构建命令解析、协议和服务状态，不声称完成 Windows 实机验收。

Windows 首期不复制 macOS Services 菜单或辅助功能 API；系统取词 UI 会显示“快捷键取词”，并提供当前快捷键和剪贴板权限说明。这样能力描述和实际行为一致，后续可在 Windows 实机上增加 UI Automation 捕获而不改变协议。

### Linux 状态

Linux 不新增桌面 helper。平台门面返回 `supported: false`、`status: 'unsupported'`、`detail: 'Linux 桌面版暂未提供；可继续使用 WebUI 划词翻译'`，WebUI 仍可用普通翻译和浏览器浮层。服务端不会尝试构建或启动不存在的二进制。

## WebUI 体验设计

### 首屏主线

翻译工作台首屏只突出三个动作：输入原文、选择目标语言、开始翻译。顶部工具区保留源语言、目标语言、互换和平台快捷键；模型/Provider/路由进入明确的高级设置折叠区。整页翻译变成首屏下方的轻量任务条，不再与输入双栏争夺首要注意力。

### 状态反馈

沿用现有流式 reducer 和反馈 hook，补齐视觉状态：

- 检测中：显示检测标签和短暂 shimmer，不阻塞输入。
- 等待首字节：显示阶段文字、耗时和可停止按钮。
- 流式输出：保留光标和滚动位置，首字节时对译文区域做一次轻微进入动画。
- 完成：复制按钮变为短暂的成功状态，并保留耗时/模型元信息。
- 取消：保留已生成内容，明确显示“已停止，可重新翻译”。
- 失败：错误信息、错误码和重试动作保持行内显示，不用整块 Alert。
- 整页翻译：显示已处理/失败段落、停止、重试和撤回；任务完成后不遮挡主工作区。

### 视觉与动效

使用现有 design tokens、HUD 轮廓和 `prefers-reduced-motion` 约束，增加：

- 输入/输出面板的层级阴影和聚焦描边。
- 目标语言和主操作的轻量强调状态。
- 状态点、光标、骨架 shimmer、面板进入/退出和复制成功反馈。
- 历史记录的可扫描双行布局，长文本省略并保留完整 title/可访问名称。

禁止使用大块提示容器、左侧粗彩条和与状态语义无关的装饰动画。

### 响应式与可访问性

- 桌面保持输入/译文双栏，但高级设置和整页任务可以折叠。
- 低于窄屏断点时改为输入在上、译文在下，主操作保持可见。
- 所有动作按钮有语义化 aria-label，状态通过 `role="status"` 和 `aria-live` 暴露。
- `prefers-reduced-motion: reduce` 时关闭 shimmer、进入/退出和光标闪烁，只保留状态文字和颜色。

## 数据流与错误处理

1. WebUI 从 `/webui/translation/system` 读取平台能力和系统取词状态。
2. Node 服务通过平台门面构建 helper，启动后发送 `configure`，helper 回传 `ready` 和 `status`。
3. helper 捕获文本并发送 `translate-intent`；Node 完成本地语言预检、路由选择和执行端口调用。
4. Node 只向当前请求代际发送 `start`、`attempt_*`、`delta`、`done` 或 `error`；取消和平台切换会使旧请求失效。
5. WebUI 按事件更新 reducer，所有失败保留可重试动作和明确错误码。

Windows 具体错误包括 `windows_helper_unavailable`、`windows_shortcut_registration_failed`、`windows_clipboard_capture_failed`、`windows_clipboard_restore_failed` 和 `desktop_protocol_version_unsupported`。Linux 使用 `desktop_platform_unsupported`，不能伪装成翻译执行失败。

## 验证计划

- Node：扩展既有 `test/desktop-runtime.test.js`、`test/translation-execution-integration.test.js` 和协议测试，覆盖平台描述符、Windows 配置事件、Linux 明确暂缓、快捷键规范化、取消和重启。
- WebUI：改动文件限范围 ESLint；`cd web && npm run build`；运行现有翻译目标和页面相关测试。
- macOS：真实 helper 启动、Services/辅助功能状态、快捷键、选区、流式翻译、取消、重启和 full-app。
- Windows：在 Windows 实机或 CI 构建并运行 helper，验证快捷键、剪贴板保存/恢复、窗口、协议握手、翻译流、取消/重启和权限提示。
- Linux：验证 WebUI 翻译链路仍可用，系统取词明确显示桌面版暂缓。

## 交付顺序

1. 提交本设计规格。
2. 建立平台适配器门面与 Windows 构建/协议接线，先完成 Node 可验证部分。
3. 增加 Windows helper 的首期实现和 Windows 构建说明。
4. 重做 WebUI 翻译工作台首屏、状态反馈、整页任务条、历史和响应式样式。
5. 运行 Node/WebUI 验证，随后做 macOS 真实回归；Windows 实机证据可用后再声称完整 Windows 对齐。
