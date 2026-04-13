# 当前会话 Web UI 验收清单

更新时间：2026-04-13

说明：
- `[x]` 代表当前代码与本轮已执行的定向回归可以确认已完成。
- `[ ]` 代表仍未完成，或必须依赖真实账号 / 真实客户端 / 真实浏览器环境手工验收。
- 这份文件是当前会话的统一验收清单；旧文档只作参考，不再作为最终验收入口。

## 一、已完成并已验证

- [x] Web UI 已补统一缓存基础层，项目 / 归档 / 账号不再全部走“请求时同步全量扫盘”。
- [x] SSE 已收敛到公共广播层，项目运行态、账号增量、会话增量不再各自散写监听逻辑。
- [x] Codex 配置同步已抽成共享实现，账号默认切换与 PTY 运行时不再各写一套 `config.toml` 逻辑。
- [x] AIH Codex provider 配置块生成已统一，修复了 `model_provider` 与 `[model_providers.aih]` 容易丢失的问题。
- [x] 普通 API Key 模式不再无条件伪造 `http://127.0.0.1:8317/v1`，避免错误退化成伪 `aih` provider。
- [x] `.codex-global-state.json` 已接入项目路径线索读取，Web 项目发现能力比之前更完整。
- [x] Codex `config.toml` 与 `.codex-global-state.json` 里的 workspace roots 已并入 Web 项目列表，即使暂时没有新 session 文件也能显示项目。
- [x] 仪表盘与账号管理页已接入统一的 usage remaining 数据来源。
- [x] API Key 模式账号统一按无额度显示处理，不再伪造 remaining 数值。
- [x] Codex 用量快照支持 `5h` 与 `7days` 窗口数据结构。
- [x] Gemini 用量快照支持按模型维度展开显示。
- [x] 账号类型字段已落到 `planType`，支持 `team / plus / free / api-key`。
- [x] remaining 展示已恢复为水平 progress bar，而不是纯数字 label。
- [x] 项目列表已改为单路 `/webui/projects/watch` 聚合运行态，不再为每个会话单独开监听。
- [x] Web 已支持按会话维度同时跟踪多个运行中的会话。
- [x] 切换会话时不再自动中断当前运行中的其他会话。
- [x] 会话级 provider icon 已支持稳定旋转运行态。
- [x] 项目折叠时，项目名右侧 provider icon 会按 provider 维度显示旋转运行态。
- [x] 项目展开时只保留会话级运行态 icon，不再重复做项目级旋转。
- [x] 已归档会话入口固定在项目列表底部。
- [x] 会话选中状态已持久到 URL，刷新后可恢复焦点。
- [x] Web 轻量 `thinking` 尾部状态已落地，在没有 assistant 锚点时也会给出反馈。
- [x] Web 已避免把纯 `thinking` 渲染成新的独立 assistant 会话消息。
- [x] assistant 流式事件已按 `thinking -> delta -> done` 合并到同一条消息链路。
- [x] 队列已按会话维度独立存储，不再混到单会话单流模型里。
- [x] Codex OAuth 会话支持 `after_tool_call` 队列模式，其他 provider 默认为 `after_turn`。
- [x] `TodoWrite` 已支持解析并挂到输入框上方工作区。
- [x] `Plan` 已支持解析并挂到输入框上方工作区。
- [x] 输入框上方 `Queue / TodoWrite / Plan` 已统一为同一组工作区。
- [x] Web 发消息支持携带图片。
- [x] Web 发送图片后会持久化到聊天附件目录，并可通过附件接口回放。
- [x] 消息图片已限制为较小缩略图尺寸，可通过预览放大查看。
- [x] 会话消息读取已保留 Codex 用户图片输入。
- [x] Web 打开项目和 Codex 原生会话发送前，都会把 `projectPath` 注册到宿主 `~/.codex/config.toml` 的 `[projects."..."]`。
- [x] 真实 Web 文本消息已验证会落到 `~/.codex/sessions/.../rollout-*.jsonl`，且 server 重启后仍能重新出现在项目列表。
- [x] 真实 Web 图片消息已验证会落到 transcript 读取链路，`readSessionMessages` 能读到带 `images` 的 user message。
- [x] Web 原生新建 Codex 会话完成后，会等待 transcript 可读再刷新项目快照，避免“完成事件早于持久化”导致的新会话丢失竞态。
- [x] Codex 归档会话扫描已保留 `projectPath` 元数据，减少 App / Web 归档视图之间的项目来源信息丢失。
- [x] 浏览器通知权限请求与完成通知逻辑已落地。
- [x] Codex host 全局配置已写入 `codex_hooks = true`。
- [x] Codex Stop hook 脚本已自动安装到宿主 `hooks`。
- [x] Stop hook 已接入 `beep` 提示逻辑。
- [x] 当前机器已验证 `hook: Stop` / `hook: Stop Completed` 会在完成态触发。
- [x] `aih server start` 已支持非阻塞后台启动路径。
- [x] `aih server restart` 已支持先快速 stop 再快速后台 relaunch 的路径。
- [x] assistant 头像已外置到独立 gutter。
- [x] assistant 消息内容、轻量 `thinking` 行、输入框上方工作区、输入框本体已统一到同一内容轨道。
- [x] 用户消息仍保持右对齐，不破坏现有阅读节奏。

