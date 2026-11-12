# Chat harness 模型目录对拍（harnessModelsViaGo，2026-11-06）

> 任务代号 harness-models-parity。只读对拍：未发起推理、未删账号、未改 Go 代码、未 `git add` / `git commit`。
> 目的：真机打开 `config:server.harnessModelsViaGo`，比较 Chat harness 网关目录与 Go `account-models` 的 effective 集，
> 验证 Go 不可用时回落本地快照，最后恢复开关。

## 1. 开关原值与开启

`config:server` 原本**没有** `harnessModelsViaGo` 键（缺省 false）：

```
$ sqlite3 ~/.ai_home/app-state.db "select json_type(value,'$.harnessModelsViaGo') from app_kv where key='config:server';"
NULL
$ sqlite3 ~/.ai_home/app-state.db "select value from app_kv where key='config:server';" | shasum -a 256
3ba3255c58a5d7a490e36999fd9c8b3a81ec85b1e5c0ee38e76f8b45172f55ae  -
```

用 node:sqlite 备份原值后置 true（其它键不动），写入值 sha256 `dd2a8251…cf75`。
按原参数重启（`HOME=/Users/model`、`AIH_HOME_DIR=/Users/model/.ai_home`，端口 9527）：

```
launchctl remove com.meadeo.aih-server
/bin/launchctl submit -l com.meadeo.aih-server -o ~/.ai_home/logs/server.log -e ~/.ai_home/logs/server.log -- \
  /bin/bash -lc 'export HOME=/Users/model AIH_HOME_DIR=/Users/model/.ai_home; cd /Users/model/projects/feature/ai_home; \
  exec /Users/model/.nvm/versions/node/v22.21.0/bin/node lib/cli/app.js server serve --host 0.0.0.0 --port 9527 \
  --no-proxy localhost,127.0.0.1,0.0.0.0,192.168.31.57 --models-probe-accounts 8 --window-activation'
```

重启后：`/healthz` 200（第 9 次探测），`/readyz` 为 `ready=true`、`go_core.state=ready`；
Node 进程 57746，Go 进程 58130；`config:server` 的 `harnessModelsViaGo=true`。

## 2. 对拍账号与结果

数据源：
- 账号：`GET /v0/webui/accounts`（32 个账号）；
- Go：`GET 127.0.0.1:19550/v1/management/account-models`（用 Go 子进程环境里的 Management Key，不打印密钥），只取 `effective=true`，按 `go-account-sync:state.links` 把 Go ref 翻回 Node ref；
- harness：`POST /v0/webui/chat/sessions`（`provider=codex`、`executionAccountRef=gateway`）后
  `GET /v0/webui/chat/sessions/<id>/composer/catalog`，走的是 `createChatHarnessModelReader` 的网关全局池分支。

| 账号 | provider | 显示名 | Go effective | harness 命中 | 差集 |
| --- | --- | --- | ---: | ---: | --- |
| `acct_c016fd7eee0f64163068` | codex | proxy.meadeo.com | 31 | 31 | 0 |
| `acct_04a193ed26f71e4619c5` | codebuddy | meadeodeo@gmail.com | 26 | 26 | 0 |
| `acct_9dc03880a872f711983e` | codebuddycn | 码逗 | 20 | 20 | 0 |
| `acct_5997549c49c82339fac3` | zcode | yfadmgkl | 2 | 2 | 0 |
| `acct_d88d90081d3166703839` | zcode | MeaDeo | 12 | 12 | 0 |

`agy` 在 `/readyz` 里账号数为 0，本机没有可对拍的 agy 账号。

全局去重口径同样完全一致：

```
harness=206  goEffectiveUnion=206  intersection=206
H_only(0)=
G_only(0)=
```

即冷启动后的第一次 gateway 目录读取，harness 返回的 206 个模型与 Go effective 并集逐项相同。
Node 快照当前并集是 212；按 `model-catalog-settings` 过滤掉 15 个显式停用模型后也是 206
（其中 qoder 的 `Auto/Cantus/Efficient/Fast/Sonus/Ultimate` 6 个只在快照里且已停用），所以本机两条来源过滤后集合相同。

## 3. Go 不可用时的回落

对 Go 子进程做 `SIGSTOP`（不退出、不触发 supervisor 重启），确认 Go 私有端点不可达：

