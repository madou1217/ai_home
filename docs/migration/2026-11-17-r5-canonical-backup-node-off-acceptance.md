# R5 / 原 W6：canonical backup 入口纯 Go、Node-off 真实验收

## 归属和结论

- 授权：监督 `01a1df63` 的 `pm-0cad4e01`，仅认领 R5 的 canonical backup Go 入口验收，不接管原 M 整包，不代表原 M 已恢复。
- 本验收 owner：`01a1da1b-02c2-7b02-83f7-9a27cac2bdb4`。时间：2026-11-17 10:31–10:41，Asia/Shanghai。
- 对应原计划：`2026-11-14-node-go-next-development-plan.md` 的 W6，“独立在 Go owner 下工作”和退出旧调用链的局部门禁；不是新增功能计划。
- **本次通过：** 已有 `aih-go __backup-accounts` → `internal/host/backupaccounts` 在没有可执行 Node、禁止子进程和网络/RPC的环境中，完成真实 canonical 数据的导出、dry-run、私有新目的导入、重复导入、写锁拒绝和锁释放恢复。
- **本次未完成：** 公开 backup caller 的默认切换、Node adapter/projection writer 退出、完整 R5、全 W6 或全项目 Node 退役。它们不能因这份入口证据被标记完成。
- 源码零修改；只新增本文件。无测试文件、fixture、伪造 token/账号、第一方 Node 调用、共享服务重启、原客户端恢复或原库写入。

## 构件和数据边界

验收源码固定为 `9c94b3ad9bfb4c9b8b99d44fd4ff4b5fcd757e87`，包含原 canonical backup 实现 `8794a6d0f`。共享 main 当时含其他会话暂存/未暂存改动，因此最终验收二进制从该提交的 `git archive` 源码、assets 和 contracts 构建，不使用共享 dirty 内容，不创建 Git branch/worktree，也不复制 `.git` 或未提交文件。

```sh
# $PRIVATE 是本人新建的 mode 0700 临时验收目录，不是共享 HOME。
git archive 9c94b3ad9bfb4c9b8b99d44fd4ff4b5fcd757e87 \
  go.mod go.sum cmd application core internal assets contracts \
  | tar -xf - -C "$PRIVATE/source"
cd "$PRIVATE/source"
GOWORK=off CGO_ENABLED=0 go build -trimpath -o "$PRIVATE/aih-go" ./cmd/aih
```

最终构建 exit 0；Go `go1.27.3 darwin/arm64`、`CGO_ENABLED=0`。实际运行二进制 SHA-256：

```text
a82d263cb1926e29df3abbe004628aad6345d5d26094ecb6d0b7799e8ed3257b
```

真实数据来自现有 canonical `~/.ai_home/aih.db`，不是 legacy 导出或模拟账号库。验收父进程以 SQLite `mode=ro`、`PRAGMA query_only=ON`、读事务打开在线原库，调用 `sqlite3.Connection.backup` 取得同一读视图的私有一致快照；另有 OS 沙箱禁止向真实 AIH HOME 写入。未对原库执行 migration、checkpoint、VACUUM、flock 或写 SQL。

- 在线快照：964063232 bytes，backup API 1.099 秒，`PRAGMA quick_check=ok`。
- 真实账号 41 个、11 个 provider；源快照账号/凭据/档案及 portable supplement 的只读 HMAC 与读事务内原库相同。
- 原库实际 credential 分类：`api_key` 4、`api_key/native_auth_json` 1、`oauth/native_auth_json` 35、`vertex_ai` 1。只证明这些已有记录，不外推所有 provider/auth 组合。
- 后续所有 Go 命令只接触私有快照和私有新目的 HOME；目的库固定为该 HOME 下的 `aih.db`，锁为 `run/canonical-account-writer.lock`。
- 原始导出/导入 JSON 包含凭据，只通过私有文件/管道传递；未放进 argv、终端、Git 文档或共享 HOME。临时根和子目录 0700、证据/DB 0600。

