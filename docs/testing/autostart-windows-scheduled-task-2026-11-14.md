# 自启验证报告：Windows 计划任务

- 日期：2026-11-14
- 范围：`aih server start` 在 Windows 上生成并安装的自启（计划任务主路径 + Startup VBS 回退），能否真正拉起 Go 服务并在宿主退出后存活
- 结论：**通过**。计划任务方式启动的 `aih-server --front-door --supervise-node` 在 SSH 会话结束后持续运行，健康检查可用
- 相关提交：`be0edc54`（Windows 可构建）、`861f25c1`（Windows SQLite DSN）、`142ac304`（计划任务优先 + 日志重定向）、`f442f6ef`（启动器写入 AIH_HOME_DIR）

## 1. 环境

| 项 | 值 |
|---|---|
| 宿主 | Windows 主机，OpenSSH Server（非交互 SSH 会话） |
| Shell | cmd.exe / PowerShell 5.x |
| 被测二进制 | `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/aih-server` 交叉编译产物 |
| 隔离 | 独立目录 + `AIH_HOME_DIR` + 端口 19555，不触碰真实 `.ai_home` |

## 2. 被测产物（当前 HEAD 生成器输出）

`aih-server-serve.cmd`（计划任务与远程启动器的落点）：

```bat
@echo off
set "AIH_HOME_DIR=C:\Users\<user>\aih\.ai_home"
"C:\Users\<user>\aih\bin\native\win32-x64\aih-server.exe" "--front-door" "--supervise-node" >> "C:\Users\<user>\aih\.ai_home\logs\services\background-supervisor.log" 2>&1
```

注册命令：

```bat
schtasks /Create /SC ONLOGON /TN com.meadeo.ai_home /TR "<aiHome>\run\aih-server-serve.cmd" /F /RU <user> /IT
```

回退路径 `com.meadeo.ai_home.vbs`（写入 Startup，仅在计划任务被策略拒绝时使用）：

```vbscript
Option Explicit
Dim shell, execObj
Set shell = CreateObject("WScript.Shell")
shell.Environment("PROCESS")("PATH") = "C:\Windows\system32"
shell.Environment("PROCESS")("AIH_HOME_DIR") = "C:\Users\<user>\aih\.ai_home"
Set execObj = shell.Exec("%ComSpec% /c """"<exe>"" ""--front-door"" ""--supervise-node"" >> ""<log>"" 2>&1""""")
```

## 3. 验证项与结果

### 3.1 二进制与参数面

| 检查 | 结果 |
|---|---|
| 交叉编译 | 通过（见 4.1 的前置修复） |
| `aih-server.exe --help` | 列出 `-front-door`、`-supervise-node`、`-host`、`-port` |

### 3.2 生成产物的引号与执行

| 检查 | 结果 |
|---|---|
| `serve.cmd` 形式（cmd /c） | `CMD_EXIT=0` |
| 生成器 VBS 的 Exec 引号信封，普通路径 | exit 0 |
| 同上，含空格路径（`space dir\aih-server.exe`） | exit 0 |

### 3.3 计划任务端到端

按生产 `/TR`（指向 `serve.cmd`）注册临时任务（`/SC ONCE`；生产为 `ONLOGON`，仅触发方式不同），`/Run` 后：

| 检查 | 结果 |
|---|---|
| `healthz` | True（轮询命中 200） |
| `readyz` | 200（测试库无账号，`ready:false`） |
| 监听 | `127.0.0.1:19555` |
| 进程 | `aih-server.exe` 存活，父进程为任务的 cmd，持续超过 5s |
| 任务状态 | Running |
| `schtasks /End` + `/Delete` 后 | 无残留进程、无残留任务、测试目录已删除 |

补充：首轮曾用 Startup VBS 方式启动，出现进程随 cscript 退出而消失（见 4.3），因此生产改以计划任务为主路径。

## 4. 验证中发现并修复的问题

### 4.1 Windows 无法构建（`be0edc54`）

`syscall.Access`、`syscall.Kill`、`syscall.Stat_t` 在 Windows 上不存在，交叉编译失败。已收口到 `internal/runtime/platform`（Unix / Windows 双实现：`IsExecutable`、`IsWritable`、`FileIdentity`、`ProcessState`、`ProcessAlive`、`Terminate`）。

### 4.2 SQLite DSN 非法（`861f25c1`）

`C:\...` 直接放进 `url.URL{Scheme:"file"}` 会把盘符当作 host，驱动报误导性错误（`out of memory (1)`）。新增 `internal/adapters/sqlitefile`，Windows 盘符先转 `/C:/...`；账号库、app-state、规则、聊天、用量、会话扫描等 20 处 DSN 统一走该 helper。

### 4.3 Startup VBS 子进程活不过 cscript（`142ac304`）

真机复现：`shell.Exec` 拉起的服务已 `listening`，cscript 退出后进程随即消失（控制台关闭事件）。修复：

- Windows 自启首选计划任务（Task Scheduler 拉起的进程有独立会话）；
- VBS 与 `serve.cmd` 都把 stdout/stderr 追加到 `background-supervisor.log`，避免管道关闭把服务带死；
- Startup VBS 降为计划任务被拒（EPERM）时的回退。

### 4.4 启动器缺 `AIH_HOME_DIR`（`f442f6ef`）

计划任务/Startup 不继承安装者 shell 环境，自定义 home 会被忽略。生成器现已在 `serve.cmd` 与 VBS 的 Process env 中显式写入 `AIH_HOME_DIR`（同批修复也覆盖 systemd 与 launchd）。

## 5. 边界

- **未执行真实注销/登录**（`ONLOGON` 触发时机）；等价启动路径已由 `schtasks /Run` 验证，`/TR` 与生产完全一致。
- 该 Windows 主机同时被用作远程工作区测试机，测试使用独立目录与端口，结束后已清理。
- 仓库里 `bin/native/win32-x64` 的旧构建不含 `--supervise-node`；发布打包必须重新构建（本次已证明可构建）。

## 6. 复现要点

1. 交叉编译：`GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/aih-server`。
2. 生成产物：以 `platform='win32'`、`path.win32` 调 `createServerAutostartService(...).install()`，检查 `aih-server-serve.cmd` 的 `set "AIH_HOME_DIR=…"`、`--front-door --supervise-node` 与日志重定向。
3. 注册并运行：`schtasks /Create /SC ONCE /TN <tmp> /TR "<serve.cmd>" /F /RU <user> /IT` → `schtasks /Run`。
4. 判定：`healthz`/`readyz` 200、`Get-NetTCPConnection` 显示监听、进程存活 >5s、`schtasks /Query` = Running。
5. 清理：`/End`、`/Delete`、删除测试目录；确认无残留进程与端口。
