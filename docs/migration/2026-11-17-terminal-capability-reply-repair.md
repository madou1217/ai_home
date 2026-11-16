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
6. CLI 草稿观察器在非括号粘贴状态跳过三类回复；第 10 节进一步补齐超过 stdin 合帧时限的 CSI 分片，括号粘贴中的相同字节和正常文本继续保留。

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
- 本节的 CLI 初轮验收调用生产草稿模块的 `take()` 并检查待重放字节，当时未对真实 Provider 执行换号，也未消耗真实账号请求；第 8 节补充了后续 AWS 实际换号及取出/重放字节对照。
- Edge 通过现有扩展连接，在本轮自有页面后台验收。当前构建的普通输入通过实际 xterm 实例的 `Terminal.paste` 触发；本轮后台 DOM 按键没有到达 `onData`，未将其报告为当前构建的键盘验收成功。账号列表等外围数据使用空数据夹具，终端组件、adapter、Go、PTY、tmux 均为真实实现。
- 真实桌面截图 `edge-terminal-current-build.png` 已检查，终端为正常连接状态，没有新增大块告警容器或粗左侧装饰条。

构建/静态检查：`go build ./internal/runtime/terminalsession ./internal/transport/http/webuiterminalapi`、两个修改 JS 文件的 `node --check`、限定修改路径的 `git diff --check` 均通过。前端使用 Node 22 运行 `web/scripts/build-locked.cjs`，Webpack 编译完成并生成新 dist；没有新增或运行测试套件。

独立只读审查已核对最终源码及报告中的原始 JSON，未发现本轮三类能力回复路径的新确定性阻断问题，也未发现报告的确定性错误。审查特别复核了 21 个用户 pane 的归属和稳定计数，以及旧 CLI 未热更新等交付边界。初轮审查时未执行真实 Provider 换号；后续 AWS 实际换号对照见第 8 节。

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

本节补齐了**远端真实 AGY 的终端输入、草稿保持及最小模型请求**证据；当时未覆盖远端旧 AIH 包的补丁升级、真实账号切换重放、Go WORK/Capture 全链路或 AWS Edge 可视验收。后续真实换号重放对照见第 8 节，其余边界继续保留。


## 8. AWS 真实换号与重放字节对照（02:00 补充）

此前仅检查 CLI 草稿模块的待重放内容，本轮补做真实 AGY 账号 1 → 2。为保护原有终端和正式服务，复制远端已安装的 AIH 包到 `/var/tmp/aih-terminal-switch-23786a82b6d6/package`，并创建自有宿主 HOME、空项目、tmux socket 和最小账号库。仅选择两个启用账号的必要记录及凭据，凭据始终留在 AWS；未复制远端约 700MB 的整库、旧会话历史或第三个账号。最初未复制 CLI 数字别名，导致快捷键提示无可切换账号；补齐独立库的两条别名后再进行对照，未改变正式账号配置。

本项明确直接调用复制包中的 Node CLI 组合根，覆盖本次修复的 **legacy stdin framer → switchDraft → Ctrl-Alt-A → spawnSwitchedProcess → scheduleDraftReplay → 新 AGY PTY**，不是把它当作当前所有 Go CLI 入口的替代证据。验收入口只包装导出函数，记录真实 `take` 结果及 `write` 调用的原始字节；没有替换选号、启动、草稿处理、调度或官方 AGY 实现。旧版与修复版间仅替换私有包内的 `switch-draft.js`，正式包文件哈希保持不变。

| 真实操作 | 旧版私有副本 | 修复版私有副本 |
| --- | --- | --- |
| 输入 `SWITCH_DRAFT中文🙂`，再发送 DA1/DA2/2026 三类完整回复，触发 Ctrl-Alt-A | 实际从账号 1 换至账号 2，官方 AGY 以 `--continue` 启动 | 同样实际换至账号 2，`/proc` 中新 AGY HOME 指向账号 2 的私有投影 |
| `take()` 真实取出的字节 | 括号粘贴草稿后附带三类回复，各一次 | 仅保留括号粘贴草稿，三类回复计数均为 0 |
| 调度器真实写入新 PTY 的字节 | 与 `take` 相同，确实重放了三类回复 | 与 `take` 相同，确实排除了三类回复 |
| 新账号提交真实模型请求 | 初始账号请求已收到独立回答 `AGY_SWITCH_SEED`，换号后续接该对话 | 新账号实际返回独立回答 `AGY_SWITCH_FIXED_OK`，随后回到输入框，三类屏幕模式均为 0 |

对应原始结果：`aws-switch-baseline-traced-result.json`、`aws-switch-fixed-result.json`、`aws-switch-fixed-turn-result.json`。汇总：`aws-switch-acceptance-summary.json`。

