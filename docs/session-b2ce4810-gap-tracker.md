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
