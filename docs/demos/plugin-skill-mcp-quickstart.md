# 插件、Skill、MCP 与原生插件快速上手

这份 quickstart 对应当前已经能运行的管理面。统一插件设计见 [Universal Agent Plugin Architecture](../superpowers/specs/2026-10-25-universal-agent-plugin-design.md)；实现证据见 [Plugin Management Closure Evidence](../architecture/plugin-management-closure.md)。管理命令操作本机资源；下列 demo 脚本使用确定性 fixture，不消耗上游模型额度。手工原生对话按各 CLI 的模型配置运行。

如果要做一次不触碰真实账号的演示，优先运行下面的脚本。它们各自创建临时 home，结束后清理临时文件，并且输出会刻意省略凭据、完整请求正文和管理密钥：

```bash
node scripts/plugin-closure-demo.js --json
node scripts/aih-portable-plugin-demo.js
node scripts/skill-native-demo.js --provider claude --binary /Users/model/.local/bin/claude
node scripts/mcp-native-demo.js
node scripts/native-plugin-demo.js
node scripts/workbuddy-resource-native-demo.js
node scripts/native-plugin-use-demo.js codex
node scripts/native-plugin-use-demo.js claude
node scripts/pi-plugin-native-demo.js
node scripts/pi-plugin-native-demo.js --managed
node scripts/pi-plugin-tool-loop-demo.js
node scripts/deepseek-plugin-native-demo.mjs
node scripts/deepseek-plugin-managed-demo.mjs
```

## AIH 自有插件

AIH 插件使用签名/摘要制品和受监督 Host。最小手工流程如下：

```bash
aih plugin validate examples/plugins/echo --load
aih plugin pack examples/plugins/echo /tmp/aih-sample-echo.aih-plugin
aih plugin install /tmp/aih-sample-echo.aih-plugin
aih plugin enable aih.sample.echo
aih plugin call sample.echo.call \
  --value-json '{"marker":"AIH_PLUGIN_DEMO_OK"}' --json
aih plugin list --json
aih plugin doctor --json
aih plugin disable aih.sample.echo --remove
aih plugin uninstall aih.sample.echo
```

`node scripts/plugin-closure-demo.js --json` 会另外验证重启后的 `use-after-restart`。插件停用先撤销可见贡献，正在进行的调用仍归属于原 generation；制品和状态目录由 AIH 管理。

同一份在 Pi、DeepSeek、OpenCode 运行的 canonical 包也可以直接交给 AIH。
安装和调用需要已启动的 `aih server`：

```bash
aih plugin validate examples/native-plugins/aih-demo --load
aih plugin pack examples/native-plugins/aih-demo /tmp/aih-demo.aih-plugin
aih plugin install /tmp/aih-demo.aih-plugin
aih plugin enable aih-demo --accept-permissions
aih plugin call aih-demo.tool.aih_demo --value-json '{"text":"portable-input"}' --json
aih plugin disable aih-demo --remove
aih plugin uninstall aih-demo
node scripts/aih-portable-plugin-demo.js
```

预期调用值为 `AIH_PLUGIN_DEMO_OK:portable-input`。最后一条脚本使用临时 home、
真实签名和受监督 Host 验证完整链路，无需修改正在运行的服务。源包无需维护
`plugin.json`；生成的清单只存在于制品内。首期工具通过 AIH command contribution 调用。

## Managed Skill

Skill 安装到 provider 声明的宿主投影位置，安装后立即启用；显式停用或移除会被后续启动保留。下面以 Claude 为例，Codex/另一个已声明宿主只需替换 `--provider`：

```bash
aih skill install assets/provider-skills/aih-demo --provider claude --json
aih skill list --provider claude --json
aih skill doctor --provider claude --json
aih skill disable aih-demo --provider claude --json
aih skill enable aih-demo --provider claude --json
aih skill remove aih-demo --provider claude --json
```

若要证明 native client 真正读到了 skill 内容，使用对应本机 CLI 的 probe：

```bash
node scripts/skill-native-demo.js \
  --provider claude \
  --binary /Users/model/.local/bin/claude
node scripts/skill-native-demo.js \
  --provider codex \
  --binary /Users/model/.codex/packages/standalone/releases/0.164.0-aarch64-apple-darwin/bin/codex.aih-original
node scripts/skill-native-demo.js \
  --provider opencode \
  --binary /Users/model/Library/pnpm/bin/opencode
```

