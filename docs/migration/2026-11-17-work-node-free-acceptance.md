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


## 10. 2026-11-18 R1 后续工程：模型前缀 headless 私有候选（待 scope，不报已落地）

本轮没有重复R3或已交的数字账号紧随exec分支。只定位现有 **`codex <数字alias> [--] (-m MODEL | --model MODEL | --model=MODEL) exec/e ...`** 的一个转交点：`bin/ai-home.js::tryRunGoProviderLaunch()`。Node只识别一个模型前缀后的紧邻命令；argv仍原样交既有Go，不扫exec之后的prompt，不复制账号/凭据/model业务。没有扩大到默认、裸TUI、管理、Gateway、M/Desktop、安装器或协议。

**目前状态是私有候选已真实验证，生产源码尚未落地。** 向监督01a1df63发送精确scope申请 `pm-3f465d7e`，以及实跑结果 `pm-66b38a9f`；尚未观察到本扩展形状的scope确认。此前即刻exec的获批范围不自动扩大。共享bin核查仍为HEAD/index/disk同blob `e1db1a81ec41cfb3835c7790a5d8eb439648485f`、100755；未覆盖peer新增的CLI availability/install前置。

### 实际工程与真实结果

- 私有源码由已提交 `0ae8a37ae0779a8f0b04e4e94977150004301fa2` archive冻结；只在上述predicate修改。复审后候选bin SHA-256为 `bca11c5f532f871df13c7c48f1f648d8d6249c0d9d952d9ae60d0989a1bc412c`。
- 使用此前来源冻结 `9c94b3ad...` 构建的Go CLI `aae834af...`，两份来源明确分列，不冒充当前共享artifact验收。官方Codex0.167.2；私有HOME/DB、PATH无node，bootstrap仅绝对Node启动；管理端口预占但不listen、无management key、不启动AIH server。
- **02:41:49–02:42:04**：修正版私有公开薄壳→Go→官方Codex真实小请求exit0，观察到`thread.started`、`turn.completed`，答案 `CODEX_PREFIX_REVIEWED_OK`。prompt含usage/policy/set-default仍是文字。另`-- -m MODEL e --help`与`--model=MODEL exec --help`均exit0。
- 不存在账号与只移动**私有**Go链接的缺Go操作均exit1、失败关闭；上述5项V8覆盖均未加载旧app/router/PTY/default launcher/stdio业务模块。caller实际观察为Node bootstrap→Go→官方Codex，观察的私有PID最终0、敏感HOME/DB全部删除。
- 初次公开入口基线只证明旧Node app/router/PTY仍被加载；其失败stderr未保留，**不据此声称生产回归或确定失败根因**。另一个无凭据、空私有HOME的诊断命令因无效账号/无TTY失败，也不借用作原有效账号失败根因。

### 审查发现和保留边界

Hubble初审抓到`-m -- exec`会被Go分隔符解析变成`-m exec`、潜在误入TUI的P2。候选已改为只消费非空、非option的独立model值，inline model值也须非空；Hubble对上述新SHA复审无blocking。**不是用旧SHA实跑代替修正版验收。** 修正版随后真实执行malformed边界命令，确认没有新增Go接管；它仍加载旧Node业务并exit1，此分支明确未迁移，不宣称整个malformed/Node边界已退役。

候选diff、原/新SHA、逐操作结果、进程和cleanup进入既有evidence JSON；本节只保存新实做证据，**未把待确认候选混作已安装入口交付或共享服务发布**。Node bootstrap仍在；V8与采样进程记录不等于完整network/syscall trace。无新测试/fixture/mock、无共享restart/stamp/迁库/登录改写。


## 11. 2026-11-18 scope已直接获批：模型前缀单点落地及共享公开入口实跑

用户直接转达监督的正式独占结论，§10的“待scope”是上一checkpoint的历史状态，现已解除。**02:48:51**落盘前重新核对共享bin的HEAD/index/disk全部为`e1db1a81ec41cfb3835c7790a5d8eb439648485f`、100755、scoped clean；仅应用Hubble已审的同字节predicate，1文件12+/1-，应用后SHA-256为`bca11c5f532f871df13c7c48f1f648d8d6249c0d9d952d9ae60d0989a1bc412c`。其它内容包括peer的install/availability前置保持原样。只认数字alias、至多一个原生边界、一个有效model前缀后紧邻exec/e；argv不改写，失败保持handled。不是全量Codex/TUI/默认账号或协议切换。

### 此次确实运行共享公开入口，而非只运行私有candidate

现存标准Go CLI SHA-256 `62ade2667a5f63fea300a75d389ecb6f45b5d4c67f3e161609d5b2f4f35f44b6`，原位使用、未替换。私有HOME/DB/PATH无node，bootstrap由绝对Node执行，官方Codex0.167.2；管理地址为预占但不监听的私有端口，无management key、不启动AIH Node server。

- **02:49:32–02:49:47**：真实共享`bin/ai-home.js codex <alias> --model gpt-6.1-sol exec --json ...` exit0，观察到`thread.started`与`turn.completed`，实回`CODEX_PUBLIC_PREFIX_GO_OK`；prompt中的usage/policy/set-default保持普通文字。
- 共享entry的`-- -m MODEL e --help`与`--model=MODEL exec --help`均exit0；无效数字alias exit1、未回落旧Node业务。四项V8记录均实际加载共享entry，五个旧app/router/PTY/default launcher/stdio业务模块全部未加载。
- caller为Node bootstrap→现存标准Go→官方Codex；已观察的私有PID最终0、敏感HOME/DB删除。entry与标准Go执行前后SHA完全相同。
- 缺Go证据仍仅来自§10已审同SHA私有candidate，未为此移动共享Go；不把私有negative操作冒充标准产物验证。malformed前缀仍不接新predicate，其legacy业务边界保留。

`node --check`与scoped `diff --check`通过；本次来源应用receipt、真实逐操作/进程/cleanup及原始报告digest已追加既有evidence JSON。**Node bootstrap仍在；没有共享server发布、restart、stamp更改，也不称R1或整个迁移全部完成。** 后续继续R2 wrapper/stdio的单一Go转交方案，先核cf13ed88f及其后续owner写集，不覆盖managed runtime能力。


## 12. R2 实做：CLI-owned POSIX 纯版本 wrapper 直接 Go（2026-11-18）

**本组状态：源码已获准落盘、私有 Node 不可用窄门禁通过；公开安装／loaded／旧 Node writer 退出仍为 Partial。** 不以 R1 单 hunk 收工，也不把版本查询等同整个 R2/W0–W6。监督 `pm-a03c1cb6` 核对无并行 diff 后准予精确两生产路径；03:20:23 落盘前再次逐 blob 核实 HEAD/index/disk 相等。仅修改：

