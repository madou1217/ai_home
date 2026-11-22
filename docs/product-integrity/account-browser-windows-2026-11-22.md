# 账号浏览器 Windows 实机验收（2026-11-22）

目的：确认服务器端账号级虚拟浏览器在真实 Windows 上的启动、画面、输入、Profile
持久化与进程清理。设计文档
`docs/superpowers/specs/2026-11-20-account-browser-cross-platform.md` 写作时 Windows
仍未实现；本文记录之后落地的 Windows 稳定版 Edge 适配器与实测结果，并以本文为准。

## 环境

- 执行端：Windows 11（10.0.26300.10075），SSH Host 中的 Windows 实验机
- 服务端构建：`main` 的 `4abf955b`，`CGO_ENABLED=0 GOOS=windows GOARCH=amd64`，
  `aih-server.exe` SHA-256 `fbe4ba2eb21636914ed6244e72e5f29b00b46c43a14c062e64185f3426e3cb00`
- 浏览器：宿主已安装的 Microsoft Edge stable（无调试端口、无 headless、无 stealth 参数）
- 隔离：临时目录 + 临时 HOME + 临时端口 19764 + 独立管理密钥；不触碰业务端口 9527
- 账号：临时库内两条 `codebuddy` 账号（`acct_11111111111111111111`、
  `acct_22222222222222222222`），用于 account scope 解析；不含任何真实凭据

## 方法

1. `POST /v1/management/webui/account-browser/live/stream`，body
   `{"scope":"account","provider":"codebuddy","accountRef":"..."}`，取首个
   `session` 事件的 `controlToken`。
2. 逐条 `POST /v1/management/webui/account-browser/live/command`
   （`X-AIH-Browser-Session`）：`start` → `navigate` → `pointer` → `scroll` →
   `key` → `text` → `close`。
3. 每条输入后等待新的 `frame` 事件；关闭后检查 `BrowserSurface.exe`、带本测试
   `user-data-dir` 的 `msedge.exe`、Profile 目录与 `profile.json`。

## 结果

- `start` 返回 202；`ready` 为 1200x900。
- `navigate/pointer/scroll/key/text/close` 全部返回 202；没有
  `browser_input_unavailable`。
- 中文文本 `中文输入 verify` 经 `SendInput` 提交成功；每次输入后帧继续递增
  （单轮 6 帧）。
- 保存的首帧为 1200x900 PNG，98,693 bytes。
- 关闭后 `BrowserSurface.exe` 数量为 0，带本测试 user-data 目录的 Edge 进程为 0。
- 同一账号重开：`profile.json` 的 `id` 与 `createdAt` 不变
  （`browser_870f84d695cde1bcaccc4c2f5c4bec76`），说明复用原 Profile 而非重建。
- 第二个账号：独立 Profile `browser_a78a50be836fcec79e13f55d26482bad`，两个账号
  不共用 user-data 目录。
- 资源样本（`https://example.com`，单个 Profile）：8 个 Edge 进程，工作集合计约
  541.8 MB。这是 Windows 工作集，共享页会重复计数，不是独占物理内存；该数字不支持
  “KB 级”或“共享单内核”的说法。

## 未验证的边界

- OAuth 登录后的 Cookie/登录态持久化（需要真实第三方登录，不能伪造）。
- 站点级 Cookie 隔离的运行时证据；本次只证明 Profile 目录与 user-data 隔离。
- 账号代理出口（没有绑定真实代理做出口验收）。
- macOS 实机与 WebUI 视觉/移动端验收。
- 多账号同时打开的内核复用：当前每个 durable Profile 启动一个普通 Edge 进程，
  不声称共享单内核。

## 复现要点

替换临时服务的 `aih.db` 前必须先停服务并删除 `aih.db-wal`/`aih.db-shm`；
旧 WAL 会让新库里的 KV（例如 `server:identity`）对只读连接不可见，account scope
会误报 404。这是部署操作坑，不是产品逻辑缺陷。
