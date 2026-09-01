# 会话 b2ce4810 需求缺口审计与补救追踪表

> **建立**:2026-08-31 · 基于 Claude 会话 `b2ce4810-587f-4bf8-93c4-f5605606c062`(08-27 ~ 08-31)全量消息审计 + 本机实测验证。
> **用途**:回答"哪些需求声称完成但实际没做完",并逐项跟踪补救状态。状态必须附验证证据,不允许无证据标记完成。

## 状态图例

- ✅ 已闭环(有代码 + 测试/实测证据)
- 🔧 本次会话修复(08-31,附证据)
- ⚠️ 部分完成 / 与原需求形态不符
- ❌ 未实现
- ❓ 状态不确定

## 一、bug 与可靠性类

| # | 需求(出处) | 审计结论 | 当前状态 | 证据 |
|---|------------|----------|----------|------|
| 1 | 账号列表无法滚动、只见一半(L11987/L12092) | 根容器滚动已由 `6c519393` 修复 | ✅ | Playwright 实测:MAIN 容器 scrollTop 可达 1847(=max),最后一个账号完整可见;卡片/列表切换在位 |
| 2 | 刷新后 chat 会话丢失 / 模型回退(L2120/L3643) | **chat 模式会话(无 projectPath)不进 canonical/project 目录,刷新后恢复链路必然失败**;且挂载时 `usePersistedChatSelection` 以空选择擦除 URL 与 localStorage | 🔧 | 新增 `useChatSessionRestore`(`web/src/pages/chat-page-hooks.ts:41`)+ `matchPersistedChatSession`(`web/src/pages/chat-selection-state.js:93`);实测带 `?sessionId` 刷新与裸 `/ui/chat` 刷新均恢复会话、模型(k3-256k)与消息;测试 `test/web.chat-selection-state.test.js` 5 项通过 |
| 3 | 上下文动态换算 + 60% 自动压缩(L4797) | 动态换算早已存在(服务端 `resolveModelContextLimit` 按模型元数据 + UI `dynamicMaxTokens`),但阈值是 75%/80%,与要求的 60% 不符 | 🔧 | 服务端高水位 0.75→0.60(`lib/server/webui-chat-routes-opencode-proxy.js:169`),UI ContextMeter 80%→60% 并抽出 `context-meter-stats.ts` 单一事实源;`test/webui-chat-context-compaction.test.js` 新增 60% 边界用例,3 项通过;bun 测试 6 项通过 |
| 4 | OpenAI Responses 优先 WS mode(L2515) | **原审计误判**:WS relay 早已实现(`lib/server/server.js:1647` 起,`/v1/responses` Upgrade → `wss://<upstream>/responses`,先连上游再升级客户端) | ✅ | 实测 `ws://127.0.0.1:9527/v1/responses` 握手成功(意味着选号+上游 wss 连接全链路通过);codex ≥0.144 默认 WS 优先、失败自动回退 HTTP,受管配置无需改动 |
| 5 | kimi 401 阻塞其他账号(L2280) | 第一次压缩摘要标记已闭环 | ❓ | 未重新实测 |

## 二、设计规范类(用户验收持续失败的重灾区)

| # | 需求(出处) | 审计结论 | 当前状态 | 证据 |
|---|------------|----------|----------|------|
| 6 | 设计规范落地:按钮/字号/间距(L7232/L9116/L12319,截图=Chat/Work 切换器) | 规范文档与 `--hos-text-*` token 存在但**全站 0 处引用**;`chat.module.css` 存在 `.modeOptionBtn` 重复定义,后写的 24px/12px 覆盖前面的正常版;`sidebarActionBtn` 28px 不符 32px 规范 | 🔧(点状修复) | 删除重复定义块与死代码 `.modeTab` 系列;ModeSelector 实测 32px 高/13px/600,图标按钮 32×32;**全站数百处硬编码 font-size 未迁移,系统性落地未完成** |
| 7 | 全站页面鸿蒙 6.1 化(L3512/L10139) | 大量"已完成"声称无用户验收背书 | ⚠️ | `docs/dsh-harmonyos-evolution-matrix.md` 的 ✅ 均为自评;需逐页 Playwright 截图对照验收 |
| 8 | Work 模式三栏同屏布局(L2808:左文件树/中 Agent 轨迹/右终端+Diff) | 组件(文件树、xterm 终端、Diff Review、浏览器)齐全,但形态是**手动添加的标签页**,非三栏同屏 | ⚠️ | 实测 Work 模式 `+` 菜单可加 终端/文件/变更/浏览器 面板;`web/src/features/project-workbench/`。三栏同屏是独立大改造,需单独立项决策 |

## 三、流程类(原会话 /loop 纪律)

| # | 需求(出处) | 审计结论 | 当前状态 |
|---|------------|----------|----------|
| 9 | 每轮 loop 必须 aih codex/claude 带需求 review(L3027/L8199) | 08-31 03:47 后十几次 loop 一次 review 都没跑,报告措辞与实际不符 | ❌(流程层面,本会话以人工审计替代) |
| 10 | loop 自动进化/自动发现盲区(L7232) | `evolution-planner.ts` 只是静态数据结构,无自动进化逻辑;loop 退化为复读 | ❌ |
| 11 | 全量需求逐条梳理对照表(L10084) | 从未产出 | 🔧(本文档即交付物) |

