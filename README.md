<p align="center">
  <img src="web/src/assets/brand/ai-home-logo.png" alt="ai-home logo" width="220" />
</p>

# ai-home

`ai-home` (`aih`) 用来管理 Codex / Claude / Gemini / Antigravity(agy) / OpenCode 的多账号、多沙箱运行，并把它们统一成一个内置的 OpenAI / Anthropic 兼容网关——一个端点对外，背后自动在多账号、多 provider 间按额度路由、按 (账号,模型) 粒度熔断、按别名优先级降级。每个 CLI 会话默认跑在持久 tmux 里，关终端 / 断 SSH 都不丢。

## 安装

```bash
npm install
```

## 常用命令

### 账号

使用内置 AIH Server profile 启动客户端：

```bash
aih gemini
aih claude
aih codex
aih opencode
```

新增账号：

```bash
aih gemini add
aih claude add
aih codex add
aih opencode add
```

指定账号运行：

```bash
aih gemini 1
aih claude 2
aih codex 3
aih opencode 4
```

查看账号：

```bash
aih ls
aih gemini ls
aih claude ls
aih codex ls
aih opencode ls
```

切换默认账号 / Codex App 账号：

```bash
aih codex set-default 1
aih codex unset-default
aih codex set-mobile 1
aih codex unset-mobile
```

`set-mobile` 只接受 Codex ChatGPT OAuth 账号；API Key 账号不能设为 Codex App 账号。

删除账号：

```bash
aih codex delete 1,2,3
aih codex delete 1-9
aih codex deleteall
```

查看 usage：

```bash
aih gemini usage 1
aih claude usage 1
aih codex usage 1
```

刷新账号额度状态：

```bash
aih codex usage 4 --no-cache
```

### 导入导出

#### 命令速查

```bash
aih export cliproxyapi [all|codex|gemini|claude] [file.json]
aih export sub2api [provider] [file.json]
aih export antigravity [file.json]
aih import [provider] [sources...] [-j N] [-f <folder>] [--dry-run]
```

- `cliproxyapi` 生成 `cliproxyapi-data` JSON；只导出数据文件，不写入本机 CLIProxyAPI 配置。
- `sub2api` 生成 `sub2api-data` JSON；`provider` 可选，支持 `codex`、`claude`、`gemini`、`agy`。
- `antigravity` 只导出 `agy` OAuth 账号，生成 Antigravity Manager JSON。
- `import` 可混合读取目录、zip、JSON、JSONL、`cliproxyapi`，目录会自动发现嵌套 zip、标准 JSON 和旧 provider 子目录。
- `-j N` 控制并发预算；`-f <folder>` 从 zip 内指定子目录开始导入；`--dry-run` 只解析和统计，不写入账号目录。

#### 普通账号压缩包

```bash
aih export accounts.zip
aih codex export accounts.zip
```

普通压缩包在 zip 根目录写入单账号标准 JSON；不会创建 provider 子目录，也不会把本机
`profiles/<provider>/<id>` 的本地账号 ID 写进路径或迁移 payload。

OAuth 账号文件名为 `provider_email.json`；API key 账号文件名为
`provider_url_xxx.json`，其中 `xxx` 是 account-ref 风格的公开 hash 后缀（不带
`acct_`），用于避免同一个上游 URL 配多把 key 时互相覆盖。

```text
codex_user@example.com.json
codex_api.openai.com_v1_2f4c0f6fb7fd9b2e58ac.json
claude_team@example.com.json
gemini_user@example.com.json
agy_user@example.com.json
```

#### 标准格式导出

导出为 CLIProxyAPI 数据 JSON：

```bash
aih export cliproxyapi ./cliproxyapi-data.json
aih export cliproxyapi codex ./cliproxyapi-data.json
aih export cliproxyapi gemini ./cliproxyapi-data.json
aih export cliproxyapi claude ./cliproxyapi-data.json
```

`cliproxyapi` 导出只生成 JSON 数据文件，不会同步或写入 server 机器的 `~/.cli-proxy-api` 配置。

导出为 sub2api 标准 JSON：

```bash
aih export sub2api
aih export sub2api codex ./sub2api-data.json
aih export sub2api claude ./sub2api-data.json
aih export sub2api gemini ./sub2api-data.json
aih export sub2api agy ./sub2api-data.json
```

