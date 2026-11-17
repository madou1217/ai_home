# R1 本地 WORK：AIH Node 宿主缺席的真实业务验收

> Owner `01a1d99a`；原 W0–W6 的 R1 节点。实际执行日期 **2026-11-17**（Asia/Shanghai）。本次是生产 Go 构件与真实 CLI/API/文件操作，不是新测试用例、mock、fixture 或又一份平行规划。

## 1. 本轮实际做了什么

已从 committed source 冻结并构建私有 server，不启动 AIH Node server 宿主，也不配置 Node frontdoor/base URL；用已有真实 Claude 静态 API-key 账号执行：

**create → list/catalog → send/SSE → 只重启私有 Go → native resume → cancel → approve allow/deny → cancel pending approval → delete sessions / cleanup。**

这把此前“本地 WORK 已迁 Go”从源码审查和部分成功，推进到**没有第一方 Node server 宿主仍成立的具体业务链**。没有新增第二套业务实现，也不需要为了该链路再运行 Node chat/session/approval actor。

**边界：不是整个 Go 服务零 Node 进程，不是所有 WORK/全 W0–W6 完成。** 仍观察到绝对路径 Node 子进程（其中一个确定为版本探测，另一个未归因）；本次没有删除旧 Node 文件、切换公开 CLI/远端入口或改变共享部署。

## 2. 来源冻结与实际产物

| 项 | 已发生事实 |
| --- | --- |
| 固定源码 | `9c94b3ad9bfb4c9b8b99d44fd4ff4b5fcd757e87`，`git archive` committed tree，无工作区 overlay |
| Git tree | `b7111c2d3f7135bdab6d5ba1c2c65ab16b6265f1` |
| 构建 | `go build -mod=readonly -o <private-artifact> ./cmd/aih-server`，exit0；10:28:39–10:28:48 |
| 构件 SHA-256 | `57e97796ccaeb36c5ec8729a1d0f5f1087c96d70ce8a0175743d2ddc415d4020` |
| 执行后来源复核 | archive 的 **5999** 个文件逐内容相等；二进制摘要未变 |
| 实际客户端 | 本机 **Claude Code 2.1.325**，固定实际 executable；模型 `deepseek-flash` |
| 最终整链时间 | **10:36:41–10:36:57**；私有 Go PID32050→32086，loopback50577 |

本次产物在私有目录，不替换 `bin/native/*`。R0 的共享构件/stamp来源问题不阻止这条已授权隔离工程，本次也不替 R0 补写凭证或共享重启。

## 3. 隔离、授权与没有 Node 宿主的证明范围

- 从本机 `aih.db` 用 SQLite **mode=ro** 连接做 private backup，源库无写连接。只在副本中保留选定静态凭据，禁用其他账号并移除其凭据，清除旧 chat runtime 行和 app_kv，避免复制现有会话恢复、定时任务或账号/OAuth刷新。不是更改共享账号/默认配置或迁库。
- 每轮使用私有 AIH_HOME、Host HOME/XDG、项目目录及随机管理/API key；key、credential JSON、原有会话内容不输出、不进入证据文件。真实请求只用原本已授权的选定静态账号，没有登录或轮换 OAuth。
- 启动命令只有 `<private-artifact> --host 127.0.0.1 --port <private>`，**无** `--supervise-node`、`--front-door`、`--node-base-url`；白名单环境不传入共享 Node supervisor 设置。桌面翻译启动在这次 WORK 验收中不运行，不据此认证桌面域。
- 最终私有进程 PATH 为 `/usr/bin:/bin:/usr/sbin:/sbin`，`node` 在该 PATH 上不存在；官方 Claude 使用绝对路径。没有制造假 node 可执行文件或阻断后伪造成功。
- 每约150ms采样私有进程后代，只持久化安全 argv 元数据，未导出整 argv/env。观察到官方 Claude 的原生 `--resume` 和3个相同 Go 构件的 `__mcp-approve` 子进程；**未观察到 AIH Node server 宿主**。
- 同时诚实保留：观察到2个绝对路径 `/opt/homebrew/bin/node` 子进程，其中1个明确带 `--version`，另1个未完全分类；无 AIH JS script basename。`webui_warmup.go` 会预热工具箱，`toolkit/apps/versions.go` 等仍做版本／运行时探测。这些不是本次 native session/approval 的业务 owner，但本结果**不能证明整个服务已零 Node 调用/依赖**，也不是穷尽的 syscall trace。

## 4. 最终真实结果

以下全部来自同一冻结构件的最终实际操作。HTTP200/202之外，检查了终态、流事件、实际文件效果、原生ID/参数和清理。

