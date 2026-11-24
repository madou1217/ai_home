---
name: remote-realmachine
description: Run real-machine verification of this repo's Go/CLI changes on the user's remote Windows (and Linux) machines over SSH. Use whenever a change needs Windows-only verification (npm.cmd adapter, Windows installers, system proxy, scheduled task service), or whenever you are about to ask the user "do you have a Windows machine / what are its details". Never ask — the hosts are discoverable.
---

# 远程真机验证（remote-realmachine）

用户明确要求：**不要再问 Windows 机器的信息**。所有主机都在 `ssh_connections` 里，
自己查。每次凭本能想问「你的 Windows 机器地址/账号是什么」时，回到这份 skill。

## 0. 铁律

- **先查主机，再动手**。绝不凭记忆写 IP/端口/用户名。
- **不要在远端复制整棵源码树**（仓库 AGENTS.md 明令禁止）。用
  `git worktree`/临时目录 `mktemp -d`，用完即删。
- **不要动远端的用户配置**（真实账号、`~/.ai_home` 现状）。验证要落在临时
  `AIH_HOME_DIR` / 临时 prefix 上，除非用户明确要求在真环境跑。
- 远端是**用户的机器**，可能正跑着服务：改动前先看 `aih server status`、
  有没有活跃推理（`/readyz` 里的 `active_inference`）。
- 结论要区分「真机验证过」与「静态核对」。没有真机证据就写没有。

## 1. 发现主机（唯一事实源）

主机存在本机 `aih.db` 的 `app_kv` 表，键 `ssh_connections`（JSON 数组）。
只读打开，别写：

```bash
python3 - <<'PY'
import sqlite3, json
con = sqlite3.connect('file:/Users/model/.ai_home/aih.db?mode=ro', uri=True)
raw = con.execute("select value from app_kv where key='ssh_connections'").fetchone()
for c in json.loads(raw[0]):
    print(f"{c['id']:22} | {c.get('label',''):26} | {c.get('user')}@{c.get('host')}:{c.get('port')} | auth={c.get('authType')} | key={c.get('identityFile') or '-'}")
PY
```

已知机器（2026-11 实测，仍以查询结果为准）：

| 标签 | 连接 | 用途 |
| --- | --- | --- |
| `Windows - MeaDeo` | `madou@www.desired.cn:22009`，agent 认证 | **Windows 真机**，Git/Go/Node/aih-server 都在 |
| `AWS` | `ubuntu@ec2-…`，`~/.ssh/aws.pem` | Linux 服务端验证 |
| `Linux - desired.cn:22008` | `model@www.desired.cn:22008`，`~/.ssh/id_rsa` | 另一台 Linux |

`authType=agent` 表示走本机 `ssh-agent`，**不要**去找密钥路径。

## 2. Windows 上怎么下命令

Windows 默认 shell 是 cmd.exe。两种写法，别混：

```bash
# 单条/少量命令：cmd /c 包起来，用 & 串接
ssh -o ConnectTimeout=10 -p 22009 madou@www.desired.cn 'cmd /c "where go & go version & echo %USERPROFILE%"'

# 多条或需要引号安全：把脚本写成本地文件再喂给远端 cmd（避免引号地狱）
ssh -p 22009 madou@www.desired.cn 'cmd /s /c "C:\path\script.cmd"'
```

注意：
- 远端中文输出在 SSH 下常是乱码（GBK）。**别用中文判断成功与否**，用 exit code、
  ASCII 标记（`echo OK`）或读文件。
- 路径反斜杠：在单引号里原样传，`cmd` 能收。
- 后台常驻进程用 `start /b`；SSH 断开可能带走它，长任务要留意。

## 3. 在这台 Windows 上验本仓库的改动

远端**没有**仓库副本（实测 `C:\Users\madou\ai_home` 不存在），但已装好
`aih.exe`（`%LOCALAPPDATA%\aih\aih.exe`）与运行中的 `aih-server`（端口 9527，
Windows 计划任务常驻）。

### 3.1 只验 CLI 行为（多数改动够用）

把新编译的二进制传过去覆盖临时副本，用独立 HOME 跑，不碰真实配置：

```bash
cd /Users/model/projects/feature/ai_home
GOOS=windows GOARCH=amd64 go build -o /tmp/aih-verify.exe ./cmd/aih
scp -P 22009 /tmp/aih-verify.exe madou@www.desired.cn:C:/Users/madou/aih-verify.exe

# 远端：独立 HOME + 强制网络失败，验证自动代理
ssh -p 22009 madou@www.desired.cn 'cmd /c "set AIH_HOME_DIR=C:\Users\madou\verify-home && set HTTP_PROXY=http://127.0.0.1:9 && C:\Users\madou\aih-verify.exe codex install"'
```

**Windows 交叉编译是验证的第一道关**：`GOOS=windows go build` 能立刻抓出
`syscall`/`os` 平台差异，不需要远端机器。

### 3.2 验 server 侧行为（需要新二进制）

远端已有运行中的 server。**不要**直接覆盖它——先问用户，或在临时端口起一个：

```bash
# 远端编译（远端有 Go）
ssh -p 22009 madou@www.desired.cn 'cmd /c "cd C:\tmp\ai_home && go build -o C:\tmp\aih-server.exe .\cmd\aih-server"'
# 临时端口 19527 + 临时 AIH_HOME_DIR 起一个，验完关掉
```

要验「服务重启后的行为」才需要动真实例，那必须先征得用户同意。

### 3.3 Windows 专属路径清单

这些代码只在 Windows 生效，真机验证优先覆盖：

| 路径 | 文件 | 验什么 |
| --- | --- | --- |
| npm 启动适配 | `internal/runtime/toolkit/apps/codex_npm_command.go` | `npm.cmd` 经 node 启动，argv 不含代理凭据 |
| 代理环境变量 | `internal/runtime/updateproxy/environment.go` | `%HTTP_PROXY%` 等被 npm/curl 识别 |
| 安装器拒绝语义 | `internal/runtime/toolkit/apps/cli_lifecycle.go` | 非 npm 官方安装器在 proxyActive 时拒绝 |
| 计划任务服务 | `internal/runtime/distributioninstall/` | `aih server status` 的 autostart |
| 进程组终止 | `internal/adapters/hostexec/*_windows.go` | 取消能带走子进程 |

## 4. 验证报告的写法

每条结论后面必须有**可复核的证据**，并标明来源：

- 「真机验证（Windows 10.0.26300）」+ 命令 + 关键输出行
- 「静态核对」+ 说明为什么没真机跑（例如只改了 darwin 路径）
- 「未验证」+ 缺什么条件

不要把交叉编译通过写成真机通过。

## 5. 收尾

- 删掉远端临时二进制/HOME/仓库副本；用户机器上不留垃圾。
- 若动过真实服务（重启/改配置），明确告知改了**什么**、**可怎么回退**。
- 本地临时产物（`/tmp/*.exe`）一并清掉。

## 反例（做过就别再做）

- ❌ 问用户「你的 Windows 机器 IP 是多少」——查 `ssh_connections`。
- ❌ 在远端 `git clone` 一份完整仓库当验证环境——禁止；用临时目录且用完即删。
- ❌ 用中文输出的存在与否判断远端命令成功——SSH 下会乱码，看 exit code。
- ❌ 直接覆盖远端正在运行的 `aih-server.exe`——先确认有没有活跃推理。