`install --all-supported` 会尝试所有已声明 projection adapter，但这只证明投影写入；没有 native executable 的宿主仍须由 `doctor` 标为不可用或 projection-only。

## Managed MCP

MCP 定义保存在 AIH 的受管状态中，`enable` 才写入 provider 原生配置；`test`、`tools`、`call` 直接启动本地 stdio server，用有界 JSON-RPC 客户端做真实工具调用。例子使用仓库的 demo server：

```bash
aih mcp add aih-demo \
  --provider claude \
  --command node \
  --arg "$PWD/examples/mcp/aih-demo-server.js" \
  --json
aih mcp test aih-demo --provider claude --json
aih mcp tools aih-demo --provider claude --json
aih mcp call aih-demo aih_echo \
  --args-json '{"text":"AIH_MCP_DEMO_OK"}' \
  --provider claude --json
aih mcp enable aih-demo --provider claude --json
aih mcp disable aih-demo --provider claude --json
aih mcp remove aih-demo --provider claude --json
```

跨 provider 的真实配置形状和工具调用可以一次复核：

```bash
node scripts/mcp-native-demo.js
```

该 probe 当前覆盖 Codex、Claude、OpenCode 和 Cline。`list`/`doctor` 只显示参数数量和环境变量键名，不输出值；用户修改过的原生配置会 fail closed，避免覆盖非 AIH 内容。

## 原生插件管理与 Portable Projection

原生插件仍由各宿主拥有安装语义；AIH 管理器保存 package digest、生成投影、执行启用/停用/移除并做所有权检查。以 Claude 为例：

```bash
aih native plugin install examples/native-plugins/aih-demo \
  --provider claude --json
aih native plugin list --provider claude --json
aih native plugin disable aih-demo --provider claude --json
aih native plugin enable aih-demo --provider claude --json
aih native plugin doctor --provider claude --json
aih native plugin remove aih-demo --provider claude --json
```

在新开的原生会话里，Codex 使用 `$aih-demo:aih-demo`，Claude 使用
`/aih-demo:aih-demo` 调用包内 Skill。下面两条 probe 通过真实 native client
验证插件正文进入请求，并覆盖启用/停用/重新启用/移除四阶段：

```bash
node scripts/native-plugin-use-demo.js codex
node scripts/native-plugin-use-demo.js claude
```

OpenCode 使用同一插件包的 server 入口注册 `aih_demo` 工具：

```bash
aih native plugin install examples/native-plugins/aih-demo --provider opencode --json
opencode run 'Use the aih_demo tool if available.'
aih native plugin disable aih-demo --provider opencode --json
aih native plugin enable aih-demo --provider opencode --json
aih native plugin remove aih-demo --provider opencode --json
node scripts/opencode-plugin-native-demo.js
```

交互使用需要 OpenCode 自己可用的模型配置。最后一条 demo 则使用隔离目录与
本地推理 fixture，证明四阶段的工具 schema、原生执行事件和结果回传，
不需要远程推理；可选位置参数为 CLI 路径和已安装的 SDK 依赖目录。

同一个 canonical `package.json` 可以先做宿主导入检查和投影：

```bash
aih native plugin inspect examples/native-plugins/aih-demo \
  --host deepseek --json
aih native plugin project examples/native-plugins/aih-demo \
  --host deepseek --out /tmp/aih-demo-deepseek --json
aih native plugin inspect examples/native-plugins/aih-demo \
  --host pi --json
```

`inspect/project` 验证 `agentPlugin`、`exports`、入口文件和 `pi.extensions` 的一致性，并写入不含秘密的 `host-projection.json`。真实调用使用单独的 probe：

```bash
node scripts/native-plugin-demo.js
node scripts/pi-plugin-native-demo.js
node scripts/deepseek-plugin-native-demo.mjs
```

后两条的 package directory 是可选位置参数；省略时会按外部 harness 描述符查找全局安装和 pnpm store，并用真实 CLI 的版本输出确认可运行性。Pi probe 通过原生 install/remove、SDK ResourceLoader、工具、命令和 shutdown 验证；DSH probe 通过原生 profile add/remove/dump、DSH ToolRuntime 和 Cordis scope 验证。它们不调用远程模型，也不证明 DSH browser/TUI 或 OpenCode TUI/RPC 的专用能力。

Pi 已接入独立的 host 管理入口（Pi 是外部 harness，不是账号 provider）：

