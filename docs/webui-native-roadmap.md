# WebUI 会话 / Provider 优化 Roadmap

> 收敛自 2026-07-07 长 session。分:P0 根本架构 / P1 交互体验 / 已修待验 / 账号侧 / 已论证不做。

---

## ▶ START HERE —— 新 session 执行顺序

**plumbing 已铺好并验证**(commit `f12a97e`,opt-in `accountId='.aih-server'`,对现有会话零影响)。从下面两个深层 blocker 切入,不要重铺 plumbing:

1. **codex 原生"no available claude account"**(P0 codex)—— ✅ **已根因 + 已修 + 已验(2026-07-08)**
   - **真因**(非 422,非账号,非 body):网关**两层 bug**。① `resolveGatewayProvider→resolveProviderByModel` 纯目录字符串匹配无家族感知,某 claude 中转也宣称支持 `gpt-5.5` → 抢走 codex 家族请求路由 → 派发 claude → "no available claude account"(甩锅假象)。② api-key codex(yesboss)对 gpt-5.5 的路由资格【只】依赖一次成功探测写的 `byAccount` 绑定(无本地兜底),`shouldRejectEmptyRemoteModels` 原仅 OAuth codex 生效 → api-key codex 信任空探测 → 一次返空就被 `mergeByAccountCache` 抹成 `[]` → 掉出路由(症状=强制 refresh 后只有第 1 个请求能成)。
   - **修**:① `capability-router.js` 严格家族路由(非显式别名的 `gpt-*` 锁死 codex + 如实报错)commit `f3503ce`;② `provider-model-discovery.js` codex 空探测按失败处理保留绑定 commit `2ad70b3`。均含回归测试。
   - **验证**:重启网关(launchd kickstart)后 **24/24 gpt-5.5→codex 200 无抖动**。yesboss 上游本就健康(直连 200)。详见记忆 [[codex-no-claude-account-misroute]]。

2. **claude native hang**(P0 claude 前置 blocker,也是既有 bug)—— ✅ **已根因 + 已修(2026-07-08)**
   - **真因**(非"claude 不吐 result"):claude【会】吐 result,但 `is_error:true`(如 403 鉴权失败)时 `parseNativeStreamEvent` 把它映射成 `type:'error'`,而 kill 分支只认 `event.type==='result'` → **错误 result 永不触发 kill** → `cat<file>-` 撑住 stdin、claude(stream-json 输入)吐完不自退 → 进程泄漏、`onExit` 永不触发 → `done` 永不 settle → SSE 流不关 → webUI 挂到超时(所谓"无 error")。本机实证:12 条 `cat…|claude…qwen3.6-plus` 泄漏进程,每条 log 都以 `result`(403)结尾但无 `__AIH_RUN_EXIT`。
   - **修法**:parser 给错误 result 打 `claudeTerminalResult:true` 标记;native-session kill 分支识别它→无条件 kill 且【不】设 `expectedResultKill`(保留非零退出码→`finish` 走失败分支 reject→前端收到 error 并关流)。`native-session-chat.js:1124` + `:1837`。回归测试见 `test/native-session-chat.test.js`(2 例)。
   - **注意**:此修把 **hang → 可见 error**。claude native 真正出正文仍需解决 403(账号侧:`qwen3.6-plus` 别名指向的账号 api-key 失效)。success 路径未受本次改动影响(else-if 分支字节级不变),但当前全 403 账号下无法在本机验证 success。

3. **opencode aih-server**:overlay 由 `opencode-strategy.js` prepare 处理(已建),native 路径待验(`accountId='.aih-server'` provider=opencode 跑一遍)。

4. **前端账号选择器**(P0 收尾)—— ✅ **已做 + 已 E2E 验(2026-07-08)**:`MessageArea.tsx` 账号下拉加「**aih-server(全部账号+别名)**」项(codex/claude/opencode 显示,agy/gemini 正确排除),选中 `accountId='.aih-server'`;顺带修了 `.aih-server` 无 model-list 键→"无可用模型"+发送键永久置灰、及轮询冲掉选中项两个 bug(`web/aih-server-account.ts` + `account-model-selection.js` + `Chat.tsx`)。已 build 进 `web/dist`(9527 直读盘,刷新即生效)。**Playwright 实测**:新建 codex 会话选 aih-server → claude-* 别名链路由到 codex(yesboss)真出 "pong",网关日志 `provider:codex accountId:1 status:200`,零 "no available" 报错。