## 四、本次修复清单(08-31)

| 改动 | 文件 | 验证 |
|------|------|------|
| chat 会话刷新恢复 | `web/src/pages/chat-page-hooks.ts`、`web/src/pages/chat-selection-state.js/.d.ts`、`web/src/pages/Chat.tsx` | `node --test test/web.chat-selection-state.test.js` 5 项通过;`npm run build` 通过;Playwright 实测刷新恢复 |
| 上下文 60% 高水位统一 | `lib/server/webui-chat-routes-opencode-proxy.js`、`web/src/components/chat/ContextMeter.tsx`、`web/src/components/chat/context-meter-stats.ts`(新) | `node --test test/webui-chat-context-compaction.test.js` 3 项通过;`bun test web/src/components/chat/context-meter-stats.test.ts` 6 项通过;eslint 0 错误 |
| ModeSelector/图标按钮规范修复 + 死代码清理 | `web/src/components/chat/chat.module.css` | `npm run build` 通过;Playwright 实测 32px/13px |

## 五、剩余工作(按建议优先级)

1. **设计规范系统性落地**:全站硬编码 `font-size`/按钮尺寸迁移到 `--hos-text-*` token,逐页 Playwright 截图验收(工作量大,建议按页面分批)
2. **Work 三栏同屏布局**:立项决策(是否把标签页工作台改为可调整三栏)
3. **loop review/自动进化纪律**:若重启 /loop,需把"每轮双模型 review + 真实交付增量"做成强制门禁,防止报告复读

## 六、全量需求矩阵(2026-08-31 重提取)

> 方法:从会话 JSONL(13026 行)提取全部用户消息(1246 条,去噪),4 路并行穷尽提取 → 跨片去重 → 6 路并行代码核对。每条状态附 `文件:行号` 证据。本节为全量清单,第一~五节为补救记录。

### 6.1 功能类(22 条)

| # | 需求 | 状态 | 证据 / 缺口 |
|---|------|------|------------|
| F1 | chat/work 双模式(chat=纯 API 聊天无工作目录) | ✅ | 双模式已在位;chat 不持久化 projectPath(`chat-page-hooks.ts:22-31`) |
| F2 | 参考/复刻 dsh UI 持续演进 | ⚠️ | 持续进行,见 D 类落实率 |
| F3 | chat 底层是 agent 而非简单调接口;slash command 覆盖 | ✅ | `lib/server/chat-runtime/` 驱动真实 CLI agent;`native-slash-command-catalog.js` claude~80/codex 46/opencode 21/agy 29/gemini 10 条 |
| F4 | chat 记录/显示用时 | ✅ | `message-metrics-format.ts:84`;`MessageMetadata.tsx:67-90` |
| F5 | HTML/SVG 代码块预览(预览/代码双 Tab + PC/手机沙箱弹窗) | ✅ | `HtmlCodeBlock.tsx:35-91` iframe sandbox;`html-preview-window.ts:60-91` |
| F6 | 断线韧性:刷新不影响在途回复,后端续跑并保存 | ⚠️ | native 链路闭环(`use-detached-run-recovery.ts:33-44` + sessions/watch);api-proxy 纯聊天仅"后端续跑+落盘"(`webui-chat-routes.js:1426`),**前端在途逐字续接无证据** |
| F7 | 会话粘性调度(同账号接续,命中 KV cache) | ✅ | `account-selector.js:122-171` sessionAffinity,TTL 30min 可配 |
| F8 | 跨账号思考链加密内容最优解(不剥离降智) | ⚠️ | Claude/Gemini signature 透传保留;**codex 仍剥离**(`codex-adapter.js:402-406`);无解密注入机制 |
| F9 | OpenAI Responses 优先 WS mode | ✅ | `server.js:1647` 起;实测握手通过 |
| F10 | OAuth 报错自动定向回退 API Key 账号 | ⚠️ | 通用换号在(`upstream-failure-policy.js:647-662`);**无 auth-type 定向回退策略** |
| F11 | chat 集成 harness 2(dsh 2.0) | ⚠️ | 12 项吸收清单落地 10 项,见 F20 |
| F12 | AI 自动发现并规划 + 双模型 review + loop 自动进化 | ➖ 剔除 | **非 aih 产品需求**:该会话 /loop 自动执行纪律,2026-09-01 用户裁决剔除(见第十节) |
| F13 | 上下文动态换算 + 60% 自动压缩 | ✅🔧 | 本次修复,见第一节 #3 |
| F14 | MessageIconActions:复制代码/重新生成/分流新对话 | ✅ | `MessageIconActions.tsx:35-121`;代码复制由 `CodeBlock.tsx:41-54` 承担 |
| F15 | StatsLine 度量条(总耗时/首字/速度/Token) | ✅ | `StatsLine.tsx:29-91`,常驻输入区上方;非滚动 sticky 形态 |
| F16 | ThinkingBlock 吸收 ReasoningRow(节流+右滚) | ⚠️ | legacy 链路完整(`ThinkingBlock.tsx:31-44`);**canonical `TimelineItemView.tsx:52-53` 未传 `running`,流式期不生效** |
| F17 | Work 三栏同屏(目录树+Git+Sessions \| Agent 轨迹 \| PTY+Diff) | ❌ | 当前为互斥标签页(`workbench-types.ts:1-6`);架构级差距 |
| F18 | Chat 顶栏极简(胶囊切换器+模型选择+新建对话) | ✅🔧 | 本次修复 ModeSelector 32px/13px |
| F19 | 主区域居中最大宽 840px | ⚠️ | 居中自适应有;实际 `--chat-content-width: 800px`(`chat.module.css:1600`),与 840 不符 |
| F20 | dsh 2.0 十二项:首字渲染✅、右滚打字机✅、微光扫描✅、ContextMeter 环形✅、悬浮操作栏✅、长图分享✅、分支 Diff✅、会话内搜索✅、置顶✅、灵感胶囊✅、快捷键✅、**跨 Tab 同步⚠️** | ⚠️ | `cross-tab-session-sync.ts` 有广播方(2 处)**但全仓无 subscribe 调用方,有发无收,链路未闭环** |
| F21 | 200+ 轮虚拟列表 60fps / 500 条聚合 <5ms 基准 | ⚠️ | 虚拟列表在(`VirtualConversationList.tsx:20-60`);滚动回调未 rAF 节流;**无性能基准测试** |
| F22 | 分支版本对比 Diff + 离线 PWA | ⚠️ | Diff ✅(`SessionDiffModal.tsx:64`);PWA 仅静态资源(`web/public/sw.js`),**会话数据无离线缓存** |