- `internal/runtime/codexhooks/wrapper.go`：**CLI marker＋POSIX＋完整 argc=1 的 `--version/-V`** 在 Node 分流前直 exec 同 helper 安装根 `bin/native/<platform>-<NodeArch>/aih-go`；Go amd64 映射 x64。缺失、不可执行、capability 不兼容都失败关闭，不回 Node；缓存 upstream 仅为内部 discovery hint。
- `cmd/aih/provider_info.go`：Codex-only raw 版本适配，沿既有 canonical resolver，保留显式 override > managed current/tombstone/invalid > hint 的选择权和只读 `CheckHostReady`。官方 stdout/stderr 原样继承，正常非零及 signal 的 `128+signal` 静默透传；不新增 default/config writer。

没有写 JS launcher、`run.go`、CLIHookService/host、managed receipt/resolver 实现、Desktop/VSCode、协议、TUI/default/exec/resume。版本诊断**有意不再执行**旧 helper 的账号/default 环境选择、config heal、rollout 修复和 catalog 投影副作用；它保留 host recovery admission，但不是上述启动语义的全量等价迁移。

### 同 SHA 实证，而非只看源码或旧回合

冻结源码为已提交 `2075e22f2` archive＋上述两 path；最终源码 SHA-256 为 wrapper `b4b84260…`、info `195c2c92…`，Go CLI 为 `ed479591d1ac591c50c8488f039e4afb78570a5fce7a2265e7b255e4122b6c5c`。使用真实产品 `CLIHookService` 在本人私有 HOME 生成 wrapper，并重复产品自愈确认同字节；操作入口仅是私有 operational main 调用产品服务，不复制产品函数、不加测试/mock/fixture。因此本证据是**真实产品生成的私有 wrapper**，不冒充公开 installer 已发布。

**03:20:22 最终 18 项真实操作完成：**绝对 `NODE_BIN` 不存在、PATH 无 node、无 AIH Node server/账号凭据/第一方管理 RPC；官方 Codex 0.167.2 的 `--version/-V` 均 exit0、原样版本行；连私有 JS helper 暂不可用仍成功。缺 Go、真实旧 Go、不可执行 Go、无效 explicit override、pending host marker、managed disabled 和损坏 receipt 均 exit1，不回 Node。managed 激活调用真实产品 transaction，先执行官方 version 和 app-server initialize，再发布；当前版本不依赖旧 cached backup，显式 valid override 的优先级真实验证。4 个排除形状（exec、model-prefix、extra token、native escape）继续旧路径，Node 缺失时 exit126，**未迁移**。

仅对记录到的本人 PGID 内、Go 的**官方 native 子进程**发 SIGKILL，最终 exit137 且无 `aih:` 追加，未杀 Go 或共享进程组。采样进程链包含 Go 与官方 native，未观察 Node，18项 V8 文件数均0；这不是完整 syscall/network trace。03:21:53 复核已观察 PID 无残留、本人 root executable 扫描为空，仅删除三份本人私有 HOME；冻结源码／低敏证据保留。

native build、focused vet 通过；Linux x64／Windows x64 cross-build exit0，**不是异机运行验收**。Hubble/Mendel 对最终两 SHA 源码复审 no blocking；曾发现的 amd64/x64 定位和 native signal P2 已修。首个 operator 15秒 snapshot-copy 超时保留记录（观察到175MiB本人临时copy），改用90秒有界真实操作完成；未据此修改产品快照逻辑或伪称产品回归已修。

### 交付边界与下一退出门禁

- 此前私有 JS early-delegation spike 保留历史但已撤出私有产品源码，**不计作 Node 不可用验收**；共享 JS 一直未写。
- **没有热更新现存公开 Codex wrapper、标准 Go CLI／server、stamp 或共享服务。** 当前公开旧 wrapper 仍可依赖 Node；后续由发布 owner 协调来源一致的构件和真实安装／loaded 验收。
- 旧 Node CLI hook 的条件 self-heal writer 仍须单 owner 证明及退出门禁；本次不声明其已删除，也不武断声称当前双 writer 正在运行。Windows wrapper、实机 x64/Linux、默认/TUI/exec/resume/app-server/stdio，以及完整 R2/W0–W6继续保留，不能借纯版本成功关闭。

完整低敏逐操作／来源／caller／cleanup／原始 digest 追加既有 `evidence/2026-11-17-work-node-host-free.json` 的 `cliOwnedPosixRawVersionGoWrapper`。不新增测试用例，不操作共享草稿／暂停 goal／其他 owner 文件或索引。


**补充的真实公开产品入口尝试（没有用 operational main，仍未闭门禁）：**同冻结源码两path构建现存 `cmd/aih-server`，用另一本人私有 HOME/DB/端口、`--enable-codex-cli-hook=true`、无 `--supervise-node`／front-door／Node base，启动后 ready 和鉴权管理状态可用，但120秒内 CLI hook 始终未 enabled，未产生 CLI state，复制的官方 native target 未被包装。随后仅停止该私有 server，根进程扫描为空并删除本人 home。源码逐层核对：`cmd/aih-server/run.go` 传 `Options.CodexHooks`，但 `aihserver.New` 到 `buildServerHandlers` 未转交该 options；内部 `startCodexHooksDaemons` 只启 notification bridge，不含 CLI enable。这是冻结版本的**真实 host 接线阻碍**，不是本两path版本转交的通过结果。没有修改共享 composition／host／run.go；已向监督01a1df63报告由其确认并分配 host owner，不能因两path获准而扩scope。

Mendel最终核对源码、raw、manifest、cleanup和native子进程PPID/PGID，18项预期分布为 `0×6、1×7、126×4、137×1`，无新一致性 blocker。**仍披露两份新增私有 operational Go main 的验证入口边界；调用真产品库不自动等于全程使用既有公开入口，也不将两path授权解释为临时驱动合规豁免。** 上述新增公开入口尝试未成功，不用私有矩阵掩盖。最终raw的 `publicSourceApplied=false` 保留03:20:22历史快照；03:20:23落盘由独立application receipt接续，不回填原记录。


## 13. 下一 R2 stdio 节点已实跑既有 Go 核心，未冒充 wrapper 切换（2026-11-18 03:42）

版本两path已作为 `00dfa6a05` 提交推送；监督随后本人接 sole composition 的 `Options.CodexHooks` 接线，本writer不碰 host/composition。下一步并非仅写规划：03:42:30–03:42:32 使用**现存 `cmd/aih-server __codex-local-app-server`**，首行私密配置走stdin、私有HOME、PATH无node、无AIH Node宿主／账号凭据／管理RPC，通过已安装第三方 `wscat` 真正发送官方RPC。没有新增main或测试；operator客户端自身Node运行时明确与AIH业务分列。

共观察6帧：`initialize`、`config/read` 成功；`model/list` 为9项；`thread/list` 在空私有home为0项；不存在UUID的 `thread/goal/get` 返回 **-32600**，该原样错误不是Goal兼容通过。首次operator用DEVNULL令wscat在stdinEOF时退出0且0帧，**未算验收**；只纠正客户端保持stdinpipe后拿到上述响应，未改产品。采样AIH tree未见Node，但native进程可独立PGID，不能以采样推完整进程覆盖；观察PID无剩余、私有home已删除。来源仍为固定2075e22f2 archive＋已提交版本两path，不伪称最新并行main整体构件。

