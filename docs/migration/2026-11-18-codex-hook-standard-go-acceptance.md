# Standard Go server Codex CLI hook options and bounded discovery

时间：2026-11-18 04:02 Asia/Shanghai。Owner：原监督 `01a1df63`。仅关闭标准 Go server 未接收显式 CLI hook options 与 native discovery 全文件正则扫描两个具体缺口，不代表完整 R2 或第一方 Node 退出。

## 源码、交付与未加载边界

- source：`758bb6443a25e1e59bd843c74b92221235dd36be`，恰两个生产路径，30+/19-。
- `internal/host/aihserver/composition.go`：13+/13-；把 `Options.CodexHooks` 经 typed handler dependencies 交给已有 `buildCodexHooksDaemonOptions`，复用同一 daemon/lifecycle，保留 context/host home。未把默认 false 改 true。
- `internal/runtime/codexhooks/cli_hook.go`：17+/6-；仅六处 marker/alias/Node-entry/pnpm/delegate discovery 改用已有 prefix reader，最多16 KiB，含 NUL 不按发现文本解析。完整 wrapper 比较、snapshot、write/admission/restore 未被全局改写。
- owned-only composition SHA：`1794243ff980d75087d0c9c02fe81e848fc086eabd9ae18dd3a5fd0c18e1131e`；cli_hook SHA：`ce29443d47c73c7faeb96f11646591dfc454af4a1e35de430d3409dba45ce0c2`。
- 独立 source review 各 Important0/Critical0，绑定这两个精确 hash；源码审查不替代 runtime。位于16 KiB之后的元数据或前缀含 NUL 的自定义 shim 不再被这些 discovery 识别，不宣称任意超长 shim 全兼容。
- 提交使用普通私有 archive 的 commit-view 与一次性 index、显式2path。共享 composition 另有 peer ContextWindows 8+/7-，物理文件完整保留而未夹入提交；主 index 全文件 bytes 与所有 stage records 前后精确相等，未同步共享文件任何 peer hunk。receipt 保存该次 digest，不挪用其他 checkpoint 的旧 digest。
- push：本文写入时此 commit 尚未单独新核远端；后续统一 push + fresh ls-remote 另报。
- loaded：仅私有标准 `./cmd/aih-server` 短进程；未替换标准 binary、未变正式 hook/CLI、未重启共享9527或AWS。

## 不可变来源与构件

固定 committed base `2446378e68ad458458495f08fbda561e193fa160`，git archive SHA `4cf40949dc8f697129ffb8e4da4bf386c40813297414ea1032786fe520a4f014`；只覆盖上述 owned source。此基线没有后来 W0 的 transport-neutral core，不把本构件当最新整仓集成发布。

| 真实构件 | SHA-256 |
| --- | --- |
| baseline standard server | `fd2c154af85ebf734da293a4ec30dfa036e9ab53fb5ef182523c4cf0465ef6b8` |
| options-only candidate，保留失败复现 | `1af0c565eaf67c80a0432bcff34fa59aa263d3cfaf8ba80421c0c3af8853bbd7` |
| final two-file standard server | `92add0e2b99974493c6816d625d70b23c09d93efa5ed413b745c7283d0c5163c` |
| frozen native Go CLI used by generated wrapper | `d4cf2b619d75e2e4c18d30098a64b37bab2d99092b232920330ee6c79fdaa31f` |
| actual official Codex 0.167.2 private copy | `97bc82fd46f117cf10efb95e6ff0c81dc4784f5797bcdc2cb75093ba09e4def0` |

`CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 GOWORK=off go build -mod=readonly` 与 focused `go vet` 均 exit0，manifest 绑定实际源码与产物。未新增仓库 tests、fixture、mock、branch 或 git worktree。Python 文件是一次性操作 driver，不代替/复制产品实现。

## 根因与保留失败

原 W0 在真实标准 server 加 `--enable-codex-cli-hook=true`，ready/status 可用但等待120秒后 CLI 仍 disabled。cmd 已生成正确 options，composition 丢弃而只启动 notification bridge；baseline 在本轮再次实际复现，未安装 wrapper、native 原文件未改。

接线后，official native binary 约271 MB。既有 Status → ResolvePaths → isTrustedUpstreamFile → isCleanExecutableSnapshot → resolveUpstreamDelegateTarget 对 native 整文件读取再 regexp；高频 status 叠加 self-heal 导致明显耗时。保留以下尝试，不称所有尝试 clean：

1. 首轮使用1秒 self-heal 与10秒 HTTP timeout，中断于 status 等待。
2. options-only 已能安装、真实版本 exit0，但 driver 缺 CODEX_HOME 目录导致官方 warning；只修私有 driver 创建目录，不改产品掩盖 stderr。
3. 22秒观察未等到修复，后续约24.8秒观察到；不把过短 deadline 归为产品永不恢复。
4. 重复3秒 status 请求使私有 restart PID17573 CPU179%、约2.3 GB，TERM 未退出。先保存实际 sample 与绝对 candidate/端口/私有根身份，随后只 SIGKILL 本次自有私有进程；未碰共享服务。清前另次重试真实得到 `backup_core_writer_busy`，未绕锁。sample 指向 discovery 的全 native 正则；本次有界读取后重跑下表。