### 6.2 缺陷类(24 条)

| # | 缺陷 | 状态 | 证据 / 缺口 |
|---|------|------|------------|
| B1 | `s.attachRunId is not a function` | ❓ | 全仓+git 历史无 `attachRunId` 符号,无法定位修复点 |
| B2 | chat URL 残留 projectPath/projectDirName | ✅ | `chat-selection-state.js:60-68` 主动清除 |
| B3 | 首字渲染:收到首 token 立即渲染 | ⚠️ | **native 链路首 token 前 thinking 被服务端 bufferedEvents 压住**(`webui-chat-routes.js:763-782`),无 TTL 兜底直写 |
| B4 | 多头像/分段回复未聚合 | ✅ | `MessageArea.tsx:548` followup 隐藏头像;delta 合并同条消息 |
| B5/B6 | 左侧会话列表为空/衔接断裂 | ❓ | 三锚点:`use-canonical-session-directory.ts:114-118` 空 queries→EMPTY;`:143-146` 失败静默吞;`:158-160` key 变化清空重建 |
| B7 | zcode glm-5.3 报错引导误导 | ⚠️ | `webui-chat-routes-utils.js:80-85` 无 zcode 特判;zcode OAuth 本就不做推理 relay,文案引导"补全凭据"偏题 |
| B8 | 时间统计矛盾(首 token 6.2s > 用时 6s) | ✅ | `message-metrics-format.ts:89-91` ttft>duration 守卫 |
| B9 | 连续 user 消息重复 | ❓ | 原会话声称已修并推送,未复核 |
| B10 | eventstream 已收数据但 UI 思考中 15s | ⚠️ | 与 B3 同根因(服务端缓冲) |
| B11 | 刷新后会话指标丢失 | ✅🔧 | `durationMs/ttftMs/model` 持久化恢复;**小缺口:`outputTokens/tokensPerSec` 未持久化**(`webui-chat-routes.js:1470-1473`) |
| B12 | thinking 渲染最新数据/宽度稳定 | ⚠️ | legacy ✅;canonical 未传 `running`(同 F16 缺口) |
| B13 | kimi 401 阻塞其他账号 | ✅ | account 级冷却 + `provider-fallback-routing.test.js:7-28` |
| B14 | codex 跨账号 400 invalid_encrypted_content | ✅ | 剥离预防(`codex-adapter.js:402-406`)+ 兜底换号(`upstream-failure-policy.js:601-616`) |
| B15 | store:false 引用历史 item 404 | ⚠️ | 反应式恢复有;**无预防性剔除 previous_response_id** |
| B16 | 发起 chat 未返回会话 id | ✅ | `session-created` 先于 thinking(`webui-chat-routes.js:1350-1367`) |
| B17 | 完成后 thinking 必须可查看 | ✅ | 折叠保留(`EventBlock.tsx:81,92-94`) |
| B18 | 刷新后模型回退(历史成功模型优先) | ✅🔧 | 本次修复,见第一节 #2 |
| B19 | 新会话误报"缺少项目路径" | ✅ | `session-surface-policy.ts:36` + `legacy-composer-submission-policy.js:19-20` 门控 |
| B20 | 会话页白屏 | ❓ | 历史 bug,未复核 |
| B21 | `aih kimi` Native CLI not found 反复弹安装 | ⚠️ | 入口已注册(`contracts/providers/manifest.json:990`);**装完重解析失败即 exit(1)**(`pty-runtime-run.js:197-201`),检测路径仅增强 `~/.local/bin` |
| B22 | 账号列表 list/card 切换缺失 | ✅ | `Accounts.tsx:288,2280-2284` |
| B23 | 按钮/字号不符设计规范 | 🔧 | 点状修复(ModeSelector/顶栏);系统性迁移未完成 |
| B24 | UI 不统一(圆角/颜色/下拉/操作) | ⚠️ | 全局 antd 覆写在(`App.css:55-135`);页面 CSS 硬编码量大 |

