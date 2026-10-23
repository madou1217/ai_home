# 21 · Provider Hooks 与交互协议全景(webUI 对齐 TUI 的机制底座)

> 目标:完整记录各 provider 的 hook / 事件 / 审批 / steer 机制,以及 aih 用了哪些、怎么用。
> 每个结论标注实证方式与验证版本;"未验证"会明说。更新时先重跑对应实验。

## 1. 事件管线总览(仓库现有基建)

```
provider CLI (hook/插件/协议事件)
  → aih-provider-session-hook-sender.js(stdin 收事件,POST)
  → POST /v0/webui/session-events/provider-hook?provider=X&event=Y
  → provider-hook-event-normalizer.js(40+ 原始事件 → 9 类 session:*)
  → session-event-bus.js(内存广播)
  → webui-session-watch.js(SSE /v0/webui/sessions/watch)
  → 前端 Chat.tsx watch(pending 态/刷新/交互 prompt)
远端:一切经 x-aih-server-id 由本地 server 管道转发(SSE 已流式代理)。
```

安装与诊断:`GET/POST /v0/webui/provider-hooks`(webui-provider-hook-routes.js),
配置写入由 provider-session-hook-config.js 负责(claude settings.json / codex hooks.json / agy hooks.json / gemini settings.json / grok hooks.json,见 §8)。

**用户可见的接管入口是 `PUT /v0/webui/toolkit/apps/:provider/settings` 的 `sessionHook` 开关**
(2026-10-23 加),在「应用管理 → 高级设置」里,与启动权限并列:

- 默认**关**。安装 Hook 要写用户的全局 CLI 配置,启动时自动写入的行为早已移除
  (`provider-session-hook-autoinstall.js` 头注释),所以必须由用户显式打开。
- 打开 = 立刻装一次,之后 aih 会替你守着:自动升级前后发现 Hook 没了会装回去
  (`provider-cli-upgrade/hook-survival.js`),装不回则按升级失败处理并回滚。
- 关闭 = 只停掉接管与恢复**行为**,不主动删除已有配置(删除会改写用户配置,
  而关掉开关的意图通常只是「别再动我的东西」)。
- 只有 `sessionHook: true` 显式出现在请求里才会动 Hook;改启动权限的 PUT 不会顺手改它。

`POST /v0/webui/toolkit/apps/hooks` 与 `POST /v0/webui/provider-hooks/install` 都是底层
`installProviderSessionHookConfig` 的薄包装,职责不同:前者带「CLI 已安装 / 支持 Hook」前置检查
与装后二次诊断(卡片上的动作走这条),后者支持 `dryRun`/`confirm` 并透传 server 实际的
`receiverUrl`/`senderScriptPath`/`codexVersion`。2026-10-23 起 toolkit 那条也补齐了这三个透传——
此前它会退回硬编码的 `127.0.0.1:9527`,server 换端口后装出来的 Hook 指向一个不存在的地址。

诊断对象带 `syncMode` 三态(`getProviderSessionSyncMode`,2026-07-24 加):`hook`=官方 hook 已接入、
`polling`=无官方 hook 但 `resolveSessionFilePath` 有实现,靠 session-event-bus 的 500ms 文件 watch/poll
兜底、`unavailable`=连会话文件都读不到。WebUI 设置页「会话实时同步」卡(RealtimeSyncCard.tsx)按此三态
诚实展示**全部 10 个 provider**,不再把没有官方 hook 的 provider 从卡片里滤掉。

### 归一化事件(前端消费的 9 类)
`session:opened / turn-started / turn-updated / turn-completed / turn-failed / closed / notification / interactive-prompt / interactive-prompt-cleared`
(完整原始事件→类型映射见 provider-hook-event-normalizer.js:EVENT_TYPE_BY_NAME)

## 2. 逐 provider 能力矩阵

