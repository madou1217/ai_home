# Image 模型自动路由与生图能力激活方案 (v2 架构评审修订版)

## 1. 背景与问题根因
在 WebUI 中使用 `agy`（或其它 native provider）搭配生图模型（如 `gemini-3.1-flash-image`）发送消息时，系统默认将其作为原生会话派发给本地 CLI（执行 `agy --print "..." --model "gemini-3.1-flash-image"`）。
由于 `agy` 本地 CLI 是代码/对话 TUI 专用进程，其内置模型白名单不包含生图模型，导致在启动参数校验时抛出：
`Error: invalid model selection (--model "gemini-3.1-flash-image" --effort ""): model gemini-3.1-flash-image is not recognized as a known model or custom model in settings`。

实际上本地 AIH 网关底层对 Google Code Assist 的生图模型已有完整支持（自动注入 `responseModalities: ['TEXT', 'IMAGE']`、剥离 thinking 预算、并将 Base64 `inlineData` 转译为 Markdown `![生成的图片](data:image/png;base64,...)` 流式透传）。

---

## 2. 架构审查关键发现与 P0 修复点（来自 Codex & Claude 评审）

1. **变量声明与解析时序问题**：
   在 `webui-chat-routes.js` 中，必须先统一解析 `effectiveRequestModel`（结合 `requestModel`、模型别名解析 `resolveNativeAliasModel` 以及默认模型 fallback），然后再进行路由决策，防止变量未初始化异常。
2. **Provider 与模型能力解耦（精准路由，拒绝一刀切正则）**：
   - 只有 `agy` / `gemini` 的 Code Assist 图像模型（`gemini-3.1-flash-image` / `gemini-2.5-flash-image` / `nano-banana`）支持在 `/v1/chat/completions` 通道通过流式生成图片 Markdown。
   - `codex` 的 `gpt-image-2` 与 `grok` 的 `grok-imagine-*` 属于专属 Images API 体系，不能混淆进 `/v1/chat/completions`。
   - 判定必须是 `provider + model` 联合判断：`isAgyCodeAssistImageModel(provider, model)`。
3. **Slash 命令与交互拦截**：
   生图模型不具备交互式 TUI/slash 环境，当检测到生图模型时，禁止进入 `useInteractiveNativeSlash`，统一走 API 网关处理。
4. **生成文件与源文件同步**：
   `lib/server/native-session-chat-command.js` 属于通过 `scripts/native-session-chat-split.cjs` 生成的代码，修改必须在 `lib/server/native-session-chat.js` 源头进行并重新构建。
5. **超时预算适配（Timeout Budget）**：
   图像生成耗时普遍在 15s~45s，网关对生图模型的 HTTP 超时应设置为 120s，防止默认短超时导致 504/连接中断。

---

## 3. 具体实现方案

### 3.1 集中式路由判定 (`lib/server/webui-chat-routes.js`)
1. **模型前置归一化**：
   ```javascript
   const effectiveRequestModel = await resolveNativeAliasModel(ctx, provider, requestModel)
     || resolveProviderDefaultModel(provider, '', { state: ctx.state, accountRef });
   ```
2. **生图模型判定**：
   ```javascript
   const isAgyImageModel = (provider === 'agy' || provider === 'gemini') && isImageGenerationModel(effectiveRequestModel);
   ```
3. **Native 路由守卫**：
   ```javascript
   const useOfficialNativeSession = Boolean(
     webuiNativeSessionProvider
     && !useInteractiveNativeSlash
     && !isAgyImageModel // agy 生图模型跳过本地 CLI
     && normalizedPrompt
   );
   ```
4. **API Proxy 请求体透传**：
   在 `api-proxy` 分支中使用已解析的 `effectiveRequestModel`，并针对生图模型应用 120s 的请求超时。

### 3.2 Native CLI 防御层 (`lib/server/native-session-chat.js`)
在 `buildStartCommand` / `buildResumeCommand` 中，对 `agy` 传入生图模型进行前置类型防御，若被直接调用则抛出明确可读的错误。修改后运行脚本同步拆分文件。

### 3.3 测试与验证
1. 单元测试：`test/webui-chat-routes.test.js` 增加对 `agy` + `gemini-3.1-flash-image` 请求路由至 `api-proxy` 的用例。
2. 边界测试：覆盖别名解析、默认模型 fallback、流式 Markdown 图片透传与超时配置。
