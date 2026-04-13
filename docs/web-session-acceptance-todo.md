# Web 会话与队列验收清单

更新时间：2026-04-12

说明：
- 这是 Web 会话、thinking、队列、多会话运行、项目列表运行态的最终验收清单。
- 后续实现与修复只按这个清单推进。
- 只有真实完成并验证过的项才会标记为 `[x]`。

## Thinking 与消息衔接

- [ ] 修复 `thinking / 正在思考中` 在 Web 里错误地新起独立消息块/独立会话感的问题
- [ ] 修复 `thinking` 必须挂载在当前正在进行的 assistant 消息流里，而不是额外插一块悬空内容
- [ ] 修复 `thinking` 到正式回复之间的衔接，不能闪一下消失，也不能断层
- [ ] 检查 `Claude / Codex / Gemini` 三种 provider 的 `thinking` 渲染策略是否统一抽象，而不是各写各的分支
- [ ] 检查消息解析层是否真正做成“抽象层 + 适配器”，避免后续 provider 适配继续漏细节
- [ ] 检查 Web 是否还存在“运行中会话看起来像新起了一条会话”的错误交互

## 多会话运行与队列

- [x] 确认切换会话时不会自动中断当前运行中的会话
- [x] 确认支持多个会话同时运行，而不是前端只维护一个全局单例运行态
- [x] 确认停止按钮只停止当前选中的那个运行中会话，不会误停别的后台会话
- [x] 确认运行中会话还能继续输入新需求
- [x] 确认运行中输入的新需求会进入该会话队列，而不是丢失、覆盖、串到别的会话
- [x] 确认队列消息会在当前轮完成后自动串行发送下一条
- [ ] 为队列项补齐更接近 Codex App 的交互
- [x] 队列项支持编辑消息
- [x] 队列项支持删除/关闭排队
- [x] 队列项支持“立即发送/立即介入”模式
- [ ] 只在有可靠事件边界时，实现 Codex 风格 `After next tool call`
- [ ] Claude / Gemini 若没有可靠 tool-call 边界，不要硬做假逻辑

## 项目列表与运行态

- [x] 确认会话行里 provider icon 与标题文本完全水平对齐
- [x] 确认运行中的会话在项目列表里有明显运行态，不只是一个几乎看不出的细图标
- [x] 确认运行中的会话行显示 `进行中` 等明确状态文案
- [x] 确认项目折叠时，如果该项目某个 provider 有运行中会话，则右侧对应 provider icon 旋转
- [x] 确认项目展开后以具体会话行的运行态为主，不重复制造冲突视觉
- [ ] 检查项目行、会话行、归档入口、按钮之间的整体视觉对齐和层级是否统一

## 底部与归档入口

- [x] 确认 `已归档的会话` 入口稳定吸附在侧栏底部
- [x] 确认项目列表滚动再长，归档入口也不会漂移
- [ ] 确认移动端下归档入口和安全区、底栏不会互相遮挡

## 输入区与消息区

- [x] 确认输入区在会话运行中仍可输入，不会被错误禁用
- [ ] 确认队列区域、任务区域、图片预览区域、输入框之间的层次与间距正确
- [x] 确认运行中消息详情不会被 `pending` 分支吃掉，只剩一句“正在思考中”
- [ ] 检查 `TodoWrite / Plan / Queue / Thinking` 四块在消息区和输入区上方的共存布局是否打架

## Provider 适配与源码核对

- [ ] 重新核对 `Codex` 的会话事件流、tool-call 边界、thinking 事件
- [ ] 重新核对 `Claude` 的会话事件流和 thinking 结构
- [ ] 重新核对 `Gemini` 的会话事件流和 thinking 结构
- [ ] 把三者差异收敛进统一适配层，而不是继续在 UI 里到处写 if/else
- [ ] 对照仓库源码实际能力，标明哪些行为是真支持，哪些只是 UI 近似实现

## 测试与验证

- [x] `npm run web:build` 通过
- [x] `npm test` 通过
- [x] 给本轮新增的前端关键交互补自动化测试或最少可复现验证脚本
- [x] 覆盖多会话并行运行场景
- [x] 覆盖运行中继续输入并入队场景
- [x] 覆盖 thinking 不新起独立消息块场景
- [x] 覆盖项目折叠态 provider 旋转场景
- [ ] 覆盖底部归档入口固定场景
- [x] 解决 `web lint` 当前不可用的问题，补齐前端校验链
- [x] 再跑一次全量回归，确认没有把旧功能带崩

## 当前已知事实

- [ ] 当前统一队列语义仍未完全收敛
- [ ] 当前还不是完整稳定版 `after next tool call`
- [x] 后端已有运行中 native session 的继续写入能力：`/webui/chat/runs/:runId/input`
- [x] Codex 在当前仓库里有 `assistant_tool_call` 事件基础
- [ ] Claude / Gemini 暂未确认存在同等级、可安全复用的 tool-call 边界事件

## 当前部分进展说明

- [x] `web lint` 已补上 `eslint.config.js` 并完成规则收口，当前已可通过
- [x] Codex 队列已开始接入 `assistant_tool_call` 边界注入，但还没有达到“完整稳定可验收”的程度
- [x] `MessageArea` 已收口一处独立 pending 来源：当只有 `watchPending / externalPending` 且没有真实 assistant 挂点时，不再凭空追加一条 synthetic assistant 消息
- [x] `thinking` 拼接逻辑已收口到共享 helper，并修复连续 thinking chunk 被错误拆成多个块的问题
- [x] 队列状态已抽成共享 reducer helper，并补上“继续输入会入队 / tool-call 边界出队 / draft run 迁移到真实 run key”的自动化覆盖
- [x] 项目运行态已抽出共享 helper，并补上项目级 running provider / 会话显示窗口的自动化覆盖
- [x] assistant live 消息流已抽出共享状态机 helper，并补上 `thinking / delta / tool / result / done` 的自动化覆盖
- [x] session 事件与 stream 事件已开始收敛到 adapter 层，不再由 `Chat.tsx` 直接散写全部 assistant 状态转移
- [x] active run 命中逻辑已抽出共享 helper，并补上 draft session / persisted session / 并行运行 key 推导的自动化覆盖
- [x] 项目折叠态 provider 旋转逻辑已抽成共享 helper，并补上折叠/展开下 badge 旋转状态的自动化覆盖
- [x] 已新增 provider 事件矩阵文档：`docs/web-provider-event-matrix.md`，把 Codex / Claude / Gemini 当前源码中已确认的事件能力与禁止假设的点写成事实表
- [x] provider capability / pending policy / provider meta 已抽成共享 helper，并补上队列模式、external pending、归档标签颜色与名称的自动化覆盖
- [x] 队列项已补“立即介入/立即发送”动作：运行中会先置顶并停止当前轮，空闲时会直接发送该条队列消息
- [x] Web 已补单路项目级运行态流：`/webui/projects/watch`，不再为每个会话单独打开 EventSource，避免拖死 `projects` 请求
- [x] 项目列表运行态已支持聚合外部客户端的会话文件更新，不再只依赖当前页面本地发起的 run
- [x] 输入框上方 `TaskDock / QueueDock` 已合并成统一工作区栈，队列项改为内容区 + 操作区分层布局
- [x] Web 已补轻量 `thinking` 尾部状态：在还没有真实 assistant 挂点时，也会在消息区底部显示 `正在思考中`，避免长时间无反馈
