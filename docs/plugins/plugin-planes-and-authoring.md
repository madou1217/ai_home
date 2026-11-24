# 插件平面、声明与编写方式

> 2026-11-24 整理。回答三个高频问题：插件要不要声明？账号级插件是什么？
> Provider / Harness 级插件分别该怎么做？以及当前体系真正的弱点。

## 0. 结论先行

1. **插件必须声明。** 没有声明就没有能力槽、没有安装确认、没有可发现性。
2. 当前仓库其实有 **三个插件平面**，它们不是同一种东西，UI 和文档过去把它们都叫“插件”，这是混乱的主因。
3. 账号级、Provider 级、Harness 级都已经有落点，缺的是 **声明式作用域**、**统一目录** 和 **作者文档**，不是从零开始。

## 1. 三个平面

| 平面 | 装在哪 | 在哪运行 | 声明文件 | 当前 UI |
|---|---|---|---|---|
| A. AIH 能力插件 | `~/.ai_home/plugins`，签名制品 | AIH 插件宿主（Node / process） | `plugin.json`（manifest v1） | 插件与资源 → AIH 能力插件 |
| B. Harness 原生资源 | Provider / Harness 自己的目录 | 对应 CLI / Harness 内部 | `package.json#agentPlugin`、`SKILL.md`、MCP server spec | 插件与资源 → 原生插件 / Skill / MCP |
| C. 专用进程插件 | 同 A | 同 A，但走领域合同 | `plugin.json` + 领域能力 | 各自功能页（网络连接器等） |

- **A 是“给 AIH 增加能力”**：账号来源、账号刷新、Provider 描述符、网关请求/选号/尝试钩子、聊天准备、工具与审批等。
- **B 是“给某个 Harness 增加能力”**：DSH cordis patch、opencode 本地插件、pi extension、Claude/WorkBuddy marketplace 插件、Skill、MCP。AIH 只负责安装与投影，插件在 Harness 内执行。
- **C 是 A 的领域特化**：例如 `network.connector`、出口内核、订阅渲染。它们仍用 A 的 manifest 与生命周期，只是能力合同由领域拥有。

> 页面上的 `aih-dsh-gateway / 插件 / host/deepseek` 属于 **B**；它不是 AIH 能力插件。
> 三个平面现在共用同一个“插件与资源”页面：AIH 能力插件、原生插件、Skill、MCP 各占一个 Tab。
> AIH 能力插件按 pluginId 聚合，主卡只显示当前实例版本，旧版本收进折叠区。

## 2. 声明是什么

### 2.0 顶层 `kind` 是什么

`kind` 是清单最外层的**平面标识**，回答“这个包归谁管”：

| kind | 含义 | 清单 |
|---|---|---|
| `capability` | AIH 能力插件，运行在 AIH 宿主，挂能力槽 | `plugin.json` |
| `harness` | Harness 原生插件，投影到 Provider / Harness 内执行 | `package.json#agentPlugin` |

它不是 `contributes[].capability`：

- `kind` = 插件平面（capability / harness）。
- `capability` = 具体能力槽（`account.login`、`gateway.attempt`、`network.connector` 等）。

省略时按清单默认：`plugin.json` → `capability`，`agentPlugin` → `harness`。安装预检会读取它；把 AIH 能力插件拖进原生插件安装页时会明确提示，而不是报一个晦涩的清单错误。

### 2.1 AIH 能力插件：`plugin.json`

```json
{
  "manifestVersion": 1,
  "kind": "capability",
  "protocolVersion": 1,
  "pluginId": "acme.account",
  "version": "1.0.0",
  "engines": { "aih": ">=1.0.0", "node": ">=22" },
  "runtime": "node",
  "entry": "index.js",
  "permissions": {
    "network": ["https://api.acme.example"],
    "filesystem": { "read": ["state"], "write": ["state"] },
    "secrets": ["ACME_TOKEN"],
    "environment": []
  },
  "contributes": [
    { "id": "acme.account.source", "capability": "account.source", "version": 1 },
    { "id": "acme.account.login",  "capability": "account.login",  "version": 1 },
    { "id": "acme.account.refresh","capability": "account.refresh","version": 1 }
  ]
}
```

关键点：

- `contributes[].capability` 必须来自 `contracts/plugins/contract.json` 的 `capabilities`，否则安装校验失败（`plugin_capability_incompatible`）。
- `failurePolicy` 只有 `deny` / `delegate`；`order` 决定同一能力链中的顺序。
- `permissions` 是安装确认与宿主边界，**不是执行沙箱**；process 插件没有沙箱。
- `engines` / `targets` 管宿主版本与平台，不是 Provider / Harness 选择器。

### 2.2 Harness 原生插件：`package.json#agentPlugin`

```json
{
  "name": "@acme/dsh-tool",
  "version": "0.1.1",
  "description": "DSH plugin that exposes ACME quota as a tool",
  "exports": { "./deepseek": "./dist/deepseek.js" },
  "dsh": { "bundle": { "patch": "./patch.yml" } },
  "agentPlugin": {
    "pluginId": "acme-dsh-tool",
    "kind": "harness",
    "manifestVersion": 1,
    "engines": { "deepseek": ">=0.0.0" }
  }
}
```