| 动作 | 实际结果／证据 |
| --- | --- |
| Create/list | 创建201；list200，返回本次唯一会话 |
| Composer | 200；实际账号2个模型，所选 `deepseek-flash` 在目录中 |
| Send/stream | submit202；真实 SSE200 `text/event-stream`；`timeline.item.delta` 和 `turn.completed` seq18；回答匹配 `WORK_NODEFREE_OK`，idle且nativeID存在 |
| 完成后重启／原生 resume | 先确认上一轮已completed，再只停起私有Go32050→32086；同session/nativeID保留；新官方CLI进程实际带 `--resume`，原生ID仅存hash；新SSE `turn.completed` seq30；实际记住前文 `R1_NOV17_COBALT`，idle |
| Active turn cancel | 先看到activeTurn，再发 `turn.interrupt`202；SSE `turn.interrupted` seq15，idle、activeTurn清空。未宣称已证明所有 shell 孙进程的中断矩阵 |
| Allow | confirm模式真实 Bash 操作触发 `interaction.requested`；`approval.decide` allow202；恰1次决策，实际写出 private项目文件，内容严格 `R1_APPROVED`；`interaction.resolved`，turn.completed seq22，idle |
| Deny | 另一个confirm会话真实触发审批；deny202且1次决策；目标文件不存在，pending0，turn.completed seq22，idle；deny是拒绝副作用，不要求整轮变failed |
| Pending approval cancel | 确实看到pending审批后interrupt202；`interaction.expired`、turn.interrupted seq20；目标文件不存在，activeTurn清空、pending0、idle |
| 删除／资源回收 | 本次5个session DELETE均200；active runs查询为0；停止私有server后所有观察到的私有进程均不在；敏感HOME/DB/项目目录已删除 |

SSE replay/resume使用已确认的cursor；新轮终态及实际输出不以旧轮completed替代。该静态直连 native 请求不经共享推理网关，**本轮没有证明 gateway用量/费用记账**。

### 操作端纠正，不冒充产品修复

首轮实际业务已成功发送/续聊，但 operator 用了不支持的 `GET /sessions/{id}`（405）而非 snapshot，且把 canonical 审批事件误认成 `approval.requested`；由此出现了错误identity观察和未作决策的等待。这不是产品根因或新增源码修复。

随后改用真实 `/snapshot`、`interaction.requested` 与 `approval.decide`，先补跑审批，再以更严格PATH和完整安全进程元数据执行上述最终整链。首轮日志仍保留，不将错误观察抹成通过；首轮自己的pending也先interrupt/delete并完成cleanup。首轮DB binding事件及真实官方transcript仅保留identity/类型计数，不导出内容。

## 5. 可复核产物、命令与审查

- 同目录 [`evidence/2026-11-17-work-node-host-free.json`](evidence/2026-11-17-work-node-host-free.json) 为持久低敏真实结果，含source/tree/build、32个实际API/CLI操作的时间/状态、原生resume hash、Go MCP拓扑与Node限制；没有mock结果或原有用户历史。
- 本地指针 `/tmp/aih-work-nodefree-latest-20261117.txt` → manifest、`final-live-result.json`、早轮/审批补跑记录。private原始日志及含凭据DB/HOME已清理，只保留源码、构件和低敏结果。
- 实际操作命令：`python3 -u /tmp/aih-work-nodefree-final-live-20261117.py`。它直接调用冻结的生产server/已安装CLI及真实管理API，不复制生产函数做驱动；脚本不进入源码或测试集。
- 关键真实入口：POST/GET `/v1/management/webui/chat/sessions`；GET `.../{id}/composer/catalog`、`snapshot`、`events`；POST `.../{id}/commands`（turn.submit / turn.interrupt / approval.decide）；DELETE会话；GET `/v1/management/webui/chat/runs`。

本checkpoint仅收验收文档、低敏JSON和原ledger追加。提交前后使用显式pathspec、独立一次性index检查；提交后只逐blob同步本人新文档的index entry，保留其他会话的所有entry与源码。独立审查结果以最终回执为准，不把审查代理当作重新业务运行者。

## 6. 本轮关闭和仍保留的门禁

**已关闭的窄节点：**冻结已提交来源下，真实固定静态账号的本地 WORK 核心不必启动 AIH Node server 来完成上述创建、流式交付、私有恢复、取消、Go审批与清理。不是再证明“两边都有同功能”。

**没有关闭：**