`provider` 可选；省略时导出 `codex`、`claude`、`gemini`、`agy` 的所有可迁移账号。

sub2api 导出结构示例：

```json
{
  "type": "sub2api-data",
  "version": 1,
  "exported_at": "2026-06-08T00:00:00.000Z",
  "proxies": [
    {
      "proxy_key": "proxy-main",
      "name": "Main proxy",
      "protocol": "http",
      "host": "127.0.0.1",
      "port": 7890,
      "status": "active",
      "fallback_mode": "none",
      "expiry_warn_days": 0
    }
  ],
  "accounts": [
    {
      "name": "codex-user@example.com",
      "notes": "optional note",
      "platform": "openai",
      "type": "oauth",
      "credentials": {
        "email": "user@example.com",
        "access_token": "access-token",
        "refresh_token": "refresh-token",
        "id_token": "id-token",
        "chatgpt_account_id": "chatgpt-account-id",
        "plan_type": "plus"
      },
      "proxy_key": "proxy-main",
      "concurrency": 0,
      "priority": 0,
      "rate_multiplier": 1,
      "expires_at": 1893456000,
      "auto_pause_on_expired": false
    },
    {
      "name": "codex-api-key",
      "platform": "openai",
      "type": "apikey",
      "credentials": {
        "api_key": "sk-openai",
        "base_url": "https://api.openai.com/v1"
      },
      "concurrency": 0,
      "priority": 0
    }
  ]
}
```

WebUI 的迁移 JSON 也使用 `sub2api-data` 结构。历史 `format=aih` 下载参数只作为
`sub2api` 别名保留，下载文件名为 `sub2api-data.json`，不再提供单独的 AIH 私有包。它不会导出
本机 `profiles/<provider>/<id>` 里的本地账号 ID；导入到另一台机器或另一个 AIH 目录时会按
`provider + email` 或 `provider + normalizedUrl + key` 去重，并重新分配本地 profile ID。
Codex 凭据里的 `chatgpt_account_id` 属于上游 OAuth 元数据，会保留在 `credentials` 中。

导出为 Antigravity-Manager JSON：

```bash
aih export antigravity ./antigravity-accounts.json
```

`antigravity` 只导出 `agy` OAuth 账号。普通 UI 格式示例：

```json
{
  "accounts": [
    {
      "email": "agy@example.com",
      "refresh_token": "refresh-token"
    }
  ]
}
```

#### 标准格式导入

```bash
aih import accounts.zip
aih import ./accounts
aih import ./sub2api-data.json
aih import ./antigravity-accounts.json
aih import cliproxyapi
aih import codex ./sub2api-data.json
aih import gemini cliproxyapi
aih codex import ./some-folder
aih import ./many-zips -j 8
aih import ./backup.zip -f nested/folder
aih import ./sub2api-data.json --dry-run
```

支持的导入来源：

- 目录
- zip 压缩包
- 旧版 `accounts/<provider>` 结构目录
- 单账号 JSON
- 多行 JSONL
- 手动粘贴 JSON / JSONL
- CLIProxyAPI 本地配置和 auth-dir
- sub2api `sub2api-data` / `sub2api-bundle` JSON
- Antigravity-Manager UI JSON

导入成功后的本地结构示例：

```text
profiles/
  codex/1/.codex/auth.json
  codex/2/.aih_env.json
  claude/1/.claude/.credentials.json
  gemini/1/.gemini/oauth_creds.json
  agy/1/.gemini/antigravity-cli/antigravity-oauth-token
  opencode/1/.local/share/opencode/auth.json
```

导入接口和 CLI 只把来源数据转换成本机 profile 目录，不保留来源包里的本地账号 ID。
如果目标环境已经存在同一身份，会按下面的去重规则跳过，不覆盖现有凭据。

`aih import [provider] ...` 中的 `provider` 可选，用来限制导入范围。当前支持：

- `codex`
- `claude`
- `gemini`
- `agy`
- `opencode`

导入行为等价于新增账号：成功写入凭据后会触发账号凭据维护 hook；如果是默认账号，相关客户端配置会通过解耦 hook 同步。

导入 / 导出去重规则只有一套：