```
$ kill -STOP 58130
$ curl -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:19550/healthz
000   # timeout
```

新建一个 gateway 会话后读 composer catalog（不是复用已有会话的 30s 缓存）：

```
POST /v0/webui/chat/sessions -> 201
GET  /v0/webui/chat/sessions/<id>/composer/catalog -> 200, 1.992s
models_down=206
snapshotOnlyPresent=Auto=false,Cantus=false,Efficient=false,Fast=false,Sonus=false,Ultimate=false
```

harness 没有报错，仍返回 206 个模型；该集合与「Node 快照按 model-catalog-settings 过滤后」的 206 个模型**完全相等**。
随后 `kill -CONT 58130`，`/readyz` 的 `go_core.state` 回到 `ready`，未发生重启（`restarts=0`）。

## 4. 关键发现：当前 Go 二进制不支持 `meta_only`

对运行中的 Go 进程直接请求条件刷新用的指纹端点：

```
GET /v1/management/account-models?meta_only=1
400 {"error":{"code":"invalid_models_query","message":"模型查询参数无效"}}
```

`meta_only=true`、`metaOnly=1`、裸 `meta_only` 也都是 400；全量 GET 的响应只有 `data`，没有
`generation` / `updated_at_ms`。原因不是 Go 源码没实现，而是**运行中的二进制是旧的**：

```
bin/native/darwin-arm64/aih-server                 2026-11-06 18:49
internal/transport/http/accountsapi/account_models_collection.go  2026-11-06 23:14
strings bin/native/darwin-arm64/aih-server | grep -c meta_only   -> 0
```

用 harness 自己的导出函数直接探两次，复现得非常清楚：

```
first=ok accounts=30 generation=null updatedAtMs=0
second=null
third=null
```

后果：`harnessModelsViaGo=true` 时，**只有冷启动后的第一次**目录读取走 Go 全量；
之后每次先读 `meta_only=1` 指纹，拿到 400 后 `chat-harness-go-models.js` 返回 null，
`chat-harness-model-reader.js` 静默回落到本地快照。本机两条路过滤后恰好都是 206，所以页面上看不出来；
一旦 Go 与快照有差异，模型菜单会在第一次读取后从 Go 集合翻成快照集合。

## 5. 复原

把备份的原始值写回 `config:server`：

```
$ sqlite3 ~/.ai_home/app-state.db "select json_type(value,'$.harnessModelsViaGo') from app_kv where key='config:server';"
NULL
```

- 写入时 `restoredExactly=true`，sha256 回到 `3ba3255c…f55ae`；
- 按原参数再次 `launchctl remove + submit`；`/healthz` 200（9s 内），`/readyz` `ready=true` / `go_core.state=ready`；
- 最终 `GET /v0/webui/accounts` 200、32 个账号；
- 与备份原值逐键深比较 `deepDiffs=0`、`harnessModelsViaGo` 键不存在。
  注：Node 服务启动/运行中会把 JSON 重新序列化（空格/缩进变化），所以最终原始文本 sha256 是
  `e3c78fa2…417`；**配置语义与备份完全一致**，开关保持缺省关闭。

## 6. 结论与建议

- 冷读对拍：206 vs 206，逐项一致；所选 5 个账号的 Go effective 模型全部出现在 harness 目录里，差集为 0。
- 回落：Go 被 `SIGSTOP` 时 composer catalog 仍 200、206 个模型、无错误，等于过滤后的快照集合。
- **不建议现在默认开启** `harnessModelsViaGo`：当前运行的 Go 二进制早于 `meta_only` 指纹端点，
  开启后实际只有第一次读 Go，之后每次都静默回落快照；Go/快照不一致时会造成目录来源漂移。
- 建议先重新构建并部署 Go 二进制（包含 `generation`/`updated_at_ms` 与 `meta_only=1`），
  再按本文步骤复跑一次：确认第二次及后续读取的 `generation` 非空、目录仍与 Go effective 一致，
  且 Go 停止时回落快照不报错，再考虑默认开启。

## 7. 追补验证：`meta_only` 条件刷新（2026-11-06 23:36–23:39）

> 任务代号 harness-meta-only-verify。Go 已按 `daa7e407` 重建（`bin/native/darwin-arm64/aih-server`
> 23:31，`strings … | grep -c meta_only` = 1）。本节仍为只读验证：未发起推理、未改 Go/Node 代码、未提交。