### 下一最小工程动作及不能盲接的原因

公开CLI-owned wrapper的app-server仍 `exec NODE_BIN HELPER --upstream ... --state-file ... -- <argv>`。现成Go `BridgeAppServerStdio` 虽已复用rewrite/resume/listScope/process owner，但接口硬绑WS；local-app-server先读私密config且写ready地址，直接接公开stdio会污染/吞握手；串行`codexlaunchrpc.Client`自己握手且丢method帧，也不能透明替代。enabled helper还包含列表投影、metadata、resume hydration和条件writer，不是搬一条pipe即可保真。

已报监督的下一**候选**写集仅：新 `internal/runtime/codexappserverws/bridge.go`、既有 `internal/transport/http/codexappserverapi/stdio_bridge.go`、必要 `stdio_lines.go`，将有界帧泵抽为transport-neutral核心，让现有WS adapter委托同一实现；**尚未获该共享范围独占确认，当前未落盘**。这只是后续完整转交的工程前提，不作CLI stdio已无Node或R2完成声明。

完整cutover需要监督确认M/metadata对sourceKinds/hidden/聚合分页/cursor/title/model/Goal投影合同，resume/protocol owner对运行配置/hydration/通知抑制/stale steer的合同，以及现存rollout/title条件writer的保留或退役；Go已有`codexstatepage`/`codexrollout`/`codexnotifications`直接复用，不再复制第二套reader/writer。`thread/goal/get`的兼容只可在原上游-32601及本地found时按既有合同补，不用本次-32600错误证明覆盖。

逐RPC结果／来源／客户端边界／operator纠正／cleanup及digest保存在原JSON `nextCliStdioExistingGoCoreInvestigation`。Hubble只读架构审查已给出上述最小范围与缺口；完整协议切换仍需原协议/metadata owner协作。无新增生产文件、feature、tests、共享重启、stamp或其他会话索引操作。


## 14. R2 已授权纯 transport-core 提炼：3-source checkpoint（2026-11-18 03:53）

监督 `pm-cf1fece5` 已核三path clean并准予本writer独占，故§13“下一scope待确认”是历史状态；不回填旧记录。固定main **`21a5dd90c`** archive（digest `ab52bec4…`）后，先独立保留未改archive构建，再只在本人候选改3path；03:53再次核HEAD/index/disk，原两个文件逐blob一致、新path缺失后落盘：

1. 新 `internal/runtime/codexappserverws/bridge.go`：`FrameTransport` 只提供 `Read(context.Context)`／`Write(context.Context, []byte)`／`Close()`；原有frame pump与bounded stdout/stderr reader单实现迁入，复用原rewrite/resume/listScope及原process session ports，不创建业务状态或初始化消费者。
2. `internal/transport/http/codexappserverapi/stdio_bridge.go`：**公开函数签名不变**，仅将WS `Read`、Text `Write`、`CloseNow` 适配给共享核心；`SetReadLimit`仍在原adapter。
3. `stdio_lines.go`：旧bounded reader全部随core迁移，无第二套实现；原path仅保留迁移说明。

入站仍 scope remember → rewrite → resume remember；出站仍 resume patch → scope patch；16MiB默认限帧、15秒写deadline、2秒最终stdout drain、取消／single Close／Wait／stderr 64KiB均源码精确保留。最终三SHA `c0edefcb… / 256a4e3c… / 78a4cc8e…` 经原Hubble和Mendel逐段独立审查 **no blocking**。没有改wrapper/CLI startup/host composition/metadata/env/resolver；新公开stdio adapter与wrapper切换仍未授权、未实施。

### 前后真实反证

未改构件 `d3d8d48b404d2a022c651ac15af83052c8d1df486fd66981e5d50e350374935b` 与3path候选 `6f0bac20518b4f448f3640966a1e5fdffaabcdc99305beb42b77b28953a889bd`，分别运行现成 `__codex-local-app-server` → 官方native0.167.2，并使用现成第三方wscat，每个构件3连接，断开后重连。initialize/configread/modellist9/threadlist0一致；Goal不存在与未知method各原样 **-32600**，不是成功兼容。数字9与字符串“9”同时请求分别收到config/model响应；初operator汇总 `str(id)` 可能合并两者，已不改产品、以原生typed keys在**同两构件重跑**后独立核对，初回合不借作该门禁通过。

无账号/管理RPC/AIH Node宿主，PATH无node；wscat第三方客户端Node单列。进程采样以PPID递归收集官方native独立PGID，观察AIH树无Node、已观察PID全部退出，两privateHOME均清；不是全系统syscall tracing。所有调用是既有product entry+官方CLI+既有诊断客户端，无新Go operational main、测试、fixture或mock。

native build与focused vet通过；Linux/Windows x64交叉编译exit0，仅编译不冒充异机运行。oversize／slowconsumer／最终无换行帧目前**只有源码等价保留**、未专门实跑，不用常规RPC代替这些验收；认证inference/approval/resume、metadata parity及公开wrapperstdio仍未完成。shared服务／构件／stamp均未操作。

本组是**Partial transport-core checkpoint**，只为下一CLI adapter提供唯一可复用核心；metadata/titleGoal/hidden/cursor、resume hydration/turn状态机、旧条件writer及标准loaded继续按§13协调。完整逐操作、typed-ID operator纠正、来源、三SHA、review与raw digest追加原JSON `transportNeutralCodexFrameCoreExtraction`，不另建平行迁移计划。


## 15. R2 已交 core 的真实边界补验（2026-11-18 04:12）

§14 三源码及原三文档已由本writer提交推送 **`007620be1`**。临时index只用于一次显式6path commit；本人逐blob同步6条，sync窗口outside **6124 entries全部相同**、43条peer cached保留。随后main有并行新提交/暂存不回退不代清；本组不把source/push当标准installed/loaded。

在同一固定3path候选（`6f0bac20518b4f448f3640966a1e5fdffaabcdc99305beb42b77b28953a889bd`）和既有 `__codex-local-app-server`／官方native0.167.2上，新增两个此前只有源码证据的真实操作。全在本人private HOME/临时loopback端口，PATH无node、无AIH Nodehost/第一方Node RPC、无账号凭据或推理；第三方诊断客户端使用已安装wscat的ws依赖，Node单列。

- **超限入站帧**：initialize后发送合法config/read JSON后填空白至 **16,777,217 bytes**，收到WS **1009**、`read limited at 16777217 bytes`；同一Go私有宿主随后重连config/read正常。这只覆盖WS入站帧限制，不冒充native stdout超长行门禁。
- **真实慢消费者**：initialize后暂停客户端socket读取21秒，同时发送4096个官方 `model/list` 只读请求；恢复读取后收到 **1006**，没有operator timeout或强制关闭。递归PPID采样的官方native最后可见约20.193秒，后无残留，宿主仍可重连config/read。支持“慢消费者/饱和下有界终止＋宿主可重连”；**不凭采样推导精确15秒或唯一outbound超时原因**，入站pipe背压也可触发同一保护。