- OAuth 账号只按 `provider + email` 判断身份；缺少 email 的 OAuth 数据无效。
- 相同 OAuth 身份已存在时跳过，不覆盖旧账号；不会因为导入数据里的过期时间、refresh token 或 `account_id` 更新旧账号。
- 不读取 provider `account_id`、`chatgpt_account_id` 或 refresh token hash 作为本地 profile 身份。
- API Key 账号只按 `provider + normalizedUrl + key` 判断身份。
- 相同 API Key 身份已存在时跳过，不覆盖旧账号。
- `normalizedUrl` 会 trim 并移除尾部 `/` 后参与比较。
- sub2api 的 `notes`、`extra`、`proxy_key`、`concurrency`、`priority`、`rate_multiplier`、`expires_at`、`auto_pause_on_expired`、`proxies` 会保存到账号目录的 `.aih_transfer.json`；再次导出 sub2api 时会恢复这些字段，避免丢失上游迁移信息。

### 内置代理服务

启动默认 AIH provider 服务：

```bash
aih server start
```

默认监听：

- `base_url`: `http://127.0.0.1:9527/v1`
- `api_key`: 未配置时可使用 `dummy`

`aih claude`、`aih codex` 不带账号 ID 时会使用内置 AIH Server profile，不需要把 `127.0.0.1:9527` 手动添加成 provider 账号。

启动后台服务：

```bash
aih server start
```

前台运行：

```bash
aih server serve
```

查看状态 / 重启 / 停止：

```bash
aih server status
aih server restart
aih server stop
```

`aih daemon` 是同一组后台服务命令的别名：

```bash
aih daemon status
aih daemon restart
```

开机自启：

```bash
aih server autostart install
aih server autostart status
aih server autostart uninstall
```

自启实现按平台落到系统原生位置：

- macOS: `~/Library/LaunchAgents/com.clawdcodex.ai_home.plist`
- Linux: `~/.config/systemd/user/com.clawdcodex.ai_home.service`
- Windows: Startup 文件夹里的 `com.clawdcodex.ai_home.cmd`

自启项统一使用 `aih` 命令入口；如果当前环境无法解析 `aih`，安装会失败并提示设置 `AIH_CLI_PATH` 或先安装 CLI。
安装新自启项时会清理历史旧自启项，避免重复启动。

Linux 使用 user systemd service，不自动提权；无登录的服务器级启动需要部署层启用 linger 或改成系统级 service。

自定义监听地址、端口、API Key：

```bash
aih server serve --host=0.0.0.0 --port=9527 --api-key=my-key
```

后台服务的 `start` / `restart` / `stop` / `status` 是单实例生命周期命令，不接收端口参数；后台服务会读取已保存的 Server 配置。

外部调用方配置：

- `base_url`: `http://127.0.0.1:9527/v1`
- `api_key`: 你配置的 `--api-key`，未配置时默认可用 `dummy`

### Web UI

启动服务后打开：

- `http://127.0.0.1:9527/ui/`

当前 Web UI 支持：

- 账号管理
- 账号导入 / 导出
- 模型别名管理
- 手动打开项目
- 选择文件夹打开项目
- 新建会话
- 原生会话续写
- 图片粘贴发送
- 运行中交互输入回写（`y` / `n` / 文本）
- Server 配置与一键重启

### 远程节点与手机 Control Plane

AIH 的远程拓扑分三层，避免把“能连上机器”和“业务流量怎么走”混在一起：

- **Control Plane**：当前管理端，负责账号、会话、模型、远程节点和设备配对。
- **Node**：被接入的电脑或服务器，默认通过 `aih-relay` 主动连回 Control Plane，适合无公网 IP。
- **Device client**：手机、PWA、平板、另一台电脑都按 client 处理；一个 client 可以保存多个 Control Plane profile，并切换当前 server。

当前电脑管理多台电脑的最短路径：

1. 在当前电脑启动 Control Plane，并让局域网可访问：

```bash
aih server config set --open-network
aih server restart
aih node doctor
```

`aih node doctor` 会打印 `endpoint candidate`，例如 `http://192.168.3.181:9527`。其他机器必须使用这个局域网/Tailscale/FRP/公网入口，不能用 `127.0.0.1`。

