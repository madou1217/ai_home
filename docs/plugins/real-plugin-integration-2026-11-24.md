# 真实 DSH / OpenCode 插件集成（2026-11-24）

目标不是“装上”，而是**不改插件源码、能在真实 harness 里用起来**。

## 1. 最终保留的 3 个插件

| 插件 | 版本 | 用途 | 是否已验证可用 |
|---|---|---|---|
| `dsh-context` | 0.87.1 | DSH 上下文/Token/成本洞察，左侧「上下文洞察」页、Context 侧栏、`/context` 命令、Fleet 多 Agent 视图 | ✅ DSH Web 侧边栏出现该入口，客户端资源实际返回 200 |
| `dsh-whale-widget` | 0.4.2 | DSH Web 右下角 DeepSeek 余额/今日已用/每轮消耗挂件 | ✅ DSH Web 右下角实际渲染，`/dsh-whale/widget.js` 返回 200 |
| `opencode-rules` | 2.0.0 | 按 glob/keyword/model 等条件向 OpenCode 注入 markdown 规则 | ✅ 插件入口已加载；规则发现与元数据解析已实际验证 |

已移除两个“装了也用不上”的：

- `opencode-wakatime`：本机没有 `~/.wakatime.cfg` / API key，无法上报。
- `dshmarket`：DSH 内置插件市场，与 AIH 自己的插件管理重复，容易形成第二套来源。

## 2. 怎么用

### DSH

启动（AIH 网关身份）：

```bash
aih harness dsh --provider <provider> --account <n>
```

Web UI 中：

- 左侧 **上下文洞察**：`dsh-context` 的跨会话 KPI、Token/成本图表、会话卡片。
- 会话内 **Context** 侧栏 / `/context` 命令：当前上下文组成、时间线、Agent Fleet。
- 右下角 **小鲸鱼**：DeepSeek 余额、今日已用、每轮消耗；点击手动刷新，菜单里可调显示与音效。

### OpenCode

正常启动 `opencode`。`opencode-rules` 会在启动时扫描：

1. `~/.config/opencode/rules/`（全局）
2. `.opencode/rules/`（项目）
3. 插件配置里的 `additionalRuleDirectories`

已创建一条实际规则：`~/.config/opencode/rules/aih-plugin-boundary.mdc`

```yaml
---
keywords: ['plugin adapter', 'dsh plugin', 'opencode plugin']
globs: ['**/ai_home/**']
---
# AIH 插件边界
- 不修改第三方插件源码；优先在 AIH adapter 层完成适配。
- 安装真实插件后必须验证实际加载/使用，不以“已安装”作为完成。
- 验证优先使用真实 harness / 真实页面，不新增测试文件。
```

当输入包含 `plugin adapter` 等 ASCII 关键词，或处理 `ai_home` 项目文件时，这条规则会作为 `<rule name="aih-plugin-boundary">` 注入上下文。新增规则只需往目录里放 `.md` / `.mdc`。

## 3. 真实插件形状与 adapter

### DSH 社区插件

```json
{
  "name": "dsh-context",
  "engines": { "dsh": ">=0.2.0-rc.2" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "main": "lib/index.js"
}
```

没有 `agentPlugin`，也没有 `exports["./deepseek"]`。官方安装机制是 DSH profile + pnpm。

Adapter：

- 确保 `~/.dsh/profiles/aih` 存在，并包含 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`。
- 执行 `dsh plugin --profile aih add <pkg>@<version>`。
- 禁用/移除执行 `dsh plugin --profile aih remove <pkg>`。
- AIH 启动 DSH 时使用 `--profile aih`；这类插件不再生成 `--patch`。
- 健康检查要求：AIH 快照存在 + profile bundle/dependency 存在。

### OpenCode npm 插件

插件是 npm 包，声明在 `opencode.json#plugin`；依赖由 OpenCode/Bun 自己安装。

Adapter：

- 把 `name@version` 写入 `~/.config/opencode/opencode.json#plugin`。
- 不复制源码，不替 OpenCode 解析依赖。
- 禁用/移除只改数组项；卸载时删除 AIH 快照。

### npm 源

安装源支持 `npm:<name>@<version>` 或 `npm:<name>@latest`。AIH 读取 registry 元数据并生成**仅属于 AIH 的托管描述符**，第三方包本身不变。

## 4. 验证证据

DSH：

- `~/.dsh/profiles/aih/package.json` 的 bundles 含 `dsh-context`、`dsh-whale-widget`。
- `dsh --profile aih --dump-config` 中出现两个插件层。
- 实际启动 `DSH_HOME=~/.dsh dsh --profile aih`：
  - 页面左侧出现「上下文洞察」。
  - 页面右下角出现小鲸鱼挂件。
  - `/dsh-whale/widget.js` 返回 200（1.1MB）。
  - dsh-context client 资源返回 200（1.0MB）。

OpenCode：

- `opencode-rules@2.0.0` 入口被 OpenCode 加载：
  `.cache/opencode/npm/.../opencode-rules/dist/src/index.js`
- 用插件自身的 `discoverRuleFiles` 验证：
  `aih-plugin-boundary.mdc` 被发现，元数据解析为
  `globs: ["**/ai_home/**"]`、`keywords: ["plugin adapter","dsh plugin","opencode plugin"]`。
- 真实免费模型回合（`opencode/deepseek-v4.1-flash-free`）：
  - 输入含 `plugin adapter`，模型原样返回了 `# AIH 插件边界` 规则正文。
  - `~/.opencode/state/opencode-rules/{sessionId}.json` 记录
    `matchedRulePaths: ["/Users/model/.config/opencode/rules/aih-plugin-boundary.mdc"]`。
- 注意：`opencode-rules` 的关键词匹配使用 ASCII `\b` 词边界，**纯中文关键词不会命中**；规则里要写 ASCII 触发词。

## 5. 未采用/已移除的候选

| 包 | 原因 |
|---|---|
| `opencode-wakatime@1.4.0` | 无 WakaTime API key，装了不会上报 |
| `dshmarket@1.80.1` | 与 AIH 插件管理重复，形成第二套安装来源 |
| `opencode-sandbox@0.7.0` | OpenCode 缓存安装未完成，空目录并阻塞启动 |
| `@jgordijn/opencode-remote-config@0.3.1` | OpenCode 未生成 npm 缓存条目 |
| `opencode-subagent-statusline@2.1.1` | `NpmInstallFailedError: unable to resolve dependency tree` |

## 6. 边界

- AIH 不修改 npm 包内容，也不替 Harness 解决 peer dependency。
- DSH 插件是否运行取决于 DSH 版本与 profile 启动；AIH 验证 profile、快照与 Web 资源。
- OpenCode 插件是否运行取决于 OpenCode/Bun 启动阶段；AIH 验证配置项、快照与插件入口加载。
- npm 源只支持精确版本或 dist-tag（`latest`）。
