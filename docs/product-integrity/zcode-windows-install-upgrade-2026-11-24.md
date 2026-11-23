# ZCode Windows 安装与升级实机验收（2026-11-24）

目的：在真实 Windows 上验证应用管理卡片「安装 / 更新」ZCode Desktop 的完整链路
（官方页面解析 → 下载 → 静默安装 → 安装后探测），并确认升级路径。

## 环境

- 执行端：Windows 11（10.0.26300.10075），SSH Host 中的 Windows 实验机
  （`meadeo666\madou`，管理员且会话令牌已提升）。
- 服务端：从工作区源码 `CGO_ENABLED=0 GOOS=windows GOARCH=amd64` 构建的
  `aih-server.exe`，SHA-256 `0198a7394d9d2350aaecfb0cbbacb3b083a3539808b142ce68d7ec77f6e6a9d8`
  （含本验收的修复；修复前构建为 `07a43164…`）。
- 隔离：临时目录 `C:\Users\madou\zcode-test-20261124` + 临时
  `AIH_HOME_DIR` + 端口 19775 + 独立管理密钥；不触碰业务端口 9527。
- 网络：实验机直连 `zcode.z.ai` 与 `cdn-zcode.z.ai` 均可达
  （HTTP 200；win-x64 安装包 238,009,216 字节），因此未触发代理出口。
- 起始状态：机器上已安装 ZCode 3.16.3（Program Files，卸载项
  `InstallLocation` 为空，`DisplayIcon` 指向 `uninstallerIcon.ico`）。

## 方法

全部通过管理面 API（与 WebUI 卡片同源）：

1. `GET /v1/management/webui/toolkit/apps?refresh=1` 观察 `zcode-desktop` 的
   `installed`/`version`/`canUpdate`。
2. `POST /v1/management/webui/toolkit/apps/plan` 取安装/更新计划。
3. `POST /v1/management/webui/app-install` 创建作业，轮询
   `GET /v1/management/webui/app-install/jobs/{id}` 直到终态。
4. 用注册表与 `ZCode.exe` 文件版本交叉核对实际安装结果。

## 结果

### 1. 修复前：安装器成功，但作业判失败

`update` 作业 `app-install-324f6447-2e8e-44d6-9edc-e4eb7ed14d24`：
官方安装器实际把 3.16.3 升级到 **4.0.0（文件版本 4.0.0.10870）**，
但作业以「更新命令已完成，但未检测到目标 Desktop 应用。」失败。

根因两处：

- `builtinZcode` 未声明 Windows 卸载注册表产品名，`findWindowsRegisteredDesktopClient`
  直接跳过（返回 nil）。
- 旧版安装器只写 `DisplayIcon`、不写 `InstallLocation`，即使探测执行也找不到目录。

### 2. 修复

`fix(toolkit): detect Windows desktop installs without InstallLocation`（915830aa）：

- ZCode 声明 Windows DisplayName `ZCode`（匹配 `ZCode 4.0.0` 这类注册表项）。
- `InstallLocation` 为空时，用 `DisplayIcon` 所在目录作为安装目录回退
  （通用处理 NSIS 安装器；不写死厂商路径）。

### 3. 修复后：更新与安装都成功

- `update` 作业 `app-install-7727c141-c0d8-45bb-bb7a-3f56ffdc516e`：
  `succeeded`，`result.executablePath = C:\Program Files\ZCode\ZCode.exe`。
- 用厂商静默卸载器（`Uninstall ZCode.exe /S _?=...`）回到干净状态：
  卸载项消失，`installed=false`。
- `install` 作业 `app-install-1f15d54b-f548-4c76-b34a-65f986c5c0dc`：
  `succeeded`，`result.executablePath = C:\Users\madou\AppData\Local\Programs\ZCode\ZCode.exe`
  （无历史机器级安装时，官方安装器选择 per-user 目录；探测同时覆盖两种位置）。
- 安装后 `GET apps`：`installed=true`、`version=4.0.0`；注册表
  `DisplayName=ZCode 4.0.0`、`InstallLocation` 为实际目录；
  `ZCode.exe` 文件版本 `4.0.0.10870`。

## 未验证 / 边界

- `POST /apps/zcode-desktop/check-update` 返回
  `latest_version_source_unavailable`：ZCode 的安装计划是官方页面解析脚本，
  没有可推导的远程版本源，因此没有「有新版本」徽标；本次只证明更新动作本身可执行。
- 卸载计划由产品生成时使用注册表 `UninstallString`（未带 `/S`），本次为构造干净
  状态改用厂商静默参数，未验证产品卸载计划在无人值守会话中的行为。
- 自动代理出口失败轮换未被触发（实验机直连可用）。
- 未验证 macOS/Linux 端本次改动（改动只影响 Windows 探测，且
  `provider-manifest --check` 通过）。

## 复现要点

- 启动隔离服务前确认端口 19775 未被占用；实验机上长期运行的 9527 服务不要触碰。
- 替换远端测试二进制前必须先停进程（Windows 不允许覆盖运行中的 exe）。
- 从 SSH 会话用 `Start-Process` 拉起的服务会随会话关闭被回收；用
  `Win32_Process.Create` 启动 `cmd /c launch.cmd` 可脱离会话常驻。