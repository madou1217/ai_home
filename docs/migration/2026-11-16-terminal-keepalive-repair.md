# WebUI Terminal 连接保活修复 — 2026-11-16

## 根因和修复范围

真实正式服务 `127.0.0.1:9527` 上创建一个本轮专用 keyed shell，写入环境变量后仅执行该 tmux server 的 `detach-client`。后台 shell 仍活着，但连续两次 `/attach` 返回 `404 terminal_not_found`。旧处理器遇到保留期内已退出的 PTY 客户端就直接报会话不存在，没有检查对应的持久 tmux 会话。

- `internal/transport/http/webuiterminalapi/sessions.go`：恢复接入前检查持久后台；保留旧客户端的稳定 key、目录、尺寸和 shell 元数据，兼容旧 termId 寻址。attach-only 不创建新后台；非持久客户端和 native 私有 key 不误走普通 shell 恢复。
- `web/src/components/chat/ShellTerminalPanel.tsx`：持久接入客户端退出先尝试恢复原会话；已确认原任务结束则停止重试。初始 keyed 接入遇到暂时错误持续限速重试，鉴权/容量/身份错误停止；没有稳定身份、响应未知的 unkeyed open 不自动重发，避免多开 shell。保留输入队列已有的明确 404 可重试、网络结果未知不重放约束。显式重启与后台自动恢复互斥；记录已观察到退出的客户端 ID，防止早到退出帧或迟到 attach 响应把死客户端重新标为 ready。
- `web/src/services/webui-auth-transport.ts` 和 `web/src/services/api.ts`：仅 terminal mux 启用 90 秒无任何字节的看门狗，SSE 注释心跳计入活动；网络恢复和唤醒时检查失活连接。渲染背压暂停读取不当作网络故障，关闭时释放定时器和监听器。其他 SSE 默认不启用该超时。

未添加或修改测试用例；没有改动其他并行会话的源码、暂存区、分支或工作树。独立只读审查发现并促成修复显式重启/自动恢复冲突、早到退出帧、迟到接入响应及 unkeyed 请求与连接代次变化的竞态；最终审查和运行证据边界分开记录。

## 直接运行验证

隔离服务是完整真实 Go 二进制，监听 `127.0.0.1:19527`，使用独立 AIH_HOME、真实 shell/tmux/PTy；不是假会话服务。运行证据位于 `/Users/model/.ai_home/run/aih-terminal-keepalive-20261116/`。

1. `go build -o <evidence>/aih-server ./cmd/aih-server` 成功；`go vet ./internal/transport/http/webuiterminalapi ./internal/runtime/terminalsession` 成功。
2. `real-client-recovery.json`：断开网页接入客户端后，分别按旧 termId 和稳定 sessionKey 接入成功。原 shell PID `54140`、环境变量、实际工作目录保留；旧客户端尺寸 `103x31` 继续使用。真正执行 `exit` 后返回 404，未创建替代 shell。
3. `real-server-restart.json`：仅重启本轮隔离服务，稳定 key 重新接入后原 shell PID `63731` 和环境变量保留。跨服务重启后的响应元数据使用现有默认尺寸/目录；此项不宣称元数据跨重启持久化。
4. `real-native-recovery.json`：本轮专用原生 tmux 会话通过真实目录发现，确认网页客户端已实际连上后只断开它；恢复产生新客户端，原后台 PID 不变。关闭网页客户端后后台仍活着；未知 native key 返回 404。清理只涉及本轮 fixture。
5. `real-sse-transport.json`：打包执行实际认证传输模块，通过真实 HTTP 转发连接真实 Go SSE/PTY。缩短超时观察静默半开流能重连并继续收到原 PTY 输出；online 事件触发重连；渲染背压不重连。该证据没有浏览器 DOM，不替代页面验收。
6. `real-sse-90second.json`：使用生产配置的完整 90 秒超时，持续观察约 97 秒。正常心跳连接始终 1 次连接/0 次错误，渲染暂停连接始终 1 次连接/0 次错误，网络黑洞连接在约 90 秒检测失活并完成 1 次重连。该项执行实际传输源码和真实 Go SSE，没有浏览器 DOM。
7. WebUI 使用 Node `22.21.0` 的正式 `npm run build` 成功，日志 `web-build-final.log`。默认 Node 26 的构建因旧依赖 `http_parser` 不兼容失败，切回项目现有 Node 22 后成功。
8. 生产 Umi 别名的全量 TypeScript 检查仍有三个已有错误：`active-control-plane.ts:218`、`control-plane-profiles.ts:1306,1316`。已核对 HEAD 原样存在，未改动这些文件；本轮修改文件没有诊断。不能声称全量类型检查通过。

## 尚未完成的交付边界

- 正式 9527 仍是原 Go 二进制，未替换、未重启；因此后端修复目前只在隔离服务生效。Web 构建通过仓库既有原子构建流程更新 ignored `web/dist`，不代表现有浏览器标签已刷新或后端已加载。
- 当前现有 Edge PID `20063` 的受支持连接不可用：CDP 未开放，Playwright 扩展连接报告不可发现；本机隐私控制拒绝读取 Edge profile。没有使用 AppleScript、Apple Events、其他浏览器、新开浏览器或绕过隐私限制。真实页面断网/唤醒/重启及视觉验收仍未完成。
- 本地源码 checkpoint 与推送、正式部署分开；正式服务正在承载其他会话，未更新/重启，不能把提交或隔离验证等同正式发布。