两个private操作均观察AIH树Node0、已观察PID全退出、HOME已清、私有宿主exit0。首次超限operator把pnpm shell shim当Node module base，客户端在发送产品请求前退出；不计通过，纠正为现成wscat包依赖后才有上述实证，未改产品。没有新增源码、测试、fixture、mock或operational main。

另直接以官方native现装构件执行initialize/initialized/configread后关闭真实stdin，3帧（含官方notification）后exit0、stderr0、privateHOME清。**仅证明上游EOF合同，不是新Go stdio helper验收**。新raw adapter不能照搬WS EOF立即stop；必须先half-close native stdin、保留stdout收尾、原始stderr和native退出/信号，不抢客户端initialize或双向method/typed-ID。

后续可调用helper的精确4path（`codexappserverws/stdio_transport.go`、`host/codexstdio/run.go`、`cmd/aih-server/codex_stdio.go`、`cmd/aih-server/main.go`早期dispatch）已报监督 `pm-227b9579`，**待ownership/scope确认，未写入**。不添孤立unused adapter冒充公开迁移，不改wrapper／composition／cli_hook／M metadata／协议／Terminal。

最终无换行native输出、native stdout超限行、精确deadline归因，以及认证inference/approval/resume、metadata与条件writer、公开installed wrapper stdio退出Node仍未闭。§14旧“未实跑oversize/slowconsumer”保留为历史快照，本节只追加新范围实证，Goal -32600仍不算兼容成功。原JSON `transportCoreRealBoundaryFollowup` 保存操作、边界、raw SHA和本地root指针；无shared构件/stamp/服务变更。


§15审查补记（04:18，Hubble）：慢消费者应精确表述为“恢复读取后，**客户端 close 事件报告1006（异常关闭）**”；1006不是对端发来的close frame。官方native是**相对首个进程样本最后可见于约20.193秒**，之后采样未再观察到，不把时间原点混成请求开始或精确15秒。原JSON的raw digest别名 `source-commit-index-sync-receipt.json` 对应实际文件名 **`commit-index-sync-receipt.json`**，准确root由 `/tmp/aih-r2-frame-core-latest-20261118.txt` 定位，SHA256 `4a94ccb287b816a6fe1f030f7ebab8674b8b2e5a14dfd1c7512587f31b273b68`；JSON新增reviewClarifications映射，不修改原始实跑或同步记录。本补记仅校准引用与措辞，不新增验收通过项或源码。


## 16. R2 CLI-owned hook-disabled app-server 的可消费 Go 转交（2026-11-18 04:38）

监督后续 `pm-74a3f28c / pm-a3016b71 / pm-f91052b5` 已明确选择**真正退出一个公开分支**，不选§15申请的四路径新server helper；`pm-cdbe3020` 正式授予原writer三个精确源码路径。没有创建 `codexappserverws/stdio_transport.go`、`host/codexstdio/run.go` 或新的server dispatch；旧“待四path”保留为历史状态，由本节接续。

### 源码与信任边界

1. 新 `cmd/aih/codex_app_server.go`：聚焦私有 `__codex-cli-app-server` adapter，复用 `codexhooks.CLIHookState` v1，不新建业务状态来源。64KiB有界、普通文件／非末级symlink、inode／mtime前后核对、重复字段及 `version/enabled` 大小写别名拒绝。缺文件按原约定disabled；空／坏JSON／缺bool／null／错误类型／非v1／不可读／非regular均**失败关闭**，不沿用旧Node“坏state当disabled”的宽松行为。
2. `cmd/aih/run.go`：仅private命令早期分派3行，避开R5相邻Desktop语义，没有改普通launch／默认账号／账号写者。
3. `internal/runtime/codexhooks/wrapper.go`：仅CLI marker＋RouteDefaultCLIThroughGo的POSIX app-server分支，按 GoBinaryPath（显式配置或 aih-server 同目录 aih-go）定位绝对 Go 路径，不再解析 Node helper 脚本；能力检查后，由Go输出精确 `disabled-v1` 或 `enabled-compat-v1`。**enabled在任何native执行前明确选择旧Node兼容**；disabled复读state、canonical resolver、host admission后以 `syscall.Exec` 原样替换官方CLI，原stdin/out/err、EOF、退出／信号不经过另一套pipe／handshake／RPC消费者。任何缺Go、坏state、目标／admission／native失败均不获得回Node的资格。

state复读只是时间点校验，**不是与原writer原子互斥**；私有命令仅为可信安装wrapper的固定state path，不把绝对basename检查说成通用权限端口。capability是版本标记不是构件签名；canonical resolver保留用户显式binary选择，第三方JS CLI本身可能用Node，不能对任意override承诺zeroNode。原内部PASSTHROUGH分支、默认／resume／Desktop／VSCode／Windows生成逻辑未扩。

固定 `631276ee5` archive（SHA256 `7adcf3b0…`）＋仅本人3path构建。独立审查发现case collision：旧候选 `enabled:true, Enabled:false` 被Go whole-struct解码错选disabled，已通过真实product private command复现后修复，只从精确字段解码并拒大小写别名；新实测exit1/stdout空。Hubble／Mendel对最终源码SHA **`3c6db1b6… / 0b21c93b… / ed618012…`** 复审no-blocking。

04:36再次核共享两个旧path的HEAD/index/disk==冻结基线、新path缺失后落盘；04:37本人仅3source提交 **`b4cc56e9f`**（241+/3-），本人3index逐blob同步，窗口outside **6131 entries相同**、45条peer cached保持。没有修改标准Go、现有用户wrapper、stamp或服务。

### 真实公开生成 wrapper，不新增 operational main

现存 `cmd/aih-server --enable-codex-cli-hook=true` 在本人private HOME／DB／loopback端口真正安装wrapper，再停止私有server；不是直接调用生成函数的新main。最终Go **`dd0ead24c0ec9a149ebc6abb3497530f7912e0a63648b66534ceada0bbf47742`**、候选server `66901ff7…`、生成wrapper `3e2d330b…`；最终源码重新运行server使state enabled并确认wrapper同字节，随后仅私有state设disabled做真实调用。无登录、账号复制或收费推理。

- 无PATH Node、配置的绝对Node不存在；wrapper真实 `app-server --listen stdio://` 收initialize、官方notification、数字9 config/read／字符串“9” model/list两独立响应，stdout纯RPC，EOF退出0、stderr0；同PID已替换为官方native0.167.2。
- 移走**本人私有源码副本**的旧JS helper后仍同样RPC／EOF0，恢复副本后再测。全局 `-c model="aih-argv-probe"` 原参数实际出现在config/read，非仅对比argv字符串。
- direct official与最终wrapper分别实送SIGTERM／SIGINT／SIGKILL，结果均为 **0／-2／-9**；TERM0是官方实际graceful行为，不强设-15。两个真实非法argv都exit2，stdout空，stderr长度及SHA完全相同，没有AIH附加错误尾缀。
- 19项最终负例／预选记录覆盖missing state disabled、空／坏／缺bool／null／string／version／duplicate／casecollision／超64KiB／symlink／FIFO、缺Go／不可执行Go／真实旧Go能力缺失、非法binary override、host recovery admission、enabled显式选旧Node缺失exit126以及直接执行时发现enabled拒绝。enabled126是**兼容路径未迁移**，不是成功或运行失败fallback。