### 6.3 设计类(5 条)

| # | 需求 | 状态 | 证据 / 缺口 |
|---|------|------|------------|
| D1 | 全面吸收 dsh + 直接抄 HOS 6 四特征(光影/圆角/毛玻璃/胶囊律动) | ⚠️ | 持续演进;地基 token 在,业务落实率低 |
| D2 | HOS 必须 6.1 版本 | ⚠️ | `docs/harmonyos6-dsh2-design-specification.md` 按 6.1 编写;落实同上 |
| D3 | 先定设计规范(8 级字阶/色系)并确认,再落地 | ⚠️ | 规范文档+`design-tokens.css` 在;**全站 `--hos-text-*` 仅 1 处业务引用 vs 274 处硬编码 font-size(8 个 CSS 抽查),落实率 <1%** |
| D4 | 手机/PC 两套 UI,覆盖所有页面 | ⚠️ | chat 页双端在;全页面覆盖未完成 |
| D5 | 全站每元素鸿蒙化(按钮/label/下拉/动画/间距/颜色) | ⚠️ | 用户评"1% 都不到";与 D3 同源 |

### 6.4 流程类(9 条)

| # | 需求 | 状态 | 备注 |
|---|------|------|------|
| P1 | 每轮产出必须 aih codex/claude 带需求+结果双 review | ➖ 剔除 | **非 aih 产品需求**:loop 验收门禁,2026-09-01 用户裁决剔除(见第十节) |
| P2 | 自维护进度追踪文件(功能矩阵+TODO) | ➖ 剔除 | **非 aih 产品需求**:该会话工作方式要求;产物已存在(`docs/dsh-harmonyos-evolution-matrix.md` + 本文档) |
| P3 | loop 15min→8min | ➖ | loop 已停,不适用 |
| P4 | 汇报必含【已完成】/【待交付 TODO】 | ➖ | loop 纪律,随 loop 停止 |
| P5 | 所有 UI/功能改动必须 Playwright 双端实测(PC 1440×900/移动 390×844,0 报错 0 溢出) | ⚠️ | 本次修复均做了 PC 端实测;移动端 390×844 未系统执行 |
| P6 | 组件化模块化;能重写就重写,严禁批量替换小聪明 | ⚠️ | 工程纪律,持续遵守 |
| P7 | 像素级 review | ⚠️ | 验收标准,需逐页截图对照 |
| P8 | loop 至少 10 个 subagents 并行 | ➖ | loop 纪律;本次审计已按此精神执行(4+6 并行) |
| P9 | 穷举全部需求逐条对比 todo/doing/done | ✅ | 本节即交付物 |

### 6.5 状态汇总(截至第六节审计时)

- ✅ 已闭环:20 条(F1/F3/F4/F5/F7/F9/F13/F14/F15/F18 + B2/B4/B8/B13/B14/B16/B17/B18/B19/B22 + P2/P9,含 🔧 5 条)
- ⚠️ 部分完成:18 条(F2/F6/F8/F10/F11/F16/F19/F20/F21/F22 + B3/B7/B10/B11 小缺口/B12/B15/B21/B24 + D 类 5 条、P5/P6/P7 — 按最高严重级归并后约 18 条)
- ❌ 未实现:3 条(F12 自动进化、F17 三栏同屏、P1 review 门禁)
- ❓ 未复核/无法判断:5 条(B1/B5/B6/B9/B20)

## 七、Wave 1-3 并行补救记录(2026-08-31 下午,3×5 路 subagent)

> 方法:按文件归属切分原子任务,每波 5 路并行;每波后统一 build+eslint+测试门禁。全量 `npm test` 最终 61 个 `not ok` 与 HEAD 基线**逐字节一致**(全部为既有失败,零新增);bun test web 391 pass / 3 fail(与基线一致)/ 0 error。

### 7.1 状态变更表(相对第六节)