## Node-off 不是只改 PATH

每个验收 Go 进程使用最小环境：私有 `HOME`、显式私有 `AIH_HOME_DIR`、私有 `TMPDIR`、空目录 `PATH`，无继承的宿主/RPC配置。通过 `/usr/bin/sandbox-exec` 启动，关键限制为：

```scheme
(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec)
(allow process-exec (literal "$PRIVATE/aih-go"))
(deny file-read* (subpath "$REAL_AIH_HOME")
                 (subpath "$SHARED_REPOSITORY")
                 (subpath "$REAL_CODEX_HOME"))
(deny file-write*)
(allow file-write* (subpath "$PRIVATE") (literal "/dev/null"))
```

这是说明性路径占位符；实际 profile 使用绝对路径。Node 即使使用绝对路径也不能执行；网络禁止包含到现存服务的 RPC，因此没有“私有 Go CLI 再委托 Node 宿主”的允许通道。真实对照：

- 在相同 backup profile 下执行绝对 `/usr/bin/true` 被拒绝，exit 71。
- 在同样 `deny network*` / `deny process-fork` 规则下，独立探针的 loopback connect 和 `fork` 均为 `EPERM`（errno 1），未向业务服务发请求。
- 空 PATH 目录中无任何可执行文件。未停止系统中其他会话的 Node；本结论只针对验收进程树和受强制限制的调用链。

## 实际操作与结果

所有导入输入均为本次 Go 导出得到的完整原始 `aih-accounts` v1 document，41 条，未删选/改造账号内容。每条命令均运行最终 SHA 的同一独立二进制，stdin/stdout 留在私有目录。

```sh
# 原始输入/输出必须重定向到私有文件；不运行 aih 的 Node wrapper。
# request.private.json 是从本次 export 结果提取的原样 document，不是 fixture。
umask 077
run_backup() {
  target="$1"; shift
  /usr/bin/env -i HOME="$PRIVATE/home" AIH_HOME_DIR="$target" \
    PATH="$PRIVATE/node-off-path" TMPDIR="$PRIVATE/tmp" LANG=C LC_ALL=C \
    /usr/bin/sandbox-exec -f "$PRIVATE/nodeoff.sb" \
    "$PRIVATE/aih-go" __backup-accounts "$@"
}
run_backup "$PRIVATE/snapshot" export > "$PRIVATE/evidence/export.private.json"
run_backup "$PRIVATE/dryrun-destination" import --dry-run \
  < "$PRIVATE/evidence/request.private.json" > "$PRIVATE/evidence/dryrun.private.json"
run_backup "$PRIVATE/destination" import \
  < "$PRIVATE/evidence/request.private.json" > "$PRIVATE/evidence/import.private.json"
run_backup "$PRIVATE/destination" export > "$PRIVATE/evidence/readback.private.json"
# import 的 document 通过 stdin 输入，不放 argv 或终端；不 cat 原始文件。
```

| 真实动作 | exit / 结果 | 目的地副作用和读回 |
|---|---|---|
| 私有在线快照 export | 0；`protocolVersion=1`、`ok=true`；41 账号、0 skipped | 41 条全部保留；没有 Node/RPC |
| 全量 import `--dry-run` 到空私有 HOME | 0；total 41、planned 41、invalid/failed/created 均 0 | HOME 前后为空，无 DB、run 目录或锁创建 |
| 父进程持有目的锁的 `LOCK_EX|LOCK_NB`，再 import | 1；stdout 空，stderr 33 bytes，仅通用 `backup_accounts_core_failed` | 未创建目的 DB，未替换锁 inode；未泄露凭据或原始错误 |
| 释放同一锁 inode 后 import | 0；created 41、failed/invalid 0 | 新 canonical DB 建立，全部账号有实际读回 |
| 同一输入重复 import | 0；unchanged 41，created/updated/failed/invalid 0 | accounts、account_credentials、account_profiles、app_kv 的全行内容相同，未新增重复身份或改凭据代次 |
| 目的库再次 export | 0；41 条、0 skipped | 按 accountRef 比较整个 portable entry，忽略数组顺序后与源完全一致：provider/ref/CLI alias/status/env/nativeAuth 都一致 |
| 真 stdin pipe 再验 dry-run、锁拒绝、重复导入 | 分别 0 / 1 / 0 | 仍为 planned 41 / 无 DB / unchanged 41；额外重复后上述四表仍相同 |

