# Agent CLI 版本限制记录（按版本追加）

> 目的：把「某个 CLI 版本下 aih 的某个默认行为会被上游拒绝」这类**版本相关事实**集中
> 记录在一处，便于升级 CLI 后对照复查、并持续追加新版本的新限制。
>
> 维护方式：
> 1. 每条记录都绑定**已取证的版本号**（`<cli> --version` 实测值），不写「大概」。
> 2. 只记录**实测结论**：命令原文 + 实际报错/结果。没有复现的命令写成「未取证」，不要推测。
> 3. 新版本行为变了 → **新增一条**（标出新版本），不要直接删旧条目；旧版本仍可能被用户安装。
> 4. 升级任何 provider CLI 后，先跑 `npm run providers:usage -- --write` 刷新
>    `docs/providers/agent-cli-usage.md`，再回来核对本文的「受影响范围」是否仍然成立。

## 记录格式

| 字段 | 含义 |
| --- | --- |
| CLI / 版本 | 实测的二进制与版本号 |
| 触发条件 | 哪些参数组合会命中该限制 |
| 实测报错 | 上游原文，逐字保留（便于 grep） |
| aih 影响 | aih 哪条启动链路会被打中 |
| 当前处置 | 已规避 / 待修 / 仅记录 |

---

## codex

### codex-cli 0.163.0：resume 远程任务时拒绝任何权限覆盖

| 项目 | 内容 |
| --- | --- |
| CLI / 版本 | `codex-cli 0.163.0`（macOS，`~/.codex/packages/standalone/releases/0.163.0-aarch64-apple-darwin/bin/codex.aih-original`） |
| 取证日期 | 2026-10-21 |
| 触发条件 | `codex resume <SESSION_ID>` 同时带**任意**权限覆盖：`-s/--sandbox`、`-a/--ask-for-approval`，或等价的 `-c sandbox_mode=…` / `-c approval_policy=…` |
| 实测报错 | `Error: Permission overrides are not supported when resuming a remote task.` |
| 同族文案 | 二进制约 0.163.0 内还存在 `Permission overrides are not supported when forking a remote task.`（fork 分支，本机未单独取证） |
| aih 影响 | `aih codex resume <id>`（以及 WebUI 触发的同形启动）。aih 的 CLI 默认最大权限注入会给 codex 追加 `--sandbox danger-full-access --ask-for-approval never`；同时 resume 链路会注入 `--remote ws://127.0.0.1:<port> --remote-auth-token-env …`。两者同时出现即必挂。 |
| 当前处置 | **已规避**（两条互补的规避，见下） |

**关键判据：codex 认定的「remote task」只看 `--remote` 是否存在。**

实测矩阵（同一台机器、同一会话 id）：

| 命令 | 结果 |
| --- | --- |
| `codex resume <id>` | ✅ 正常恢复 |
| `codex resume <id> -s danger-full-access -a never` | ❌ `Permission overrides are not supported when resuming a remote task.` |
| `codex resume <id> -c 'sandbox_mode="danger-full-access"'` | ❌ 同样报错（换 `-c` 形式同样被拒） |
| `<原始二进制> --no-daemon resume <id> -s danger-full-access -a never` | ✅ 进入恢复流程（不带 `--remote`，限制不生效） |
| `<原始二进制> --no-daemon resume <id> --remote ws://127.0.0.1:<port>` | ❌ `ERROR: --no-daemon cannot be used with --remote.` |

由此两条结论：

1. 限制的对象是 **resume/fork + `--remote`（远程 task）**，不是权限参数本身：
   `aih codex`（裸启动）注入同样参数完全正常。
2. `--no-daemon` 不是逃生门：它与 `--remote` 互斥，而 aih 的 resume 链路会注入 `--remote`。

**aih 的规避（2026-10-21 已落地）**

规避不靠版本号判断，靠两条互补的闸门，因此对接受权限覆盖的旧版本零影响：

1. **启动装配侧**：`lib/providers/permission-flag-catalog.js` 把 `resume` / `fork` 声明为
   `subcommandsBlockingPermissionOverrides`；`buildToolPermissionLaunchArgs` 命中时
   **不注入**默认权限参数，并给出可见提示（`reason: 'remote_resume_permissions_unsupported'`）。
   恢复的会话沿用自己保存的权限，符合语义。
2. **续接链路侧**：aih 在注入 `--remote` 的同一步（`buildCodexRemoteResumeLaunch` /
   `runCodexCliResumeWithLocalAppServer`）用 `stripPermissionIntentFlags('codex', args)`
   摘掉权限旗标，并把摘掉的旗标打到 stderr。即使调用方（显式 argv、旧配置、第三方包装）
   仍然带着 `-s` / `-a`，被上游拒绝的组合也**不会**被发出去。

既有的可用规避方式（不改代码）仍然有效：

- 在 WebUI 的 CLI 工具设置里关掉 codex 的「默认最大权限」开关 →
  注入被跳过（`reason: 'disabled'`）。
- 或显式传入权限参数触发「尊重用户显式参数」分支（`reason: 'explicit'`）。

---

## 追加指南

新的限制条目按下面顺序补：

1. 在本文件对应 provider 小节末尾新增 `### <cli> <版本>：<一句话结论>`。
2. 表格里的「实测报错」逐字复制上游原文。
3. 附一张最小实测矩阵（至少包含「能过」和「不能过」各一条命令）。
4. 如果限制已经被 aih 规避，把「当前处置」改成 `已规避` 并写明规避代码位置。

## zcode

### ZCode Desktop 3.17.1：plan 端点的 `app_version` 与 body `system` 必须同源成对

| 项目 | 内容 |
| --- | --- |
| CLI / 版本 | ZCode Desktop 3.17.1（macOS，`~/Applications/ZCode.app`，`CFBundleShortVersionString` 实测 3.17.1）；对照版本 3.16.3 |
| 取证日期 | 2026-10-31 |
| 触发条件 | 请求打到 `POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`，且 `x-zcode-app-version` 与 body `system` 里的 harness **不是同一个客户端版本产出的** |
| 实测报错 | `HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}` |
| aih 影响 | relay（`lib/server/upstream-endpoints-transport-general.js`）与 `aih zcode -p`（app-server 通道）全线 |
| 当前处置 | **已规避**：画像成对学习/成对发送，见 `docs/providers/zcode-3012-harness-upgrade-incident.md` |

四格矩阵（同账号、9s 间隔）：

| app_version | harness | 结果 |
| --- | --- | --- |
| 3.16.3 | 42/3155/8672 | 200 |
| 3.17.1 | 42/3155/8672 | 405 3012 |
| 3.16.3 | 35/3173/1703 | 405 3012 |
| 3.17.1 | 35/3173/1703 | 200 |

**不要给这个端点加「最低版本」判断**：旧版本 + 旧 harness 依然放行，单方面抬版本号只会
制造错配。判断依据是「这份组合有没有被上游放行过」（缓存画像），不是版本号大小。

另：`x-zcode-app-version` 在 CLI 通道里自报的是 **bundle 版本**（实测 `0.17.1`），
与桌面端版本不是一回事；直接透传同样命中 3012。