原operator先只等先到的model响应便EOF，未记完整typed-ID门禁，已同binary等双ID纠正；原SIGTERM=-15和缺Node=127期望都由直官方／实际shell反证纠正，不改产品来迎合期望。新构件最终重跑与旧候选记录分离，不用旧09b485e0结果冒充最终dd0ead24。

native build、focused vet及Linux／Windows x64交叉编译通过，后两项仅编译，不称平台运行。private HOME已删除，root-scoped进程executable扫描为空；不是全系统trace。新source不是第二套Node业务，无新tests／fixture／mock／Go main；真实命令全部为现存产品入口。

本组关闭**源码及私有真实安装入口下hook-disabled app-server的第一方Node调用**，不称shared标准installed／loaded已变，enabled metadata/titleGoal/list/hydration/notifications/条件writer、TUI/default/resume、Desktop／Windows及完整R2／W0-W6仍open。来源、生成、最终操作、审查修复、清理、源index receipt与raw digest统一追加原JSON `cliOwnedHookDisabledAppServerGoDelegation`；本地pointer `/tmp/aih-r2-cli-appserver-latest-20261118.txt`。

## 17. 2026-11-18 R2 startup argv／catalog：真实 caller 消费 Go（非完整 launcher Node-off）

**范围与来源。** 按监督 `pm-4d5fe146`／`pm-372cf8a0`，源码 `128c7e637` 为6path窄checkpoint：同步JS adapter、CLI早派／stdin、startup policy、catalog I/O、有序JSON。保留现有Chat同步通用写函数，未改default/auth/env/heal/generation/rollout/lease/mode写者；不新建协议／worker main。最终私有构件来自固定 `a331e43b2609686c96df76737c388cfed3b87b19` archive（`f2eb11d26f19977dba06b08265c9be4a653c1223dc68a83a273450d6782ccd3f`）+本人6path，Go **`fffbad8c83733e66cdf63eefe773980d3757221d6f413f44c7f9268a1159cb88`**。早轮moving-HEAD探索构建不作为最终来源；最终manifest和archive由原Hubble/Mendel逐hash审，均no-blocking。

**真实操作与结果。** 不新增测试用例：只复制当前真实config/cache至私有HOME（无auth凭据），8种native/OAuth/gateway/provider形状及7项边界原Node-vs-Go argv全同；最终构件3项复核亦同。缓存232模型中无gpt-5，原Node生成后删除，再由Go独立生成233模型catalog，**307203bytes及SHA `01aa3a67ac28582c34ceff7360e1835113ca109b000dc9e3ab00a56bc45a02dc`逐字节相同**；未知字段顺序保留，模板tier不继承，未启用旧未消费的unsupported-tier降级函数。

- 真实现存 `codex-app-server-stdio-proxy.js --run-cli-default ... -- --help` 与 `--run-cli-resume ... -- resume --help` → 私有installed Go → 官方0.167.2；分别0.481s／0.068s、exit0、stderr0。未加载旧provider/projection策略模块；Node bootstrap仍在，不称整个caller已无Node。
- 无PATH Node／无AIH Node server宿主，最终Go策略独立运行0.068s exit0并生成catalog。另一次官方appserver验证使用最终Go生成的启动参数（该组未带catalog参数），完成initialize／model-list／config-read三RPC响应、官方通知及stdin EOF退出0。官方实际stderr361bytes记录在raw，不伪报静默，不产生收费推理。
- strict DTO的重复／大小写version、尾随JSON、null／非string／NUL argv、超限、非object真实拒绝；缺Go／旧Go能力不足明确报错不回Node。stdin不结束约5.016s input-timeout；capability与编译分别5s／10s hard-kill截止，不宣称整调用10s。
- 坏／缺cache软跳过；CODEX_HOME／cache／目录symlink及相对父段沿旧受信本地路径语义，8项原行为比较通过；输出位置为普通文件时两侧硬失败。路径安全未新增no-symlink／沙箱隔离保证。
- 两reviewer独立指出读FIFO先open再Stat会卡且TERM仅cancel不退出；本人真复现captured ownPID仍live后仅kill/wait该child。修为O_NONBLOCK打开+fd regular校验及JS SIGKILL截止；最终config symlink→FIFO／config直接FIFO／cache symlink→FIFO分别0.900／0.013／0.012s软skip退出0，目标catalog FIFO可及时原子替换为正确regular file。原旧worker通过新adapter约10.739s硬拒绝且无root-scoped残留。无共享进程操作。

**构建、索引与剩余门禁。** native build、focused vet、JS syntax及diff检查通过；Linux／Windows amd64仅交叉编译。源码commit前scoped cached exact6，之后本人6条逐blob同步，outside6132 entry未变，85peer cached保留。第一轮隔离Node缺smol-toml属私有安装依赖未挂，补只读使用现node_modules后真caller通过，不为迎合验收改业务。

完整default/TUI/resume仍缺CLI-only snapshot/env等必要合同；heal算法／stale rollout条件writer／lifecycle、enabled metadata及Desktop仍open，既有Node逻辑不得长期当完成。shared标准Go构件、wrapper、stamp、服务未发布／重启。JSON字节等价只证明本次官方真实catalog；孤立UTF-16 surrogate／数值溢出存在旧parser差异，文件8MiB／depth100／request2MiB／argv4096与1MiB为新增资源门禁，SIGKILL可能留本人隐藏临时文件，不等同原子事务回滚。全R2／W0-W6保持Partial。原JSON新增 `cliStartupPolicyCatalogGoDelegation` 含最终6hash、12raw digest、runtime边界与index receipt，pointer `/tmp/aih-r2-startup-policy-latest-20261118.txt`。

**共享发布具体门禁（05:29只读）**：标准CLI SHA `62ade2667a5f…` 的 `__codex-cli-startup --capabilities` 实回exit1／不支持；已安装Codex wrapper仍引用当前workspace JS。因此新default/resume启动在未发布兼容CLI构件前会按约定fail closed，不能回旧Node规则或称线上已可用。已回原监督协调精确CLI-only构件发布；本owner未获部署授权，不替换binary／改stamp／重启，既有运行会话不动。

## 18. 2026-11-18 R2 provider-heal：真实外层 caller 消费 Go 文本修复

本组源码 **`6a7ab80dea0e673d133bad5e20c5f7ea3c82e5b1`**，只关闭原 managed-provider/name 纯规则的 Node owner，不等于整个 healer、启动器或 R2 迁完。监督批准消息 `pm-793653bad1b0fba963605fac1a7c4b40` 的四路径：

