# 自动代理（auto egress）验证记录

本文记录「直连网络失败后自动使用受管代理并轮换」这条链路的验证方式与结果，
以及**尚未验证**的部分。它是验收依据，不是设计文档；设计理由写在对应源码注释里。

## 覆盖范围

同一条 `updateproxy.RetryWithEgress` 状态机服务三个入口：

| 入口 | 装配位置 | 触发条件 |
| --- | --- | --- |
| `aih <provider> install\|update` | `cmd/aih/provider_update.go` | 直连失败且归类为网络错误 |
| 缺失 CLI 的自动安装 | `internal/host/aihcli/provider_cli_remediation.go` | 同上 |
| WebUI 工具箱安装作业 | `internal/runtime/toolkit/apps/jobs.go` | 同上，仅当作业未显式指定代理 |
| `aih proxy serve` 长驻自愈 | `cmd/aih/proxy_serve_heal.go` | 续期失败且属于租约丢失 |

显式 `--proxy`（或作业里显式传 proxy）**永不**轮换：用户点名出口就是选定出口。

## 已真机验证（macOS 15 / darwin arm64，本地 aih-server）

### 1. CLI 入口

死代理端口 + 空 npm 缓存，令直连必然失败：

```
[aih] 由于连接被拒绝，已自动启用代理 AWS（仅本次任务，不改全局配置）。
[aih] codex CLI 更新验证通过: 0.171.0 -> 0.171.0
[aih] 本次经自动代理 AWS 完成；全局代理配置未改动。
```

### 2. 轮换 A→B

真实租约 + 真实 npm 请求，确认首个出口失败后换下一个并逐条告知：

```
[aih] 由于连接被拒绝，已自动启用代理 AWS（仅本次任务，不改全局配置）。
[aih] 代理 AWS 不可用（连接被拒绝），已自动切换到 🇯🇵JP02。
```

候选全部尝试完时：`自动代理的候选出口都已尝试（…）；不再重试。`

### 3. WebUI 作业

server 进程带死代理启动，调用
`POST /v1/management/webui/toolkit/apps/install {"appId":"grok","action":"install","kind":"cli"}`：

```
status: succeeded | proxy field: 'AWS'
  A: Grok CLI 官方 macOS/Linux 安装器            ok=False   (curl 28 直连超时)
  A: 由于连接被拒绝，已自动启用代理 AWS（…）      ok=True    (轮换告知进 attempts)
  A: Grok CLI 官方 macOS/Linux 安装器            ok=True    (经代理成功)
```

作业视图 `proxy` 字段由建单时的空值回写为 `AWS`。轮换告知放进 `attempts`
而不只是进度 label——label 会被下一个计划覆盖，实测原先看不到。

### 4. 健康账本回写

成功出口按**出口身份**记账（不是显示名：账本条目名是 `node-<index>` / `ssh|connId`）：

```
ssh|conn_d05358604a4ee45b:  uses 0 -> 1, successes 0 -> 1
```

### 5. 候选排序

排序改为与 `NodeHealthLedger.PickBest` 共用同一份评分后，候选顺序由健康账本驱动；
SSH 出口（账本无事实，计「从未探测」500 分）正确排在池内陈旧失败（300 分）之前。

### 6. `proxy serve` 自愈

运行中的常驻入口被服务端删除租约（404）后：

```
[aih] 出口已失效（代理管理 API 返回 HTTP 404），正在自动切换…
[aih] 已切换到出口 AWS（入口已重建）。
[aih] HTTP 代理入口：http://…@127.0.0.1:64604   ← 端口已换，入口重建
```

TUN 路由、系统代理与已发布的 `run/proxy/entry.json` 随整套入口一起重建。

### 7. 反例（必须不触发）

| 真实失败文案 | 是否触发代理 | 理由 |
| --- | --- | --- |
| `npm error code ETARGET No matching version found` | 否 | 版本不存在，换出口无用 |
| `npm error code ENOTEMPTY ... rename` | 否 | 文件系统问题 |
| `npm error code E403` | 否 | 上游拒绝 |
| `此 Windows 官方安装器不能保证所有下载使用 --proxy` | 否 | 显式终止条件，见下 |

## Windows 真机验证（已完成）

