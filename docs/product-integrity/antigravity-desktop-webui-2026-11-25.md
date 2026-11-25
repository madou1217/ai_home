# Antigravity 桌面端（App）WebUI 账号入口

日期：2026-11-25

范围：Accounts 页的 Provider 级桌面端入口、Windows 桌面端发现、无桌面 Server 的隐藏规则。

## 三产品边界

Antigravity 有 **Desktop（App）/ IDE / CLI** 三个独立产品，不能互相替代：

| 产品 | 应用 | 本仓库归属 |
|---|---|---|
| Desktop | `Antigravity.app` / `Antigravity.exe`，bundle `com.google.antigravity` | Provider 的 `agyDesktopClient` + Toolkit 桌面卡 |
| IDE | `Antigravity IDE.app` / `Antigravity IDE.exe`，bundle `com.google.antigravity-ide` | 独立 Toolkit IDE 卡（`app.install` 插件） |
| CLI | `agy` | Provider CLI 安装计划/终端 |

本文只覆盖 Desktop；把 IDE 当成 Desktop 会导致安装落点、账号入口和审计 appId 全部错位。

## 行为

- 当某个 Provider tab 没有任何账号时，列表上方显示一行
  `Antigravity 桌面端 · 未安装/已安装 · 安装/打开`。
- 安装与打开都走 Toolkit 应用清单（`/v1/management/webui/app-entries` +
  `/v1/management/webui/toolkit/apps`）；Accounts 页没有 Antigravity 分支，
  新增桌面客户端只改 Provider 合同 / 应用清单。
- `serverRuntime=true`（Linux 无 DISPLAY/WAYLAND，或远端 Server）时不渲染该行；
  账号行的 Desktop 入口同源隐藏。CLI 入口在 Server 上仍按 Web Terminal 保留。
- Windows 安装落点与卸载注册名写入 Provider 合同：
  `{localAppData}/Programs/Antigravity/Antigravity.exe`、
  `{programFiles}/Antigravity/Antigravity.exe`、
  `{programFilesX86}/Antigravity/Antigravity.exe`，注册表 DisplayName = `Antigravity`。
  Toolkit 的 `FindDesktopClientRecord` 与 app-entries 共用这份声明，解决了
  “装完仍显示未安装、点击打开又回安装”的不一致。
- macOS BundleID 取自官方 DMG 的 Info.plist：`com.google.antigravity`。

## 真机验证

| 平台 | 操作 | 结果 |
|---|---|---|
| macOS arm64 | 官方下载页解析到 2.35.0 DMG → WebUI 点击“安装” → 等安装任务完成 → app-entries `desktop=true` → 点击“打开” | 通过；`~/Applications/Antigravity.app` 实测存在，主进程 `Contents/MacOS/Antigravity` 启动 |
| Windows 11 AMD64 桌面 | WebUI 点击“安装” → 安装任务成功 → `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe` → app-entries `desktop=true` → 点击“打开” | 通过；Antigravity 进程启动 |
| Ubuntu 无桌面 | 访问 Accounts → Antigravity tab | 通过；app-entries `serverRuntime=true`，不显示安装/打开 |
| macOS 桌面 | 空 Antigravity tab | 通过；显示“Antigravity 桌面端 · 未安装 · 安装”，安装后变为“打开” |

## 网络说明

- 本机直连 `storage.googleapis.com` 速度极低并会超时；macOS 的安装验证通过
  SSH SOCKS 出口完成下载，脚本本身仍是生产安装计划（下载页解析 → hdiutil →
  ditto → 安装后探测）。Windows 直连完成。

## 边界与后续

- 桌面客户端声明仍在 Provider 合同 / Toolkit 应用清单里；Accounts 页只消费
  `app-entries` 与 Toolkit 动作，没有厂商 switch。
- 若要进一步把安装计划也搬到仓外插件，需要新增 `desktop.client` 能力槽并让
  宿主执行第三方安装器；那会扩大插件执行边界，属于独立设计，不在本次改动内。
