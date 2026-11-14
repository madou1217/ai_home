# 自启验证报告：Linux systemd（含真实 reboot）

- 日期：2026-11-14
- 范围：`aih server start` 在 Linux 上生成并安装的 systemd user unit，能否在真实重启后自动拉起 Go 服务
- 结论：**通过**。enabled unit + linger + 生成器写入的 `AIH_HOME_DIR` 三者配合，开机由 systemd 直接运行 `aih-server`，Node 只是它的子进程
- 相关提交：`142ac304`（Windows 计划任务）、`f442f6ef`（启动单元钉住 AIH_HOME_DIR）

## 1. 环境

| 项 | 值 |
|---|---|
| 发行版 | Ubuntu 26.04 LTS (amd64) |
| systemd | 259 |
| 用户管理器 | `systemctl --user is-system-running` = running |
| linger | `Linger=yes`（无登录会话也会启动用户管理器） |
| Node | v22.22.1（`/usr/bin/node`） |
| 被测二进制 | 从该提交交叉编译：`GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/aih-server` |

测试使用隔离 home（`AIH_HOME_DIR=<test-root>/.ai_home`、端口 19556），不触碰主机上已有的生产实例。

## 2. 被测 unit

由 `lib/cli/services/server/autostart.js` 的 `buildLinuxUnit()` 原样生成（仅将安装前缀换成测试目录）：

```ini
[Unit]
Description=AI Home local server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="<test-root>/bin/native/linux-x64/aih-server" "--front-door" "--supervise-node"
WorkingDirectory=<test-root>/bin
Restart=always
RestartSec=5
TimeoutStopSec=12
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="AIH_HOME_DIR=<test-root>/.ai_home"
StandardOutput=append:<test-root>/.ai_home/logs/services/background-supervisor.log
StandardError=append:<test-root>/.ai_home/logs/services/background-supervisor.log

[Install]
WantedBy=default.target
```

安装方式与生产一致：`systemctl --user daemon-reload` → `systemctl --user enable --now <unit>`。
`systemd-analyze verify` 对该 unit 返回 0。

## 3. 重启前基线

| 检查 | 结果 |
|---|---|
| `is-enabled` | enabled（`default.target.wants` 链接存在） |
| `is-active` | active |
| healthz / readyz | 200 / 200 |
| `/v1/models` | 200 |
| `/v0/webui/accounts` | 200 |
| 进程树 | Go 为 systemd 直接子进程，Node 为 Go 子进程 |
| boot_id | `b422911d-…` |
| uptime since | 2026-11-14 02:57:06 UTC |

## 4. 真实 reboot

| 时刻（UTC） | 事件 |
|---|---|
| 12:17:02 | `sudo -n systemctl reboot` |
| ~12:17:10 | 主机离线（约 8s） |
| ~12:17:23 | 新内核起来（`uptime -s` = 12:17:23），SSH 恢复 |
| 12:17:31 | journal：`systemd[810]: Started aih-linux-e2e.service - AI Home local server.` |
| 12:18:01 | 数据面复核完成 |

`boot_id` 变为 `ecb857a9-…`，确认是整机重启而非服务重启。

## 5. 重启后结果（无任何手工操作）

| 检查 | 结果 |
|---|---|
| 测试 unit | active / enabled |
| `NRestarts` | 0（首次启动即成功，未走重启补偿） |
| 主进程 | PID 874，PPID 810（`systemd --user`） |
| 启动命令 | `aih-server --front-door --supervise-node` |
| `/proc/874/environ` | `AIH_HOME_DIR` 正确 |
| healthz / readyz | 200 / 200 |
| `/v1/models` | 200 |
| `/v0/webui/accounts` | 200 |
| Node 子进程 | 由 Go 拉起（私有端口） |
| linger | 仍为 yes |
| 同机其它 enabled 用户单元 | `com.meadeo.ai_home`（Node-first 生产实例 9527）、`nexus-cloudflare`、`nexus-ingress` 均自动恢复，无 failed |

观察：生产 unit 是 Node-first（`aih server serve`），重启后需十几秒才健康（Node 先起再拉 Go）；Go-first 的测试 unit 2s 内就绪。

## 6. 过程中发现并修复的问题

### 6.1 启动单元没有钉住 AIH_HOME_DIR（已修，`f442f6ef`）

systemd user unit 不继承安装者的 shell 环境。首轮 unit 缺少 `AIH_HOME_DIR` 时，服务读的是 `~/.ai_home`（该机为生产 home），真实表现：

```
aih-server 启动失败: client key 必须为 32-8192 个非空白且非控制字符
```

并进入 `auto-restart` 循环（`NRestarts=7`）。修复：生成器在 systemd `Environment`、Windows `serve.cmd` 的 `set`、VBS 的 `Process` env、launchd plist 的 `EnvironmentVariables` 四处显式写入 home。修复后生成的 unit 无需任何手工 env 即可启动（本报告第 3-5 节即基于修复后产物）。

### 6.2 验证操作覆盖了主机上的生产 unit（已还原，未造成中断）

首轮测试误将测试 unit 写到主机已有的 `com.meadeo.ai_home.service` 上。通过 `systemctl show` 读取**内存中**的单元属性（ExecStart / WorkingDirectory / Environment / Restart / TimeoutStopUSec / 日志路径），逐项还原 unit 文件并 `daemon-reload`，核对与覆盖前一致：服务全程 active、9527 健康 200。后续改用独立 unit 名，避免再次触碰生产单元。

## 7. 边界

- 未验证：Windows 真实登录（ONLOGON）触发——其等价路径已由 `schtasks /Run` 覆盖（见 `142ac304`）。
- 本次 reboot 会重启主机上所有服务（生产 aih、nexus 两个单元），已完成并确认全部恢复。

## 8. 复现要点

1. 基线与 unit 文本：第 2、3 节。
2. 触发：`systemctl --user enable --now <unit>` 后 `sudo systemctl reboot`。
3. 判定：`boot_id` 变化、`systemctl --user is-active` = active、`NRestarts` 为 0、healthz/readyz 200、`/proc/<pid>/environ` 含正确 `AIH_HOME_DIR`、journal 有 `Started <unit>`。
4. 清理：`disable --now`、删除 unit 与 `default.target.wants` 链接、`daemon-reload`、删除测试 home。