必须区分两个结论：本轮证明了**真实换号时，修复模块不再把机器回复存入并重放到新 PTY**；没有证明新 AGY 一定自动恢复可见草稿。旧版和修复版的自动重放均发生在新 AGY 输入框就绪前，观察到的最后输入框为空，因此没有把包含旧画面的全历史抓取误报为恢复成功。等新 TUI 就绪后，手动向该自有终端发送修复版记录的完全相同字节，屏幕准确出现 `> SWITCH_DRAFT中文🙂`，三类模式为 0。这是额外的字节/渲染验收，不冒充自动重放成功。重放就绪判定沿用现有逻辑，本轮没有扩大修改范围。

02:00:36 清理后，独立 wrapper/AGY 进程为空，自有 tmux server 已关闭，自有宿主 HOME（包括最小账号库、投影凭据和新增会话）已移除。原有两个 AWS pane 仍存在，三类计数均为 0；`com.meadeo.ai_home` 仍 active/running、MainPID 341399，正式 `switch-draft.js` SHA256 仍为 `3fffafa58b48f240915deeec55c43b41b7909462e0d91cf5d13810e95ae9019b`。证据：`aws-switch-cleanup.json`。

本轮续查时本机未发现正在运行的 Microsoft Edge 主进程，两套已安装 Playwright CLI 的 `list` 均返回 `(no browsers)`。未为补齐截图启动浏览器，因此 AWS Edge 可视验收仍未完成。


## 9. AWS 完整 Linux 候选包验收（02:19 补充）

从已推送的固定提交 `83d7c2db069da62509bdc6934bcd452d4a0de740` 用 `git archive` 准备只读来源的构建副本，没有创建 branch/worktree，也没有使用共享索引中的内容。前端使用 Node 22.21.0 的锁定构建，发行包使用规范 `scripts/package/build-release.js --targets linux-x64 --node-version 22.21.0`；Go Server、Go CLI、Node、生产依赖和 WebUI 均随包生成。源码归档不含两个空目录，补建归档副本内的 `examples`、`native` 后，规范发行构建退出 0；没有修改仓库构建脚本。

| 产物信息 | 实测值 |
| --- | --- |
| 单文件启动器 | `aih-1.0.0-linux-x64.run`，121839776 字节 |
| 启动器 SHA256 | `9f7784638f28cb19e31cc808a426a603c48a661c9d5a52f24daed1966bae483a` |
| `BUILD_INFO.source_sha` | `83d7c2db069da62509bdc6934bcd452d4a0de740` |
| Go Server SHA256 | `3a317d29d431c6c39950f31d6c0c8f9c6a637eb2c16e354df002ad4dbfe1ac47` |
| Go CLI SHA256 | `34503bc9e83d3c8d5db051bb1adfb553f415e2025b42286be766f03129a69bb3` |
| 草稿修复模块 SHA256 | `df49288edf34e40a0e884fa4a457943184e5cdcb54b5fb6f02b2c2f8329368cc` |

将启动器上传 AWS 的 `/var/tmp/aih-terminal-candidate-49623487e51f/aih-candidate.run`，先比对完整 SHA256，再由启动器自身解包至该目录的 `packages/1.0.0-linux-x64-bb7e54fc`。实际启动包内 Go Server，使用回环端口 19543、自有空 HOME/数据库，并监督启动同包 Node；未导入正式账号或凭据。`/healthz`、`/ui/chat`、两种前缀的终端会话接口均 HTTP 200。`/readyz` 为 HTTP 200、`ok=true`、`ready=false`、所有账号数为 0，与其“至少一个启用 Provider 账号才 ready”的源码语义一致；没有将空库候选服务报告为具备真实推理就绪证据。

- **tmux 3.6 → 原始 Linux PTY：** 等待 6.2 秒后，通过真实 `/v0/webui/terminal/input` 的 Node adapter 发送 18 个完整、重复、分片及未带 `protocol` 字段的协议请求。pane 中三类模式均为 0；随后普通输入中的 Escape、四个方向键、中文、表情和标记文本逐字节等于预期。经 Go 接口关闭自有会话后，其独立 socket 已停止。
- **直接 Linux PTY：** 程序实际输出三类查询后等待 6.2 秒，首份合法回复逐字节到达；再次发送完整和分片重复回复，接收内容不增加。之后 `protocol=false` 的括号粘贴包含相同三类字节及中文表情，全部原样保留。没有将 tmux 的期限错误套用于直接程序。
- **前端产物：** AWS 候选 `/ui/chat` 实际引用 `umi.a26938dc.css` 和 `umi.7d254ccf.js`；HTTP 资源分别为 719227、6918925 字节，与包内文件完整字节相同。此为资源生效证据，AWS 浏览器可视验收仍未完成。

02:19:11 候选清理后，自有终端列表和进程列表均为空，私有 HOME、数据库和随机管理密钥文件已移除，候选包/启动器及非凭据验收记录保留。正式 `com.meadeo.ai_home` 仍为 active/running、MainPID 341399，旧包模块哈希未变，原有两个 AWS pane 均保留且三类模式计数为 0。

另在本机持续只读扫描：01:50:57 → 02:17:42 的 21 个用户 pane 身份完全相同，没有新增或退出，三类模式总计始终为 36/35/23，逐 pane 均未增长。该轮对照使用自己的起始快照，不混用第 4 节更早一轮中已退出的 pane。

