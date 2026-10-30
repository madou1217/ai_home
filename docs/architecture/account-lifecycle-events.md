# 账号生命周期事件与模型投影刷新

> 目标：账号池发生「配置层」变化（新增 / 导入 / 启用 / 停用 / 删除）时，
> 由**一个事实事件**驱动所有下游消费面，而不是让每个消费面各自去轮询账号目录。
> 新增消费面 = 注册一个监听者；发布点与已有监听者都不需要改动。

## 1. 两类事件，故意分开

| 事件 | 语义 | 触发者 | 是否会自动恢复 |
| --- | --- | --- | --- |
| `account.runtime.changed` | 运行时健康态（成功 / 限流 / auth_invalid / 冷却） | 网关请求路径、探针 | 会（成功请求、冷却到期、人工手动清除） |
| `account.lifecycle.changed` | 配置层事实（added / imported / updated / deleted / enabled / disabled） | 注册、删除、用户显式启停 | 不会（只有人或导入流程发起） |

把两者混在一起会导致两个方向的事故：把「限流自动下线」播成用户关闭（审计失真）；
或者拿每次推理成功去重建模型目录（网关被自己刷爆）。

- 事件类型与脱敏快照：`lib/server/account-lifecycle-event-types.js`
- 发布器：`lib/server/account-lifecycle-event-publisher.js`
- 进程级总线：`lib/server/account-lifecycle-bus.js`
- Hub（通配订阅 + 监听者隔离）：`lib/server/account-runtime-event-hub.js`

事件字段：`type / action / provider / accountRef / source / reason / before / after / batchId? / happenedAt`。
`before` / `after` 只允许 `enabled / status / authMode / modelCount`，**任何凭据都不进事件对象**。

## 2. 权威发布点（写入成功之后才发）

| 动作 | 发布点 | 备注 |
| --- | --- | --- |
| `added` | `lib/account/account-registration.js#registerAccountIdentity` | 仅 `created: true` 时发布，宿主扫描不会为存量账号刷事件 |
| `deleted` | `lib/account/account-removal.js#deleteAccountByRef` | 删除成功且 codex 桌面端重启之后 |
| `enabled` / `disabled` | `lib/account/state-service.js#setOperationalStatus` | 只有调用方显式传 `{ lifecycle: true }` 才发布（WebUI、management 路由已接） |

`setOperationalStatus` 的自动路径（auth_invalid 自动下线、冷却恢复）**不传** `lifecycle: true`，
因此仍然只走运行态事件。

CLI 进程不会设置 bus（`setAccountLifecycleHub` 只在 server 组装时调用），
所以 `lib/account/**` 里的发布调用在 CLI 中是安全 no-op：发布永远不能反过来破坏写入。

## 3. 监听者

监听者在组合根注册，监听者本身只订阅事实，不知道是谁触发的：

```js
// lib/server/server.js
setAccountLifecycleHub(accountRuntimeEvents);
const unregisterAccountRuntimeListeners = [
  ...registerAccountRuntimeEventListeners(accountRuntimeEvents, { ... }),
  ...registerAccountLifecycleEventListeners(accountRuntimeEvents, {
    fs, path, aiHomeDir,
    onRefresh: (result) => console.log('model projection refreshed', result)
  })
];
```

订阅模式支持精确类型、`account.*` 通配前缀、`*` 全量。同一个监听函数被重复订阅时
只会被调用一次；单个监听者抛错会被 `onError` 隔离，不影响其它监听者。

已注册的监听者：

| 监听者 | 订阅 | 作用 |
| --- | --- | --- |
| `runtimeStateIndexListener` | `account.runtime.changed` | 运行态索引落库 |
| `serverPoolSyncListener` | `account.runtime.changed` | 服务端账号池同步 |
| `createHarnessModelProjectionListener` | `account.lifecycle.changed` | 刷新各 harness 的模型投影 |

## 4. 模型投影刷新（aih → harness）

运行中的 harness 不会替我们重写自己的模型文件（Pi / DSH 有扩展轮询兜底，其他工具没有），
所以 server 在生命周期事件后主动把网关当前目录写回每个投影目录。

实现：`lib/harness/model-projection-refresh.js`

- **描述符表**，一行一个 harness，刷新逻辑不认识任何具体 provider：

  | harness | 模型事实源（相对账号投影根） | 格式 |
  | --- | --- | --- |
  | `pi` | `models.json` → `providers.aih.models` | JSON |
  | `dsh` | `profiles/aih/cordis.patch.yml` → `llm-pi-ai.config.providers.aih.models` | DSH patch YAML |
  | `dsh-tui` | `dsh/profiles/dsh-tui/cordis.patch.yml` → 同上 | DSH patch YAML |

