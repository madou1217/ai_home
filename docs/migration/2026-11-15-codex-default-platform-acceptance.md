# Codex 默认配置与中断恢复：Windows/Linux 真机验收

日期：2026-11-15。对应 W2/W3 的配置发布、私密恢复记录、动态网关认证和跨平台恢复边界。

## 范围与约束

- 使用本仓库真实 `cmd/aih` 交叉编译产物，在既有可访问的 Windows/Linux 主机上新建独立临时目录运行。
- 不复制真实账号凭据，不改原生安装，不修改已有计划任务、自启、宿主配置或业务数据库，不重启本机/远端共享服务。
- 不新增测试用例。下列为真实程序和 OS 行为的操作记录；临时验证脚本位于 `/tmp`，没有作为测试套件入库。
- Windows CLI SHA-256：`8d33fc0e9aa5492e0ad55f61b0dd0dbdcd10d825bb66bf50368c58a7fee4356c`。
- Linux CLI SHA-256：`7510c50eb1fe3c3a36d9e1ddb3048c1a3d20e5c774ed40695353cbd8534bed87`。
- 两份产物都从当前共享工作区构建；Windows 构建时 HEAD=`bba5121d1`，Linux 构建时 HEAD=`e1116d3af`。工作区存在 peer 变化，HEAD 单独不是构件内容证明；以上 binary hash 与实际运行产物核对。

## Windows 真机

Windows NT 10.0.26300.0 / PowerShell 5.x，运行同一用户权限，不提权、不注册任务。

| 操作 | 真实结果 |
|---|---|
| `codex effort fast` / `effort show` | exit0；fast 保存，max 推理强度不变 |
| 原文件保留 | CRLF、注释、profile 保留 |
| `codex set-default --json`（空账号临时数据根） | exit0；gateway=true；未创建旧 app-state.db |
| `codex gateway-auth --ai-home ...` | exit0；读取显式网关 key，不采用无关 OPENAI_API_KEY；key 未记录 |
| 观察 CLI 真实恢复 journal 后终止该新进程 | 成功观测并终止；journal 留存 |
| journal 权限 | DACL protected=true，允许项仅当前用户和 SYSTEM；不是用 Mode().Perm() 推断 |
| 再次执行 default | exit0；journal 与 stage 文件均清理 |
| 真实官方 Codex 读取生成配置 | v0.163.0 app-server `config/read` 有 result、无 error；进程正常退出 |
| 清理 | 新目录内无仍存活进程；核对目录前缀及 CLI hash 后移除本次目录；已有任务状态值3前后相同 |

第一次恢复尝试在读取 ACL 时错过快速提交窗口，crashCaptured=false，未算通过。第二次先终止已观测到 journal 的目标 PID，再读取 ACL，得到真实 crash/recovery 证据。

官方 PATH 上的 `codex.exe` 是既有 AIH 文本包装器，直接 CreateProcess 被 Windows 拒绝。通过真实 Go CLI `codex version` 解析到既有 `codex.exe.aih-original`，版本0.163.0，再调用该官方上游成功读取配置；未修改/修复该安装文件。

证据（本机临时记录，不含凭据）：
- `/tmp/aih-w3-windows-env-20261115.json`
- `/tmp/aih-w3-windows-acceptance-result-20261115.json`
- `/tmp/aih-w3-windows-native-result-20261115.json`
- `/tmp/aih-w3-windows-cleanup-result-20261115.jsonl`

## Linux 真机

既有 AWS Linux x86_64 主机，仅使用新建 `/tmp/aih-w3-default-live.*` 目录。原服务观察为 inactive/dead/MainPID0；验证期间未执行 service start/stop/restart。

| 操作 | 真实结果 |
|---|---|
| effort fast | exit0；max、注释、profile、CRLF 和原 mode0640 均保留 |
| gateway default | exit0；gateway=true；未创建旧 app-state.db |
| gateway-auth | 读取网关环境 key，忽略上游 OPENAI_API_KEY |
| 观察 journal 后 SIGSTOP/SIGKILL 本次 CLI | crashCaptured=true，journal mode0600 |
| pending journal 时 effort fast | exit1，明确 recovery_required |
| 重试 default | exit0，journal/stage 全部清理 |
| 清理 | /proc 中无本次CLI；核对临时目录和构件hash后仅移除本次目录；服务仍 inactive/dead/MainPID0 |

Linux 没有安装官方 Codex，故不计原生 config/read/登录/推理通过；只证明真实 AIH CLI、SQLite、文件系统与恢复链路。

## 完成与未完成边界

本检查点补齐 **网关模式配置与恢复的 Windows/Linux 真机证据**，包括 Windows DACL，不再只以交叉编译代替这些检查。

仍未覆盖：真实 OAuth 登录与旋转 token、API-key账号切换的跨平台原生业务、Desktop App运行态重载/重启、TUI/浏览器视觉验收、断电级存储故障、完整安装升级、自启各身份模式、全 W0–W6。临时 key 只用于本地配置验证，不能作为真实上游认证证据。