## 真实标准 CLI 最终验收（03:52:15–03:52:30）

每实例独立 HOME/AIH_HOME/CODEX_HOME/端口/密钥，actual official Codex 复制到 own `home/bin/codex`。标准 server 不带 front-door/supervise-node/node-base；PATH 无 node，配置的绝对 Node executable 实际不存在。未读真实 credential/用户配置，不发上游推理请求。

启动命令形态：`candidate --host 127.0.0.1 --port <own> --enable-codex-cli-hook=true --enable-codex-desktop-hook=false --codex-cli-hook-self-heal-interval-ms 5000`。所有配置、profile 与 wrapper 变动仅在 own private HOME；不是 production-host bootstrap 冒充标准入口。

| 真实操作 | 结果 |
| --- | --- |
| baseline + 显式 CLI true | status200，CLI disabled；无 state file，native target hash 原样 |
| final candidate + 显式 CLI false | disabled，无 wrapper，native 原样 |
| final candidate + 显式 CLI true/Desktop false | status200，enabled=true，实际生成 Go-owned wrapper/backup；Desktop/VSCode false，self-heal 存在 |
| 实际生成的公开 wrapper `--version` / `-V` | 两次 exit0，stdout 精确 `codex-cli 0.167.2\n`、stderr 空；这两次版本调用不需要 Node |
| hook management 缺鉴权 | 401，未放宽安全门 |
| 只把自有 wrapper 换回同一 official native copy | Go self-heal 4.756秒内重新生成相同 wrapper hash，official backup hash 保持；修后真实 version exit0 |
| 停止私有 Go 后，同 HOME/state 重新启动 | enabled、wrapper/official backup hash 均保持；正常停止 exit0 |
| 最终四个 server PID29319/29390/29443/30042 | 全部 exit0；最终72个已观察 PID 检查，同 owned root 存活数0，旧17573也已退出 |

final generated wrapper SHA `71a8ea870021c407e09fba0edcd0266371440afdc39ffb6278c43388ed3fa2a9`。这是该私有路径生成物，不用于宣称正式安装的所有 wrapper 字节相同。

## Node 与下一门禁

配置未启动 AIH Node server，也未使用第一方 Node backend/RPC实现 hook安装/状态/self-heal。**本标准 CLI 没有 OS deny-fork/exec**，warmup 的 observed topology 中实际包含绝对 Homebrew Node 子进程；本轮未逐项分类，不声称整服务或整机零 Node。上表只证明两条版本调用的 Go/native 路径在其 Node executable 缺失时工作，及标准 Go hook生命周期成立；第三方 CLI探测、第一方 Node宿主、操作侧 driver 分开。

仍 OPEN：enabled CLI stdio 全形状及 metadata/Goal/hydration/hidden/pagination/conditional title/rollout writer；Desktop/VSCode 真安装与GUI；Windows wrapper/跨平台实际运行；用户现有wrapper升级及旧Node self-heal/host writer调用归零；完整新构件/批准/正式加载；剩余R0–R8与最终默认无第一方Node监督拓扑。W0后续 stdio core 自己的源码/验收独立登记，不由本窄门禁代证。

composition 已在源码提交后顺序释放给原 tokenRefresh owner `01a1ea74` 的既有最小接线；R4等其释放 webuiroutes，不并发写同一共享 hunk。目标持续 active，不因这两处 checkpoint 结束全量迁移。

## 证据

root：`/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-codex-hook-options-20261118-c9k1cqul`；pointer：`/tmp/aih-codex-hook-options-latest-20261118.txt`。完整source/archive/build/driver与私有原始数据留在受限根，不提交credentials/config正文；此根尚未获单独cleanup批准，不广泛删除。

- `evidence/build-manifest.json`、`build-v2-manifest.json`、`source-manifest-v2.json`、`source-commit-receipt.json`。
- 最终 `result.json` SHA `751959af3bccd9e81ec8df4eb2dd0b57876f17abd5c23c70ec0510bc57003416`；`operations.json` SHA `2d1c5a34072af8bcb06138efe805f5eb152b7c2fb00be483ee3945db8f51f3cc`。
- `post-run-pid-audit.json` SHA `63551dcd8750f2ebb6707dc6e089f9c5b6e429a5d4ba56d2c6c992d735a49801`；`observed-executable-topology.json` SHA `9638a4f55110f7182dd82561de40e16f7c957029f634625b42ab25595e340b09`。
- `attempt1/2/3/4-result.json`及各 operations；`own-hung-restart-cleanup.json`与sample保留早期失败/自有私有进程终止证据，不以最终绿覆盖。