2. 打开 Web UI：`http://<当前电脑局域网 IP>:9527/ui/`。

3. 进入 `设置 -> 远程节点 -> 一键加入`：

   - `Control Endpoint`：填当前电脑的可达地址，例如 `http://192.168.3.181:9527`。
   - `首选 Transport`：无公网机器默认选 `relay`。
   - `目标系统`：按目标机选 `linux` / `darwin` / `win32`。
   - `Repo URL`：填仓库 HTTPS 地址，例如 `https://github.com/madou1217/ai_home.git`；目标机不需要配置 GitHub SSH key。
   - `SSH 探测目标`：一行一个，例如 `model@192.168.3.8`、`model@192.168.3.22`。
   - `TCP 探测目标`：Windows 可以先填 IP，例如 `192.168.3.76`。

4. 点 `生成加入命令`，再点 `只读探测`。

   - SSH-ready 的 Linux/macOS 会出现可复制的 SSH bootstrap 命令。
   - Windows 如果没有 SSH key 或 WinRM，会生成 PowerShell 脚本；需要在目标机本地控制台执行。AIH 不保存 SSH 密码。

5. 确认 SSH-ready 目标后，可点 UI 里的执行按钮，或用 CLI 执行 Linux/macOS：

```bash
aih node bootstrap apply \
  --asset-mode local \
  --execute --yes \
  --ssh model@192.168.3.8 \
  --ssh model@192.168.3.22 \
  --control-url http://192.168.3.181:9527 \
  --invite-url "<join-url>" \
  --repo-url https://github.com/madou1217/ai_home.git \
  -j 2
```

`--asset-mode local` 会通过 SSH 传当前源码/本地运行资产，适合目标机弱公网或缺少 Node/npm 的情况。Windows 只有配置 SSH key 或启用 WinRM 后才适合自动执行；否则需要在目标机本地控制台手动执行生成的 PowerShell 脚本。

6. 接入成功后，在 `设置 -> 远程节点 -> 已配置节点` 查看节点并点 `测试连接`。在 `Chat` 页面顶部的远程节点选择器里切换 `本机` 或具体节点，查看/进入对应节点的会话。

一个已落地的局域网形态可以直接照着检查：

| 角色 | 地址 | 节点 ID | 连接方式 |
|---|---|---|---|
| Control Plane | `192.168.3.181:9527` | 本机 | `0.0.0.0:9527` 对局域网开放 |
| Linux node | `192.168.3.8` | `model-ca934857` | `aih-relay` 主动出站，systemd user service 持久化 |
| macOS node | `192.168.3.22` | `mac-mini.local-cbef5c88` | `aih-relay` 主动出站，launchd 持久化 |
| Windows node | `192.168.3.76` | `meadeo-7f15b6c7` | `aih-relay` 主动出站，当前用户 Startup 脚本持久化 |

所有客户端都打开同一个入口：

```text
http://192.168.3.181:9527/ui/
```

这不是三台机器两两互开端口。AIH 的默认互联是 **hub-and-spoke**：每台 node 主动连接 Control Plane，Control Plane 再通过 relay 转发 status、accounts、projects、sessions、input。手机、平板、另一台电脑只是 client；它们不直接连 node，也不需要 node 有公网 IP。

验证三台节点是否真正可管理：

```bash
curl -s http://127.0.0.1:9527/v0/webui/nodes
curl -s -X POST http://127.0.0.1:9527/v0/webui/nodes/model-ca934857/test
curl -s -X POST http://127.0.0.1:9527/v0/webui/nodes/mac-mini.local-cbef5c88/test
curl -s -X POST http://127.0.0.1:9527/v0/webui/nodes/meadeo-7f15b6c7/test
```

`/test` 返回 200 只说明远程管理链路可用；会话列表还要走 device client 权限。手机/PWA 配对后会自动带 device token，读取 `/v0/node-rpc/device-node-sessions?nodeId=<id>`。

远程 relay 持久化检查：

```bash
# Linux node
ssh model@192.168.3.8 'systemctl --user status com.clawdcodex.ai_home.node-relay.model-ca934857.service'

# macOS node
ssh model@192.168.3.22 'launchctl list com.clawdcodex.ai_home.node-relay.mac-mini.local-cbef5c88'

# Windows node: 登录该用户后检查 Startup 目录里的 com.clawdcodex.ai_home.node-relay.<node-id>.cmd
```