### 7.1 开关原值与开启

`config:server.harnessModelsViaGo` 仍是缺省（键不存在，原文本 sha256 `3ba3255c…f55ae`）。
置 true（写入值 sha256 `dd2a8251…cf75`，其它键逐键不变）后，按第 1 节同一条
`launchctl remove + submit` 重启：Node 75360 / Go 75770；`/healthz` 200（第 16 次探测）、
`/readyz` `ready=true`、`go_core.state=ready`。

### 7.2 第二次读走 `meta_only` 的直接证据

Go 没有 management 请求访问日志：`~/.ai_home/logs/go-core.log` 只有启动/探测错误，没有请求行，
因此按 2b 用 harness 导出函数 + 记录真实请求路径。直连运行中的 Go：

```
full:        status=200 dataAccounts=30 effectiveRows=629 uniqueModels=199
             generation=1793979339589 updated_at_ms=1793979338908
meta_only=1: status=200 dataAccounts=0  generation=1793979339589 updated_at_ms=1793979338908
```

`createChatHarnessGoModelSource` 连调两次，注入的 `readAccountModels` 记录每次路径：

```
#1 calls=["/v1/management/account-models"]
#2 newCalls=["/v1/management/account-models?meta_only=1"]
   accounts=30 effectiveRows=629 generation=1793979339589
   second.byAccount === first.byAccount: true
```

即第二次只取指纹、没有整份拉取。实时服务（开关 true）再按来源确认：两个 gateway 会话的
composer catalog 都是 199 个模型，与 Go effective 并集逐项比较 `onlyGo(0)=`、`onlyLive(0)=`，
`live==goUnion: true`。

### 7.3 Go 停止时的回落

第一次 `SIGSTOP 75770` 时快照仍是旧的那份：

```
go /healthz -> timeout
新 gateway 会话 catalog: 200, 2075ms, models=206
onlyBaseline(0)=
onlyFallback(7)=glm-4.5,glm-4.5-air,glm-4.6,glm-4.7,glm-5-turbo,glm-5.1,glm-5.3-flashx-legal
```

这 7 个是旧快照里的 stale 行；回落本身触发了后台刷新（`cache:webui-models-snapshot.json`
15:38:03 更新）。刷新后快照并集 205 = Go 199 + 6 个已停用的 qoder 模型
（Auto/Cantus/Efficient/Fast/Sonus/Ultimate），按 `model-catalog-settings` 过滤后 199。

快照收敛后重测（开关仍 true；`readServerConfig` 按请求实时读库，未再重启）：

```
Go up #1/#2: 200, 199 models, sameSet=true
SIGSTOP -> catalog: 200, 2032ms, models=199, sameSet=true
onlyGo(0)= onlySnapshot(0)=
```

`SIGCONT` 后 `/readyz` 立即回到 `go_core.state=ready`、`restarts=0`。

### 7.4 复原

- 原文本写回，`restoredExact=true`、`harnessModelsViaGo` 键不存在、`deepDiffs=0`；最终原始
  文本 sha256 回到 `3ba3255c…f55ae`。
- 已按原参数重启：Node 79920 / Go 80304；`/healthz` 200（第 15 次探测）、`/readyz`
  `ready=true`、`restarts=0`；`GET /v0/webui/accounts` 200、32 个账号。
- 开关关闭时 composer catalog 199，与 Go 并集一致（205 快照减去 6 个停用 qoder 模型）。

### 7.5 结论

- 已拿到直接证据：第二次及后续读只发 `meta_only=1`，返回空 `data` + 同一 generation，不整份拉取；
  实时目录与 Go effective 并集逐项相同。
- 回落：Go `SIGSTOP` 时 catalog 仍 200；快照收敛后与 Go 集合逐项相同（199）。首次回落可能短暂
  返回旧快照的 7 个 stale GLM 模型，后台刷新后消失。
- 建议：现在可以默认开启 `harnessModelsViaGo`（发布需包含本次 Go 二进制）；保留现有回落语义。
  若在意首次回落的一致性，切换默认前先触发一次快照刷新。

## 8. 模型缓存 go-batch 对拍（2026-11-07 01:05–01:10 +08）

