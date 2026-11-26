# CodeBuddy Windows 登录路径修复（2026-11-26）

## 症状

WebUI 发起 CodeBuddy 国内版 OAuth 登录时立即失败：

```text
OAuth 授权
FAILED
exec: "C:\Windows\System32\codebuddy": executable file not found in %PATH%
```

## 根因

`internal/host/aihlogin.Run` 把裸命令 `codebuddy` 交给 PTY：

- Windows 服务的工作目录是 `C:\Windows\System32`；
- 服务的 PATH 不包含用户安装目录；
- CodeBuddy 官方安装器实际落在
  `C:\Users\<user>\AppData\Local\codebuddy\bin\codebuddy.exe`。

因此 PTY 启动阶段就报“可执行文件不存在”，OAuth 还没有开始。

## 修复

1. `internal/runtime/providercli/binary.go`
   - 新增 `ResolveBinaryForHost(providerID, binary, hostHomeDir)`；
   - CodeBuddy 家族（codebuddy / codebuddycn / workbuddy / workbuddycn）在 PATH 之外
     检查已知安装落点：
     - `%LOCALAPPDATA%\codebuddy\bin\codebuddy.exe`
     - `%LOCALAPPDATA%\Programs\CodeBuddy\codebuddy.exe`
     - `~/.local/bin/codebuddy`、`~/.codebuddy/bin/codebuddy.exe`
     - `/opt/homebrew/bin/codebuddy`、`/usr/local/bin/codebuddy`
   - 只做存在性检查；找不到时回退 `exec.LookPath`。
2. `internal/host/aihlogin/login.go`
   - 登录前解析绝对路径，不再传裸 `codebuddy`；
   - 工作目录改为投影内的临时 `login-workspace-*`，不再继承服务的
     `C:\Windows\System32`；
   - 信任目录也改为这个临时工作目录。

## 验证

Windows 已安装服务热替换为本次构建的 server：

- 本地构建 SHA-256 前缀：`83c801b9bd0ab2a3`；
- 服务二进制 SHA-256 与构建一致；
- 通过网页同款接口启动 `codebuddycn` 登录作业：
  `POST /v1/management/webui/accounts/login-jobs`；
- 作业 `login-5244ea3404762d17` 状态为 `running`，
  `authProgressState=auth_url_ready`；
- 作业日志中可见：
  - 启动路径 `C:\Users\madou\AppData\Local\codebuddy\bin\codebuddy.exe`；
  - 工作目录 `...\login-workspace-...`；
  - `CodeBuddy Code v2.187.0`；
  - OAuth 登录方法菜单与授权链接。
- 不再出现 `exec ... codebuddy ... not found`。

验证后已取消作业、删除探针、恢复服务为原本的 Disabled 状态。

## 提交

`88743523 fix(codebuddy): resolve installed CLI path for Windows login`