- **一次事件 = 一次目录读取**：`refreshAllHarnessModelProjections` 先检查是否存在投影目录，
  再 `GET /v1/models` 一次，所有 harness 共用同一份结果；没有目录时连网关都不打扰。
- **合并语义必须与 harness 自己的扩展一致**（`pi-extension.ts` / `aih-model-refresh.mjs`）：
  按模型 id 集合判断变化；已存在的条目原样保留（`contextWindow` / `cost` / `thinkingLevelMap`
  是比 `/v1/models` 更精确的事实）；新 id 只用最小字段补入。
  不一致的代价：扩展每 5 分钟把 server 刚写的文件改回去，形成写放大。
- YAML 的解析与序列化复用 `lib/harness/dsh.js` 的 `parseDshPatch` / `serializeDshPatch`，
  保证与启动时写出的文件同形状；否则下一次启动会把刷新结果覆盖回去。
- 写盘是原子替换（`writePrivateJson` / `writePrivateText`，0600）。

## 5. 为什么只覆盖 pi / dsh / dsh-tui

仓库里真正「持久化一份网关模型目录、并且运行时可能长期不重启」的只有这三个外部 harness
（`lib/harness/catalog.js`）。其余是原生 Provider CLI，配置由启动期策略再生：

| 类别 | 工具 | 模型目录如何进入 | 事件驱动刷新是否有意义 |
| --- | --- | --- | --- |
| 外部 harness | pi / dsh / dsh-tui | 账号投影目录里的文件 | 有（本次实现） |
| 原生 CLI | claude | 每次启动写 `modelPicker.options` 到瞬时 settings | 无：下次启动再生 |
| 原生 CLI | codex | 启动参数 `-c model_catalog_json=...`（`run/codex/model-catalogs/<hash>.json`） | 无：进程启动时读取 |
| 原生 CLI | opencode | `OPENCODE_CONFIG_CONTENT` 环境变量 + zen overlay 文件 | 无：启动时注入 |
| 原生 CLI | cline / kimi / qoder / kiro / grok / gemini / agy / zcode | 只有凭据或端点，没有生成的模型目录 | 不适用 |

结论：**不是「只给 pi 做」，而是给所有消费生成目录的外部 harness 做**；原生 CLI 的
目录在启动策略里再生，事件驱动刷新对它们没有可观察效果（YAGNI）。

## 6. 扩展方式

新增一个事件消费面（例如「账号变化后给 WebUI 推一次通知」）：

1. 写一个监听者工厂（只接收事件；去抖 / 单飞放在监听者内部）；
2. 在 `registerAccountLifecycleEventListeners` 里 `hub.on(ACCOUNT_LIFECYCLE_CHANGED, ...)`；
3. 发布点不动。

新增一个模型投影面：

1. 在 `HARNESS_MODEL_PROJECTIONS` 加一行（路径 + 格式 + `applyModels`）；
2. 若格式不是 JSON，同时提供 `readDocument` / `writeDocument` 的分支；
3. 合并语义照抄该 harness 自己的扩展，不要发明第二套。

## 7. 验收证据

- `refreshAllHarnessModelProjections` + 真实临时目录 + 本地 stub 网关：
  一次生命周期事件 → 1 次 `GET /v1/models` → pi / dsh / dsh-tui 三个投影同时更新；
  已存在模型的 `contextWindow` / `maxTokens` 保留；`account.runtime.changed` 不触发刷新。
- 非生命周期事件（运行态成功/限流）被监听者显式忽略，避免刷新风暴。
- 去抖 + 单飞：同一批导入的 N 个事件合并为一次目录读取；进行中再次触发只记一个 pending。
- **真实 server 联调（2026-10-30 12:54:56）**：重启加载新代码后，经
  `POST /v0/management/state-index/operational-status`（同状态重放，不改变路由）发布一次生命周期事件，
  服务端日志出现一条 `GET /v1/models` 与三行刷新结果：

  ```
  [aih] model projection refreshed: pi scanned=6 updated=5
  [aih] model projection refreshed: dsh scanned=2 updated=2
  [aih] model projection refreshed: dsh-tui scanned=1 updated=1
  ```

  落盘核对：pi 投影 81 个模型、59 个保留 `contextWindow`、`apiKey` 仍是 `$OPENAI_API_KEY`；
  dsh-tui patch 的 `aih-model-refresh` 插件条目仍在。

## 8. 尚未解决（明确的边界）

`/v1/models` 是**池级**目录：它按能力索引发布「任一账号曾提供过的模型」，
关闭账号只影响路由，不会让目录收缩。因此「关闭账号后 Pi 菜单变短」还差一步：
目录需要按「至少一个启用账号可服务」收窄（备选方案 C）。这会改变所有客户端看到的目录，
属于产品口径变更，未在本轮擅自实施；事件机制已经就位，届时只需在发布侧改口径，
监听者与投影层不需要再动。
