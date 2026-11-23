# Windows 主机 aih-server 正式部署（2026-11-24）

目的：把实验机（`www.desired.cn:22009`，用户 `madou`）上的 aih-server 用产品
自带的分发流程正式部署到最新 `main`，并让 WebUI 可用。

## 结果

- 部署方式：`node scripts/deploy-server.js --ssh madou@www.desired.cn
  --ssh-port 22009 --target win32-x64`（从 `origin/main` 构建单文件包 → scp →
  远端执行 `aih install --bin-dir %LOCALAPPDATA%\aih`）。
- 最终 `distribution-install.json`：`state=installed`，
  `releaseVersion=1.0.0`，`sourceSha=2721ac0d87d77f0280e87412138aced1e7f4d413`，
  `packageRoot=~/.ai_home/pkg/1.0.0-win32-x64-7358e36f`，
  `binarySha256=dd109729ef311556ea809c99d51bd52cbb1051ec262acf93c1c470731060a690`，
  `launcherSha256=54e045fe335e26b2f5f30713c641e34271bbb045eef7892a708b3ab4dabe9235`。
- 服务：计划任务 `com.meadeo.ai_home` 为 Running，`run/aih-server-serve.cmd`
  指向新包内的 `aih-server.exe --host 127.0.0.1 --web-dir <pkg>/web/dist`；
  进程 PID 43660 的命令行与之一致。
- 手工部署遗留的 `AihServerWindows` 任务保持 Disabled，不再与产品任务抢 9527。
- 验收：`/readyz` 200（`zcode=6` 账号、64 模型、126 路由）；`/ui/` 200；
  `umi.ed982d8e.js` 200（8,550,145 B）；管理 API 200；
  `zcode-desktop installed=true, version=4.0.0,
  path=%LOCALAPPDATA%\Programs\ZCode\ZCode.exe`。

## 部署过程中修复的两个真实缺陷

### 1. main 无法构建（commit `18da7e9f`）

`64bf71bf` 起 `egress/manager.go` 引用 `NodeHealthLedger.PreferenceScore*`，
但评分方法从未提交，`origin/main` 直接编译失败。补上唯一一份评分实现
（`PickBest` 复用），并保持「陈旧失败低于陈旧成功」的分档。

### 2. Windows 安装从不启动新建的服务（commit `2721ac0d`）

第一次正式部署在「恢复后台服务并验证新版本」处失败：`autostart.installWindows`
只用 `schtasks /Create /SC ONLOGON` 创建任务，从不执行它，安装器的
`/readyz` 轮询自然全部连接失败（90 秒），随后回滚也因「无法验证旧 AIH 服务
退出身份」卡住，留下 `activating` 状态。

修复：任务创建成功后立即 `schtasks /Run /TN <label>`；是否真正可用仍交给
安装器现有的启动验证判定（重复运行时 `/Run` 返回成功，不影响重装）。

## 首次失败的事务如何收尾

- 手工 `schtasks /Run` 启动待激活的包，确认激活服务在 9527 上返回
  `installation=awaiting_commit`，且 `run/go-server-runtime.json` 的
  executable / binarySha256 与安装回执一致。
- 按安装器提交阶段的动作把 journal 的 `phase` 置为 `complete`、回执
  `state` 置为 `installed`、删除 `run/distribution-install-pending.json`；
  激活服务随即退出等待并完成正常启动。
- 之后用修复后的 `main` 重跑正式部署，安装器自行完成停止旧服务、安装新包、
  启动任务、激活验证与提交，全部通过。

## 回滚

- 安装器在 `~/.ai_home.install-history/` 保留事务备份；
  手工部署的旧二进制与脚本仍在 `~/.ai_home/deploy-20261124/backup`。
- 如需回到手工部署：停 `com.meadeo.ai_home`，恢复 `backup` 里的
  `aih-server.exe`/`run.cmd` 并启用 `AihServerWindows`。两者只能有一个持有 9527。

## 备注

- `%LOCALAPPDATA%\aih\aih.exe` 启动器已随本次安装更新为同一构建。
- 日志中部分账号模型刷新 401/403（zcode/kimi/opencode/gemini）是既有凭据状态，
  与部署无关。
- 测试机 ZCode 当前为 4.0.0（per-user，`%LOCALAPPDATA%\Programs\ZCode`）；
  旧机器级目录 `C:\Program Files\ZCode` 可能残留空壳，未被服务使用。