- 本机AGY注册账号仍为0；AGY authenticated inference/resume、OAuth file-projection/Capture未由Claude静态成功代替。
- 全局gateway Claude、其他provider/transport、完整plan/超时/断线矩阵、UI/remote/公开CLI wrapper/host writer、正式部署与跨平台交付仍按原状态卡推进；本轮未重新验证那些历史缺口。
- 至少一个Node版本探测以及一个未归因的绝对路径Node子进程仍被观察到。不能因Node不在PATH就宣称该二进制可在彻底无Node的机器上全功能运行。
- 没有关闭旧JS入口或删除Node实现；未授权共享停服/重启/迁库/删文件。不借此修订M、Chat9、terminal/protocol的owner结论。

**下一可执行交接：**监督可把本地固定账号R1节点列为真实accepted（来源和构件限定）；本owner后续在独立声明path后承接Codex公开wrapper／条件hostwriter的Go切换。跨域warmup/remote/static与M/部署writer仍由各owner协调，不以本验收授权越界改代码。整体W0–W6仍未完成。

独立复审：Mendel对最终真实结果、operator作用域及5999文件来源做只读核对，窄结论无blocking；本卡保留其要求的四个边界：未知Node子进程不强行归因、仅completed后重启续聊、清理仅限已观察集合、没有AGY/Capture/UI/全服务零Node声明。复审未重新执行业务。

## 7. 下一独立节点实做：R1 公开 Go CLI native-direct 入口

监督于10:44要求不重复已完成的WebUI/WORK验收，因此本轮改选**公开Go CLI的固定账号直启入口**，实际经过 `cmd/aih/run.go` → `internal/host/aihcli` → `internal/runtime/providercli/runner.go` / `launch_preparation.go`，不是另跑一次chatruntime服务。此次没有发现需要改产品源码的阻碍，未扩新功能。

- **构件／命令已执行：**同一committed archive `9c94b3ad9bfb4c9b8b99d44fd4ff4b5fcd757e87`，`go build -mod=readonly -o <private-aih-go> ./cmd/aih` 成功；**10:45:01**产出CLI摘要 `aae834af7a34692bc9636194a6055abe59bbe3d6c6d763961124f51280697c23`。实际调用了其公开 `help claude` 核对语法，然后运行：

  ```sh
  <private-aih-go> claude <existing-numeric-alias> -- --print --output-format json --model deepseek-flash <own-prompt>
  ```

- **Node／RPC缺席条件：**没有启动任何AIH server；私有HOME/DB，PATH仅系统目录且无node；Gateway URL指定到随机bound但**未listen**的loopback端口，未提供管理密钥。源码中数字别名选中NativeDirect，`cmd/aih/run.go`不建Gateway账号RPC resolver，`aihcli.App.Run`也只在GatewayRelay时构造Gateway endpoint。所选真实静态账号的当前配置上游安全检查为HTTPS且非loopback，不导出URL或key。
- **10:46:14–10:46:16真实结果：**Go CLI退出**0**；官方Claude JSON `subtype=success`、`is_error=false`，实际答案匹配 **`GO_CLI_NODE_OFF_OK`**，而非只拿到help/HTTP200。stdout1675bytes、stderr81bytes仅记长度，不发布可能含客户端诊断的原文。
- **进程／caller：**观测到Go CLI PID43029 → 官方Claude2.1.325 PID43031；本次**没有观察到Node进程**、没有AIH server宿主。观察集合在完成后无剩余，私有敏感HOME/DB/项目目录删除。未触碰共享端口、stamp、草稿、迁库或其他owner路径。
- **新缺口被补到哪：**证明该Go公开native-direct入口不需要Node launcher或第一方RPC服务即可完成实际账号选择、调用和退出；这是与WebUI R1/R3路径不同的可执行入口证据。它**不代表已将 `/opt/homebrew/bin/aih` 从现有Node包装切换到Go**，没有进行安装器/包装脚本退役，也不借此关闭OAuth、TUI、取消等未跑矩阵。

本地原始低敏记录为前述root的 `cli-manifest.json`、`public-go-cli-native-result.json`，同目录JSON的 `publicGoCLINativeDirect` 保存持久派生证据。仅把新的真实操作追加到本人已有证据，未提交同义迁移卡或新的生产实现。

## 8. 获批落地：公开 Codex 指定账号 headless 单点转交

监督明确确认独占 `bin/ai-home.js::tryRunGoProviderLaunch()`；11:09:43落盘前重新核对 **HEAD/index/disk blob全部为 `382d139f9f40ada258962c0afbc0f257751ff90b`、mode100755、scoped clean**。只落一个hunk，11 additions / 5 removals，应用后SHA-256 `a1f5d9327e02ce5ccf1fe28ba31576330e679303bfae4a3bcd8f72dd8889218e` 与Hubble审过的私有candidate完全相同。