## 二、已完成但仍需手工验收

- [ ] 用真实 `plus / free / team` 账号逐个核对 Web 展示是否和实际额度完全一致。
- [ ] 用真实 Gemini 多模型账号核对展开后的模型用量是否全部正确。
- [ ] 手工验证“切换会话时不会误终止另一个正在运行的会话”。
- [ ] 手工验证“其他客户端触发的运行态，Web 侧也能稳定感知并旋转显示”。
- [ ] 用真实 Codex 会话验证 `thinking -> tool call -> answer` 全链路视觉衔接。
- [ ] 用真实 Claude 会话验证“thinking 不与最终 AI 消息并存卡住”。
- [ ] 用真实 Gemini 会话验证 `thinking / Queue / TodoWrite / Plan` 都能收到并正确渲染。
- [ ] 手工验证“Web 发出的消息在 Codex App 重启后不会丢失或闪退消失”。
- [ ] 手工验证“Web 发图后在 Codex App / 多端同步界面里都稳定可见”。
- [ ] 手工验证浏览器通知在真实会话完成时会触发。
- [ ] 手工验证本机真实重启耗时是否恢复到可接受范围。
- [ ] 手工验收桌面端最终视觉对齐。
- [ ] 手工验收移动端最终视觉与滚动体验。
- [ ] 手工验收移动端 AI 消息隐藏头像后的整体可读性与字号观感。
- [ ] 手工验收输入框上方 `Queue / TodoWrite / Plan / Thinking` 共存时的层级、间距、折叠与滚动表现。

## 三、明确未完成 / 未闭环

- [ ] 统一验收后再决定是否继续做“基于 `.codex-global-state.json` 的 `project-order / active-workspace-roots` 真正参与项目列表排序”。
- [ ] 账号性能优化还未完成最终收口，目前只是缓存基础层与异步广播层已落地，仍需继续做大账号量实测与慢路径消除。
- [ ] 账号列表极端多账号场景下，“先秒开基础列表，再异步补 usage / metadata / runtime” 的最终体验仍需补实测与细节收口。
- [ ] `thinking` / `tool-call` / `pending` 的 provider 适配虽然已有抽象收敛，但还没有达到“三端真实行为完全对齐”的最终验收状态。
- [ ] `after_tool_call` 当前只对 Codex OAuth 开启，Claude / Gemini 还不能假设存在同等级可靠边界事件。
- [ ] `function_call_output` 仍不能被当作稳定增量消息直接拼接，相关体验只能走 snapshot 回退，不应误判为已彻底解决。
- [ ] 手机版浏览器下拉回弹 / 滚动异常仍需继续专项验收。
- [ ] 手机端弹窗问题仍需继续专项验收。
- [ ] Codex App 归档项目与 Web project 的同步问题，这轮还没有重新完整闭环验收。
- [ ] 项目列表与会话列表的历史丢数据 / 不同步问题，这轮还没有重新完整闭环验收。
- [ ] 近期改动后的接口并发性能尚未做系统压测，不能宣称已达到多人并发目标。

## 四、本轮已执行的定向验证

- [x] `node --test test/webui-sse-broadcaster.test.js`
- [x] `node --test test/web-ui-router.chat.test.js`
- [x] `node --test test/web-ui-router.accounts.test.js`
- [x] `node --test test/web-ui-router.projects.test.js`
- [x] `node --test test/web-ui-router.archived.test.js`
- [x] `node --test test/web-ui-router.sessions-watch.test.js`
- [x] `node --test test/config-sync.test.js`
- [x] `node --test test/host-sync.test.js`
- [x] `node --test test/cli.session-baseline.test.js`
- [x] `node --test test/ai-cli.router.test.js`
- [x] `node --test test/session-reader.test.js`
- [x] `npm run web:build`
- [ ] 全量 `npm test`

## 五、建议优先验收顺序

- [ ] 先验 Web 发消息与 Codex App 重启后的 transcript 持久化是否稳定。
- [ ] 再验 Codex / Claude / Gemini 三种 provider 的 `thinking` 视觉衔接。
- [ ] 再验浏览器通知与 Codex Stop hook 的真实完成态触发稳定性。
- [ ] 再验手机端滚动、字号、弹窗与消息布局。
- [ ] 最后再决定是否继续推进“排序增强 / 账号性能极限优化”。
