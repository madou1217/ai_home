# Desktop 三平台发布与 packaged smoke

## 目标与边界

`.github/workflows/desktop-release.yml` 是可由 `workflow_dispatch` 手动触发的三平台发布闸门。它不读取仓库 Secret，因此当前产物明确标记为 `unsigned`，不等同于面向最终用户的已签名发行版。

该工作流必须同时满足以下条件才通过：

| Runner | 必需制品 | 安装/运行方式 | 必需 smoke |
| --- | --- | --- | --- |
| `macos-14` | `.app`、`.dmg` | 挂载 DMG，将 `.app` 复制到隔离安装目录，启动 `Contents/MacOS/*` | DMG 安装后的应用 |
| `windows-2022` | `.msi` | `msiexec /i ... /qn /norestart`，启动安装目录中的 `.exe` | MSI 安装后的应用 |
| `ubuntu-22.04` | `.deb`、`.AppImage` | `dpkg --install` 后启动 `/usr/bin/*`；AppImage 复制、授权后直接启动 | DEB 与 AppImage 各一次 |

macOS 的 `.app` 是可审计的独立构建制品；DMG smoke 已覆盖 DMG 中实际携带的同一应用。AppImage 是便携包，不写系统安装数据库，因此对应步骤称为 stage，但仍会启动真实 AppImage 制品并执行完整 smoke。

## 触发方式

1. 打开 GitHub Actions 的 `desktop-release`。
2. 选择目标 ref 后执行 `Run workflow`。
3. 等待 macOS、Windows、Linux 三个 matrix job 全部结束。
4. 下载三个 `desktop-<platform>-<run-id>-<attempt>` artifact。
5. 检查每个平台的 `desktop-evidence/release-evidence.json`。

单个平台成功不能代表三平台发布完成。只有三个 job 的 `Enforce complete release evidence` 都通过，才具备三平台 unsigned 候选包证据。

## 每个平台的真实步骤

1. 安装 Node.js、Rust 和平台原生打包依赖。
2. 用 `npm ci` 分别安装根目录与 `web/` 的锁定依赖。
3. 三个平台都运行显式的 portable desktop Node.js 测试集；macOS、Linux 额外运行包含宿主 CLI/POSIX 行为的全量 Node.js 测试。Windows 不用平台不兼容的宿主测试冒充桌面发布闸门。
4. 三个平台都运行 Rust native core 的测试与 `cargo check`。
5. 用仓库内 Tauri CLI 构建平台明确指定的 bundle，不使用空壳替代物。
6. 用平台安装器安装或 stage 刚构建的包。
7. 启动安装后的真实可执行文件，并注入仅存在于子进程环境中的 smoke 配置。
8. packaged 应用通过正常 Rust 路径访问系统 Keyring、JSON、SSE、Blob。
9. harness 核对应用结果和 fixture 实际收到的认证请求。
10. 对制品计算 SHA256，对构建、安装、smoke 记录耗时。
11. 无论前序步骤成功与否，都尝试生成并上传 evidence；最终 gate 会拒绝 `incomplete` evidence。

Linux smoke 在独立 `dbus-run-session` 和 `xvfb-run` 中启动。harness 会启动并解锁临时 Secret Service，再用 `secret-tool` 做一次写入、读回、删除探针；该探针通过后，packaged 应用仍必须独立完成自己的 Keyring 契约，禁止改用内存或明文文件。

Windows job 通过只证明 portable desktop Node.js 测试、Rust native core 和 packaged smoke 通过，不代表仓库全量 `npm test` 已兼容 Windows。现有宿主 CLI/文件系统测试中的 Windows 断言失败与 worker 生命周期问题属于独立兼容性债务，必须另行修复，不能通过 `--test-force-exit` 或 `continue-on-error` 纳入发布结论。

## 失败语义

以下任一情况都会让 job 失败：

- Tauri 未生成矩阵要求的全部 bundle。
- 安装器失败，或无法唯一定位安装后的可执行文件。
- packaged 应用未实现 smoke driver、提前退出或超时。
- Keyring 后端不是当前 OS 的真实后端，任一写入/读回/删除检查失败。
- JSON、SSE、Blob 任何请求未携带正确 Management Key，或结果内容不一致。
- smoke/evidence JSON 出现测试 Management Key。
- 任一制品 SHA256 在最终 gate 重算时不一致。

工作流不会因为能够编译 Rust、能够打开窗口或 fixture 自测通过而宣称 packaged smoke 成功。

## 签名状态

当前 dispatch 工作流不依赖提交 Secret：

- macOS：没有 Developer ID 签名和 notarization。
- Windows：没有 Authenticode 签名。
- Linux：没有发行仓库/GPG 包签名。

因此证据中的 `distributionSigning.status` 固定为 `unsigned`，并携带平台原因。未来增加签名必须另行配置受保护的发布环境和 Secret，并增加平台原生签名校验；不能只把 evidence 字段改成 `signed`。

## 当前集成要求

发布 harness 不在 Web/Tauri 源码中偷偷加入 mock。packaged 应用必须按 [desktop-smoke-contract.md](./desktop-smoke-contract.md) 实现受环境变量约束的 test-driver 入口。入口缺失时，工作流会在等待结果文件阶段失败，这是预期的诚实失败。