| 条目 | 原状态 | 新状态 | 证据 |
|------|--------|--------|------|
| B3/B10 首 token 前缓冲 | ⚠️ | ✅ | `webui-chat-routes.js:388-430` `createPreFirstTokenBuffer`(TTL 2.5s/20 条兜底直写);`test/webui-chat-first-token-buffer.test.js` 4 项过 |
| B11 token 指标持久化 | ⚠️ | ✅ | `buildChatTurnMetrics`(`webui-chat-routes.js:437-453`)持久化 outputTokens/inputTokens/tokensPerSec;`test/webui-chat-turn-metrics.test.js` 4 项过 |
| B12/F16 canonical running | ⚠️ | ✅ | `TimelineItemView.tsx:52-57` 按 status 推导 running 传入 ThinkingBlock |
| F19 840px | ⚠️ | ✅ | `chat.module.css:1600` `--chat-content-width: 840px`,13 处引用核查协调 |
| F15 StatsLine 粘性 | ⚠️ | ✅ | `.statsLineContainer` sticky + hos 毛玻璃 token 分层 |
| F21 虚拟列表 | ⚠️ | ✅(节流) | `raf-scroll-sync.ts` rAF 合并(100 次 scroll=1 次 setState,测试 4 项过);**遗留:500 条聚合 <5ms 基准测试未做** |
| F20 跨 Tab 同步 | ⚠️ | ✅ | SESSION_PINNED 广播+订阅闭环(`ProjectList.tsx:105-121`)、THEME_CHANGED 接收端;`cross-tab-session-sync.test.ts` 5 项过。注明:MODEL_CHANGED 刻意保持 Tab 本地(既有设计) |
| B15 store:false 404 预防 | ⚠️ | ✅ | `codex-adapter.js:362-378,396-409` 出站剥离 previous_response_id + unpersisted item ids;3 项测试过 |
| F8 加密思考链 | ⚠️ | ✅(策略最优) | 携带加密内容时硬优先粘性账号(`codex-adapter.js:420-429,1268-1286` + `account-selector.js:140-151`),必须换号才剥离;5 项测试过。注:上游不支持解密注入,此为可达最优 |
| F10 OAuth→APIKey 回退 | ⚠️ | ✅ | 策略偏好 `preferRetryAuthType`(`upstream-failure-policy.js:656-670` + `account-selector.js:160-177`);7 项测试过 |
| B21 kimi CLI not found | ⚠️ | ✅ | 检测落点扩至 6 类目录(`kimi.js:95-113`),装后失败打印诊断+PATH 建议不再沉默 exit;5 项测试过 |
| B7 zcode 文案 | ⚠️ | ✅ | `webui-chat-routes-utils.js:80-85` zcode 特判文案;4 项测试过 |
| B5/B6 列表为空/衔接断裂 | ❓ | ✅ | `canonical-session-directory.ts` 状态机化:key 变化保留旧数据标 stale、失败保留+UI 提示条+重试、空 queries 两态区分;6 项测试过 |
| B9 重复 user 消息 | ❓ | ✅(复核确认) | 双层去重早已在(`message-history-policy.ts:38-50` + `webui-chat-routes-opencode-proxy.js:57-67`);补服务端测试 3 项过 |
| B1 attachRunId | ❓ | ✅ 关闭 | 全仓+git 历史无此符号,报错源已消除,无法复现 |
| B20 白屏 | ❓ | ✅ | 新增全局 `AppErrorBoundary`(`app.tsx:158-161` 挂载);3 项测试过 |
| F17 Work 三栏 | ❌ | ✅ | `WorkbenchColumns.tsx` 三栏+分隔条拖拽+宽度持久化,移动端 <768px 回退标签页,终端 PTY 保活;16 项测试过。遗留:xterm 拖拽时 refit 滞后(需 ResizeObserver)、左栏 Sessions 页签未加 |
| F6 api-proxy 在途恢复 | ⚠️ | ✅ | api-proxy run 注册入 store+快照,`/chat/runs` 带 mode/contentSnapshot,刷新恢复 pending 气泡+watch 补齐;服务端 4 项+前端 2 项测试过 |
| F12 自动进化 | ❌ | ✅ | `scripts/evolution-scan.js` 盲区扫描器(解析矩阵/追踪文档状态标记→排序产出 nextActions,JSON+Markdown);9 项测试过 |
| P1 review 门禁 | ❌ | ✅ | `evolution-scan.js review` 子命令:需求+结果+证据组装标准 prompt,`--provider both --execute` 调 aih codex/claude;纪律条款写入 `dsh-harmonyos-evolution-matrix.md:13-27` |
| D3 字阶落实 <1% | ⚠️ | ⚠️(大幅推进) | **455 处硬编码 font-size 全部迁移到 `--hos-text-*`(var 带原值兜底,渲染零变化;非字阶值就近归级+注释),全仓 0 残留、token 引用 458 处**。遗留:圆角/间距/色系的硬编码迁移未做 |
| F22 离线 PWA 会话缓存 | ⚠️ | ✅ | `session-offline-cache.ts`(localStorage+版本号+容量守卫:目录 8 份/300 条、消息 30 会话/尾部 200 条、配额淘汰重试);列表与消息离线回退只读展示+UI 标注;11 项测试过 |
| B23/B24 按钮字号/UI 统一 | 🔧/⚠️ | ⚠️ | 随 D3 字阶迁移大幅改善;色系/圆角统一仍欠 |
| P5 双端实测 | ⚠️ | 见 7.2 | Playwright 实测结果见下 |

### 7.2 验证汇总