> 任务代号 verify-model-cache-go-batch。只读对拍：未改 Go / Node 代码、未发起推理、未删账号、未 `git add` / `git commit`。
> 目的：真机把 `config:server.modelCacheSync` 切到 `go-batch`，比较 `state.webUiModelsCache` 的 `byAccount` / `byProvider`
> 与 Go `account-models` 的 effective 集，验证 30 秒补同步与单飞，最后恢复原值。

### 8.1 开关原值与开启

`config:server` 原本**没有** `modelCacheSync` 键（缺省 `scheduler`）：

```
rawLen 919  sha256 3ba3255c58a5d7a490e36999fd9c8b3a81ec85b1e5c0ee38e76f8b45172f55ae
hasModelCacheSync false
```

备份原文本后只写 `modelCacheSync='go-batch'`（其它键逐键深比较 `deepDiffs=0`），写入值
sha256 `ded23421…5976d`。按原参数重启（`HOME=/Users/model`、`AIH_HOME_DIR=/Users/model/.ai_home`，
端口 9527，`--models-probe-accounts 8 --window-activation`）：Node 45131 / Go 45485；
`/healthz` 200（第 3 次探测），`/readyz` 为 `ready=true`、`go_core.state=ready`、`accounts_synced=true`。

启动后批量同步写出快照 `cache:webui-models-snapshot.json`：`updatedAt=1793984738125`
（2026-11-06T17:05:38.125Z，约在 listen / Go ready 后 1 秒），`source=remote`、
`byAccount=30`、`scannedAccounts=30`。

### 8.2 byAccount / byProvider 对拍

数据源：
- Node：`state.webUiModelsCache` 的持久化形态（`cache:webui-models-snapshot.json`，每次 go-batch 同步由
  `writePersistedWebUiModelsCache(deps, nextCache)` 原样写出，即同一次 `nextCache`）；
- Go：`GET 127.0.0.1:19550/v1/management/account-models`（用 Go 子进程环境里的 Management Key，不打印密钥），
  按 `go-account-sync:state.links` 的 `goRef → nodeRef` 翻回页面 ref。

30 个账号逐账号比较结果：

- **全量关系集 diff=0**：30/30 个账号的 Node `byAccount` 与 Go `models` 全集逐项相同；`unmappedGoRefs=0`、
  `nodeOnlyAccounts=0`、`goOnlyAccounts=0`。
- **effective 集**：27/30 个账号逐项相同；3 个账号 Node 多出 `effective=false` 的行，**没有任何 effective
  模型缺失**（所有账号 `onlyGoEffective=[]`）：

| 账号 | provider | Node byAccount | Go 全量 | Go effective | Node 多出的非 effective 行 |
| --- | --- | ---: | ---: | ---: | --- |
| `acct_103a82d5fbd9e9cedd16` | qoder | 15 | 15 | 9 | Auto, Cantus, Efficient, Fast, Sonus, Ultimate（6） |
| `acct_229f9ffa9b05e70467dd` | codebuddy | 26 | 26 | 18 | balanced-model, default-model, fast-model, glm-5.2, grok-4.7, hy3, hy4-preview, primary-model（8） |
| `acct_cb6a07c689c8d46432e6` | workbuddy | 26 | 26 | 18 | balanced-model, default-model, fast-model, glm-5.2, hy3, hy4-preview, minimax-m3.1-flash, primary-model（8） |

byProvider 聚合（只看 Go 接管的 Provider）：9/10 个 Provider 完全一致；唯一差异是 qoder
（Node 15 / Go effective 9，`onlyNode=6`，即上表 6 个非 effective 模型）。全局并集
Node 205 / Go effective 199，`onlyGo=0`、`onlyNode=6`。

这 6 个 qoder 模型本来就是 Node 快照里的停用行（第 2 节记录的 205 = Go 199 + 6 个停用 qoder），
不是 go-batch 新引入的。差异来源是 **WebUI 缓存的口径是全量关系快照**（停用/人工行要能在模型管理页
看见并编辑），不是 effective 路由目录；页面的 `selectableByAccountRef` 会按 `model-catalog-settings`
过滤：同一时刻 `/v0/webui/models` 的 qoder `byAccountRef=15`，`selectable=9`，6 个停用模型均不在可选集里。

### 8.3 30 秒补同步与单飞

