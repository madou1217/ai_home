# 终端能力回复污染草稿：原因、修复与真实验收

记录时间：2026-11-17，Asia/Shanghai。修复提交：`ec0da819299062f18217f303b288d6aacb2dbcfd`。

用户报告的 `>0;276;0c`、`?2026;2$y`、`?1;2c` 确实可以由终端协议回复进入输入链路产生。本轮复现了旧运行时的污染，修复了 WebUI/Go 传输和 CLI 换号草稿两条路径，并验证了当前本机服务。没有新增测试文件或运行单元测试；验收使用真实 HTTP、PTY、tmux、SSH 和现有 Microsoft Edge。

当前本机 Go 和新构建前端已验证生效。已经运行的 Node CLI wrapper 不会热更新草稿观察器，需在其下次正常启动时加载修复；没有为激活补丁而中断共享任务。既有草稿中的历史污染没有被自动删除。

## 1. 字符串来自哪里

这些字节通常带有不可见的 `ESC [` 前缀，是终端回答能力查询的回复：

| 可见部分 | 协议意义 |
| --- | --- |
| `?1;2c` | Primary Device Attributes（DA1） |
| `>0;276;0c` | Secondary Device Attributes（DA2） |
| `?2026;2$y` | DECRQM 对 synchronized output mode 2026 的状态回复 |

xterm 的 `onData` 同时承载按键、粘贴和自动回复。多个查看器、重新订阅和输出回放都可能再次生成回复。如果只把这些事件作为普通输入转发，回复就可能进入 CLI 的草稿或命令行。

