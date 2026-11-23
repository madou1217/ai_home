# Windows 主机 aih-server 重新部署（2026-11-24）

目的：把实验机（`www.desired.cn:22009`，用户 `madou`）上长期运行的手工部署
aih-server 更新到当前可构建源码，并让 WebUI 可用。

## 现状与原因

- 运行中的服务是 11/23 的 `~/.ai_home/bin/aih-server.exe`（74,750,976 字节），
  由自建计划任务 `AihServerWindows`（wscript → `launch.vbs` → `run.cmd`）启动，
  命令行为 `--host 127.0.0.1 --port 9527`，没有 `--web-dir`，`/ui/` 一直 404。
- 机器上同时存在产品安装器创建的 `com.meadeo.ai_home` 任务（指向
  `pkg/1.0.6-win32-x64-9a1d01f9`），与自建任务重复。
- 本次没有走 `scripts/deploy-server.js` 的产品包部署：`origin/main` 在
  `64bf71bf` 之后引用了 `NodeHealthLedger.PreferenceScore`，但该方法只存在于
  并行会话未提交的 `internal/runtime/egress/health_select.go`，从已推送提交
  无法构建发行包。部署用的二进制来自当前可编译的工作区（HEAD `0a2477c6`
  + 未提交的 egress 改动）。
  **main 修好后应再用 `node scripts/deploy-server.js` 做一次正式包部署。**

## 产物

- 构建：`node scripts/build-go-server.js --platform win32 --arch x64`
  - `aih-server.exe` SHA-256 `0745be6656b729b020158123b11936621904519c9893dee2a2a41693c7f4e6ca`
  - 同批 `aih-go.exe`、`aih-mcp-shim.exe`、`aih-engine-mihomo/singbox.exe`、
    `aih-render-subscriptions.exe`
- WebUI：`npm run web:build`（`web/dist`，25 MB，SW 缓存戳
  `aih-hos6-pwa-6a31014d`）
- 上传包：`bundle.tar.gz` SHA-256
  `61caae62d18a2a1dba5dad5676a49a7b65b2a621c617625bfcba23e6cd03d79e`

## 部署步骤

1. 冻结旧进程：`POST /v0/management/shutdown`（Bearer 管理密钥）→ 202，
   等待 9527 端口释放。
2. 备份到 `~/.ai_home/deploy-20261124/backup`：旧 `aih-server.exe`、`aih-go.exe`、
   `run.cmd`、`launch.vbs`。
3. 发布新二进制到 `~/.ai_home/bin`；WebUI 到 `~/.ai_home/web/dist`。
4. `run.cmd` 增加 `--web-dir "C:\Users\madou\.ai_home\web\dist"`，其余环境变量
   （管理密钥 / 客户端密钥 / 数据目录）保持不变。
5. 禁用陈旧的 `com.meadeo.ai_home` 任务，避免下次登录与自建任务同时抢 9527。
6. `schtasks /Run /TN AihServerWindows` 启动。

## 验收

- `GET /readyz`：`ready=true`，`accounts.zcode=6`，`model_count=64`，
  `route_count=126`。
- `GET /ui/`：200（625 B 入口壳），`/ui/umi.c617d92f.js` 200（8,541,290 B），
  `/ui/sw.js` 200（2,939 B）。
- `GET /v1/management/webui/server-config`：200。
- `GET /v1/management/webui/toolkit/apps?refresh=1`：`zcode-desktop`
  `installed=true`、`version=4.0.0`、
  `cliPath=C:\Users\madou\AppData\Local\Programs\ZCode\ZCode.exe`。
- `POST /v1/management/webui/toolkit/apps/plan`（zcode 安装）：`ok=true`，1 个计划。
- 进程：PID 41616，命令行含 `--web-dir`，文件哈希等于上述构建哈希。
- 任务状态：`AihServerWindows` Ready（服务进程由子进程常驻），
  `com.meadeo.ai_home` Disabled。

## 回滚

- 停 `AihServerWindows`，将 `deploy-20261124\backup` 下的文件复制回
  `~/.ai_home/bin`（先停进程，Windows 不允许覆盖运行中的 exe），
  删改前的 `--web-dir` 参数即可恢复旧行为。
- 如需恢复产品任务：`schtasks /Change /TN com.meadeo.ai_home /ENABLE`，但需先让
  自建任务停止，二者只能留一个持有 9527。

## 已知遗留

- `%LOCALAPPDATA%\aih\aih.exe` 启动器仍是 1.0.6 产品包；本次只替换了服务端与
  WebUI。正式包部署（`deploy-server.js`）在 main 可构建后补做。
- 日志中部分账号模型刷新 401/403（zcode/kimi/opencode/gemini）是既有凭据状态，
  与本次部署无关。
- 测试机 ZCode 当前为 4.0.0（per-user，`%LOCALAPPDATA%\Programs\ZCode`），
  旧机器级目录 `C:\Program Files\ZCode` 可能残留空壳，未被服务使用。