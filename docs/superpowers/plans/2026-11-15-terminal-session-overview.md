# Web Terminal 会话总览实现计划

目标：网页可发现并接入现有 Codex、CodeBuddy 等原生会话，默认一个可交互主窗口，其他会话实时缩略预览，点击切换且原任务继续运行。

采用用户明确指定的布局和复用 Web Terminal 的方向。仅桌面，不新增测试用例，不创建分支或 worktree，不回退并行代码。关闭原生会话的网页视图只断开网页客户端，不终止原任务。

- [ ] Go 接入：复用 persistent 会话收集器，提供鉴权的目录接口；按服务器生成的稳定标识 attach 到已存在的 tmux 会话，禁止客户端传任意 socket/命令。预览客户端使用 ignore-size，主窗口才参与尺寸计算，失焦恢复预览状态。
- [ ] 渲染：复用 ShellTerminalPanel 的单条 mux 和 xterm。抽出输出批处理与缩略窗口组件，后台窗口保持终端网格而用 CSS 缩放；输出不进入 React 状态。切换只改变角色，不重建 PTY/xterm。挂载、隐藏和缩放不抢焦点。
- [ ] 管理：增加可发现的“会话总览”入口，自动纳入服务器现有会话，支持搜索、选主窗口、重新连接、隐藏预览和保留选择。所有状态按 server 隔离，切换服务器不串会话。
- [ ] 稳定性：合并输出写入，限制无主早到帧缓存，修正切换时重复 fit 和重连时输入可用状态；页面隐藏后恢复时补齐布局，保留用户手动滚动位置。
- [ ] 真实验证：构建 Go/Web；使用现有 Edge 后台连接检查主窗口/缩略窗、连续切换、真实输入、持续输出、resize、断流重连、页面刷新、关闭视图后原任务存活。若 Edge 连接缺失，保留明确验收边界，继续可独立完成的真实 PTY/API 验证。

文件边界：Go 的 terminal API 负责会话目录和受限接入，terminalsession/pty 只暴露客户端进程身份供设置 tmux client flag；Node terminal routes 仅做协议转发。前端在 features/web-terminal 组织目录和页面，components/chat 保留共享终端运行与渲染。

2026-11-15 执行记录：接入、总览页面、切换、目录管理与输出流控代码已实现。标准 Go CLI/server 和 Node 22 Web 构建通过；Go 的终端接口及宿主编译、Windows PTY/终端接口交叉编译通过。现有 TypeScript 全量检查仍有 19 条其他模块诊断，本次修改的终端模块未出现诊断，不能称全仓类型检查通过。

隔离真实验收接入 13 个现有 tmux 会话的两个总览，共 26 个独立客户端。原进程与预览接入前尺寸一致，关闭和断开一个总览不影响另一个，重新连接回原会话，普通包含 @ 的会话 key 仍可关闭。正式 9527 的 11 个原生会话接入、控制状态切换、真实 shell 输入/resize/持续输出和关闭验证通过。生产自启动 C locale 会改写 tmux 输出的控制分隔符，已改用 ASCII 分隔符，并在同语言环境和正式服务验证控制状态全部返回 200。

正式入口为 `http://127.0.0.1:9527/ui/terminals`。服务 `/readyz`、账号接口、目录接口和页面入口返回 200。恢复的五个 Codex 中四个继续追求原目标，一个目标已完成；shalou 会话发生上下文耗尽后已原地 compact 并恢复目标。CodeBuddy 原会话可发现，既有目标已报告完成。

真实证据目录：`/Users/model/.ai_home/run/aih-terminal-overview-20261115/`，关键文件为 `live-pty-acceptance-final.json`、`production-pty-acceptance.json`、`production-health.json`、`restored-codex-status.json`、构建日志和 `typecheck.log`。这些是直接连接真实生产处理器/PTY/正式服务的运行结果，没有新增测试用例。

待验收：已有 Edge 的 Playwright 扩展连接超时，已请求用户接通，尚未获得连接。主窗/缩略窗实际视觉、连续切换流畅度、中文输入法、焦点、页面刷新和滚动位置需要继续在现有 Edge 中验收；不得把上述构建和 API 结果当作页面验收完成。

2026-11-15 追加稳定性修复：真实单核调度的 PTY 持续输出复现了订阅溢出后仅保留 mux 心跳的失流，原进程仍能输入。Go 现在识别无正常退出帧的订阅中断，关闭网页传输以触发恢复；普通无 sessionKey 的终端以已有 termId 重新绑定。修改后的同场景一次断开、一次重连即收到后续输出，原进程未替换。证据 `single-cpu-burst-before.json` 与 `single-cpu-burst-after.json`。

早到输出不再按 128 帧截断，改为记录正在进行的接入、按容量暂停读取；移交 xterm 后再释放缓存压力。真实 PTY + 实际 xterm 解析器验证 1,043 帧早到输出、5,000 行全部有序保留，并核对 pending 暂停→xterm 接管→恢复的顺序，证据 `real-xterm-pressure.json`。此验证没有浏览器 DOM，不替代 Edge 页面验收。

接入响应增加连接代次与实例请求序号，旧响应不能覆盖新连接。关闭与重新接入在 await 后核对实例身份；同 native key/mux 的当前实例保护可能被新请求复用的客户端。仍需在 Edge 中实测快速切换、断网恢复及页面离开/返回。