目的库 `PRAGMA quick_check=ok`。没有执行真实凭据的上游认证或刷新，不把“导入后读回一致”当作 OAuth 仍有效的验证。

### 真实进程树

父进程使用独立 `/bin/ps -axo pid=,ppid=,comm=` 采样，跟踪目标 PID 及递归后代，不读取其他会话 argv 或环境。Node-off 命令不启动 server。主要目标 PID：

| 操作 | PID | 样本数 | 观察 |
|---|---:|---:|---|
| export | 32030 | 12 | 单一 Go PID，无 child |
| 初次成功 import | 33061 | 3 | 单一 Go PID及退出态，无 child |
| repeat import | 33065 | 2 | 单一 Go PID及退出态，无 child |
| 目的 export | 33068 | 1 | 单一 Go PID，无 child |
| 真 pipe dry-run | 33772 | 1 | Go executable 已观察，无 child |
| 真 pipe lock reject | 33776 | 1 | Go executable 已观察，无 child |
| 真 pipe repeat | 33778 | 2 | Go executable 已观察，无 child |

证据修正：最初两个快速命令的 ps 只抓到同一 PID 的 `(sandbox-exec)` 退出态；另一次有 `<defunct>`。最初“名称必须全为 Go”的摘要断言因此失败，不是 backup 操作失败。原始样本保留，不把退出态重命名成 Go。随后真 pipe 输入在观察到 Go executable 后释放，重新执行 dry-run/锁拒绝/重复路径，取得上表 33772/33776/33778 的实际 Go PID证据。进程采样不是完整内核 exec 审计；短命 child 的禁止由 OS `deny process-fork/foreign exec` 强制补足，而不是靠采样无遗漏的假设。

## 原库与快照不变证据

- 验收前后分别只读计算 canonical account scope 的 HMAC-SHA256，随机 HMAC key只存私有目录；accounts 41、account_credentials 41、account_profiles 0、portable supplements 0，前后全行摘要相同。
- Go 入口完全被禁止读取真实 AIH HOME，更不能向其写入；在线原库仅被验收父进程只读快照/核对访问。
- 私有输入快照整文件 SHA-256 在 export 和全套导入之后相同：

```text
67cc3267493082439eab390a94d6c8e2e5cc9e6840365d23a2aac76d8f991ec5
```

这是“原库账号事实未被本验收改变 + 输入快照字节不变”的证据；共享服务仍可正常写其他业务，**不宣称在线原库全文件或所有表冻结**。没有为了取得证据锁住共享原库。

## 尚存 Node 调用、写者和下一退出门禁

本验收复用了现成 Go 分派，没有发现该 private canonical 入口必须借 Node 才能运行。下列既有 public 路径只读审计，未执行、未修改，也未据此扩建第二套业务：