| | claude | codex | opencode | agy | gemini(弃用) |
|---|---|---|---|---|---|
| 会话生命周期 hook | ✅ settings.json 5 事件(SessionStart/UserPromptSubmit/Stop/StopFailure/SessionEnd) | ✅ hooks.json 3 事件 + stop-notify + feature flag | ✅ 插件桥(§4,P4 落地) | ✅ hooks.json 3 事件 | ✅ 4 事件 |
| 工具级事件 | hook 支持 PreToolUse/PostToolUse(webUI headless 直接从 stream-json 拿工具流,未装该 hook,见 §6) | BeforeTool/AfterTool(同左,未装) | 插件 tool.execute.before/after(§4,实证 ✅) | PreToolUse/PostToolUse 推断 | — |
| headless 审批(confirm) | ✅ **MCP 权限工具**(§3,已落地) | ✅ **app-server JSON-RPC**(§5,已落地) | ✅ **serve HTTP API**(§4,已落地) | 未验证 | — |
| mid-run steer | ✅ stream-json 注入=同会话下一轮排队(§3,已落地) | ✅ app-server turn/steer(§5,已落地) | serve prompt_async(未接 UI) | 未验证 | — |

> 落地状态(2026-07-04):P1 slash 全集 / P2 queue+claude steer / P3 三家 confirm 审批
> 均已 commit + 部署 AWS。本文档"已落地"=代码在 main 且有真机 e2e 证据;"实证"=spike
> 阶段跑通但未必接进产品路径;"未验证"=没做实验。

## 3. claude(验证版本 2.1.191,2026-07-04 实证)

### 3.1 权限审批:`--permission-prompt-tool`(P3 主路线,已实证)
启动形态:
```
claude -p --output-format stream-json --input-format stream-json \
  --permission-mode default|plan \
  --mcp-config '{"mcpServers":{"aih":{"command":"node","args":["<aih 权限工具>"]}}}' \
  --permission-prompt-tool mcp__aih__approve
```
实证结论:
- 需要权限的工具调用 → claude 调 MCP 工具 `approve`,arguments = `{tool_name, input, tool_use_id}`(如 `{"tool_name":"Write","input":{"file_path":"/tmp/x","content":"..."}}`)——**可直接渲染成 webUI 审批卡**。
- 工具返回 content[0].text = JSON 字符串:
  - 允许:`{"behavior":"allow","updatedInput":{...}}`(可改写入参)
  - 拒绝:`{"behavior":"deny","message":"原因"}` → 工具不执行,模型收到拒绝并优雅收尾(实测回复 DENIED-OK,无重试风暴)。
- **plan 模式:`--permission-mode plan` 下 `ExitPlanMode` 本身走该权限工具**(payload tool_name=ExitPlanMode)→ "计划完成,要执行吗"的确认点天然存在;批准后后续 Write 等再逐个请求。
- 全程 stream-json 输出保持结构化(assistant/tool_use/result 正常),**不降级**。

### 3.2 steer:`--input-format stream-json`(P2c 主路线,已实证)
- stdin 常开,任意时刻写 `{"type":"user","message":{"role":"user","content":"..."}}\n`。
- 实证语义:**同会话追加下一轮**(第一轮 result 正常收尾→立刻处理注入消息→第二轮 result),与 TUI"运行中打字=排队到轮后"同语义;进程不退出直到 stdin 关闭/被 kill。
- 现有 webUI 已用该形态跑图片输入(cat-pipe);P2c 放宽为常开。

### 3.3 生命周期 hook(已在用)
settings.json hooks:SessionStart/UserPromptSubmit/Stop/StopFailure/SessionEnd → sender → aih。
诊断:claude-hook-diagnostics.js 从会话 .jsonl 提取 stop_hook_summary/hook_non_blocking_error。
未用(P4):PreToolUse/PostToolUse(工具进度)、Notification(请求注意)。

## 4. opencode(插件 API 已跨代:v1 1.4.7 首证 / v2 2.0.29 复证;serve 见 §4.2,v1 时代验证)