| 路径 | 责任／边界 |
| --- | --- |
| `lib/cli/services/pty/codex-provider-config-heal.js` | 同步 Go I/O adapter；无 Node 规则 fallback |
| `internal/runtime/codexconfigheal/provider.go` | 旧行级修复规则，不读写文件、不启动服务 |
| `cmd/aih/codex_config_heal.go` | 内部有界 stdin／能力合同，不新增 operational main |
| `cmd/aih/provider_effort.go` | `--heal-provider-config` 内部早派仅3行，既有 effort 不改 |

实际唯一调用 `codex-config-heal.js:414` 不变。外层继续一次读取、组合provider/MCP/projects/hooks后，经既有 `codexpreferences.ReplaceDocument` 在共享 advisory lock 内 expected-document 比较再写。未修改通用writer、M default/env、其他healer、peer `run.go`；不靠全局网关RPC或AIH Node server宿主计算本组策略。

### 来源冻结与实际结果

- 基点 `ec607d14e0ae3465443e5a3c4e1555df9091f2a8`，archive SHA `17cc35b4fb7d8819141d1e0498bfaf17aee3ddd34970f9b00f66d42cc893a9ae`，仅叠加own4；manifest-2 SHA `73e22cfede8b66e606a0bc6d3af7a65c817d6e87737e9728bc0840302294cec1`。最终私有CLI SHA `85c720f74dbf2672965b6f4bc60e21f999df90360a12f5c5929171ad78cdf4de`。不是从共享未提交源码整树构建。
- 当前真实config私有副本4208bytes，来源SHA `a86e74f3bd1a413a06646b9fa1fa2c5356f44d0568a1c3ccae1bf4b8ff4f0322`；抽取其中真实provider子树作文本操作，不造账号/fixture。最终28项原Node／直接Go／私有标准安装adapter的内容和changed全部相同。含删name、空/quoted/literal/注释、CRLF、child-only、missing-block、无child的inline/dotted及多行示例。原始较早20比较中部分inline/multiline仍残有child header，不能当纯分支证据；本次已完整移除子树重验。
- Hubble/Mendel发现Go dot与JS非dotAll差异，真实私有config注释插入CR/LS/PS重现3红；最终三处comment及escape排除四类行结束字符，28项绿，并补 `!changed => config相等` 响应guard。两位原reviewer按最终四hash无阻断；其结论是源码/证据只读审查，不声称独立业务重跑。
- **真实已存在outer caller**，通过私有标准package路径加载最终CLI，不依赖default/PTy caller转发override：修复后字节恢复原SHA；第二轮changed=false；mode0640保持；symlink本身与目标权限保留。不是只跑未消费的raw helper。
- 缺Go、实际共享旧CLI `62ade2667a5f…`、Go拒绝NUL三项，外层分别单条 `[codex-heal] skipped: ...`，原文件未改。实际持同一个advisory lock时拒写；原expected内容过期时保留私有外部编辑。未改或绕过writer。
- 纯策略命令在空PATH、私有HOME下exit0/stderr0并恢复原内容，无AIH Node宿主；**outer caller本身仍是Node**。本组不需要认证推理，未发生成请求、未新增记账。
- 最终10个严格DTO负向均exit1/stdout0/固定低敏code；stdin一直不EOF实测5.013s截止/PIDGone。ps捕获真实adapter子进程16996（argv只有命令，无配置），SIGSTOP后10060ms触发SIGKILL，parent返回固定rejected且worker PID消失。未把TERM/context当立即取消。
- native `go build ./cmd/aih`、focused `go vet`、`node --check`及diff-check通过；Linux amd64／Windows amd64只有cross-compile，不是runtime。未新增或执行测试用例、mock、fixture。
- 单次临时index／显式pathspec source提交，提交前cachedstat/后showstat exact4；本人4entry逐blob==HEAD后同步，outside6141 entries未变，89peer cached保留。

### 已交源码、私有安装与共享运行分列

| 维度 | 当前事实 |
| --- | --- |
| 源码 | exact4已交 `6a7ab80de`；本节和JSON为独立文档checkpoint |
| 私有installed | 固定archive+own4的标准package layout，真实outer读取／修复／锁内发布已通过 |
| shared installed／loaded | 本owner未替换；真实旧CLI `62ade2667a5f…` 无新heal能力，按旧outer catch skip；shared新启动还受§17 startup能力硬门禁阻挡，原发布owner协调 |
| Node退役 | provider纯规则不再Node计算；Node bootstrap／外层其他healer与default/resume业务仍保留，不能称入口退出 |
| 服务与配置 | 未共享restart／deploy／stamp／迁库；未修改真实用户config、账号、默认项或既有会话 |

剩余边界：request16MiB／config4MiB／missing-block1MiB；拒NUL、非法Unicode和不合DTO文本。等价性限既有正常文本及已列私有操作，不代表任意输入。输出JSON可能膨胀触发adapter16MiB，原writer另有12MiB输入限额；策略被接纳不保证可发布。stdin5s仅覆盖输入等待；adapter能力5s和worker10s为SIGKILL截止，未接main context，不承诺TERM立即取消计算。失败由原outer catch跳过本轮后续MCP/projects/hooks并继续启动，不是launcher fail closed。本组未跑完整default/resume/TUI，不复用前组help成功冒充本轮全链；下一actualcaller先向原监督报scope。原W0–W6与全R2保持Partial/active。

原JSON追加 `cliProviderHealGoDelegation`，包含最终四源码hash、11raw digest、实际结果/剩余门禁。本地低敏证据pointer `/tmp/aih-r2-provider-heal-latest-20261118.txt`；配置正文和凭据不入仓库。

## 19. 2026-11-18 R2 enabled AIH-cursor continuation：既有 stdio caller 消费 Go 完整响应

源码 **`40c5a795d9a590263ed8c7677b9a3c0c19976e6b`**，监督范围 `pm-bc6af05657d01b48d94da0afb37d0373`。此项不是整个thread/list、enabled stdio或Node进程退出；官方method `model/list` 本已透传，没有为它另造不可消费helper。

| exact路径 | 责任／不变边界 |
| --- | --- |
| `lib/server/codex-app-server-stdio-proxy-state.js` | 只替换buildStateThreadListResponse内部；原own-id/method/cursor预选与effective requestContext保留，其他export不改 |
| `lib/server/codex-state-native-reader.js` | 新完整response operation的capability／DTO／I/O；旧page/hidden仍原端口，cache区分显式模式与能力 |
| `cmd/aih-server/codex_state_page.go` | 原早派端口内新增 `--thread-list-response`；原page/hidden不收紧 |
| `internal/runtime/codexstatepage/response.go` | 复用ReadPage；公共cursor层→native层分开，逐字段投影，返回完整id/result/error |

