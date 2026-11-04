# 分发包构建与安装

目标机器**不需要预装 Node、npm 或构建工具**：每个平台的安装包都自带 Node 22 运行时（含 npm）、生产依赖和构建好的 WebUI。

## 产物

每个目标平台生成两种产物：

| 产物 | 用途 |
|---|---|
| `aih-<version>-<target>.run` / `.exe` | 单文件自解压启动器。首次运行解包到 `~/.ai_home/pkg/`，之后直接启动 |
| `aih-<version>-<target>.tar.gz` / `.zip` | 便携目录归档，解压即用；内含 `install.sh` / `install.ps1` |

目标：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`win32-x64`、`win32-arm64`。

## 构建

```bash
npm install --ignore-scripts      # 只为本机打包工具准备依赖（含 7za）
npm run web:build                 # 构建 WebUI（产物在 web/dist）
npm run pkg:build -- --targets all --skip-web-build
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--targets host` | 只打当前平台（默认） |
| `--targets all` | 全部平台 |
| `--targets linux-x64,win32-x64` | 指定平台 |
| `--build-web` | 强制重新构建 WebUI |
| `--skip-web-build` | 直接使用现有 `web/dist` |
| `--with-go` | 一并构建并携带 Go Core（默认跳过；失败只告警） |
| `--skip-sfx` | 只生成目录归档 |
| `--skip-archives` | 只生成单文件 |
| `--npm-registry <url>` | 覆盖 npm registry；例如 `https://registry.npmmirror.com` |
| `--node-version <v>` | 内置 Node 版本（默认当前运行时） |
| `--keep-work` | 保留 `dist/release/.work` 便于排查 |

构建产物、每个产物的 `.sha256` 和 `aih-<version>-manifest.json` 都在 `dist/release/`。

### 构建前置条件

- Node.js 22（打包脚本自身）
- Go 1.21+（生成单文件启动器；`--skip-sfx` 时不需要）；`--with-go` 需要 Go 1.26+
- 能访问 `nodejs.org`（下载各平台 Node 运行时）和 npm registry
- 构建 WebUI 时需要 `web/node_modules`（`cd web && npm install`）

单文件启动器用 Go 编写，构建时把 zip 载荷嵌入可执行文件；交叉编译不需要目标平台的工具链。

## 安装

### macOS / Linux

单文件（推荐）：

```bash
chmod +x aih-1.0.0-darwin-arm64.run
./aih-1.0.0-darwin-arm64.run          # 首次运行会解包并直接启动
```

把单文件放进 `PATH` 即可长期使用：

```bash
mkdir -p ~/.local/bin
mv aih-1.0.0-darwin-arm64.run ~/.local/bin/aih
aih help
```

目录归档：

```bash
tar -xzf aih-1.0.0-darwin-arm64.tar.gz
cd aih-1.0.0-darwin-arm64
./install.sh                          # 安装到 ~/.local/share/aih，链接到 ~/.local/bin/aih
```

`install.sh` 支持 `--prefix`、`--bin-dir`、`--uninstall`；不会修改 shell rc，只提示 PATH。

### Windows

单文件：把 `aih-1.0.0-win32-x64.exe` 放到一个固定目录并加入 PATH，或直接运行。首次运行解包到 `%USERPROFILE%\.ai_home\pkg\`。

目录归档：

```powershell
Expand-Archive aih-1.0.0-win32-x64.zip -DestinationPath .
.\aih-1.0.0-win32-x64\install.ps1     # 安装到 %LOCALAPPDATA%\aih 并写入用户 PATH
```

`install.ps1 -Uninstall` 卸载。

### 数据与账号

安装包只包含程序；账号、配置、会话投影仍在 `~/.ai_home`（Windows 为 `%USERPROFILE%\.ai_home`）。删除或升级程序不会动账号数据；彻底清理需自行删除该目录。

## 部署到远端服务器（二进制部署）

`scripts/deploy-server.js` 只部署**单文件发行包**，不再上传源码、不再在远端执行
`npm install`。远端只保留一个启动器（Linux `~/.local/bin/aih`，Windows
`%LOCALAPPDATA%\aih\aih.exe`），数据目录仍是 `~/.ai_home`。

```bash
# Linux / AWS：自动探测远端平台，从 origin/main 的干净 worktree 构建并部署
npm run deploy:server -- --ssh ubuntu@host

# 直接使用已构建好的发行包（CI 产物 / 本机 dist/release）
npm run deploy:server -- --ssh ubuntu@host \
  --artifact dist/release/aih-1.0.0-linux-x64.run

# Windows（OpenSSH 远程）
npm run deploy:server -- --ssh Administrator@winhost --target win32-x64 \
  --artifact dist/release/aih-1.0.0-win32-x64.exe