| 现存调用 / 写者 | 当前责任 | 下一切换/停旧路/删除门禁 |
|---|---|---|
| `lib/account/backup/remote-backup-service.js:buildLocalBackupAccounts` | 先构建 Node native 导出，再调用 canonical export，并按 link/预测身份合并 | 原 R5 owner/监督需逐一证明 native-only 剩余数据由 Go 接管、没有丢失后，才能停 merge 旧来源；本次只证明 canonical 41 条 |
| `lib/account/backup/core-accounts.js` | 已验证 daemon 时走 `/v1/management/accounts/backup/*` RPC，否则使用 Go `__backup-accounts` pipe；仍是第一方 Node caller | 将 public entry/transport 分派归 Go，分别完成 daemon-live 与 offline 锁边界验收；本次禁网直达 pipe，不覆盖 daemon RPC |
| `lib/account/backup/core-mirror.js`，由 restore caller 调用 | canonical commit 后以版本核对写 compat account refs/aliases/credentials/state 投影 | 先确认下游 compat consumer 已迁走/由 Go 持有必要投影，再停 Node projection writer，验证恢复后可见性，最后删 adapter；本次没有调用或新增此写者 |
| Node remote repository transport / journal | 远端仓库策略与恢复仍有原 caller责任 | 完成真实远端 backup/restore/integrity/recovery 和授权 caller切换后再删；本次不是远端备份全链路验收 |

这些保留项是待退出责任，不是长期 Node/Go 双业务设计。本验收 owner只负责本文件及上述 canonical Node-off证据，不能替未恢复的原 M 承诺整包归属/完成日期或擅自删除旧代码。

未覆盖：Linux/Windows运行、GUI/Edge、公开命令/包安装/升级默认分派、Node-off共享服务、daemon-live导入路由发布、远端仓库/journal、provider native HOME投影、已有身份冲突/新凭据代次/取消与磁盘故障矩阵。无 fixture补造覆盖。

## 私有证据和交付阶段

低敏结果和原始 process samples 位于本人私有根 `/private/tmp/aih-r5-nodeoff-20261117-JlGzaQ/evidence`。原始导出/导入正文、快照及目的 DB含凭据，未上传、粘贴或纳入 Git；摘要只保留聚合、布尔、exit、PID、hash和错误码。监督 `pm-543bb426` 精确批准自有敏感资源清理后，先保存低敏摘要、各敏感副本完整 SHA、HMAC、9操作状态与进程/锁证据，再确认 `lsof +D` 无打开句柄、无存活私有 Go 进程，逐路径确认 realpath位于本人root且各级无symlink。共删除27个自有敏感文件（数据库及sidecar、正文、HMAC key及本地索引基线副本）；私有锁 inode、低敏证据、二进制、固定来源源码保留。`sensitive-cleanup.json` 记录范围/前置条件/文件hash及删除结果；没有清理共享目录或整根。删除不是安全擦除/APFS快照销毁的声明。

- 源码：零改；仅本证据文档。
- 构建：上述固定 source commit和二进制 SHA，已构建并实际执行。
- loaded：只加载到私有短生命周期 CLI 进程；没有加载/替换共享服务。
- real accept：本文件列出的 canonical offline入口矩阵通过；不是 public backup业务全链路通过。
- Node退出：该局部调用链 Node-off已验；公共 caller/compat writer/远端仓库Node未退出。
- commit/push：由本 owner按该单一文档 pathspec核验并单独汇报，不能把源实现提交归到本 owner。

审查：已向现有 `01a1e2ab` 会话请求仅文档/低敏摘要的只读审查（`pm-fd546597`），请求已读；截至本文件提交前尚未返回独立 verdict，不能写成独立审查通过。为遵守不新增 writer/会话的边界，未另启动 review会话。本次按仓库能力链降级执行 **self_review + plan_check，显式 doc-only review bypass**，仅限已获授权的本文件提交：逐项复核固定构件、9次状态、沙箱对照、锁/回读/进程/清理摘要、原W6与Node退出边界；并将真实导出中79个敏感字符串直接对照本文件，匹配0、账号ref匹配0，不输出值；secret形状/乱码扫描及单path staged diff检查通过。监督原任务及 `pm-543bb426` 均明确要求本人仅新doc提交；此bypass不是原M业务或共享发布的审查授权。若后续独立反馈需修正文档，以新的本人单path提交处理，不amend或重写并行历史。