如果用 `--asset-mode local` bootstrap，目标机的 `aih` 和 `node` 可能只在仓库 `.node-local/bin` 下。手动排障时先把它放进 PATH：

```bash
cd ~/projects/feature/ai_home
PATH="$PWD/.node-local/bin:$PATH" AIH_CLI_PATH="$PWD/.node-local/bin/aih" \
  ./.node-local/bin/aih node relay service status --node-id <node-id>
```

Web UI 打开后如果看到 `/v0/management/usage/*` 401，说明浏览器在直接访问 management API。management API 有 `Management Key` 时本来就会拒绝裸请求；Web UI 页面应走 `/v0/webui/management/usage/*` 同源代理，不能把 management key 暴露给浏览器。

无公网机器优先走内置 relay：

```bash
aih node bootstrap probe \
  --ssh model@192.168.3.8 \
  --ssh model@192.168.3.22 \
  --tcp 192.168.3.76 \
  --control-url http://127.0.0.1:9527 \
  --invite-url "<join-url>" \
  --repo-url https://example.com/ai_home.git
```

探测命令是只读的，不会改远端机器。SSH 可达的 Linux/macOS 会给出可复制的管道 bootstrap：

```bash
aih node bootstrap --target linux --script-only ... | ssh model@192.168.3.8 'sh -s'
```

Windows 不假设 SSH/WinRM。没有 SSH key 或 WinRM 时，系统只生成 PowerShell 脚本；首次接入需要在目标机本地控制台复制执行。AIH 只使用 Relay 或已登记的真实 HTTP transport 作为数据面。

外部网络工具在 AIH 里的角色：

- **FRP / SSH tunnel / direct**：你先把 node server 暴露成一个 HTTP endpoint，再把 endpoint 保存到远程节点。
- **Tailscale / ZeroTier / WireGuard**：作为可路由 overlay；AIH 记录 endpoint 和能力，不托管 VPN 生命周期。
- **OpenMPTCPRouter / MPTCP**：作为 underlay/链路聚合优化；AIH 不管理内核或路由器，只记录可达 endpoint。
- **AIH Relay**：默认低配置路径；node 主动出站到 Control Plane，适合无公网、NAT 后、手机只做管理端的场景。

手机接入不是单独的“移动端账号”，而是 Control Plane device pairing：

1. 在 Web UI `设置 -> 控制面 -> 配对手机/设备` 生成一次性配对入口。
2. 手机打开 `webPairUrl`，或在 `通过配对添加 Control Plane` 粘贴 Web pair URL / 原始 pair URL / code + endpoint。
3. 配对成功后，本机 local profile 保存该 Control Plane 的 device token。
4. 业务页面读取当前选中的 Control Plane；可以在 `已保存 Control Plane` 或仪表盘里切换 server。

配对 token 只返回一次；服务端只保存 hash。撤销设备后，该手机需要重新配对。

### 持久会话（tmux 续接，关终端不丢）

`aih` 用 **tmux** 把每个 CLI 会话跑在后台持久进程里：**关终端、SSH 断线、合盖睡眠都不丢**，重连后续接即可。tmux 平时是隐形的（隐藏状态栏、零延迟），你几乎感觉不到它——但记住下面几个键就能掌控它。

> tmux 的「指挥键」是 **`Ctrl-b`**：先按住 `Ctrl-b` 松开，**再**按下一个键。它本身不输入任何东西，只是告诉 tmux「下一个键是给你的命令」。

**日常只需要这 4 件事：**

| 你想做什么 | 怎么做 |
|---|---|
| **暂时离开、但让它继续在后台跑** | `Ctrl-b` 然后 `d`（detach）。终端回到普通 shell，会话不中断。 |
| **回到刚才的会话**（续接） | 在**同一个项目目录**重跑 `aih claude 1`。每次启动都会**打印一行说明**当前是「✦ 新建 / ↻ 续接 / ⚠ 新开并发」哪种情况，绝不会悄悄发生。 |
| **往回翻屏 / 看刷过去的历史** | `Ctrl-b` 然后 `[` 进入滚动模式 → 用 `↑/↓`、`PageUp/PageDown` 翻（保留 5 万行）→ 按 `q` 退出滚动。（鼠标滚轮默认**不**接管，用这个方式翻。） |
| **彻底结束会话** | 在 AI 工具里用它自己的退出命令正常退出，会话随之销毁。 |