### 4.1 插件体系(v1↔v2 双代实证)
- 位置:`<config>/opencode/plugin(s)/*.js`(两个目录都加载;项目级 `.opencode/plugin(s)` 同;`~/.opencode` 恒被扫描;`--pure` 禁用)。
- **入口契约(2.0 起变更,入口形状不兼容)**:
  - v1(`<`2.0,`>=`1.18.29):default 导出为「工厂函数返回 hooks 对象」:`export const X = async ({project,directory,worktree,client,$}) => ({ hooks })`;**1.18.29 起也支持 default 对象 + `server()` 入口**。
  - v2(2.0+):default 必须是**普通对象** `{id, effect|setup}`——函数导出(`Expected object at ["default"]`)、只有具名导出/缺 id(`Missing key at ["default"]`)都被拒绝;`setup(ctx)` 返回 cleanup 函数。
- **事件形状也不同**:v1 `{type, properties}`,`sessionID` 在 `properties`(session.updated 带 directory/projectID);v2 是信封 `{id, created, type, location?, durable?, metadata?, data:{sessionID, ...}}`,**sessionID 在 `data.sessionID`**。v2 插件侧事件目录(run 实测)以 `session.execution.*` 为执行边界:`started` / `succeeded` / `failed` / `interrupted`;产出流为 `session.text|reasoning|tool.*`;`session.idle` 只存在于内部 bus,插件侧收不到。
- 订阅:v2 用 `ctx.event.subscribe({signal})` 返回 AsyncIterable(文案 vs v1 的 `event` hook 收 bus 全量)。
- run/serve/TUI 三形态都加载插件;`--format json` 输出不受影响。

### 4.2 审批(P3c,**已落地**:serve HTTP API 路线)
实现:`opencode-serve-runner.js`(每账号 tmux 常驻 `opencode serve`)+ `opencode-serve-client.js`
(localhost HTTP client)。webui-chat-routes 在 `provider==='opencode' && useHeadlessStream &&
approvalModeNeedsBridge` 时改走该 runner;bypass 仍走 `opencode run --format json` 零变化。
- 流程:`POST /session {directory}` → `session.update` 注入会话级 ask 规则(`CONFIRM_PERMISSION_RULES`,
  不碰全局配置)→ `POST /session/:id/prompt_async {model,parts}` → SSE `GET /event` 监听
  `permission.asked` → 审批桥登记+发 `session:approval-request` → 用户决策 → `POST /permission/:id/reply
  {reply:once|reject}`。**directory 作用域**必须与会话一致,否则 /event 空转、reply 找不到挂起项。
- 外部决议(TUI/别客户端已回复)经 `permission.replied` 双向去重,收起审批卡不重复 reply。
- 真机 e2e(1.4.7,账号 1):confirm→bash 权限挂起→审批卡带 command→allow→文件落盘;deny→文件不建。
- ⚠️ 踩过的坑(别回退):插件 `permission.ask` hook 在 1.4.7 **有类型无触发点(死的)**;`opencode run`
  自订阅 permission.asked 在 ~2ms auto-reject(run 形态做不了审批)。仓库 `opencode-server-client.js`
  是 **Zen 云端** API 客户端,与本地 serve 无关(本次新写 localhost client)。
- 风险:Zen 模型目录分钟级动态;偶发 serve 启动挂死(疑 bun 对代理 env 敏感),runner 有 readiness 轮询+超时。

### 4.3 生命周期 hook 桥(P4,**已落地**:插件文件)
opencode 无 JSON hooks 配置,机制是 JS 插件。`opencode-plugin-template.js` 生成桥插件
`<config>/opencode/plugin/aih-session-hook.js`(ESM,零依赖),订阅事件总线的会话边界信号
fire-and-forget POST 给现有 receiver。**生成模板是 v1/v2 双兼容对象**(opencode 2.0 实测,
2026-10-15):`export default { id, setup(ctx), server() }`——v2 只读 `id`+`setup`(订阅
`ctx.event.subscribe({signal})`,返回 cleanup),v1>=1.18.29 的对象入口调 `server()` 拿旧式
hooks(v2 忽略未知键;同进程 `setup` 已生效时 `server()` 返回空对象防双发;1.18.29 以下不认识
对象入口,插件静默不生效而非报错)。事件映射:
- v2:`session.execution.started` → `?event=UserPromptSubmit` → `session:turn-started`;
  `session.execution.succeeded|failed|interrupted` → `?event=Stop` → `session:turn-completed`
  (每会话去重,终态后重置)。