```bash
aih native plugin install examples/native-plugins/aih-demo --host pi --json
aih native plugin list --host pi --json
aih native plugin disable aih-demo --host pi --json
aih native plugin enable aih-demo --host pi --json
aih native plugin doctor --host pi --json
aih native plugin remove aih-demo --host pi --json
node scripts/pi-plugin-native-demo.js --managed
```

`--managed` probe 通过真实 AIH CLI 执行四阶段，再通过真实 Pi loader 调用工具/命令。
它同时验证 AIH 账号隔离的 Pi harness：启动参数只转发已启用且摘要未被修改的
受管扩展路径；停用/移除后后续启动不再加载。

该 probe 还会执行 `pi-plugin-tool-loop-demo.js`：每阶段通过真实 AIH CLI 管理
插件，再用同一受管状态的 `preparePiHarness` 账号参数启动 Pi，以本地模型
fixture 完成工具声明、调用、结果回传和最终回答。启用/重新启用各两次请求，
停用/移除各一次请求且不含插件工具。可单独运行该脚本观察 JSON 结果；它不
消耗上游额度，也不把 headless CLI 的通过宣称为 Pi TUI/RPC 验证。

DeepSeek 使用相同生命周期和独立 host 身份：

```bash
aih native plugin install examples/native-plugins/aih-demo --host deepseek --json
aih native plugin list --host deepseek --json
aih native plugin disable aih-demo --host deepseek --json
aih native plugin enable aih-demo --host deepseek --json
aih native plugin doctor --host deepseek --json
aih native plugin remove aih-demo --host deepseek --json
node scripts/deepseek-plugin-managed-demo.mjs
```

DeepSeek 安装结果的 `nativeInstall.launchPath` 是生成的 DSH patch，供已有
profile 的 `--patch` 参数使用。AIH 的 DSH 账号启动会自动携带已启用的 patch。
probe 验证原生 profile composition、真实 boot/Loader/ToolRuntime 和清理，
支持依赖已打包的 portable adapter 包；任意第三方 bundle 仍由 DSH 原生包管理器安装。

## WorkBuddy AI 插件、Skill 和 MCP

已安装的 WorkBuddy AI 桌面包提供内嵌资源运行时，无需另装 standalone CLI。
AIH 按描述符找到该入口，并保持 WorkBuddy AI 与国内版的配置目录隔离。
使用同一份 canonical 插件包：

```bash
aih native plugin install examples/native-plugins/aih-demo --provider workbuddy --json
aih native plugin doctor --provider workbuddy --json
aih native plugin disable aih-demo --provider workbuddy --json
aih native plugin enable aih-demo --provider workbuddy --json
aih native plugin remove aih-demo --provider workbuddy --json
```

安装后在新的原生会话输入 `/aih-demo`。安装独立 Skill 时使用
`aih skill install assets/provider-skills/aih-demo --provider workbuddy --json`，
同样用 `/aih-demo` 调用；演示将插件和独立 Skill 分阶段安装以避免同名覆盖。
MCP 使用上面的 `aih mcp` 命令，将 `--provider` 改为 `workbuddy`。

```bash
node scripts/workbuddy-resource-native-demo.js
```

该脚本在隔离 HOME 中验证插件、独立 Skill 各四个阶段，检查每次原生请求和
最终响应；随后验证原生 MCP Connected，并实际调用 `aih_echo` 与
`aih_list_files`。推理服务为本地 fixture，MCP 工具调用由 AIH stdio client
执行，因此这条证据不代表 WorkBuddy 模型自主选择 MCP 工具。
禁用保留插件安装和数据；移除使用原生 `--keep-data`。
升级使用同一 plugin ID 的新版本包，清单错误或目标冲突会在删除旧版本前拒绝。

## 查看所有 provider 的真实边界

```bash
aih provider capabilities --json
aih provider doctor --json
```

常见状态含义：

| 状态 | 含义 |
|---|---|
| `supported` | 该声明的原生边界已由实际宿主操作验证 |
| `projection-only` | canonical/原生配置投影已验证，但 runtime adapter 或调用证据缺失 |
| `runtime-unavailable` | 包形状或管理逻辑已验证，本机没有对应 native executable |
| `unsupported` | provider 没有声明可安全使用的原生边界，AIH 不猜路径 |

provider doctor 是能力审计，不会把静态目录存在或单元测试通过写成完整运行时兼容。需要新增宿主时，先在 canonical manifest 声明入口与能力，再通过 Host Adapter 生成 Native Projection，最后用真实宿主证明加载、调用、停用和移除。