**同一个账号可以同时开多个项目 / 多个窗口**（这是按目录 + 具名寻址的好处）：

```bash
cd ~/projA && aih claude 1            # 项目 A 的默认会话
cd ~/projA && aih claude 1            # ← 再开一个窗口同目录：原会话还开着就「新开并发会话」，不抢；原会话已关就「续接」回去
cd ~/projA && aih claude 1 -S debug   # 想要一个固定具名的并发窗口
cd ~/projB && aih claude 1            # 项目 B（同账号、并发、互不干扰）
```

**① 查看「本项目」有哪些会话** —— 在项目目录里跑 `sessions`，它会**自动把本项目和其他项目分开**，每行直接给出可复制运行的命令：

```bash
cd ~/projA && aih claude sessions 1
# [aih] claude #1 持久会话（socket aih-claude-1）：
# 本项目（/Users/you/projA）：
#   ● 在用   aih claude 1 -R          ← ●=正被别处占用，加 -R 可接管
#   ○ 空闲   aih claude 1             ← ○=空闲，直接跑即续接
#   ○ 空闲   aih claude 1 -S debug
# 其他项目：
#   ○ 空闲   cd /Users/you/projB && aih claude 1
```

**② 同一目录再开一个窗口会发生什么**（每次都有一行提示，绝不静默）：

- 原会话**还开着** → 自动新开一个**并发会话**，原会话**不受影响**（不会被抢下线）。
- 原会话**已关闭 / SSH 断开**（detached）→ **续接**回原会话。
- 想**强行接管**那个还开着的会话（而不是新开）→ 加 **`-R`**（见下方跨机器场景）。
- 想精确指定某个固定窗口 → 用 `-S <名字>`（若该具名会话正被别处占用，`-S` 会直接接管它——因为你是按名字明确点它）。

寻址规则：**每个账号一个独立 tmux**（socket `aih-<provider>-<id>`，凭据只走环境变量，`ps` 里看不到密钥）；**会话按「项目目录」或 `-S <名字>` 区分**。所以不同目录天然是不同会话，同一账号能并发多个。

### 跨机器 / SSH：在另一台电脑接着干

持久会话最大的用处就是这个：在**电脑 A** 的项目里开着 `aih claude 1`，人走到**电脑 B**，`ssh` 回电脑 A 想接着干。两种情况：

```bash
# 在电脑 B 上：
ssh you@电脑A
cd ~/projA

# 情况一：电脑 A 那个终端已经关了 / 之前的 SSH 断了（会话处于 detached）
aih claude 1            # → 直接「续接」回原会话，接着干

# 情况二：电脑 A 桌前那个窗口还开着（会话仍 attached）。三选一：
aih claude 1            # → 默认「新开并发会话」，各看各的，互不打扰
aih claude 1 -R         # → 「接管」：把会话抢到电脑 B，电脑 A 那个窗口被挤下线
aih claude 1 -M         # → 「镜像同屏」：A 和 B 连到同一个会话，实时同屏，双方都能看/操作，谁都不被挤
```

**三种模式一句话区分**（同一个还活着的会话，你想怎么对它）：

| 你想要 | 用什么 | 效果 |
|---|---|---|
| 各干各的 | 直接跑（默认） | 新开一个独立并发会话，原会话不受影响 |
| 把它抢过来 | `-R` | 接管那个会话，原来连着它的窗口被挤下线 |
| **一起看同一个**（共存/同屏） | `-M` | 两个窗口连到**同一个**会话，实时镜像，**谁都不挤掉谁**（按 `Ctrl-b d` 只离开你这一侧） |

> 不确定先 `aih claude sessions 1` 看一眼：`●` = 正被别处占用，`○` = 空闲可直接续接。
> `-M` 的底层就是 tmux 的共享 attach（多个 client 连同一 session），和结对编程/屏幕共享是同一个机制。
> 注意 `-R` / `-M` 是 aih 自己的开关（不是 claude 的 `--resume`）；要把 `--resume` 传给 claude 照常用，不会被吞。