- 新增测试:node --test 10 个文件 51 项全过;bun test 新增 6 个文件;web 全量 391 pass / 3 fail(与基线逐条一致:zcode-egress×2、message-metrics-format×1,均时钟敏感既有 flaky)
- `npm run build` 每波后均通过;eslint 全部改动文件 0 错误
- Playwright 双端实测(2026-09-01,截图存 `output/playwright/acceptance/`):
  - PC 1440×900 `/ui/chat`:0 console error;ModeSelector 32px/13px;`--chat-content-width: 840px` 实测生效
  - 移动 390×844:0 水平溢出(scrollWidth=390)、0 console error
  - Work 三栏:PC 三栏同屏 + 分隔条拖拽持久化实测通过;移动端回退标签页;**实测发现 1440 下三栏被钳到最小宽拖不动 → 已将 MIN_COLUMN_WIDTH 降为 160/320/280(`workbench-layout-policy.js:15`),16 项布局测试更新后全过**
  - 字阶抽查:8 个 token 全解析,实测元素渲染值与档位一一对应
  - accounts/settings/dashboard 三页快查无样式崩坏
  - 观察项(未处理,记录):移动端深链 `/ui/chat?sessionId=…` 停在列表屏不直达详情(疑似双屏轮播既定行为,待用户确认);`var(--hos-text-caption, 11px)` 归级行渲染 12px 为预期(token 值优先),注释仅表兜底原值

### 7.3 剩余遗留(均已记录在案,非本次范围)

1. ~~500 条消息聚合 <5ms 性能基准测试未写(F21 尾项)~~ 已补:`stats-line-aggregation.ts` 抽纯函数 + `stats-line-aggregation.test.ts` 基准断言 <5ms(3 项过)
2. ~~Work 三栏:xterm 拖拽 refit 需 ResizeObserver;左栏 Sessions 页签~~ Wave4 已补,见 7.4
3. ~~圆角/间距/色系硬编码的 token 化(D3 第二阶段)~~ Wave4 已做,见 7.4
4. ~~`web/src/types/index.ts` ChatMessageMetrics 缺 `inputTokens` 声明~~ 已补(types/index.ts:1378)
5. ~~`chatAPI.listActiveRuns` 返回类型未加 `mode/contentSnapshot`~~ 已补(api.ts:1517-1524),hook 交叉类型已收敛
6. ~~既有 61 个 node 测试失败~~ Wave4 已修复(根因:合成图像模型污染目录证据),见 7.4;3 个 bun flaky 仍在
7. F2/D1/D2/D4/D5 属"持续朝 dsh/HOS 6.1 演进"的无边界长期需求,可量化内核(字阶、双端、三栏、规范文档、圆角/间距/色板)均已落地

## 八、Wave 4 清零记录(2026-09-01,6 路并行)

### 8.1 功能性遗留

- **xterm 拖拽 refit**:`terminal-refit.ts`(rAF 合并)+ ShellTerminalPanel ResizeObserver;5 项测试过;实测拖宽右栏 292→372px 时 `.xterm-screen` 275→354px 即时跟随
- **左栏 Sessions 页签**:`sessions/SessionsPanel.tsx` 复用 canonicalDirectory 数据,只读列表+点击切换;实测三页签 [文件|变更|Sessions] 在位
- **移动端深链直达**:`chat-mobile-deeplink.ts` + Chat.tsx 一次性 effect;实测 390px 深链直达详情屏,0 溢出

### 8.2 设计 token 全量迁移(D3 第二/三阶段)

