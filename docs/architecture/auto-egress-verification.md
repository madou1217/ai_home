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

## 未验证：Windows 真机

**本仓库当前没有 Windows 机器可用**（AWS 主机是 Ubuntu），因此以下只做了静态核对，
没有真机结论：

1. **代理环境变量在全链路生效**：`curl`、`npm.cmd`、PowerShell `Invoke-WebRequest`
   三类下载方式都识别 `http_proxy`/`https_proxy`/`all_proxy`。环境变量由
   `updateproxy.Environment` 生成（含清空 `no_proxy` 与 `NPM_CONFIG_*` 大小写变体），
   `hostexec.mergedEnv` 叠在宿主环境之上并覆盖同名键。
2. **凭据不进 argv**：代理 URL 含租约令牌，只存在于环境变量；计划 argv 不含。
   已静态核对 `ResolveLifecyclePlans("codex","cli","install",…)` 的全部参数。
3. **Windows 安装器拒绝语义**：无法保证全部下载走代理的官方安装器（非 npm 计划）
   在 `proxyActive` 时直接失败，错误带 `apps.ErrEgressUnsupported`；
   `EgressFailureReason` 先匹配这个标记再判传输层，避免把「安装器不支持代理」
   当成网络错误去反复换出口。

待办：拿到 Windows 机器后补三件事——npm 计划经代理安装成功、官方原生安装器被正确拒绝、
以及拒绝后**不**进入轮换（attempts 里只应有一条失败）。

## 相关源码

- `internal/runtime/updateproxy/egress.go` — 轮换状态机
- `internal/runtime/updateproxy/retry.go` — `RetryWithEgress`（唯一重试实现）
- `internal/runtime/providercliupgrade/egressfailure.go` — 网络失败归因
- `internal/adapters/managementproxy/client.go` — 管理面租约与 loopback 入口
- `internal/runtime/sshproxy/leases.go` — 候选排序、`Rotation`、auto 回落
- `internal/runtime/egress/health_select.go` — 出口偏好分（唯一实现）