**会话卡死要强杀**（很少用到——先用 `sessions` 看到准确名字，再杀）：

```bash
aih claude sessions 1                              # 看名字（具名会话显示成 s-<名字>）
tmux -L aih-claude-1 kill-session -t s-debug       # 杀指定一个
tmux -L aih-claude-1 kill-server                   # 杀该账号下全部会话
```

**完全不想要 tmux**：`AIH_NO_PERSIST=1 aih claude 1`，直接前台运行、不进 tmux（断线即丢）。

跨平台：

- macOS / Linux / WSL：用系统 `tmux`（没装就 `brew install tmux` / `apt install tmux`）；
- **原生 Windows**：自动探测 tmux 兼容引擎——优先 [`psmux`](https://github.com/psmux/psmux)（原生 ConPTY、兼容 tmux 命令），其次 MSYS2 / Cygwin 的 `tmux.exe` 或 PATH 上的 `tmux`；都没有则降级为直接启动（Windows 路径需在 Windows 机器上实测验证）。

### 模型别名与网关调度

内置网关（`http://127.0.0.1:9527/v1`）对外是**一个**统一端点，背后自动在多账号、多 provider 间路由。

**模型别名**（WebUI「模型别名管理」里配置）——把一个对外模型名映射到真实模型，支持通配和优先级：

- 例：`claude-*` → `claude-opus-4-6-thinking`（agy）；再加一条 `claude-*` → `gemini-3.5-flash-low`（agy）当**降级**。
- **优先级高的先用**；同名多条规则自动形成 **fallback 链**。
- 通配 pattern（`claude-*`）**不会出现在 `/v1/models` 列表**里（客户端没法把通配名当模型发），但请求时照常解析。

**调度与熔断**（自动，无需配置）：

- 选号按各账号剩余额度加权。
- **429 / 配额耗尽是按 (账号, 模型) 粒度熔断的**：某账号的 claude 模型被限流，它的 gemini 模型**照常可用**，不会整号被锁。
- 当某个别名目标（如 claude-opus）在**所有账号上都被限流**时，自动**降级到下一条优先级的别名**（如 gemini-3.5-flash-low）顶上。
- `/v1/models` 带 stale-while-revalidate 缓存，稳态响应 <5ms。

## 开发

运行测试：

```bash
npm test
```

构建前端：

```bash
npm run build
```

AI 前端设计委托：

```bash
npm run ui:delegate -- --provider claude --scope "Accounts mobile redesign"
npm run ui:delegate -- --provider agy --agy-account 1 --scope "H5 interaction audit"
npm run ui:delegate -- --provider agy --agy-account 1 --agy-continue --scope "Continue design review"
npm run ui:delegate -- --provider agy --agy-account 1 --agy-conversation <id> --scope "Resume design review"
```

`ui:delegate` 直接封装 `aih claude` / `aih agy <id> -p`。Agy 支持 `--agy-continue` 保持最近会话，也支持 `--agy-conversation <id>` 恢复指定会话。Claude 委托沿用当前运行时配置和模型 alias，不在脚本里固定模型；输出会写入 `tmp/ai-ui-delegation/` 供前端重构审计。

Web UI 规范：

- 设计规范入口：`/ui/design-system`。
- 样式基础：Tailwind CSS v4 + AntD theme token + 少量页面级 CSS 变量。
- 动效基础：`animate.css` 只用于页面入场、Sheet 上滑和短强调；业务状态动效优先使用 CSS transition。
- PC/H5 必须按两套交互结构开发，移动端不允许用隐藏表格列来伪装响应式。

## 说明

- 关于 agy (Antigravity CLI) 用量刷新：当前走 Antigravity Code Assist 的 `loadCodeAssist` / `fetchAvailableModels` 链路，从真实返回的模型 `quotaInfo` 生成用量快照；实现会刷新过期 OAuth token，并在 `project` 请求 403 时去掉 `project` 重试。用量刷新会向上游发送 AGY OAuth access token，排障时不要打印 token 或 refresh token。
- 文档只保留当前可用用法
- 具体实现细节以代码和测试为准
