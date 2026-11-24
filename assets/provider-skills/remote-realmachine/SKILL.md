---
name: remote-realmachine
description: Where this machine's remote SSH hosts are and what each is for. Use when you need a real Windows or Linux box to run something on, or when you are about to ask the user for a machine's address, port, or login. Never ask — the hosts are in the aih database.
---

# 远程主机名单

**不要再问用户「你的 Windows 机器地址是什么」。** 所有连接的唯一事实源是
`<aiHome>/aih.db` 的 `app_kv` 表，键 `ssh_connections`（JSON 数组）。

只读打开，不要写：

```bash
python3 - <<'PY'
import sqlite3, json
con = sqlite3.connect('file:/Users/model/.ai_home/aih.db?mode=ro', uri=True)
raw = con.execute("select value from app_kv where key='ssh_connections'").fetchone()
for c in json.loads(raw[0]):
    print(f"{c['id']:22} | {c.get('label',''):26} | {c.get('user')}@{c.get('host')}:{c.get('port')} | auth={c.get('authType')} | key={c.get('identityFile') or '-'}")
PY
```

`aiHome` 默认 `~/.ai_home`。远端网关/投影 HOME 下可能没有这个库，那就用宿主的。

## 已知主机（2026-11 实测，仍以查询结果为准）

| 标签 | 连接 | 平台 | 用途 |
| --- | --- | --- | --- |
| `Windows - MeaDeo` | `madou@www.desired.cn:22009` | Windows 10.0.26300，cmd.exe | 真机验证 Windows 专属行为 |
| `AWS` | `ubuntu@ec2-16-178-55-97.ap-southeast-2.compute.amazonaws.com:22`，`~/.ssh/aws.pem` | Ubuntu | Linux 服务端验证 |
| `Linux - desired.cn:22008` | `model@www.desired.cn:22008`，`~/.ssh/id_rsa` | Linux | 另一台 Linux |
| `Local Mac` | `model@127.0.0.1:22` | macOS | 本机，走回环 |

`authType=agent`（Windows、Local Mac）走本机 `ssh-agent`，**不要**去找密钥文件。
`authType=key-file` 才用 `identityFile`，路径里的 `~` 要展开。

## 各机已知状态

**Windows - MeaDeo**

- 已装 `aih.exe`：`%LOCALAPPDATA%\aih\aih.exe`
- `aih-server` 常驻在 9527，由 Windows 计划任务管理（`aih server status` 可查）
- 有 Git（`C:\Program Files\Git\cmd\git.exe`）、Go（`C:\Program Files\Go\bin`）、Node v22
- **没有**本仓库副本（`C:\Users\madou\ai_home` 不存在）
- 用户家目录 `C:\Users\madou`，已存在 `.ai_home`

**AWS**

- 服务听 `127.0.0.1:9527`（只回环，SSH 进去再访问）
- 管理密钥从远端 `aih.db` 的 `app_kv` → `config:server` 读

## 相关数据库键

同一个 `aih.db` 里还有：

- `ssh_workspaces`：主机上的工作目录（`connectionId` + `remoteRoot`）
- `ssh_known_hosts`：指纹，首次连接核对用

这三张表都由 AIH 自己维护，最好的读取方式是 `aih ssh ...` 或 WebUI 的 SSH 页，
手工查库只用于脚本化。
