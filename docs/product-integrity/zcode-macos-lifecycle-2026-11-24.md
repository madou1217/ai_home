# ZCode macOS 安装 / 更新 / 卸载实机验收（2026-11-24）

目的：在本机 macOS 上验证 ZCode Desktop 的安装、更新、卸载三条生命周期链路
（官方 DMG 下载 → 挂载/复制 → 安装后探测 → 卸载与反向探测）。

## 环境

- 本机：macOS（Darwin 27.2.0，arm64）。
- 服务端：从工作区源码构建的 `aih-server`（darwin-arm64），SHA-256
  `fb80b664b78189229d1dd44f3a23af116fe5a9f261dd3ce8bd4d553d29202f93`。
- 隔离：数据目录 `/private/tmp/zcode-mac-test/home`、端口 19776、独立管理密钥；
  未触碰本机常驻的 9527 服务。
- 初始状态：`~/Applications/ZCode.app` 不存在（`installed=false`）。
- 网络：本机直连 `zcode.z.ai` / `cdn-zcode.z.ai` 均 200。

## 方法

与 Windows 验收同一套管理面 API：`GET apps?refresh=1` → `POST apps/plan` →
`POST app-install` → 轮询作业 → 用 `Info.plist` 和应用清单交叉核对。

## 结果

- 安装作业 `app-install-10802ac2-96ed-4e5f-b7c1-9f09e97ebdff`：
  `succeeded`，`executablePath=/Users/model/Applications/ZCode.app/Contents/MacOS/ZCode`；
  `CFBundleShortVersionString=4.0.0`；应用清单 `installed=true, version=4.0.0,
  cliPath=/Users/model/Applications/ZCode.app`。
- 更新作业 `app-install-fcc257f0-3e61-4bfe-81fe-c48daf2cfe50`：
  `succeeded`，同一可执行路径。
- 卸载作业 `app-install-04479f6b-e358-4906-bb31-1bbd14b201b4`：
  `succeeded`，`result.installed=false`；`~/Applications/ZCode.app` 已删除；
  再次查询清单为 `installed=false, version=-`。

## 结论

- macOS 的安装 / 更新 / 卸载三条链路在真实官方 DMG 上全部通过，未发现需要修复
  的缺陷；卸载后主机回到验收前状态。
- 安装位置是用户级 `~/Applications`，探测同时覆盖 `/Applications` 与
  `~/Applications`；卸载计划按探测到的 bundle 路径删除。

## 备注

- 数据目录放在 `/tmp` 下时服务会拒绝启动（`model_settings_watch_symlink_root`，
  因为 `/tmp` 是指向 `/private/tmp` 的符号链接）；隔离目录必须用真实路径。
- 本次只验证应用生命周期，未验证真实登录后的会话/推理（沿用既有账号测试）。