5. **P1 三项** —— ✅ **已做 + 已验(2026-07-08)**:
   - **终端 fit/resize**(`TerminalDock.tsx`,commit c39409c):dock 默认 280→380px + 顶边可拖拽调高(持久化)+ 高度变化重 fit→后端 child.resize 同步。Playwright 实测 /help 开出 380px 交互终端、codex TUI 菜单完整可读可交互(› 光标)。fit/resize/后端同步此前已实现,本次补"够高+可拉伸"。
   - **slash 逐 provider**:codex 完整验证(/help 交互 TUI);claude 终端 dock 正常开出(该账号 fable-5 限额致 /help 输出空,机制通);opencode 账号 key 失效未验(机制同源)。
   - **交互 prompt/plan 审批**:审批模式选择器 UI 实测可用(极速/需确认/计划 三档可切);审批桥后端已接线。完整"触发→审批卡→决策回传"E2E 受 claude fable-5 限额阻塞(账号侧,非代码)。

**E2E 验证结论(Playwright,2026-07-08,见 [[playwright-webui-e2e]])**:claude native 不再挂起(8s 出结果 + 关流)、codex 经 aih-server 真出回复、opencode 经 aih-server 路由通(回复失败=已知 opencode key 失效,非代码)。全量测试 3088/3132 通过,23 个失败均为【既有】(file-preview/control-plane/fabric/agy/Windows 等,与本 session 无关,已 baseline 对比确认零回归)。

**共享重构建议**:把 provisioning 抽成 `ensureAihServerProfile(provider, ctx)`(现在散在 `webui-chat-routes.js` 的 chat handler 里),CLI `spawnPty` 也改调它,避免两处 drift。

**账号侧(用户并行处理,非代码)**:opencode 换有效 key、claude 换可用端点(anyrouter.top 挂了)。

---

## P0 —— WebUI 会话走 `aih-server`(根本架构,一次性解决一堆)

**问题**:WebUI 的 native 会话按数字 `accountId` **绑死单账号**(`getProfileDir(provider, accountId)`),完全没有 `.aih-server` 网关 profile 处理——"所有账号池化 + 别名"目前**只有 CLI 的 `spawnPty` 有**。
后果:codex 会话显示 claude 模型 + agy 账号(错乱)、不能切 provider、别名不生效、无跨账号 failover、和 `aih codex` 终端会话不互通。

**怎么做**:
1. **后端**:`webui-chat-routes` / `native-session-chat` 支持 `accountId='.aih-server'` → 复用 CLI 的 `buildBuiltinServerProfileEnv`(spawn CLI 时把 base URL 指向本地网关)。网关池化该 provider 所有账号 + 解析别名 + 熔断 failover。
2. **前端**:账号选择器默认项改为「**aih-server(全部账号 + 别名)**」;模型选择器列网关别名/全模型。
3. **会话态**:会话落在 `.aih-server` profile 目录,和 CLI `aih codex` **互通**。
4. **逐 provider**:codex(`OPENAI_BASE_URL`)、claude(`ANTHROPIC_BASE_URL`)、opencode(config overlay,本 session 已建)。**agy 例外**——CLI 无 endpoint 覆盖口,进不了网关,保持单账号直连(见"账号侧")。

**收益**:单账号绑定、accountId 错乱、别名、failover、CLI 互通,一次对齐。**这是最大杠杆,建议第一个做。**

---

### P0 进展(2026-07-07,进行中)

**已做(plumbing 打通,已上线)**:
- `webui-chat-routes.js`:支持 `accountId='.aih-server'` → 读 `readServerConfig` + `buildAihServerProfileEnv(provider, cfg)` 写进 `.aih-server` profile 的 `.aih_env.json`;`nativeAccountHasCredentials`/`buildProviderEnv` 据此把 CLI 指向本地网关。**实测 claude/codex 的 native 会话都能带 `accountId:".aih-server"` 到达 `ready`**——路由+鉴权校验通了。