依据包括本机安装的 xterm 6.0.0 源码、[xterm Terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/)、[VT 支持表](https://xtermjs.org/docs/api/vtfeatures/)。

## 2. 已确认的根因

**第一条路径：Go pending 没有有效期。** 旧 guard 能拦截完整的重复回复，但 pending 只是布尔状态。当前使用 tmux 3.8，其初始能力查询约五秒后结束等待；如果浏览器的第一次回复在六秒后才到，旧 Go 仍认为它是合法首次回复并转发，tmux 已不再将其作为握手消费，最终字节进入 pane 输入。

**第二条路径：只按单次 Write 做正则。** 重复回复被拆成多个 HTTP 输入请求后，每个请求都不包含完整 CSI，旧 guard 无法识别，拼回来的字节进入 pane。

**第三条路径：CLI 换号草稿独立记录 stdin。** `pty-runtime-run.js` 在转发 stdin 前调用 `switchDraft.observe`，正常且及时的能力回复也会被观察器记录。换号时 `take()` 的内容直接写入新 PTY，绕过 WebUI 的分类和 pending 校验，旧握手回复因而可能作为草稿重放。

tmux 的具体时限和重复回复处理已对照 [3.8 tty.c](https://raw.githubusercontent.com/tmux/tmux/3.8/tty.c) 的查询计时器，以及 [3.8 tty-keys.c](https://raw.githubusercontent.com/tmux/tmux/3.8/tty-keys.c) 的 DA1、DA2 和 synchronized output 回复解析。六秒延迟和碎片重复的污染也在旧 Go HTTP → 真实 tmux → 原始输入记录器中重现，不只是源码推断。

## 3. 修复如何生效

1. 前端保留每段输入的 `protocol` 分类，只合并相邻且分类相同的队列项；API、Node adapter、Go handler 将分类完整传递到 PTY 服务。普通输入为 `false`，机器回复为 `true`；未带字段的旧客户端保留兼容路径。
2. Go 对本地 durable 和 SSH 会话使用四秒的能力回复窗口，为 tmux 的五秒期限留出余量。没有待答查询、重复或过期的三类回复会丢弃；后续真实查询可以重新打开对应能力的回复槽。
3. 机器回复流由独立模块跨请求合帧，处理碎片和非法前缀，并限制未完成帧的缓存。普通输入不进入该状态机，Escape、方向键、UTF-8 和粘贴不会新增等待。
4. 输出仍原样透传，并在本地、SSH 和直接 PTY 中观察新查询。直接本地程序保留自己的回复时限，合法的六秒晚回复不会套用 tmux 的期限。
5. 每会话写入锁与全局锁分离；等待一个繁忙 PTY 不占用服务全局锁，未新增自动写入器。
6. CLI 草稿观察器在非括号粘贴状态跳过完整的三类回复；括号粘贴中的相同字节和正常文本继续保留。

修改仅涉及以下九个文件：

- `internal/runtime/terminalsession/protocol.go`
- `internal/runtime/terminalsession/protocol_input.go`（新增的机器回复合帧模块）
- `internal/runtime/terminalsession/service.go`
- `internal/transport/http/webuiterminalapi/handler.go`
- `internal/transport/http/webuiterminalapi/sessions.go`
- `lib/cli/services/pty/switch-draft.js`
- `lib/server/webui-terminal-routes.js`
- `web/src/components/chat/terminal-input.ts`
- `web/src/services/api.ts`

未修改 Provider 行为、tmux 生命周期、页面布局或共享终端的草稿内容。

## 4. 全量终端检查与观察结果

扫描遍历当前用户 `/private/tmp/tmux-501` 中的 socket，逐个调用 `list-panes`，只读抓取每个 pane 的完整历史和当前屏幕，统计三类可见模式。失效 socket 单独记录，不视为仍运行的窗口。管理 API 的会话列表也做了交叉检查。范围是这台开发机当前用户可枚举的终端，未据此推断其他机器或不可访问的系统终端。

最初扫描时间为 11 月 16 日 18:16:13：六个有效 socket、19 个 pane，其中三个出现污染。调查期间后续扫描发现 21 个用户 pane，其中六个包含对应模式。CodeBuddy 的计数从 2/2/0 变为 3/3/0，另外三个 Codex pane 各有 1/1/0；这说明调查前半段并非所有终端都已停止增加。

最终扫描时间为 11 月 17 日 00:58:53：排除本轮两个验收 pane 后，六个有效用户 socket、21 个用户 pane，其中六个保留历史模式。它们与 00:28:14 的对应 21 个 pane 相比计数全部相同；00:50:36 → 00:52:34 的中间两轮也未观察到增长。

| 历史模式所在 pane | `0;276;0c` | `?2026;2$y` | `?1;2c` |
| --- | ---: | ---: | ---: |
| Claude `p-ai_home-1z0bk3-mvrpesos-104k` | 26 | 25 | 19 |
| CodeBuddy `p-ai_home-1z0bk3-mwf7bgl7-1ybb` | 3 | 3 | 0 |
| Codex `p-ai_home-1z0bk3-mwgb3afl-8st` | 1 | 1 | 0 |
| Codex `p-ai_home-1z0bk3-mwge8h3g-1kpg` | 1 | 1 | 0 |
| Codex `p-ai_home-1z0bk3-mwgeka4m-1rd5` | 1 | 1 | 0 |
| Codex/Shalou `p-shalou-bnsgl6-mwgjen16-1yi2` | 5 | 5 | 4 |

计数是屏幕/历史中的模式次数，不是后台协议事件计数，也不能据此判定每次历史出现的注入时刻。没有给用户 pane 注入清屏、退格或重启操作；旧草稿和历史内容继续保留。此前一次进度统计把本轮浏览器验收 pane 算入普通 pane，曾报告 22 个；最终根据准确 socket 归属修正为 21 个用户 pane。

## 5. 真实验收

证据目录：`/Users/model/.ai_home/run/terminal-reply-repair-20261116/`。目录内包括私有运行环境，未加入 Git，也不应整体分享其中的配置、数据库或 SSH 材料。下列 JSON 只记录验收结果或会话元数据。

| 验收路径 | 观察结果 | 证据文件 |
| --- | --- | --- |
| 旧 Go HTTP → tmux | 六秒首次回复、逐字节碎片重复均把三类 CSI 写入 pane，成功复现 | `real-go-baseline.json` |
| 修复 Go HTTP → tmux | 及时、重复、六秒首次、逐字节碎片、碎片暂停六秒、非法前缀后回复均未把能力回复写入 pane；正常控制文本保留 | `real-go-candidate-v2.json` |
| 不带 protocol 的旧客户端 | 完整的过期和重复回复被拦截 | `real-go-candidate-v2.json` |
| 直接本地 PTY | 包含三类同形 CSI 的括号粘贴、Escape、方向键、中文、emoji 原始字节保留；六秒合法 DA1 回复保留 | `real-go-direct-passthrough-v3.json` |
| 真实本机 OpenSSH → 远端 tmux | 及时、重复、六秒晚到、碎片四种情况只收到 `SSH_CONTROL中文`；远端 `durable=false` 也进入 guard | `real-ssh-tmux-v3.json` |
| CLI 真实 PTY → 生产 framer/草稿模块 → take | 普通草稿加三类回复后，仅保留 `草稿中文🙂 kept`；括号粘贴内的同形字节完整保留 | `real-cli-draft-v3.json` |
| 繁忙 PTY 与同时 attach | 输入请求成功，六次 attach 约 0.6–0.9ms；没有观察到全局锁停顿 | `real-go-backpressure-v3.json` |
| 原有 Edge → 实际 ShellTerminalPanel/xterm → Node 生产 adapter → Go → tmux | 自动回复携带 `protocol=true`；普通粘贴携带 `false`，中文/emoji 到达 pane；合法 pane 查询产生回复，之后额外重复回复计数未增加 | `edge-acceptance-private-build.json`、`edge-acceptance-current-build.json`、`edge-duplicate-final.json` |
| 当前共享服务 9527 → 新建自有 tmux pane | 六秒首次回复和逐字节重复均只收到 `LIVE_FINAL_CONTROL中文🙂`，验收 pane 随后关闭 | `real-shared-runtime-final.json` |

额外说明：

- tmux passthrough 的第一轮单独脚本存在初始握手尚未完成的时序，不能将该轮称为 pane 恰好一次成功。后续新查询的完整 DA1 已到达 pane；Edge 的真实查询链路中，每轮三类回复各记录一次，再发送重复回复后计数不变。
- tmux 的原始输入记录器会消费握手回复，因此没有把其粘贴用例称为“任意 CSI 均逐字节到达”；逐字节保留的结论来自直接 PTY 和 CLI 括号粘贴验收。
- 背压验收没有等待 240KB 输入逐字节收完，仅用于观察并发 attach 和写入请求是否停顿。
- CLI 验收调用生产草稿模块的 `take()` 并检查待重放字节，未对真实 Provider 执行换号，也未消耗真实账号请求。
- Edge 通过现有扩展连接，在本轮自有页面后台验收。当前构建的普通输入通过实际 xterm 实例的 `Terminal.paste` 触发；本轮后台 DOM 按键没有到达 `onData`，未将其报告为当前构建的键盘验收成功。账号列表等外围数据使用空数据夹具，终端组件、adapter、Go、PTY、tmux 均为真实实现。
- 真实桌面截图 `edge-terminal-current-build.png` 已检查，终端为正常连接状态，没有新增大块告警容器或粗左侧装饰条。

构建/静态检查：`go build ./internal/runtime/terminalsession ./internal/transport/http/webuiterminalapi`、两个修改 JS 文件的 `node --check`、限定修改路径的 `git diff --check` 均通过。前端使用 Node 22 运行 `web/scripts/build-locked.cjs`，Webpack 编译完成并生成新 dist；没有新增或运行测试套件。

独立只读审查已核对最终源码及报告中的原始 JSON，未发现本轮三类能力回复路径的新确定性阻断问题，也未发现报告的确定性错误。审查特别复核了 21 个用户 pane 的归属和稳定计数，以及旧 CLI 未热更新、未执行真实 Provider 换号等交付边界。

## 6. 本机生效状态与交付边界

00:57 观察到当前本机 Go 为 PID 59695，00:44:09 启动，其二进制 SHA256 为 `7e45232a6ebe4676b83825ef81bf3bd0567e04d8241b5ec7e343f8cb29099000`。该进程由共享发布链路替换，未由本轮单独重启；通过 9527 的最终真实 HTTP 验收确认所需行为存在，不仅依赖源码或符号判断。

本轮前端构建完成后，`http://127.0.0.1:9527/ui/chat` 返回 `/ui/umi.824a925f.js`，HTTP 内容与构建文件字节一致，SHA256 为 `d47c2dce639b7863884f16689d963ed646c8eb4b0cc5957f1bca37feffa83aec`。新加载页面已使用协议分类；长期开着的页面需要重新加载新产物。共享工作区同时存在其他会话的工作，本轮没有把整个运行时宣称为无脏文件的单提交构建。

源码提交 `ec0da8192` 为九文件、161 行新增/33 行删除。使用一次性临时索引和显式 pathspec 提交；前后主索引 SHA256 一致，未带走其他会话的暂存内容。最终逐文件比较确认九个源码文件与该提交字节相同。

首次 `git push origin main` 普通和提权重试均失败：SSH 配置依赖的 `127.0.0.1:6153` SOCKS 代理未监听，HTTPS Git 代理 `6152` 也未监听，直接连通性检查也未通。用户补充 AWS 验收位置后，重新按当前 `ssh_connections` 定位到 `54.178.88.80`，通过已配置主机的命令级 SSH `-W` 跳转成功推送。01:13 前后已用 `ls-remote` 核对远端 `main=0ec5086881ff2179d4d7ceec2d92e5ef23584352`，包含源码和首版报告。此前误试的 `yesboss` 指向旧新加坡主机，不能用于判定当前日本 AWS 不可达。没有修改全局 Git/SSH/代理配置、重写历史、回滚并行代码或创建分支/worktree。

本轮创建的私有 Go、SSH 服务、验收 tmux 和浏览器页已按精确身份关闭，证据文件保留。现有 Edge 和用户终端保留。

以下限制必须保留，不能承诺全量热更新或任意延迟下绝不再现：

- 已运行的 Node CLI wrapper 仍持有旧 `switch-draft` 模块；在其正常结束并重开前，旧草稿重放路径不能视为已热激活。没有清空已有草稿，也没有自行重启业务终端。
- 四秒窗口从 Go 观察查询时开始，是针对当前 tmux 五秒等待的保守策略；不能保证任意 SSH 延迟或底层 PTY 阻塞后抵达 tmux 的时间。远端统一采用该策略，包括远端回退为非 tmux shell 的情况。
- 不带来源字段的旧客户端只兼容完整回复过滤，不能无损区分任意碎片中的人工输入与机器回复；应加载新前端完成分类传输。
- native CLI 仍使用既有 framer 的 30ms Escape/2s 序列缓存时限；本轮没有声称 native 任意延迟碎片均已覆盖。
- 新机器帧缓存上限为 1024 字节；超过上限的 OSC/DCS 不属于透明传输承诺。当前页面没有启用 OSC52 或长标题回复处理。
- 本轮约半小时的稳定观察是当次证据，未安装常驻全局监控，也不是永久无复发保证。

## 7. 用户补充后的 AWS AGY 真实验收

用户明确 AGY 在 AWS，应连接 AWS 验收。本轮据当前数据库中的 `AWS Current Japan` 配置连接 `ubuntu@54.178.88.80`，使用已有 `~/.ssh/aws.pem`；没有因为本机缺少 AGY 账号而结束该项。

### 环境与范围

- 远端实际安装 `/home/ubuntu/.local/bin/agy` 为 **1.5.9**，SHA256 `39816d49d5ab92229952987225c23ea3fed7580699dcb4a444e0388e0ac1ce43`，tmux 为 **3.6**。非交互 SSH 的默认 PATH 不含 `.local/bin`，最初 `command -v agy` 为空不等于未安装。
- 只读查询确认远端 **8 个 AGY 账号均启用**。原有 AGY pane `p-hud-carbon-20261117-01a1e527` 和另一个 Web pane 均未发现三类模式；01:09:22 → 01:23:29 的对应计数保持 0。
- 实际运行单元是 `com.meadeo.ai_home`，`active/running`、MainPID **341399**；旧 `aih-server` unit 为 inactive，不能据此误报 AWS 业务停机。现有 AIH 来自 `/home/ubuntu/.ai_home/pkg/1.0.0-linux-x64-90e1c928`，该包中的草稿模块仍是旧版。本轮没有升级远端发行包或重启正式服务。
- 在远端 `/var/tmp/aih-terminal-agy-647052dc9254` 创建自有 HOME、空项目和独立 socket `aih-reply-agy-647052dc9254`，使用第一个启用账号的最小文件凭据副本；凭据始终留在 AWS，未复制到 Mac 或写入报告。复制了既有配置/已完成 onboarding 标记，没有为验收重新接受数据收集选项。

### 真实操作与结果

| 操作 | 实际路径与结果 | 证据 |
| --- | --- | --- |
| 认证和模型目录 | 官方 AGY 在隔离 HOME 成功拉取目录；选用返回的 `gemini-3.8-flash-low` | `aws-agy-private-models.log` |
| 协议污染和草稿保持 | **本机当前 Go 9527 → 生产 Go SSH key-file → AWS tmux 3.6 → 官方 AGY 1.5.9 TUI**。累计 73 次机器回复 HTTP 请求，覆盖过期完整回复、重复完整回复、逐字节碎片。输入 `AGY_DRAFT中文🙂` 后再发回复，前后仍为该草稿，三类模式均为 0 | `aws-agy-injected-replies.json`、`aws-agy-repeat-injection.json`、`aws-agy-real-draft-before.json`、`aws-agy-real-draft-after.json` |
| 官方 stream-json 实际推理 | `--print` 收到 init、step_update、最终 result；结果 `SUCCESS`、response `AGY_AWS_OK`、exit 0。用量 input 8857、output 6、total 8863，未执行工具 | `aws-agy-inference-summary.json` |
| 同一个真实交互终端发送一轮 | 在自己的草稿完成前后检查后，通过正常输入清除该验收草稿并提交 `Reply exactly AGY_TERMINAL_OK. Do not use any tools.`；屏幕出现独立回答 `AGY_TERMINAL_OK`，随后回到空输入提示符，三类污染计数仍为 0 | `aws-agy-real-tui-turn.json`、`aws-agy-real-tui-turn.log` |
| 原有会话与正式服务 | 仅只读观察原有两个 pane，无计数增长。清理后正式服务仍 active、MainPID 341399 | `aws-agy-pane-baseline.json`、`aws-agy-pane-final.json`、`aws-agy-cleanup-verified.json` |

AGY 交互界面同时显示 **Sign-in update needed**，提示账号缺少新版要求的部分权限。该轮确实返回了回答，但不能推广为该账号所有权限都健康；没有执行 `/logout` 或替用户重新授权。

本轮 AWS 的 Edge 可视验收没有完成：原有扩展连接的操作持续等待，定位到共享 daemon 下还有其他会话的页面操作；已通知其 owner，只取消了本轮自己的 CLI 请求，未重启共享 daemon、切换浏览器、抢焦点或使用 AppleScript。上述 AWS TUI 结论来自真实 tmux 屏幕和实际 Go HTTP/SSH 操作，不冒充 Edge 截图验收。

结束时精确关闭本轮 Go SSH attachment 和自有 tmux server，确认没有 HOME 指向本轮目录的 AGY 子进程后移除自有临时 HOME，包含复制的凭据、身份文件和会话数据库；非凭据验收记录保留。原有两个 AWS pane、账号库、已安装 AGY/AIH 及正式服务未被替换。

这补齐了**远端真实 AGY 的终端输入、草稿保持及最小模型请求**证据；未覆盖远端旧 AIH 包的补丁升级、真实账号切换重放、Go WORK/Capture 全链路或 AWS Edge 可视验收。它们不能借本轮结果标为完成。