- `agentPlugin.engines` 声明它能装在哪个 Harness（`deepseek` / `opencode` / `pi`）。
- 可移植插件用 `agentPlugin.hosts` + `capabilities` + `permissions` 声明 Host 适配器（当前是 `aih`）。
- `exports` 决定 Harness 从哪个入口加载；`dsh.bundle.patch` 之类的字段由对应适配器解释。
- 这些声明现在会显示在“插件与资源 → 详情 → 声明”里，不再只显示一个名字。

### 2.3 Skill / MCP

- Skill：`SKILL.md` 的 YAML frontmatter 必须包含 `name` 与 `description`；安装时校验，缺失即失败。
- MCP：没有“能力声明”，只有 server spec（command / args / env keys）和 Provider 的 projection。它的“能做什么”由 MCP server 自己决定。

## 3. 能力槽目录（当前合同）

以下来自 `contracts/plugins/contract.json`，是插件唯一可挂载的槽位。

### 账号

| 能力 | 模式 | 入参要点 | 宿主职责 |
|---|---|---|---|
| `account.source` | collect | `{kind:"list", provider, host}` | 汇总登录来源，补 `loginContribution` |
| `account.login` | terminal | `start/poll/submit/cancel` + `provider` | 管理登录任务、写投影、登记账号 |
| `account.refresh` | terminal | `provider, accountRef, credential, runtimeDir` | 原子写回、登记、墓碑保护 |
| `account.materialize` | terminal | `match` 后 `materialize` | 把凭据写入受控 runtimeDir |

### 网关

| 能力 | 模式 | 插件能看到 | 说明 |
|---|---|---|---|
| `gateway.request` | waterfall | `protocol/path/model/body` | 改写或拒绝请求；冻结身份字段不可改 |
| `gateway.account` | serial | `provider/model/candidates` | 只能排序/挑选候选账号，越界即 `plugin_scope_violation` |
| `gateway.attempt` | middleware | `provider/model/accountRef/authType/attempt` + `next()` | 包裹真实尝试；`next()` 至多一次 |
| `gateway.route` | serial | — | 合同已声明；**截至 2026-11-24 仓库内没有调用点** |

### Provider / 模型 / 计费

| 能力 | 模式 | 用途 |
|---|---|---|
| `provider.descriptor` | collect | 声明 Provider 元数据、配额能力、模型能力、策略实现 |
| `model.catalog` | terminal | 提供模型目录 |
| `model.metadata` | collect | 模型展示元数据（模态、推理档位等） |
| `pricing.catalog` / `pricing.quote` | collect | 价格目录与单次报价 |
| `quota.probe` | serial | 主动探测额度 |
| `usage.scan` | collect | 扫描用量 |

### 聊天 / 工具 / UI

`chat.prepare`（waterfall）、`chat.beforeCommand`（serial）、`tool`、`approval`、`ui`、`observe`、`command`。

### 领域

`network.connector`（collect）是 C 平面的代表：核心只拥有生命周期与通用调用，厂商细节全在插件里。

## 4. 账号级插件是什么，怎么做

“账号级插件”不是一个新的插件平面，而是 **贡献 `account.*` 能力** 的 AIH 能力插件。

它解决四件事：

1. **发现来源**：`account.source` 为该 Provider 返回登录方式（设备码、OAuth、导入文件等）。
2. **交互登录**：`account.login` 返回 `waiting_user` / `success` / `failed`，宿主负责把 `files` 写入沙箱并登记账号。
3. **刷新凭据**：`account.refresh` 处理 token 轮换，返回是否 `handled`、是否 `rotated`。
4. **物化凭据**：`account.materialize` 把账号凭据写成 Harness 需要的文件。

编写顺序：

1. 在 `plugin.json` 声明 `account.source` / `account.login` / `account.refresh`。
2. 在 `apply(ctx)` 里为每个 contribution ID 注册 handler：

```js
export function apply(ctx, config) {
  ctx.aih.register('acme.account.source', async ({ kind, provider, host }) => {
    if (provider !== 'acme') return { sources: [] };
    return { sources: [{ schemaVersion: 1, id: 'acme-oauth', kind: 'oauth', available: true }] };
  });
  ctx.aih.register('acme.account.login', async (value) => {
    // start / poll / submit / cancel 状态机
  });
}
```

3. 只返回数据，**不要直接写账号库**；投影入库由宿主完成。
4. 用 `permissions.filesystem` 只申请 `state`，敏感值走 `secrets`。
5. 在账号页验证来源、登录、刷新、删除四条链路，而不是只看插件“已启用”。

## 5. Provider A 的插件怎么做

有两种合法做法，按需求选：

### 5.1 只补 Provider 事实：`provider.descriptor`