原始证据：`aws-release-build-retry-result.json`、`aws-release-artifacts/aih-1.0.0-manifest.json`、`aws-candidate-package-verification.json`、`aws-candidate-health.json`、`aws-candidate-terminal-result.json`、`aws-candidate-direct-result.json`、`aws-candidate-assets-and-formal-launcher.json`、`aws-candidate-cleanup.json`；汇总为 `aws-candidate-acceptance-summary.json`，本机观察为 `all-panes-continuation-summary.json`。

本节所述旧候选正式部署仅完成规范 artifact-only 命令的 `--dry-run`，没有执行；第 10 节补漏后此包已撤下，须以包含后续补漏的新包重新验收。现存 systemd 单元从 `/home/ubuntu/.local/bin/aih server serve --host 127.0.0.1 --port 9527` 启动；`/usr/local/bin/aih` 和 `~/.local/bin/aih` 都仍指向旧包。若批准正式升级，具体范围为：以包含第 10 节补漏且重新验收的新启动器替换 `~/.local/bin/aih`、由规范发布脚本重装/重启该用户单元，保留 `/usr/local/bin/aih` 当前指向 `~/.local/bin/aih` 的链接，并复核其随之解析到新启动器；保留旧包，并在修改前保存两个原软链接的精确目标和原 systemd unit；失败时显式恢复原链接、原 unit，执行 daemon-reload 并重启原单元。规范脚本的 `aih.prev` 仅复制旧链接所指文件，不能单独恢复原链接，因此不把它作为目录包的完整回退机制。升级后复查包哈希、正式 HTTP/鉴权终端链路及原有两 pane。重启会短暂断开 WebUI/网关连接；既有 CLI wrapper 不会因包替换自动热更新。用户本次补充授权为连接 AWS 测试，故正式服务替换和重启保留为最后的明确确认步骤。

02:22 补充：已在 AWS 自有候选目录 `formal-preupgrade-backup/` 保存原 unit 的私有副本和两个软链接目标清单，未修改正式入口或单元；本机仅保存低敏清单与 unit SHA256。证据：`aws-formal-preupgrade-rollback-preparation.json`。


## 10. 超过 stdin 合帧时限的 CLI 分片补漏（02:37 续查）

继续检查修复生效边界时，发现 `terminal-input-framer.js` 在两秒后会原样放行未完成的 CSI；此前草稿过滤依赖它交付完整序列的假设并不总是成立。这是同一污染路径的剩余漏洞。在自有真实 tmux PTY 中，用 `send-keys -H` 精确发送三类回复的前后半段，段间等待 2.35 秒，实际生产 stdin framer → 草稿观察器 → `take()` 的结果仍含完整三类回复，各一次。证据：`cli-slow-fragment-before-hex-input.json`。早一轮 `send-keys -l` 的分号传输不准确，未用于该结论。

本次仅补强 `lib/cli/services/pty/switch-draft.js` 的观察状态：保存最多 1024 字节的未完成 CSI，后续闭合后再识别能力回复，不新增定时器，也不修改实时 PTY 转发、stdin framer 时限、选号或重放调度。单独 Escape 仍立即取消，回车/Ctrl-C/Ctrl-D 仍清草稿与解析尾部。`take()` 不重放半帧；保留其识别状态以过滤迟到回复，并标记半帧已属于上一份草稿，避免以后把旧的非回复 CSI 前缀重新回放。若跨边界闭合为括号粘贴开始标记，完整保留开始/正文/结束包络，防止正文换行失去字面保护。

相同真实 PTY 验收路径、相同字节和相同 2.35 秒间隔再次操作，修复后三类回复计数均为 0，`FRAGMENT_DRAFT中文🙂` 的完整括号粘贴字节与预期完全相同。证据：`cli-slow-fragment-after-hex-input.json`。

另以自有真实 tmux stdin、生产 framer 和生产草稿观察器检查 12 个边界结果，全部逐字节一致：跨 `take()` 的能力回复迟到尾部、非回复 CSI 旧前缀、Ctrl-C/回车清除、独立 Escape、方向键/SS3/Alt/退格/UTF-8、含能力回复和控制字符的字面粘贴、超长非回复，以及跨 `take()` 完成的粘贴开始标记。验收命令仅以 Ctrl-] 旁路记录真实 `take()` 返回值，没有替换模块实现。自有 socket 均已关闭；`node --check` 通过，没有创建测试文件或运行测试套件。证据：`cli-slow-fragment-boundaries.json`。

该补漏不声称覆盖 Escape 自身间隔超过既有 30ms 判定的任意拆分，或任意慢分片的括号粘贴结束标记；不改变已有自动重放就绪判定，也不将第 8 节未证明的可见草稿恢复标为成功。独立 Escape 和非能力键仍按现有语义处理。

第 9 节的 `83d7c2db0` Linux 包不含本节补漏，已从正式升级候选中撤下；其验收作为历史记录保留。正式升级需使用本节修复提交重新构建并在 AWS 验收的包，仍等待用户对正式服务替换和重启的明确确认。