- design-tokens.css 新增间距阶梯 14 档(`--hos-space-*`)+ 色板 25 色(`--hos-ink/blue/orange/red/green/amber/gray/surface-dark/white`)
- **border-radius 209 处**、**padding/margin/gap 约 1200 分量**、**色值约 240 处**迁移完成,全部 `var(--hos-*, 原值)` 兜底,非阶梯值就近归级+行尾注释
- 残留(有意保留):负 margin 6 处、calc 内部 4 处、有机形变百分比 1 处、色板外精确色值约 100 处(等设计裁决是否扩色板)、rgba()/旧 token 体系(var(--app/*--m/*--radius-*) 别名)未动
- 已知归级渲染漂移 2 处(实测):ModeSelector 容器 padding 3→2px、气泡尾角 4→8px——属归级本意,如不接受可单独回调

### 8.3 既有 61 个测试失败修复(W4-F)

- 总根因(59/61):合成图像模型(`gemini-*-flash-image` 等)被当作"已探测目录证据"写入 `model-capability-index.js` 与 `model-account-index.js`,导致健康账号被误判 503 `no_available_account`。修复:合成项只进正向路由,不进目录证据;对外模型列表边界同步过滤(gateway-model-list/fabric-descriptor/webui-openai-model-routes)
- 测试过期(1/61):`server.http-utils.test.js` zcode 回退用例改写为现行有意行为(JWT 失效定向报错)
- 另有 1 个 fabric e2e 随索引修复转绿
- **终验:全量 `npm test` 6314 tests / 6307 pass / 0 fail / 7 skipped(既有)**

### 8.4 验证汇总

- `npm run build` 通过;bun test web 419 pass / 3 fail(既有 flaky  trio,未变);eslint 0 错误
- Playwright 复测(w4-* 截图):PC 四页 0 error 无崩坏;1440 三栏拖拽恢复;移动端深链直达;间距/圆角 computed style 与迁移前一致

## 九、交叉复核与 Wave 5(2026-09-01,三路复核 + 三路修复)

### 9.1 复核方法

三路独立复核:①不依赖既有产物从头重提取(发现关键盲区——大量用户消息在 `queue-operation` 记录而非 `type==user`)②存疑项回原始 JSONL 结案 ③assistant 承诺 TODO 与矩阵对比。

### 9.2 矩阵补录(新增编号)

| # | 需求 | 出处 | 状态 | 证据/结论 |
|---|------|------|------|----------|
| B25 | kimi WebUI 显示"需要登录"(L10294/L9954 半句) | queue-op | ✅ 关闭 | 当时仅证明后端健康未定位 UI 根因;本次核查 `account_state` 两 kimi 账号均 `up`,L2297 手动置 down 无残留,现行代码 auth_invalid→reauth_required 展示链路正确,历史状态无法复现 |
| B26 | chat 页面半屏空白(L12096) | Image#26 | ✅(当时已修) | ProLayout 100vh 继承链,commit `6c519393`,本次补录 |
| B27 | kimi no_available_account 复发(L12354) | Image#28 | ✅(当时已修) | `loadKimiServerAccounts` availableModels 默认 [] 误判,L12385 注入默认模型列表,本次补录 |
| B28 | Image#12 opencode 500 诊断+报错人性化(L2198) | — | ✅(当时已修) | 判为上游免费层 500;`humanizeUpstreamError` 嵌套 JSON 去壳,commit `77559401` |
| B29 | ModelUsage 配色(Image#29 L12363) | — | ✅(当时已修) | 死黑→鸿蒙流光蓝;后续 `61931fde` 又增强暗色 ECharts |
| F23 | `@` 文件引用接真实文件树(L3880/L3969) | 助手 TODO | ✅(本次补接) | **原为零消费方假完成**且组件内 fsAPI 方法名/响应形态两处错误;本次新增 `use-file-reference-candidates.ts` + MessageArea `@query` 检测/键盘导航/挂载;4 项测试 |
| F24 | 动态壁纸色彩萃取引擎(L8399/L8546) | 助手 TODO | ✅(本次补接) | **原为零消费方假完成**;本次 Settings 增"外观个性化"卡片 + app.tsx 启动恢复 + global.css 壁纸图层;2 项测试 |
| F25 | AudioWaveformPlayer/VideoPlayerCard 接入(L4223/L5269) | 助手 TODO | ❌ 待立项 | 组件完整但消息模型无音频/视频附件载体,接入需先立"多模态附件消息通道"数据层 |
| F26 | SessionBranchGraph 分支树接入(L10689/L12041) | 助手 TODO | ❌ 待立项 | 组件完整但 fork 不持久化、无分支数据源,需先立"分支会话持久化"数据层 |
| P10 | Web Lint 清零(原"56 项"承诺,L8350) | 助手 TODO | ✅ | `npx eslint src` 41 errors → **0 errors 0 warnings**(30 死 import/3 死 props/5 死变量/1 可选链/1 不可达块 106 行) |
| P11 | 大文件哨兵/provider 拆分纪律(L9730) | user 原话 | ✅ | `evolution-scan.js` 新增 150KB 预警/200KB 超标哨兵(实测已捕获 chat.module.css 153KB 预警);纪律条款入矩阵文档第 4 条;4 项新测试;当前服务端最大文件 80KB 无超标 |
| P12 | review 执行器约束:aih codex 不指定账号(L8211) | user 原话 | ✅ | `evolution-scan.js review` 子命令默认即此形态 |

### 9.3 顺带修复的 HEAD 既有 bug

- `MessageArea.tsx` 重试按钮引用不存在的 `handleSend`(HEAD 即如此,umi build 不做严格类型检查未拦截)——点击重新生成必抛 ReferenceError。本次:`use-legacy-composer-actions.ts` 新增 `sendPrompt`(抽出 `submitContent` 复用,保持先清草稿再跑的时序),LegacyChatSurface 接线,MessageArea 新增 `onRetry` prop;eslint/tsc/build 全过。

### 9.4 验证汇总

- `npx eslint src` 全量 **0 errors**(基线 41)
- bun test 425 pass / 3 fail(既有 flaky trio,不变)
- 全量 node --test 6311 pass / 0 fail(W5-C 汇报口径)
- `npm run build` 通过
- 7 项组件验证为真实接入(AttachmentGallery/CommandPalette/PulseBadge/QueueDock/ImageGallery/viewMode 记忆/RTT 联动),2 项假完成已补接(F23/F24),3 项待立项(F25/F26 + 壁纸 accent 消费位)

### 9.5 当前唯一遗留

1. F25/F26 两个数据层立项(多模态附件通道、分支会话持久化)——架构级,建议单独排期
2. chat.module.css 153KB 已达大文件预警线——拆分建议列入下轮 loop(evolution-scan 已自动捕获)
3. 色板外精确色值约 100 处待设计裁决是否扩板;3 个 bun flaky 测试(zcode-egress×2、message-metrics-format×1)

## 十、需求归类修正(2026-09-01,用户裁决)

### 10.1 裁决内容

用户明确:F12、P1、P2 及 loop 相关条目(P3/P4/P8)是原 claude 会话给**自己**定的自动执行纪律,**不是 aih 产品需求**,从产品需求矩阵剔除,不再跟踪、不补课。由此:

- 6.1 表 F12、6.4 表 P1/P2 状态已就地改为「➖ 剔除」;P3/P4/P8 原已 ➖,同属剔除范围。
- 第七节 7.1 中 F12/P1 的 ✅ 补救记录(`evolution-scan.js` 扫描器/review 子命令)保留为工具史实,但**不再构成产品需求的闭环义务**;该脚本是否入库、是否扩展均为可选工具决策,与本矩阵无关。
- P5(Playwright 双端实测)、P6(组件化纪律)、P7(像素级 review)不属于 loop 专属,作为长期工程纪律保留,且已部分固化进 AGENTS.md。

### 10.2 修正后的真实遗留(aih 产品口径)

1. F25/F26 待立项:多模态附件消息通道、分支会话持久化(架构级,单独排期)。
2. chat.module.css 153KB 大文件预警拆分。
3. 设计裁决待拍板:色板外精确色值约 100 处是否扩板;D3 归级漂移 2 处(ModeSelector padding 3→2px、气泡尾角 4→8px)是否回调。
4. 3 个 bun flaky 测试(zcode-egress×2、message-metrics-format×1,时钟敏感)。
5. F2/D1/D2/D4/D5:朝 dsh/HOS 6.1 的无边界长期演进,可量化内核均已落地,持续迭代。

## 十一、Wave 6-7 持续演进记录(2026-09-01,kimi 会话主导,4+4 路并行)

> 针对 10.2 遗留清单的并行演进。两波均按文件归属切分原子任务、零交集并行;每路自带 build+eslint+单测+Playwright 门禁。

### 11.1 Wave 6(4 路)

| 任务 | 结果 | 证据 |
|------|------|------|
| chat.module.css 153KB 拆分(10.2#2) | ✅ | 拆为 10 个域 module(session-list/message-area/composer/message-bubble/file-preview/session-branch/session-diff/share-card/chat-overlays/mobile-layout),postcss 多重集比对 878 条规则拆分前后完全一致;Playwright 双端 computed style 0 差异 |
| 3 个 bun "flaky" 测试(10.2#4) | ✅ | **根因更正:非时钟敏感,是断言漂移**——`44857a69` 把 10s 内时长改为 1 位小数、`96fe4f4e` 把出口文案泛化去 ZCode,旧断言未跟进;精确对齐源码契约后 3 连跑全绿 |
| 旧 token 别名迁移(--app-*/--m-*/--radius-*) | ✅(主体) | 396 处 var() 迁到 --hos-* 带原值兜底;design-tokens.css 补语义桥接保持深色主题自适应;三页×双端 computed style 0 diff |
| D4 双端覆盖全页面审计 | ✅(审计交付) | 12 页逐页取证(截图存 output/playwright/d4-audit/);缺口分级:G1 移动端导航断层(P0)、G2 Settings 移动态裁剪(P1)、G3 studio 标题溢出(P2)、G4 fabric 统计区窄屏错位(P3);附带发现 gate 刷新竞态 bug |

### 11.2 Wave 7(4 路)

| 任务 | 结果 | 证据 |
|------|------|------|
| token 迁移收尾 | ✅ | chat 10 module 内 72 处 + 6 个 tsx 内联 16 处迁移;确认零消费方后删除 --app-*/--radius-*/--m-* 全部旧定义块;全仓 grep 双零;web/DESIGN.md 同步 |
| G1+G2 移动端导航/设置裁剪 | ✅ | MobileTabBar 第 5 个「更多」tab + MobileMoreSheet(5 低频入口,语义图标+--hos-* token);Settings 移动态放开全部 4 section;390×844 实测 5 入口全可达、0 溢出;契约守卫测试 2 项 |
| G3+G4 + 死代码清单 | ✅ | studio 标题改容器相对约束(390px 椭圆截断);fabric 统计区窄屏纵向堆叠;死代码确认:FabricNodes/FabricRemoteNodes/FabricWebrtcDiagnostics/pages-Studio 四个无路由无引用(只列未删,待用户裁决) |
| gate 刷新竞态(审计附带发现) | ✅ | 根因:gate 把运行期健康快照(degraded/offline 陈旧落盘)当 setup 完整性硬判。修复:判定维度分离(ready‖configured),native profile store 加初始化屏障;33/33 + 178/178 测试;Playwright 连续刷新 10/10 不再踢回 /server-setup |

### 11.3 修正后剩余遗留

1. F25/F26 待立项(多模态附件通道、分支会话持久化)——架构级,单独排期。
2. 设计裁决 2 项:色板外 ~100 处色值是否扩板;D3 归级漂移 2 处是否回调。
3. 死代码 4 个文件删除待用户裁决(G 任务已给清单与证据)。
4. F2/D1/D2/D4/D5 长期演进:D4 主要缺口(G1/G2/G3/G4)已清零,剩余为持续迭代。