- v1:`message.updated/part.updated/part.delta/session.status` 首个出现 → UserPromptSubmit;
  `session.idle` → Stop。
安装/诊断:`opencode-plugin-hook-config.js`,经 `provider-session-hook-config.js` 的统一入口
(`installProviderSessionHookConfig('opencode',...)` 等 4 个函数早分支)。文件式,幂等;诊断三态:
未装(`plugin-file`)、URL 变(`receiver-url-changed`)、**源码仍是旧 v1 形(`plugin-file-outdated`,
只查 marker/URL 会把 v2 必挂的陈旧文件误报为已安装)**。真机 e2e:v1 1.4.7(`opencode run`,
UserPromptSubmit→Stop 同会话);v2 2.0.29(生成文件装入测试配置目录,`opencode run` 实测
`session.execution.started/succeeded` → 两条 POST 到达 receiver;真实 `~/.config` 下加载零失败)。
- 与 §4.2 serve 的关系:serve 只在 confirm 模式;插件桥覆盖**默认(bypass)run 路径**的实时状态,
  两者互补(bypass 走插件桥拿 pending,confirm 走 serve 拿审批+事件)。
- 注意:§4.2 的 serve 路线(HTTP `/session`+`/event`+permission.ask)验证于 v1 1.4.7,
  v2 的 serve 契约是否兼容**未复证**,升级 opencode 2.x 后 confirm 模式需重跑 §4.2 真机 e2e。
- 第三方插件生态:v1 形 npm 插件(如 oh-my-openagent 5.1.33)在 v2 一律加载失败
  (`Missing key at ["default"]["effect"]`),需上游迁移(其仓库已有多个 v2 issue + 草稿 PR)。

## 5. codex(验证版本 0.142.0,2026-07-04 实证;完整报文样本见 S3 spike scratchpad)

已在用:hooks.json(SessionStart/UserPromptSubmit/Stop)+ aih-stop-notify + hooks feature flag;三类 binary wrapper(cli/desktop/vscode);exec headless(JSONL)。

### 5.1 app-server JSON-RPC(P3b codex 审批主路线,**已落地**)
实现:`codex-app-server-runner.js`(每账号 tmux 常驻 `codex app-server --listen ws://127.0.0.1:PORT`)
+ `codex-app-server-protocol.js`(纯函数协议编解码)。webui-chat-routes 在 `provider==='codex' &&
useHeadlessStream && approvalModeNeedsBridge` 时改走;bypass 仍走 `codex exec --json` 零变化。
handle 与 spawnNativeSessionStream 同构:`writeSteer→turn/steer`、`abort→turn/interrupt`。
真机 e2e(0.142,账号 1):allow→accept→命令执行→文件落盘;deny→decline→命令不执行,模型优雅收尾。
协议细节:
- **v2 协议**(`thread/*`、`turn/*`、`item/*`;旧 newConversation 已不在 ClientRequest):
  `initialize`→`initialized`→`thread/start {cwd,approvalPolicy,sandbox}`→`turn/start {threadId,input}`;
  流式=notification:`item/agentMessage/delta`(带 phase commentary|final_answer)、`item/commandExecution/*`、`item/fileChange/*`、`turn/completed`。