# 非 22 端口的 SSH（例如 22008 / 22009）
npm run deploy:server -- --ssh user@host --ssh-port 22009 --target win32-x64 \
  --artifact dist/release/aih-1.0.0-win32-x64.exe
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--target <platform-arch>` | `linux-x64` / `linux-arm64` / `win32-x64` / `win32-arm64` / `darwin-x64` / `darwin-arm64`；默认探测远端 |
| `--ssh-port <n>` | SSH 端口，默认 22；ssh / scp 会分别使用正确的端口旗标 |
| `--artifact <path>` | 已构建的单文件包；不传则从 `--ref` 建临时 worktree 现场构建 |
| `--install-dir <path>` | 启动器安装目录（默认 `~/.local/bin`，Windows 为 `%LOCALAPPDATA%\aih`） |
| `--unit <name>` | systemd user unit，默认 `com.clawdcodex.ai_home`（与 `server autostart install` 一致） |
| `--no-restart` | 只替换启动器，不重装/重启自启动单元 |
| `--skip-go-build` | 本地构建时不带 Go Core（Node 接管全部路由） |
| `--dry-run` | 只打印上传路径与安装脚本；配合 `--artifact` 时完全不连远端 |

远端流程：停旧服务 → 替换启动器 → `aih server autostart install`（把 systemd /
Windows Startup 指向新启动器）→ 启动 → 轮询 `/readyz` → 打印启动器结果。
启动前会清理占用服务端口的**非本启动器**旧进程（例如历史源码部署残留），避免
`/readyz` 被旧服务假通过。Linux 用 systemd user unit 常驻；Windows 用 WMI 创建
`aih.exe server serve`（挂在 WmiPrvSE 下，断开 SSH 后仍存活）。任何一步失败都会
以非零退出，不会留下半更新的服务。

## 单文件启动器

- 解包目录：`${AIH_PKG_DIR:-${AIH_HOME_DIR:-~/.ai_home}/pkg}/<version>-<target>-<sha8>/`
- 同一份载荷只解包一次；升级到新版本会使用新的目录
- `AIH_PKG_DIR`：自定义解包根目录
- `AIH_PKG_EXTRACT_ONLY=1`：只解包并打印目录，不启动
- `AIH_PKG_FORCE_EXTRACT=1`：强制重新解包
- 启动器会设置 `AIH_PACKAGED=1`、`AIH_EXECUTABLE`、`AIH_CLI_PATH`，并把内置 Node 的 `bin/` 注入 `PATH`；终端补全、`aih resume`、后台自启使用的都是启动器本身，而不是需要外部 `node` 的 `.js` 入口
- 后台自启记录的是启动器路径：把单文件放进 `PATH` 后不要移动或删除它

## 分发包里有什么

- `runtime/`：裁剪后的 Node 22 发行版（`node`、`npm`、`npx`），约 130 MiB
- `node_modules/`：生产依赖；已按目标平台裁剪 pty 预编译件，移除 `@openai/codex` 的平台包（约 240 MiB）
- `web/dist/`：构建好的 WebUI
- `lib/ bin/ assets/ contracts/ examples/ scripts/ native/`：程序与运行时资源
- `bin/native/<target>/aih-server`：可选的 Go Core（`--with-go`）

`@openai/codex` 不随包提供，`aih codex` 仍会按需安装/查找本机 codex CLI。Go Core 缺失时 Node 接管全部网关路由，功能不受影响。

## 验证

```bash
npm run pkg:smoke -- --artifact dist/release/aih-1.0.0-darwin-arm64.run
```

冒烟脚本会在隔离 HOME 中验证：无系统 Node 时 CLI 可运行、网关能启动、`/ui/` 与页面引用的 JS/CSS 都从包内返回 200。

Linux 产物可在容器里验证：

```bash
docker run --rm -v "$PWD/dist/release:/release:ro" ubuntu:24.04 \
  sh -c 'apt-get update -qq && apt-get install -y -qq ca-certificates >/dev/null && /release/aih-1.0.0-linux-x64.run help'
```

Windows x64 包可以在 macOS / Linux 上用 Wine 冒烟（不是原生 Windows 的替代验证）：

```bash
WINEPREFIX=/tmp/aih-wine wine aih-1.0.0-win32-x64.exe help
WINEPREFIX=/tmp/aih-wine wine aih-1.0.0-win32-x64.exe server serve --port 19660
```

Windows 11 x64 真机（10.0.26220）已验证：`aih-1.0.0-win32-x64.exe` 首次解包正常；`server serve` 后通过 WebUI 终端接口打开 PTY，进程加载包内 `node-pty/prebuilds/win32-x64/conpty/conpty.dll` 并拉起 `OpenConsole.exe --headless`，命令往返输出与 `mode con` 缩放（120×40）均正常，关闭终端后 helper 进程退出。

Wine 不实现 ConPTY，所以终端功能不能用 Wine 验证；`node-pty` 的 winpty 路径可单独用来确认预编译件完整。安装包内同时包含 `conpty.dll` / `OpenConsole.exe`，Windows 10/11 走 ConPTY。Windows ARM64 包需要 ARM64 Windows 或 ARM64 Wine，不能在 x64 Wine 下运行。

## 发布

`.github/workflows/release-artifacts.yml` 在推送 `v*` 标签时构建全部目标，上传 workflow artifact，并附加到对应的 GitHub Release。标签必须与 `package.json` 的版本一致。

发版流程（版本提升 → 提交 → 打 tag → 推送 → CI 打包）见 `docs/releasing.md`：
`npm run release:tag -- --bump patch`。只有 tag 会触发打包；本地 `npm run pkg:build` 仅用于验证。

## 已知限制

- 安装包未做代码签名：macOS 从浏览器下载后可能需要 `xattr -d com.apple.quarantine <file>`；Windows 可能触发 SmartScreen
- 内置 npm 的 registry 沿用用户 npm 配置；国内网络可在构建时传入 `--npm-registry`
- 升级是“下载新包 + 再次运行”；旧版本的解包目录不会自动删除，可手动清理 `~/.ai_home/pkg/`