现实际 `stdio-proxy.js:614–630` enabled stdin caller已消费该目标函数，命中后输出并return；非AIH cursor／notification／别method均原owner预选，选中失败不能发给upstream或恢复旧Node mapper。首屏merge/aggregate、title/goal、shared builder其他caller、M/default/env、R5 run.go、FrameTransport/协议/Terminal与所有writer不改。

### 冻结来源与真实行为

- base `acabe8181a924ef951f66fa333bada4eff928147`，archive SHA `2b1d1c143f56364a8e8e7f71ae8649b16292306d5ccbb666ceed2ab7b87b0a15` + own4，manifest-2 SHA `42391439cffb01538ddb9b4f456fc08718e7a5c40a9df552b1c7c96f12664665`；最终私有server SHA `0356b0e10dc27f847a850d78ac9f1e1a791c93be2df3ced3ba31d96192eb0225`。无共享未提交树整编译。
- 对真实vendor `state_5.sqlite` 以mode=ro在线backup，639threads，私有snapshot SHA `f457078cf3b192e0dcecdf8d327f200bbe00177e375f71900bdf34ef84dd0a0a`，最终DB字节未变。首屏既有ReadPage生成真实cursor，未造账号或state；参数、ID、token文本操作均有此来源。
- 最终30项原Node／新operation逐字节一致，privateStandardInstalledEqual=true。含2项非空、真实历史结束空页、空scope guard、typed number/0/string/空string/null ID、requestContext优先、notification/native cursor/othermethod不消费、public-invalid `-32602` 与native拒绝 `-32000`、额外base64 sextet、numeric grammar及limit1024.5实际187条；1025仍budget error。较早no-home因resolver回宿主实际非空，不当空home实证；最终直接显式emptyhome0项另记。
- 原2reviewer发现limit先上限后floor、JS Number/base64差异、driver time.Time／非finite值、未知zone误零偏移；真实3红复现后窄修并30绿。time.Time先RFC3339Nano，未知／无法可靠日期显错，未写新parser或修改vendor；实际639行4个时间列全integer，不把源码日期修正称实机全Date.parse兼容。两reviewer最终四hash no-blocking，均为只读源码/结果复核，不声称业务独立重跑。
- **真实当前enabled stdio主入口**通过私有HOME/config副本和真实私有SQLite：官方initialize／model-list响应、本地continuation2项均实回；trace stateDbPage=true。最终enabled完整response再次与原Node函数和无binary override私有标准安装逐byte比较相同。不是仅跑raw projection。无turn/start、认证生成或记账；官方CLI还自行探测plugins git网络，不冒绝对无网络。
- final EOF exit0；stderr377bytes有hash，不写0。亲采postEOF：Node父／官方CLI／Go notification均消失，3个官方plugins git后代在0.2s检查仍在，因此 `final-enabled-proxy-result.json` **raw pass=false保留**。之后cleanup核对同PID均已自然退出，未发kill、不触共享PID；响应策略通过与即时whole-tree cleanup未通过分列。
- 最终8严格DTO拒绝均exit1/stdout0；空stdin EOF同样拒绝。stdin开放时SIGTERM实测1ms/PIDGone，输入超时15.02s/PIDGone；空PATH/私有HOME直接Go返回完整2项/stderr0，直接明确emptyhome返回0／null cursor。这里的Node-off只属于Go operation，outer bootstrap仍Node。
- 真实worker查询过快，ps未捕获SIGSTOP目标；私有WAL DB的BEGIN EXCLUSIVE未阻读，因此**没有hard-stopped-worker／hardkill运行证明**。不造worker脚本或fixture来填绿，不据此称查询级即时取消。
- native build、focused vet、两JS syntax/diff-check通过；Linux amd64和Windows amd64只有编译。未新增或执行测试用例/mock/fixture/operational main，未迁库。
- source单次临时index、显式4paths提交；前cachedstat／后showstat exact4(+513/-18)。own4逐blob==HEAD后本人同步，outside6142entries不变，104peer cached保留。

### 发布／兼容／取消边界

新capability为 `aih-codex-thread-list-response-v1`，不拿旧state-page-v1 cache充新能力。默认允许standard→同目录companion，显式override只probe自身；能力／执行失败是稳定-32000，无Node旧row mapper fallback。实际共享server SHA `9916c222…` 的旧page cap exit0、新response cap exit1；真实旧构件/缺Go矩阵均-32000，新私有构件2条，旧page调用仍正常。本owner未替换shared/companion、未重启或改stamp，不能把source/push/privateinstalled当loaded。

资源门禁：外层严格256KiB stdin、32MiB编码输出（含换行）、15s context；helper内错误完整typed-id envelope且低敏固定code，Row内__stateDbPath不进入wire。adapter每个候选probe5s、query16s硬截止，默认多个候选会叠加，不能称整调用≤16s；同步spawn阻塞event loop，不等于单RPC cancel/reconnect即时传播。stdin取消只是已测边界，stdout Close/未捕获hardkill不当更强承诺。

时间/Unicode边界：正常vendor numeric/列已验，ISO/RFC3339和明确数值时区有源码支持；不支持的文本日期报错，包括字母时区RFC1123，不宣称完整Date.parse兼容；Node解析前已丢的number精度不可恢复。strict私有DTO拒绝非法Unicode/额外字段，不是任意wire文本无条件等价。

本节点只退本continuation响应策略的Node计算；首屏merge、其他metadata/rollout/writer、default/resume/TUI与enabled整体transport还open。下一actualcaller继续先向原监督报准确路径，不因本slice交付关闭W0–W6。原JSON新增 `cliEnabledStateContinuationResponseGoDelegation` 保存最终hash与16raw digests，pointer `/tmp/aih-r2-list-scope-latest-20261118.txt`；完整线程/配置正文只在私有证据，不入仓库。


## 20. R2 enabled thread/list 首屏与原生 cursor visibility 规则转 Go（Partial；2026-11-18）

源码 `b9878bafbd0e4987e519fad36eea1cfa78d8ba39` 已推送，exact4（监督批准 `pm-5e79938f65c7b36262d92ce98e5c65fd`，admission `pm-3e25135e104cc6f35fc131a773af4da1`，catch门禁 `pm-fd5aa2fd6b238b4c104105b3972000e0`）：

1. `lib/server/codex-app-server-stdio-proxy-patch.js`：仅 visibility apply委托与现catch预算hunk；其余patch／merge exports、title与Goal不动。
2. `lib/server/codex-state-native-reader.js`：独立visibility capability和有界JSON framing adapter，不保留Node旧过滤／合并／排序mapper fallback。
3. `cmd/aih-server/codex_state_page.go`：既有端口新增 `--thread-list-visibility` 早派，未改R5 `run.go`。
4. `internal/runtime/codexstatepage/visibility.go`：复用ReadHidden／ReadPage／projectListThread，拥有hidden/subagent/cwd过滤、首屏merge/dedupe/stable sort/cap、最终行cursor及complete replacement line。

### 实际消费与构件来源