适合“新增/补充一个 Provider 的模型目录、额度能力、策略实现”。插件返回描述符，宿主收集并校验，不参与每次请求。

### 5.2 参与请求生命周期：`gateway.*`

适合“只对 Provider A 做选号偏好 / 尝试重试 / 请求改写”。插件会收到 `provider`（`gateway.account` / `gateway.attempt`）或从 `body.model` 推断（`gateway.request`），必须自己判断：

```js
ctx.aih.register('acme.gateway.account', async ({ provider, model, candidates }) => {
  if (provider !== 'acme') return null;       // 不表态，保持原顺序
  return candidates.filter((item) => item.authType === 'oauth').map((item) => item.accountRef);
});
```

**声明式作用域（已支持）**：contribution 可以写 `scope`，宿主在调用前过滤，不再需要每个插件全局执行再 early-return。

```json
{
  "id": "acme.gateway.account",
  "capability": "gateway.account",
  "version": 1,
  "scope": {
    "providers": ["acme"],
    "hosts": ["deepseek"],
    "models": ["acme-*"]
  }
}
```

匹配语义：

- `providers` / `hosts`：精确匹配，支持 `*`；`hosts` 目前只在账号来源等带 host 的调用点生效。
- `models`：`path.Match` 通配，例如 `acme-*`。
- 空维度 = 不限制。
- 调用方拿不到对应值（例如 `gateway.request` 尚未路由出 Provider）时，该维度不做过滤，避免静默跳过插件。
- `gateway.request` 用请求体里的 `model` 过滤；`gateway.account` / `gateway.attempt` 用 `provider + model`；`account.*` 用 `provider` + `host`；`observe` 用事件里的 `provider + model`。

## 6. Harness B 的插件怎么做

1. 做一个 Harness 能加载的包（DSH cordis patch / opencode plugin / pi extension / marketplace plugin）。
2. 在 `package.json` 写 `agentPlugin.pluginId`、`manifestVersion`、`engines`（或 `hosts`），以及 Harness 需要的 `exports` / patch 字段。
3. 用“插件与资源 → 安装”选择 Harness（现在支持多选），安装后按宿主逐一启停。
4. 详情里的“声明”会显示 `engine deepseek`、`export ./deepseek`、`dsh patch ./patch.yml` 等事实。
5. 记住边界：AIH 只证明“已安装/已投影”，**不证明 Harness 内真的执行成功**。

### 6.1 安装源

“插件与资源 → 安装”支持三种源：

| 模式 | 行为 | 限制 |
|---|---|---|
| 内置 / 路径 | 随包资源或安装包内相对路径 | 路径必须位于安装包根目录下 |
| 本地文件夹 | 浏览器选择目录，上传到 `run/native-resource-sources/<id>` | 单包 4MB / 256 文件；自动跳过 `.git` |
| URL | 服务端下载 http(s) 直链 | zip / tar.gz / tar 自动解包；单文件直连；64MB 下载上限 |

上传源是**一次性安装源**：多目标安装会复用同一份内容，过期 24 小时后清理；它不会成为插件的运行目录。

安装目标会按声明联动：候选插件或上传包解析出 `agentPlugin.engines/hosts` 后，目标下拉只保留兼容的 Provider / Host，`全选可用目标` 也只选兼容项。手写路径在离开输入框或点击“预检”时读取声明，同样收敛目标。

## 7. 仍然存在的弱点

已解决：声明式作用域、安装目标与声明联动、手写路径预检、能力槽与贡献项目录、AIH 插件按 pluginId 聚合与旧版本折叠、统一插件页面、清单顶层 `kind` 平面标识与错平面预检、贡献项调用次数 / 失败 / 耗时 / 最近错误。

按影响排序，仍待处理：

1. **拒绝语义还没有单独计数。** `gateway.request` 的 reject 是正常返回值，不是 RPC 错误；目前只统计调用失败，没有把拒绝原因单列。
2. **缺少作者样例与一致性测试。** 仓库内只有 `network.connector` 一个完整样例；账号 / Provider 插件没有可复制模板。
3. **`gateway.route` 是空声明。** 合同里有，运行时没有调用点，容易误导插件作者。

## 8. 下一步建议（按收益/成本）

1. **统一 manifest 顶层 `kind`**：`capability`（AIH 能力插件）与 `harness`（原生插件），让 UI 和安装器不再靠目录猜。
2. **能力目录页**：把 reject 与普通失败的计数分开显示。
3. **模板与 doctor**：`account` / `provider` / `harness` 三个最小样例 + 每个能力的 smoke 检查。
4. **补齐 `gateway.route` 或从合同移除**，避免空声明。

## 9. 验证边界

- 声明只证明“插件声称自己能做什么”，不证明它做对了；能力调用失败、拒绝、超时都要在宿主侧可观测。
- 原生插件只有“安装/投影”证据；Harness 内执行需要 Harness 自己的日志或工具结果。
- process 插件没有沙箱：安装并启用等于以服务端用户身份执行代码，权限声明只用于安装确认。
