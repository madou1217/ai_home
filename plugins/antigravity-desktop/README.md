# Antigravity Desktop（app.install 参考插件）

这个插件把 Antigravity 桌面端（IDE）的安装、更新、卸载、状态与打开作为
`app.install` 能力贡献给 AIH。它是 `docs/plugins/app-install-capability-design.md`
的参考实现，用来验证：

- 宿主不执行插件命令，安装逻辑完全在插件内执行；
- Toolkit 应用清单与账号入口自动出现插件应用；
- 安装/卸载作业、代理、确认、超时与审计复用宿主能力；
- macOS 与 Windows 的官方安装器差异由插件自己处理。

## 安装

```bash
aih plugin install plugins/antigravity-desktop --require-signed=false
aih plugin enable antigravity.desktop --accept-permissions
```

启用后：

- Toolkit → 应用管理会出现一张来源为“插件”的 Antigravity 卡；
- Accounts → Antigravity 空 tab 会出现桌面端安装/打开条；
- 安装/卸载会创建 `app-install` 作业，进度显示在任务队列。

## 与 IDE / CLI 的关系

Antigravity 的桌面应用（`Antigravity.app`）本身就是 IDE，Provider 合同
（`agyDesktopClient`）把它归类为桌面客户端；因此插件声明 `kind: "desktop"`，
不另造一个 IDE appId。`agy` CLI 是另一个客户端，不在这个插件的范围内。

## 与内置安装计划的关系

内置的 `agy-desktop` 安装计划仍然保留，用于没有安装插件的部署。插件应用
使用不同的 appId（`antigravity-desktop`），不会覆盖内置应用；账号入口按
provider+kind 取 OR。两者同时存在时会看到两张 Toolkit 卡片，这是预期的
过渡状态。

## 边界

- 插件以服务用户身份运行，安装器会下载并执行官方 DMG/EXE。
- 卸载只删除插件自己安装的路径（`~/Applications/Antigravity.app` 或
  `%LOCALAPPDATA%\Programs\Antigravity`），不动系统级安装。
- 账号级投影打开（`accountScope`）尚未接线；当前 open 是无账号启动。
