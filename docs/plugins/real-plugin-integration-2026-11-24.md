# 真实 DSH / OpenCode 插件集成（2026-11-24）

目标：选取真实社区插件，**不改插件源码**，由 AIH 的 native-resource adapter 安装与管理。

## 1. 本次集成的 5 个插件

| 插件 | 版本 | 平面 | 安装方式 |
|---|---|---|---|
| `dsh-whale-widget` | 0.4.2 | DSH 原生 | `dsh plugin --profile aih add` |
| `dsh-context` | 0.87.1 | DSH 原生 | 同上 |
| `dshmarket` | 1.80.1 | DSH 原生 | 同上 |
| `opencode-sandbox` | 0.7.0 | OpenCode 原生 | 写入 `opencode.json` 的 `plugin` 数组 |
| `opencode-wakatime` | 1.4.0 | OpenCode 原生 | 同上 |

这些包都不是 AIH 能力插件：没有 `plugin.json#contributes`。它们由对应 Harness 自己加载。

## 2. 真实插件与旧假设的差异

DSH 社区插件的真实形状：

```json
{
  "name": "dsh-context",
  "engines": { "dsh": ">=0.2.0-rc.2" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "main": "lib/index.js"
}
```

- 没有 `agentPlugin`。
- 没有 `exports["./deepseek"]`。
- patch entry 的 `name` 是包名，不是 `file://` 入口。
- 安装机制是 DSH profile + pnpm，而不是把目录塞进 `~/.dsh/plugins`。

OpenCode 插件的真实形状：

```json
{
  "name": "opencode-sandbox",
  "main": "dist/index.js",
  "dependencies": { "@anthropic-ai/sandbox-runtime": "^0.0.76" }
}
```

- 插件是 npm 包，声明在 `opencode.json` 的 `plugin` 数组。
- 依赖由 OpenCode/Bun 在启动时安装；AIH 不应复制源码，也不应替它解析依赖。

## 3. Adapter 设计

### 3.1 npm 源描述符

安装源支持：

```text
npm:dsh-context@0.87.1
npm:opencode-sandbox@0.7.0
```

AIH 向 npm registry 读取被锁定版本的元数据，生成一个**只属于 AIH 的安装描述符**（不是修改插件源码）：

```json
{
  "name": "dsh-context",
  "version": "0.87.1",
  "agentPlugin": {
    "pluginId": "dsh-context",
    "kind": "harness",
    "manifestVersion": 1,
    "engines": { "deepseek": ">=0.0.0" },
    "mode": "dsh-profile",
    "npmPackage": "dsh-context@0.87.1"
  }
}
```

OpenCode 的描述符把 `mode` / `opencodePackage` 换成 `opencode-npm`。描述符只是 AIH 的托管记录与快照，目标 harness 实际加载的仍是 npm 原包。

### 3.2 DSH：profile 插件

- 确保 `~/.dsh/profiles/aih` 存在，并按 web 模板补齐 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`。
- 执行：
  `dsh plugin --profile aih add <name>@<version>`
- DSH 会把它写入 profile 的 `dependencies` 和 `dsh.profile.bundles`。
- AIH 启动 DSH 时继续使用 `--profile aih`；这类记录不再传 `--patch`。
- 禁用/移除执行 `dsh plugin --profile aih remove <name>`。
- 健康检查同时要求：AIH 快照存在 + profile bundles/dependencies 中存在该包。

### 3.3 OpenCode：npm 插件数组

- 在 `~/.config/opencode/opencode.json` 的 `plugin` 数组写入 `name@version`。
- 不复制文件；OpenCode 启动时自行安装依赖。
- 禁用/移除只删除数组项；卸载时删除 AIH 快照。

## 4. 验证证据

- 临时 HOME 中 5 个插件全部安装成功，并完成 disable/enable 往返。
- 真实 home 安装后：
  - `~/.dsh/profiles/aih/package.json` 的 bundles：
    `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-whale-widget`、`dsh-context`、`dshmarket`
  - `DSH_HOME=~/.dsh dsh --profile aih --dump-config` 中出现三个插件层。
  - `~/.dsh/profiles/aih/node_modules` 中存在三个包及其依赖。
  - `~/.config/opencode/opencode.json#plugin`：
    `opencode-sandbox@0.7.0`、`opencode-wakatime@1.4.0`。
- OpenCode 的 `plugin list` 在当前机器被已有 service 端口占用挡住，未能在线确认包已下载；配置文件是官方声明入口，下次 service 启动时会解析并安装。

## 5. 边界

- AIH 不修改 npm 包内容，也不替 Harness 解决 peer dependency。
- DSH 插件是否真正运行取决于 DSH 版本与 profile 启动；AIH 只验证 profile 与快照一致。
- OpenCode 插件是否真正加载取决于 OpenCode/Bun 的启动阶段；AIH 只验证配置项与快照一致。
- npm 源只支持精确版本或 dist-tag（`latest`）；范围解析留给 npm 生态。