主机：`Windows - MeaDeo`（`madou@www.desired.cn:22009`，Windows 10.0.26300）。
主机信息从 `aih.db` 的 `ssh_connections` 查，见 skill
`assets/provider-skills/remote-realmachine`。

### 发现并修复的两个真实缺陷

**1. PowerShell 安装器完全无视代理**

`Invoke-RestMethod` / `Invoke-WebRequest` **不读** `HTTP_PROXY`/`HTTPS_PROXY`。
真机对照：

| 设置 | `irm https://x.ai/cli/install.ps1` |
| --- | --- |
| 仅 `$env:HTTPS_PROXY=http://127.0.0.1:9` | 成功返回脚本（代理被忽略） |
| 加 `[System.Net.WebRequest]::DefaultWebProxy` | `无法连接到远程服务器`（代理生效） |

影响 6 个 provider 的 Windows 计划（claude / grok / opencode / kimi / kiro /
codebuddy）。自动代理选中出口后，这些安装器仍会直连下载——「看起来成功、
实际没走代理」。

修法用 `DefaultWebProxy` 而非给单条请求加 `-Proxy`：官方脚本首屏之后还会继续
下载，只代理第一跳没用。代理地址从环境读，不拼进脚本——Windows 上 argv 对所有
进程可见。

**2. `ALL_PROXY` 让 Windows 自带 curl 全部失败**

```
curl: (5) Unsupported proxy syntax in 'http://aih:tok@...': Port number was not a decimal number
```

设成空串更糟：cmd 传播出 `' '`，curl 报 `Unsupported proxy syntax in ' '`。
所有走 curl 的 Windows 计划（cmd 脚本计划全部）在设了代理后反而**连下载都发不出去**。

修法：Windows 上从任务环境里**删除** `ALL_PROXY`/`all_proxy`（不是设空），
`HTTP(S)_PROXY` 已足够 curl/npm 使用；执行层新增 `UnsetEnv` 表达「移除继承变量」。
真机核对：生成的任务环境里 `HTTP_PROXY`/`HTTPS_PROXY` 无尾随空白、`ALL_PROXY`
不存在、`UnsetForTask` 返回 `[ALL_PROXY all_proxy]`；干净环境安装仍成功。

### 3. WebProxy 不会把 URL 里的凭据当代理凭据（PS 5.1）

受管租约地址是 `http://aih:<token>@127.0.0.1:<port>`。PowerShell 5.1 既不会把
URL 里的 userinfo 当凭据，`New-Object System.Net.WebProxy($url)` 和 `-Proxy $url`
都一样。真机测（代理侧记录 `Proxy-Authorization`）：

| 写法 | 结果 | 代理收到的头 |
| --- | --- | --- |
| `irm -Proxy 'http://aih:tok@…'` | 407 | `MISSING` |
| `DefaultWebProxy = WebProxy('http://aih:tok@…')` | 407 | `MISSING` |
| `WebProxy('http://host:port')` + `.Credentials` | OK | `OK` |

**这正是先前验证方法的缺陷**：只用死端口测「连接被拒」，认证路径从未被走通，
于是「代理生效」的结论是错的。修正后计划会重建无凭据地址并显式设
`.Credentials`；用真实受管租约（端口 9618）在该主机上跑通 irm 下载，curl
路径同样跑通。

### 仍未验证

- **WinGet 计划的代理语义**：真机上 WinGet 直接下载成功、无视代理。当前
  `proxyActive` 的 Windows 检查只覆盖 `kind=cli` 且计划为 npm 的情况，
  WinGet/原生安装器需要单独确认是否应当拒绝——**待定，属于设计决策**。
- **真实租约端到端**：Windows 上只用伪造的死代理验证了「代理被正确应用/拒绝」，
  没有用真实受管出口跑完整安装（那需要 Windows 上可达的 Server 配置）。

## 相关源码

- `internal/runtime/updateproxy/egress.go` — 轮换状态机
- `internal/runtime/updateproxy/retry.go` — `RetryWithEgress`（唯一重试实现）
- `internal/runtime/providercliupgrade/egressfailure.go` — 网络失败归因
- `internal/adapters/managementproxy/client.go` — 管理面租约与 loopback 入口
- `internal/runtime/sshproxy/leases.go` — 候选排序、`Rotation`、auto 回落
- `internal/runtime/egress/health_select.go` — 出口偏好分（唯一实现）
