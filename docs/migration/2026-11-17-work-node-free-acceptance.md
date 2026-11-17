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