完整目标尚未闭环：仍需在有授权的安全窗口发布并重启正式后端、恢复现有 Edge 的受支持连接，再验证真实页面的启动、自动恢复和持续可交互性。

最终本轮只读审查已确认发现项修正。隔离服务与本轮 shell/native fixture 已停止并清理，正式服务 `/healthz` 仍正常。机器可读收口证据为证据目录中的 `completion-audit.json`，完整目标尚未完成；随后在同一交付阻碍连续复现三轮后已标记 blocked，见 `blocked-audit.json`。

## 同日续跑：限定正式基线的候选产物与真实代理链

正式进程仍为 PID `5919`，二进制 SHA-256 `079a565d...`；重新核对正式 build stamp 和此前已批准发布的证据，源码基线为 `85851ec39873946cd9dbb4e74de8d110adc9be47`。本轮没有把共享工作区当前的 native WORK、模型目录及其他并行改动混进候选产物。

- 在任务证据目录创建该提交的不可变普通源码归档（无 `.git`，没有新分支/worktree），仅覆盖 `internal/transport/http/webuiterminalapi/sessions.go`。对归档全部 tracked blob 和可执行模式重新比较，差异仅此一个文件；精确补丁为 `candidate-terminal.patch`。
- `release-candidate-manifest.json` 记录源基线、单文件差异、补丁摘要、构建目录、构件摘要和待授权状态。候选 canonical build stamp 与当前 package version/route manifest 校验通过；这不是已发布证明，也不声称源码基线已包含未提交补丁。
- `real-candidate-browser-path.json` 进一步使用真实 `handleWebUiTerminalRequest`、`createGoCoreHost`、管理客户端、认证前端传输模块、Go 候选二进制和 PTY；没有用假业务返回代替后端。实际 `/v0` 代理接入旧客户端成功，shell PID `95612`、环境变量和目录保持，SSE 断流后 2 次连接/1 次错误并继续输出，未鉴权返回 401，真正 shell exit 返回 404。此链路仍无浏览器 DOM，不替代 Edge 验收。
- 直接候选初次观察 `real-candidate-acceptance.json` 的环境标记为 false：当时仅等固定短延迟，命令执行结果尚未被观测到，不能支持“环境保留”结论；随后实际代理链先等待 shell 已执行的唯一标记，再断开并核对结果，以该正向观察作为环境保留证据。
- 前一默认 CGO=0 候选 SHA-256 为 `002b4888...`，运行验证已通过。随后发现正式构件 CGO=1；同日继续以正式构件相同 Go 工具链与 CGO 设置构建匹配候选，匹配构件的真实验收独立记录，不把前一产物证据挪给它。

截至候选准备时，现有 Edge 受支持连接重试仍失败，正式服务未更新/重启，源码尚未 checkpoint 或推送。已停止本轮先前候选独立进程及 shell。授权正式替换/重启和真实页面验收仍为明确的未完成项。

正式设置匹配候选 `aih-server.candidate-matched` SHA-256 为 `c30241b24296dbe0bf627413a90623cf11e86331664287366f0045ba24eb38c8`，Go `1.27.3` 和 `go version -m` 全部 build settings 与正式构件一致（CGO=1）。canonical stamp 通过，`real-candidate-matched-browser-path.json` 对这个确切 hash 再次真实验收：原 PID `1669`、环境、目录、107x32 尺寸保留，旧客户端 ID/稳定 key 均恢复；SSE 断流后 2 次连接/1 次错误且收到后续输出；未鉴权 401，真实退出 404，无替代 shell。该产物是当前选定的候选，未安装。正式 9527 健康检查/readyz 均为 200，15 个 native 会话仍可发现。

独立只读复核已对 5,952 个归档条目、源码差异/模式、正式与候选 build settings、canonical stamp、确切 hash 的实际执行输出完成验证，无候选准备/来源阻塞项。候选独立进程已停止；仍不等于正式发布或 Edge DOM 验收。见 `candidate-provenance-review.json`。

## 写集认领与本地源码 checkpoint

本终端修复会话明确拥有以下全部五个路径的本轮修改，并自行负责显式路径提交；不由监督者或其他 owner 代交：

1. `internal/transport/http/webuiterminalapi/sessions.go`
2. `web/src/services/api.ts`
3. `web/src/services/webui-auth-transport.ts`
4. `web/src/components/chat/ShellTerminalPanel.tsx`
5. 本验收文档。

提交边界采用基于当前 main 的临时索引和上述 pathspec；提交前核对 `git diff --cached --stat`/实际 staged diff，提交后核对 `git show --stat`、精确路径与 blob，并比较主索引字节摘要，确保其他 owner 的反向 diff/暂存文件未混入或被改写。不新建分支或 worktree，不 reset/rebase/amend。

当前源码提交门禁与正式发布门禁分开：Go build/vet、Node22 Web 生产构建、已有真实 PTY/SSE 验证及独立审查支持本地 checkpoint；全量 TypeScript 检查保留三个 HEAD 已有的无关错误，不能报全量通过。正式 9527 的替换/重启授权尚未收到，现有 Edge 自动化连接仍不可用，因此线上修复和真实页面验收仍未完成。代码认领与本地提交不再因这两个后续门禁而悬置。

本次提交门禁日志为证据目录中的 `checkpoint-go-build.log`、`checkpoint-go-vet.log`、`checkpoint-web-build.log` 和 `checkpoint-typecheck.log`；提交号、精确路径与主索引保留回执单独写入任务证据，不把机器运行日志或候选二进制提交入仓。