用 Go 的 `GET /v1/management/metrics` 的 `route_counts["/v1/management/account-models"]` 作为
「整池读取次数」的计数器（每次 Node 批量同步恰好发一次全量 GET），配合快照 `updatedAt`：

| 场景 | 结果 | account-models 增量 | 快照 updatedAt |
| --- | --- | ---: | --- |
| 距上次同步 164970ms，首次 `GET /v0/webui/model-aliases/targets` | 200, 49ms, targets=10 providers | **+1** | 1793984738125 → 1793984903121 |
| 紧接着第二次 targets（30 秒内） | 200, 8ms | **0** | 不变 |
| 再等 31142ms 后，两个 targets 并发 | 均 200（71ms / 34ms） | **+1** | 1793984903121 → 1793984934196（只前进一次） |

即：超过 30 秒会补一次同步且不报错；30 秒窗口内命中内存快照；并发请求共享同一个
`sync.running`，只向 Go 拉一次（单飞）。

### 8.4 复原

把备份的原始文本写回 `config:server`：

```
restoredExact=true  rawLen 919  sha256 3ba3255c58a5d7a490e36999fd9c8b3a81ec85b1e5c0ee38e76f8b45172f55ae
hasModelCacheSync false
```

按原参数再次重启：Node 51333 / Go 51688；`/healthz` 200（第 3 次探测），`/readyz` 第 2 次为
`ready=true` / `go_core.state=ready` / `accounts_synced=true`。模型页
`GET /v0/webui/models` 200（10 个 Provider、`byAccountRef=30`，qoder `selectable=9`），
`GET /v0/webui/accounts` 200（32 个账号）。配置文本与备份逐字节相同，`modelCacheSync` 键不存在，
开关回到缺省的 scheduler。

### 8.5 结论

- go-batch 的**全量关系快照**与 Go `account-models` 逐账号逐项一致（30/30，diff=0），byProvider 9/10 一致；
  唯一差异是 6 个 `effective=false` 的 qoder 行，属于 WebUI 缓存刻意保留的停用行，且被可选集过滤。
- 30 秒补同步、30 秒内不重复拉取、并发单飞均验证通过；Go 失败时不抛错（沿用旧快照的语义未变）。
- 建议默认改 `go-batch`，但验收口径应写成「**全量关系集 diff=0**」；如果坚持按 Go effective 口径要求
  byAccount 逐账号 diff=0，则当前实现不满足（会多出停用行），需要另行决定是否让 WebUI 缓存丢弃
  停用/人工行——那会改变模型管理页的可见性，不建议在未确认前顺手改。




## 9. 调度器退役（2026-11-07）

> 任务代号 retire-model-scheduler。只改 Node 的 `lib/**` 与 `test/**`；Go 的
> `POST /v1/management/accounts/{ref}/models/refresh` 已存在，未改 Go。未 `git add` / `git commit`。

### 9.1 删除的文件与逻辑

- `lib/server/model-probe-index.js` 删除。删除前全仓库 `grep` 确认只有
  `lib/server/webui-model-refresh-scheduler.js` 引用它（docs 里的历史记录除外）。
- `lib/server/webui-model-refresh-scheduler.js` 删除旧调度器的全部实现：
  到期时间轮分桶 / 最小堆索引、优先级插队（`requestWebUiModelProbe`）、活跃窗口
  （`touchWebUiModelActivity`）、启动补课、`setTimeout` 轮询与错误退避。
  文件保留为薄门面：`ensureWebUiModelRefreshScheduler` + `triggerWebUiModelRefreshSoon`。
- `server.js` 删除停服时清理旧调度器 timer 的分支；生命周期监听器不再传
  `requestModelProbe`，改为把 `(provider, accountRef)` 直接交给刷新入口。

### 9.2 triggerWebUiModelRefreshSoon 的新行为

- **账号级（带 ref）**：经 host 的 `refreshAccountModels` 调 Go 的
  `POST /v1/management/accounts/{ref}/models/refresh`（Node ref 由 host 翻成 Go ref）。
- **Go 不可用 / 返回失败**：对失败账号调用 `markWebUiModelsCacheStale`——只清
  `accountUpdatedAt`，保留已发现目录，让账号回到「待探测」；等下一次 go-batch
  批量同步或按需探测补回。