原enabled `stdio-proxy.js:793/865` 两路actualcaller保持原样。Node仅JSON parse/stringify I/O，传入canonical响应字符串、已捕获effective context、state home与TitleMaxBytes；Go只按原顺序编辑top/result两个对象层，保留opaque nested值与原字段名raw escape。Go返回unchanged时adapter返回传入的原line逐字节；它不是其后title stage恒不改变stdout的承诺。native/foreign cursor分支只过滤、保上游cursor及opaque字段；首屏才读Page和merge/cap，cursor锚定最终capped尾项而非扩大页的尾项。

固定base `1638c4d03bd4af0a5cd14f393db252e59d59ce09` archive SHA `643e4a9a4930b7ac2625a588abfffbc7a5499430e3da43b4113a8895b66c5357` 加owner exact4。最终manifest SHA `b28d9776296ae9546a2c35de22c92090eb2e53ff9d013703244ef4791265d44e`；私有server SHA `fba232cf050494cd823f14f17f60e91e6c8f9bbd35e673bbdeb602eee5f1156d`。最后catch只有JS变化，Go未重编，前manifest／实证保留，不冒领不同来源新binary。两原reviewer按最终四hash复审no-blocking，属于源码／证据复核，不声称独立业务重跑。

### 已运行实证与保留反证

- 沿§19只读online backup，vendor state_5共639条、SHA `f457078cf3b192e0dcecdf8d327f200bbe00177e375f71900bdf34ef84dd0a0a`，639/639 ID为canonical小写UUID。无造账号、state或改写时间列。官方首屏曾因缺private rollouts为0；没有将statePage拼作上游。随后复制4份真实已存在rollout原bytes（192854794bytes、逐文件source/copy hash相等）到私有HOME相同相对路径，官方首屏2条、真实native cursor续页2条，两轮实回；原backup字节未变，副本允许官方自身维护。
- **早两次探针反证保留**：operator仅改HOME/CODEX_HOME但继承 `CODEX_SQLITE_HOME=/Users/model/.codex`；不能作为private-DB验收。只发initialize/thread-list metadata，无create/turn或认证生成。更正后全部official显式私有HOME／CODEX_HOME／CODEX_SQLITE_HOME；新隔离结果另存，不改旧raw为绿。
- 最终Go构件34项真实wire／context操作与旧Node逐byte相同，包含官方非空首屏和native续页、empty/all/project/nonmatching、limit0.5／1024／1025、created／recency、typed number/string/null ID和原空白line保留。实测最大DTO4018bytes、最大wire181367bytes；不把这当32MiB附近真实业务最大值或全输入证明。较大32MiB门禁只以明确的RPC文本压力操作另验，不造Thread数据。
- 最终私有冻结enabled主入口→官方→Go，ordinary／aggregate／native各回2条，实际observed worker PID／argv可见、EOF0；ordinary/native以实际trace重建有效context与旧/新函数完整字节一致。两次重建曾误用operator自插cwd／原modelProviders，cursor签名不等；保留失败replay，最后改读实际rewritten params（既有rewrite清modelProviders并另携allProjects），不是产品红绿修复。aggregate实际成功，但原trace只有postpatch，不声称对它重建过prepatch逐byte。
- **当前共享物理JS入口**再次连接私有HOME/DB与同一Go构件，三路各2条、EOF0，最终四source hash精确匹配manifest；不是只运行孤立helper。未启动AIH Node server宿主，未做认证推理；第一方Node stdio proxy/bootstrap与aggregate调度仍在，本次仅将visibility策略计算转Go。官方CLI会自行探测public plugins git，故不称绝对无网络或绝对无Node进程。
- 最终10负向DTO／空EOF／过限stdin均exit1、stdout0；开放stdin SIGTERM实测1.85ms/PIDGone，deadline15.021s/PIDGone。缺Go／旧shared／旧private response-only构件均稳定 `-32000/codex_state_native_unavailable` 且无fallback；原page能力仍能用。
- 最后catch门禁实际巨大typed ID原帧33554417bytes（限额内）因error envelope过限明确抛budget；no-ID原帧33554454bytes明确抛budget；4普通typedID错误与旧字节相同、预算内无ID原line不变。没有截断ID／改ID／回超限原文。raw whitespace超限明确budget。
- 真实EOF0.3s检查：Node父、官方CLI、Go通知／worker均退，3个官方plugins git后代仍在，`immediateWholeTreeGone=false`保留。稍后同PID自然全退，未发kill、不触共享PID。**没有hard-stopped-worker adapter SIGKILL实证**，不挪用provider-heal旧证据或称per-RPC即时取消。
- native build/vet、两JS syntax、diff-check通过；Linux amd64／Windows amd64仅编译。Windows rooted-path修正只有源码审查＋编译，不冒运行验收。未新增测试用例/mock/fixture/operational main。本人源码单次临时index显式exact4，cachedstat/showstat核对；own4逐blob==HEAD后本人同步，outside6147entries前后不变、114peer cached保留。

### 新admission、发布与剩余Node

新增有界合同，不宣称任意旧JSON完全等价：raw public line及replacement/error各自32MiB含LF；JSON DTO stdin≤32MiB，Go编码response envelope≤32MiB含LF，因二次转义实际wire可能更早触及预算；过限低敏显错，无法容纳typedID错误帧时向外抛固定budget。Go context15s，adapter每候选cap5s／query16s SIGKILL，多个候选可叠加，不等于总调用≤16s；同步spawn仍阻塞Node event loop。严格外DTO拒extra/missing/非法Unicode，不把opaque内层当strict DTO；Node解析前的数字精度损失不恢复。

只有必须首屏merge同timestamp且不同ID时，无法证明localeCompare等价的非canonical小写UUID显 `codex_state_sort_identity_unsupported`；native cursor纯过滤不误拒。非finite排序值显 `codex_state_timestamp_nonfinite`，不是默选一个错序；这一额外admission实库未触发，仅源码审查保留。既有ReadPage limits、source/标题/日期语义仍原owner，当前numeric真实库不是任意Date.parse保证。

共享server仍SHA `9916c2222ab53916a694e9f9602fc30f9a6a9d591698278dc26dd9ee6951cbf1`：旧state-page capability exit0，新 `aih-codex-thread-list-visibility-v1` exit1；已交源码/推送不等loaded。本owner未替换共享binary/companion、改stamp或重启。当前源码选中Go而旧构件缺能力会显错，不暗fallback；兼容CLI/server安装门禁由原监督/发布owner处理。

本节点仅关闭enabled visibility的Node业务计算，aggregate调度、title/Goal、其他metadata/rollout/writer、default/resume/TUI以及整体stdio/R2仍OPEN；没有全量替换Node入口或关闭W0–W6 Goal。下个actualcaller先向原监督报最小scope再实施。JSON追加 `cliEnabledThreadListVisibilityGoDelegation` 保存最终hash及19份raw digests；pointer `/tmp/aih-r2-visibility-latest-20261118.txt`。完整rollout/线程/配置只在私有证据，仓库不含凭据与正文。