**剩余(每 provider 的 config 补全 + 一个前置 blocker)**:
1. **codex**:✅ 已复用 `createCodexLaunchSupport().syncCodexConfigFromHost(...,hostConfigPath=null,...)` + 写 auth.json,`.aih-server/.codex/config.toml` 现有 `[model_providers.aih__aih-server]`(base_url=网关/v1、bearer、wire_api=responses)。**401 → 422**:codex `exec --json` 打到网关后网关转上游 codex 账号返 `upstream_422`——是 codex 的 responses wire-api / 默认模型经网关的请求格式问题,需对比 CLI `aih codex`(能用)的实际请求差异 / 指定合法模型。**下一步 blocker**。
2. **claude**:`.aih_env.json`(ANTHROPIC_BASE_URL=网关)已生效,但 **claude native 本身 hang(ready 后无响应)——这是【早于 aih-server 的既有 bug】**(单账号 claude 也 hang,疑似 `--print stream-json` 的 `cat <msgfile> - | claude` stdin cat-pipe 没喂到)。是 claude 能用的**前置 blocker**,须先修。
3. **opencode**:`.aih-server` overlay 由 opencode-strategy 的 prepare 处理(已建),native 路径待验。
4. **前端**:账号选择器加「aih-server(全部账号+别名)」默认项 + rebuild。
5. **agy**:无 endpoint 覆盖口,进不了网关,保持单账号直连(前端对 agy 不显示 aih-server 项)。

**建议下一步**:先抽 `ensureAihServerProfile(provider, ctx)` 共享函数(CLI spawnPty + native 都调),把 codex config.toml / opencode overlay / claude env 一处provision;并行修 claude native hang(stdin cat-pipe)。

---

## P1 —— 交互体验

- **终端显示自适应**:TUI 挤在小 dock 里截断。前端 `TerminalDock` 按实际 cols/rows `fit` + 发 resize,后端 `child.resize()` 同步;dock 高度可拉伸。
- **/slash-command 跨 provider**:codex/claude/opencode 的 slash 走交互终端(选择器等)。本 session 已修终端卡死(去占位气泡 + 关闭即 abort);待逐 provider 验 slash 真能交互 + 显示正常。
- **交互 prompt / plan 确认(P2/P3 审批)**:确认 codex/claude/opencode 的 plan/confirm 审批弹窗端到端可用(之前审批桥已建,需实测走通)。

---

## 已修 / 待你实测(本 session,均已上线)

| 项 | commit |
|---|---|
| agy `auth_method=consumer`(修卡登录) | 57d5922 / a3befb2 |
| agy 普通对话 headless `--print`(稳定收尾) | 5d8e6bd |
| agy slash 也走 `--print` / 不进终端 | 58ac5a3 |
| agy 内部 `[Notice]` 系统消息过滤 | f1db1d1 / 4706bad |
| agy slash 改回交互终端 + 终端卡死修复 | 36f8820 |
| agy `--print` stdout 真流式(不再 16s 一次性) | fd0c7ec |
| opencode 对齐 `.aih-server` 网关 | 5bcf5d3 |
| opencode 桥接自愈(修 `aih opencode` 启动) | e27fcf1 |
| bigmodel/GLM 模型列表(200+错误体回退) | 1dd2f0f |
| DeepSeek 模型路径 `/models`↔`/v1/models` 回退 | 4f20c66 |
| 账号显示邮箱/域名(非裸 accountId) | ab874ba |

---

## 账号侧(需你处理,非代码 bug)

- **opencode #1**:API key `sk-fc36f…463c` 失效(上游报 Incorrect API key)→ 换有效 key。
- **claude 部分账号**:如 `anyrouter.top` 第三方代理自己挂/报错 → 换可用端点。
- **codex**:目前真账号是 #2 不是 #1(P0 的 aih-server 落地后不再手选账号,此问题自然消失)。

---

## 已论证不做(附理由,免得再纠结)

| 想法 | 结论 | 理由 |
|---|---|---|
| 换 Go/Rust 提速 | ❌ 不做 | 瓶颈不在 aih:agy CLI 已是 Go、其 1-2s init 是**网络往返 Google**、上游生成是模型速度;aih 只占 ~1s 包装层 |
| warm-LS 常驻复用 | ❌ 不做 | 建 LS 要 `--prompt-interactive` ~100s + 185MB/账号,只省 1-2s init → ROI 差 |
| 直连 cloudcode-pa 绕 CLI | ❌ 不做 | 要自管会话态,且**和 native CLI 会话不通**(brain 存储两套,需逆向复刻)→ 破坏互通 |
| 首字 `<300ms` | ⚠️ 做不到 | 上游生成 3-4s 是硬底;**已用流式**给到体感(边生成边显示,≠ 5s 空白) |

---

## 优先级(我的判断)

1. **P0 aih-server**(根本,解决账号/模型/别名/failover/互通一大片)
2. **P1** 终端自适应 → slash 验证 → 交互 prompt 审批
3. **账号侧**你并行处理(换 key / 换端点)
