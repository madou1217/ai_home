# Antigravity Apps（Desktop + IDE，app.install 参考插件）

这个插件覆盖 **Antigravity Desktop（Antigravity App）** 和
**Antigravity IDE** 两个独立产品的安装、更新、卸载、状态与打开。
Antigravity CLI 是第三个产品（命令行 `agy`），仍由 Provider 的 CLI 安装计划
覆盖，不在这个插件里。

它是 `docs/plugins/app-install-capability-design.md` 的参考实现，用来验证：

- 宿主不执行插件命令，安装逻辑完全在插件内执行；
- Toolkit 应用清单与账号入口自动出现插件应用；
- 安装/卸载作业、代理、确认、超时与审计复用宿主能力；
- macOS / Windows 的官方安装器差异由插件自己处理；
- 同一 Provider 下的不同产品用不同 appId、不同 CDN、不同安装路径。

## 安装

```bash
aih plugin install plugins/antigravity-apps --require-signed=false
aih plugin enable antigravity.apps --accept-permissions
```

启用后：

- Toolkit → 应用管理出现 **Antigravity**（Desktop）和 **Antigravity IDE**
  两张来源为“插件”的卡；
- Accounts → Antigravity 空 tab 的桌面端入口只跟随 Desktop；
- 安装/卸载会创建 `app-install` 作业，进度显示在任务队列。

## 三产品边界

| 产品 | 应用 / 产物 | appId | 账号入口 |
|---|---|---|---|
| Desktop（App） | `Antigravity.app` / `Antigravity.exe`，storage.googleapis.com | `antigravity-desktop` | `accountKind: desktop` |
| IDE | `Antigravity IDE.app` / `Antigravity IDE.exe`，edgedl.me.gvt1.com | `antigravity-ide` | `accountKind: none` |
| CLI | `agy` | 不在此插件 | Provider CLI |

IDE 的安装状态不会让 Desktop 账号入口显示“已安装”，反之亦然。这是刻意的：
三个产品不是同一个应用的三种叫法。

## 与内置安装计划的关系

内置的 `agy-desktop` 安装计划仍然保留，用于没有安装插件的部署。插件使用
不同的 appId（`antigravity-desktop` / `antigravity-ide`），不会覆盖内置
appId；同时存在时会看到内置桌面卡 + 两张插件卡，这是过渡状态。

## 边界

- 插件以服务用户身份运行，安装器会下载并执行官方 DMG/EXE。
- macOS 安装到 `~/Applications`；Windows 安装到 `%LOCALAPPDATA%\Programs`；
  卸载只删除这些 per-user 路径，不动 `/Applications` 或 Program Files。
- Desktop 使用 NSIS 静默参数 `/S`；IDE 使用 Inno Setup 的
  `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-`。
- 账号级投影打开（`accountScope`）尚未接线；当前 open 是无账号启动。