- **全局（不带 ref）**：go-batch 下立即单飞批量读一次 Go（`scheduleNext: false`，
  不接管 6 小时节奏）；legacy 下把运行池账号全部标成 stale。
- 任何分支都不创建定时器；go-batch 的 6 小时节奏只由
  `ensureWebUiModelCacheGoSync` 负责。

### 9.3 legacy 语义

- `config:server.modelCacheSync` 仍接受 `'scheduler'`（枚举值保留用于配置回退），
  但内部映射为「不做定时轮询、仅按需 stale」：启动与 WebUI 请求都不排 timer，
  模型目录靠持久化快照 + 显式/按需刷新。
- 默认值仍是 `go-batch`；`server-config-schema` 的默认值与说明已同步。

### 9.4 守卫测试

`test/webui-model-refresh-scheduler.test.js`：

- legacy 的 `ensure`：`setTimeout` / `setInterval` 调用数为 0，且不初始化任何调度状态；
- go-batch 的 `ensure`：只有 1 个启动后的批量同步 timer（< 5s），没有 setInterval；
- `trigger`（带 ref / 全局 / Go 不可用）：都不排定时器；Go 成功只调一次刷新，
  Go 不可用时清掉 `accountUpdatedAt` 且保留 `byAccount`；
- host 封装发出的是 `POST …/models/refresh`，Go 未就绪返回 `null`；
- `model-probe-index.js` 已不可解析。

运行：`HOME=/Users/model node --test test/webui-model*.test.js test/account-*.test.js test/source-encoding.test.js`
（153 passed / 0 failed）。

### 9.5 真机验证：旧调度器已退役（2026-11-07，verify-scheduler-retired）

按原参数重启（launchd `com.meadeo.aih-server`，`HOME=/Users/model`、`AIH_HOME_DIR=/Users/model/.ai_home`，
`--host 0.0.0.0 --port 9527 --no-proxy localhost,127.0.0.1,0.0.0.0,192.168.31.57 --models-probe-accounts 8 --window-activation`）。
Node pid 38581，Go pid 38934；`/healthz` 200，`/readyz` 200、`go_core.state=ready`、`accounts_synced=true`。

| 断言 | 结果 |
| --- | --- |
| a. 模型页数据 | `/v0/webui/models` 200（419,328 B），10 个 provider；`/v0/webui/accounts` 32 个账号 / 11 个 provider；`byAccountRef=30`、`errorsByAccountRef=3`。provider 模型数与重启前逐项一致：codebuddy 26、claude 5、workbuddycn 20、workbuddy 26、qoder 15、codebuddycn 21、zcode 2、opencode 110、codex 35、cline 16。 |
| b. 旧轮询痕迹 | 重启后累计 112 行日志；`webui-model-refresh`=0、`probe-index`=0、`WebUI 模型探测`=0、`requestWebUiModelProbe`=0、`touchWebUiModelActivity`=0、`model-probe-index`=0、`模型探测`=0。60s 观察窗口只有 health / UI access / `reverse_tunnel_retry`。 |
| c. 账号无损编辑触发刷新 | 对 codex `acct_c016fd7eee0f64163068` 做 status up→up 的无损写入（`POST /v0/management/state-index/operational-status`，200 / `updated:true`）；Go metrics 的 `/v1/management/accounts/<ref>/models/refresh` 路径 +1（server.log 19:13:07.913Z 记录该次触发），没有额外 timer。 |
| d. Go 不可用时降级 | SIGSTOP Go pid 38934 后同样触发一次：约 30s（15×2s 轮询）后 Node 判超时并把该账号 `accountUpdatedAt` 删除；持久化快照的 `byAccount[<ref>]` 仍为 31 个模型（`auto` / `claude-haiku-4.5` / `claude-opus-4-6-thinking` 等）。SIGCONT 后 `/readyz` 200、`go_core` 恢复 ready；Go 日志在 19:14:45 记录 `context canceled`，与 Node 30s 超时一致。 |

结论：未发现旧调度器的残留轮询；两次显式触发各产生 1 次 Go `models/refresh`（Go metrics 该路径最终计数 2），
Go 不可用时只清 `accountUpdatedAt`、不清 `byAccount`。最终 `/healthz` 200、`/readyz` 200、`go_core=ready`，
`/v0/webui/models` 200，网关健康。