- **只认形状：**`codex + 显式数字alias + exec/e`，中间至多一个 `--`。原生后缀保持opaque，不把prompt中的 `usage/policy/login/delete` 当AIH管理词；argv原样交Go，不写第二套账号/tier算法。
- **断开的第一方Node业务调用：**命中分支不再进入 `lib/cli/app.js` → AI-CLI router 的账号/调度/PTY launch → Codex default launcher / stdio业务包装。Go是该分支的业务owner；缺Go或Go非零退出保持handled并失败关闭，不回落旧Node app。
- **明确未接管：**默认/无账号Gateway、裸TUI、管理命令、set/unset-default/mobile/Desktop effects、native全局参数在exec之前的形态、stdio/WS协议实现。没有把整个Node CLI入口替换，也没有安装器或M模块改动。

### 真正公开入口验证（非只跑复制函数）

实际运行共享工作区公开入口脚本——它仍是现有安装 `aih` 的symlink目标——及**现存**标准 `aih-go` 摘要 `cac088bb126e46453f1212c6a98f7cbfc52d9d36244b8cd1114c35f07e46ed99`，未替换标准产物。私有HOME/DB、PATH无node；仅Node bootstrap用绝对Node executable启动；指定静态Codex账号、原生0.167.2 executable，管理地址为私有未监听端口、无management key，不启动AIH server。

- **11:10:22–11:10:38**：真实 `codex <id> exec --json ...` 返回exit0、thread/turn started、item/turn completed，答案匹配 `CODEX_GO_DISPATCH_OK`。prompt含 `usage` 作为普通文字仍正确转交。
- 公开entry的 `-- e --help` exit0；不存在数字账号exit1。Node V8原生覆盖记录确认上述五个旧业务模块**全部未加载**。
- 实际caller为 **Node bootstrap → Go CLI → 官方Codex**；观察到的额外git子进程也已退出。已观察6个PID在清理复核时无剩余；私有敏感目录已删除。
- 同字节私有candidate另执行普通exec、escape-help、invalid-alias、missing-Go、seed和exact-ID resume **6条真实命令**；resume同native ID且记住前文，旧Node业务加载均为空。missing-Go通过只临时移动私有构件验证exit1和不回落；绝不移动共享二进制。公开标准Go的本轮smoke与私有candidate的resume/缺Go结果分开列，不相互借证。

Hubble独立源码/候选结果审查无blocking；`node --check`、scoped diff check通过。V8覆盖是实际loaded-module证据，不是完整network/syscall trace。**Node bootstrap仍在，不能报Node入口已退出。** 本次是一个真实默认转交分支收敛，不是又交一份迁移规划。

## 9. 两个绝对路径Node：定向分类补证与退出依据

没有重跑WORK链。使用同构件、空私有DB/HOME，定向观察Go启动的native-resources doctor warmup；新重现的两个Node命令已按源码模板重构，和实际 `ps -o args=` **输出文本（含换行）**SHA-256完全匹配：

| 新重现类别 | Go caller与真实用途 | 指纹 |
| --- | --- | --- |
| DeepSeek CLIExport | `nativeresources/runtime.go::probeSingleHost` 设置 `process.argv` 为 `@deepseek-ai/dsh/lib/bin.js --version`，ESM导入并调用 `runCli` | `291dabb85bbe8c15ff268cb5192b1736fd156ccd6ab8dd11dff929dd3c70a114` |
| Pi direct-entry | 同函数对 `@earendil-works/pi-coding-agent/dist/bundle/cli.js` 直接传 `--version` | `7e146b94acc1ef6e8366af13bdacf7de0ed2ad95f667cd475b8de20349b285e6` |

`FindNode` 会发现绝对Homebrew Node，全局package查找也不依赖私有HOME，所以PATH无node不等于这些探测不能运行。两者为**已安装第三方JS CLI的运行时/版本探测**，不是AIH Node backend或WORK actor业务。保留该第三方能力时其Node运行时要单列，不以迁移为由删除外部SDK或把其实现复制进AIH。

Mendel独立复核source、两个命令指纹和第三方包映射。旧32132/32134未保留完整argv，**仍不能事后证明旧PID的实际命令**；本节是同构件新定向重现的已分类事实，不回写旧日志为已知。`evalProgram=process.argv`只是ps文本经shlex拆出的首token，完整程序依据source重构及全命令文本hash匹配，非execve argv-vector抓取。原whole-service非Node-free边界不变。
