# Desktop Translation and Harness Chat Design

## Goal

把翻译和小窗 Chat 做成可独立运行、可由 AIH Server 托管的 macOS/Web 桌面体验：翻译支持直连 Provider 或 AIH Server，Chat 复用现有 harness Chat Runtime，系统右键不被拦截，快捷键和设置进入原生桌面壳。

## Scope

本阶段包含两个可独立验收的子系统：

1. 翻译独立运行与 macOS 原生交互收口。
2. Web/macOS 小窗 Chat，底层复用现有 Chat Runtime/harness。

两者共享桌面 helper 的启动、快捷键、设置、窗口和状态反馈边界，但不共享业务状态机。

## Product modes

### Helper mode

- 由 AIH Server 启动和停止。
- 默认使用本机 AIH Server 的管理连接。
- 不持有 Provider 密钥，不创建独立持久化账号池。
- 负责系统选词、翻译浮层、Chat 小窗和全局快捷键。
- 退出 AIH Server 时 helper 一并退出。

### Full app mode

- 用户可以独立启动完整 macOS App。
- 翻译优先使用本地保存的 Provider 配置直连 Microsoft、Google、LibreTranslate、DeepL；也可以切换到 AIH Server。
- Chat 使用配置的 AIH Server/harness 目标；如果没有 AIH Server，Chat 明确显示“需要配置 Chat Runtime”，不伪造直连 Chat 能力。
- 设置、快捷键、Provider、服务目标、隐私和权限均在原生设置窗口完成。

## Architecture

### Desktop shell

新增共享的桌面壳边界，负责：

- helper/full-app 生命周期
- NSWindow/NSPanel 展示、焦点、置顶、拖动和动画
- 全局快捷键注册和设置
- 原生设置窗口
- 与宿主应用的 AX 读取和权限状态
- 进程协议的版本、请求 id、取消和错误投影

翻译和 Chat 作为两个 feature controller 注入桌面壳。feature controller 不直接管理进程生命周期。

### Translation adapter

翻译请求统一经过 `TranslationExecutionPort`：

```text
translate(request, signal) -> async event stream
  target = direct-provider | aih-server
  provider = descriptor id
  operation = selection | page | replace
```

- `lib/translation/provider-facade.js` 继续作为 Provider 门面。
- 新增本地执行适配器，把当前 Provider config store、route planner 和 route runner 接到桌面 helper。
- AIH Server 适配器复用现有 `/v0/webui/translation/detect` 和 `/stream` 协议。
- UI 只读状态和能力描述，不比较 Provider 名称。
- 未配置密钥的 Provider 显示配置状态，不发送请求。
- 每个直连 Provider 的错误统一投影为可读的状态、重试建议和可切换目标。

### Chat adapter

Chat 不另造“轻量模型请求”协议：

- Web 和 macOS 都调用 `/v0/webui/chat/sessions`、`/commands`、`/events`。
- Server 端继续使用 `ChatRuntimeService`、`ChatRuntimeComposition`、Codex harness driver、session store 和 event hub。
- macOS 小窗只实现 Chat Runtime 的窄客户端：创建/恢复 session、提交 turn、停止 turn、消费事件、显示错误和重连。
- Chat 的 Provider/model 选择来自 Chat Runtime catalog；helper 不直接拼 Provider-specific argv。
- 当 Chat Runtime 不可用时，显示可恢复的连接状态，不把底层 harness 错误直接暴露给用户。

## macOS interaction rules

- 不监听 `rightMouseUp` 来弹出自定义菜单；宿主原生右键菜单必须保持原样。
- 入口使用 Services、显式快捷键、系统选词浮标和独立 Chat 快捷键。
- 原生设置窗口不能跳转 WebUI。
- 快捷键冲突时显示设置状态，并提供重新录入。
- 翻译和 Chat 面板都支持 loading、slow、streaming、done、cancelled、failed 状态，按钮按状态出现。
- 面板动画尊重减少动态效果设置。
- 旧请求的事件不能覆盖新请求；所有请求带 generation/request id。

## Web interaction rules

- 翻译 Provider、模型、路由和凭据配置归入高级设置；Provider 超过 3 个使用 Tabs。
- 页面翻译支持旁注、替换、并发、进度、停止和撤回。
- Chat 小窗复用 Web Chat Runtime 的 session/event model，不复制另一套 reducer 或 SSE 语义。
- 错误使用紧凑行内状态，不使用大面积 Alert 主内容块。

## Persistence and security

- Full app 的 Provider secret 使用现有 app-state/config store，不进入 URL、命令行、tmux 参数或 helper stdout。
- Helper 只接收短期 session/config 令牌；翻译文本和 Chat 内容不写入日志。
- Chat session/history 使用现有 Chat Runtime store；桌面 UI 只保存窗口、快捷键和目标偏好。
- 不新增 `AIH_*` 环境变量；新增配置使用 server config、WebUI 设置或现有 context。

## Delivery phases

1. **Phase A — native translation boundary**
   - 完成原生设置窗口。
   - 保留系统右键。
   - 将翻译执行端口拆成 direct-provider/AIH Server 两种 adapter。
   - 通过运行态验证 helper/full-app 的 target 切换和取消。

2. **Phase B — shared desktop shell**
   - 抽出窗口、快捷键、权限和进程协议层。
   - 翻译 feature 迁移到 shell controller。
   - 增加独立 App 启动/退出和设置持久化。

3. **Phase C — harness Chat**
   - 增加 macOS Chat client controller。
   - 接入 Chat Runtime session/command/event API。
   - 增加 Chat 小窗快捷键、停止、重连和会话恢复。
   - Web 增加小窗 surface，并复用现有 runtime hooks。

4. **Phase D — page translation and UX hardening**
   - 完成外部网站整页翻译入口。
   - 验证旁注/替换/撤回、iframe、取消、并发和错误反馈。
   - 进行 Web/macOS 真实 UI 验收。

## Verification

- Swift typecheck and native helper build/sign verification.
- Node syntax and focused unit tests for execution adapters, protocol request ids and Chat Runtime client.
- `cd web && npm run build` and changed-file ESLint.
- Real macOS checks: native settings opens without WebUI, right-click menu remains host-owned, Services/shortcut/floating trigger work, panel cancellation works.
- Real Web checks: advanced settings tabs, provider fallback, page translation progress/undo, Chat session streaming and stop.