- **审批=server→client 的 JSON-RPC request(带 id 要应答)**:
  `item/commandExecution/requestApproval`(params 含 command/cwd/commandActions/**availableDecisions**)与
  `item/fileChange/requestApproval`(diff 在此前的 item/started 里,需缓存)。
  决策枚举:`accept | acceptForSession | {acceptWithExecpolicyAmendment} | decline | cancel`;
  **availableDecisions 直接给出按钮列表,UI 照渲染**。decline=拒绝但 turn 继续;cancel=中断 turn。
  等待期 `thread/status/changed.activeFlags=["waitingOnApproval"]`(驱动"等待审批"UI);45s 不应答仍等待,不自杀不自动决策。
- 策略:`approvalPolicy: untrusted|on-failure|on-request|never` + `sandbox: read-only|workspace-write|danger-full-access`。
  confirm 模式=`untrusted`+`workspace-write`;现有 bypass=`never`+`danger-full-access`。
- **thread.id == sessionId == rollout 文件 UUID**,`thread/resume` 跨进程恢复实证成功(与 exec 产生的 rollout 同存储);`turn/interrupt` 生效;**`turn/steer {threadId,expectedTurnId,input}` 实证生效**(运行中注入,同 turn 改道)= codex 的真 steer。
- **tmux 相容性**:stdio 版随父进程死(无意义);**`--listen ws://127.0.0.1:PORT` 是正解**——实测强杀客户端连接后新连接 `thread/resume`,**pending 审批原样重发(同 request id)**,应答后 turn 跑完。tmux 常驻 per 账号一个 app-server,aih 重启重连即恢复(连挂起审批都不丢)。
- 另需兜底的 server request:`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/permissions/requestApproval`。
- 未验证:unix control socket 握手;审批挂起时 interrupt 行为;acceptForSession 缓存粒度;多连接同订阅时审批下发对象。

### 5.2 exec stdin 语义(实证,澄清误区)
既非 steer 也非排队:stdin 为管道时 exec **阻塞等 EOF** 再开跑,内容整体并入初始 prompt 的 `<stdin>` 块;运行中无输入通道。中途干预只能走 app-server `turn/steer`。

## 6. agy / gemini

- agy:hooks.json PreInvocation/PostInvocation/Stop(已在用);TUI slash 面板含 /hooks /permissions(实测存在);headless 审批/steer 未验证。
- gemini:settings.json 4 事件(已配);provider 已弃用,仅存量。

## 7. 审批通道统一契约(P3,三家共用)

不管请求从哪来,审批都收敛到 **`native-approval-bridge.js`** 一个中枢 + **一张审批卡** + **一个决策端点**:

```
权限请求(来源三选一)
  claude:  MCP 权限工具 claude-permission-mcp-tool.js → POST /v0/webui/internal/approval-request(长挂)
  codex:   app-server item/*/requestApproval(JSON-RPC request)→ runner 内 registerApprovalRequest
  opencode: serve SSE permission.asked → runner 内 registerApprovalRequest
     ↓ registerApprovalRequest({runId,toolName,input,toolUseId}, respond) → {approvalId}
     ↓ publish session:approval-request(prompt=toApprovalPrompt(entry),复用 PlanChoiceDock options 协议)
  前端 watch/live 弹审批卡(kind:'approval')
     ↓ 用户点允许/拒绝 → POST /v0/webui/chat/runs/:runId/approvals/:approvalId {decision:allow|deny}
     ↓ decideApproval(approvalId, decision) → entry.respond({behavior})
  回填各自来源:claude=长挂 HTTP 响应体;codex=JSON-RPC response {decision:accept|decline};
              opencode=replyPermission(once|reject)
```
- **detached 恢复免费**:`/chat/runs` 的 activePrompt 合并 `getPendingApprovalPromptForRun(runId)`,
  刷新后审批卡自动回来。
- **run 结束/中止**:`cancelApprovalsForRun` 把该 run 的挂起审批全部 deny 收尾(claude MCP 工具不会
  悬挂到超时;codex/opencode 会话不卡)。
- **安全默认**:claude 权限工具在桥不可达/超时时返回 deny;三家的"拒绝"都让模型看到拒绝并优雅收尾。
- 前端审批模式选择器(极速/需确认/计划)按会话持久(localStorage),经 `/chat` 的 `approvalMode` 下发;
  目前 UI 仅对 claude native 显示,codex/opencode 的 confirm 走同一 approvalMode 字段(后续放开选择器即可)。

## 8. 已安装 hook 事件字典 + 工具级事件决策

**各 provider 默认安装的生命周期事件**(`provider-session-hook-config.js:DEFAULT_EVENTS_BY_PROVIDER`):

| provider | 配置文件 | 已装事件 |
|---|---|---|
| claude | `~/.claude/settings.json` | SessionStart / UserPromptSubmit / Stop / StopFailure / SessionEnd |
| codex | `~/.codex/hooks.json`(+feature flag) | SessionStart / UserPromptSubmit / Stop(+aih-stop-notify) |
| gemini | `settings.json` | SessionStart / BeforeAgent / AfterAgent / SessionEnd |
| agy | `hooks.json` | PreInvocation / PostInvocation / Stop |
| opencode | 插件 `plugin/aih-session-hook.js`(P4) | session lifecycle(见 §4.3) |
| grok | `~/.grok/hooks/aih-session-sync.json` | SessionStart / UserPromptSubmit / Stop / StopFailure / SessionEnd |

**grok(2026-07-24 加,⚠️ 未真机实证)**:官方 CLI 是 `x.ai/cli/install.sh`(AI Home 的
`native-cli-install-strategies.js:grokInstallStrategy` 装的就是这个),对应官方文档
`docs.x.ai/build/features/hooks` ——**注意不是**同名的 `superagent-ai/grok-cli` 社区项目(两者都用
`.grok/` 目录,首轮 WebSearch 差点搞混,已通过对比 install strategy 的下载 URL 与官方文档域名排除)。
schema 与 claude 一致(`{"hooks":{"EventName":[{"hooks":[{"type":"command",...,"timeout":秒}]}]}}`),
事件名与 claude 完全同名,因此复用了 `buildEventHooksConfig` 通用分支,未新增专属 build/diagnose 逻辑。
本机未装 grok CLI,无法端到端触发验证,**故未加入 `provider-session-hook-autoinstall.js` 的启动自动安装
白名单**——只能通过设置页「一键启用」手动触发(写入前用户可见、可控),避免对未验证 provider 每次启动
静默写用户配置文件。真机验证后再考虑转入自动安装。

**qoder / qodercn / kiro(未接入,`syncMode='polling'`)**:WebSearch 显示三者都疑似有 Claude 兼容的 hook
机制(qoder `~/.qoder/hooks`、kiro `agentSpawn`/`postToolUse` 等不同事件命名),但尚未像 grok 那样核对到
官方文档 + 排除同名项目混淆风险,暂缓接入,靠 `resolveSessionFilePath` 的文件轮询兜底同步(有延迟,非
事件驱动)。

**kimi(未接入,`syncMode='unavailable'`)**:`resolveSessionFilePath` 无 kimi 分支(`session-reader.js`
default 返回空字符串),会话读取本身就没做,装了 hook 也无处可读——这是比"没有官方 hook"更前置的缺口,
需要先补会话文件读取支持才谈得上 hook。

**归一化映射**(`provider-hook-event-normalizer.js`):40+ 原始事件 → 9 类 `session:*`(§1)。
PreToolUse/PostToolUse/BeforeTool/AfterTool 已映射为 `session:turn-updated`,Notification→`session:notification`。

**工具级事件(PreToolUse/PostToolUse)为何不默认安装**(决策,非遗漏):
webUI 的 headless 路径已直接从 stream-json/JSONL 输出拿到**每个工具的调用与结果**(实时渲染工具卡,
见 native-session-chat parseNativeStreamEvent),再装 PreToolUse/PostToolUse hook 会**重复**同一信息且
放大高频事件量(每工具两次 POST)。因此工具进度走输出流、不走 hook。hook 的工具级事件保留给未来
"非 headless/PTY 场景需要旁路工具信号"时按需开启(normalizer 已就绪,只差 DEFAULT_EVENTS 加项)。

## 9. slash 清单来源(附录)

各 provider autocomplete 清单 = `lib/server/native-slash-command-catalog.js`,来源为 2026-07-04 tmux 起真实 TUI 输 `/` 抓补全面板全量(claude 另与官方 commands 文档求交集剔除本机技能);更新方式=重跑同法。claude 81 / codex 45 / opencode 20 / agy 30 / gemini 10;未列命令由 passthrough 放行(权威=CLI)。
