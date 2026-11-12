# 插件实例启停（enable/disable）迁 Go 的边界方案

> 日期：2026-11-09 · 基线：`main` @ `bbfa37a5`（分支 `slice/plugin-design`）
> 只读盘点 + 架构方案，不改代码。
> 前序切片：`docs/plans/reports/2026-11-08-plugins.md`（列表与投影一致性只读迁 Go）；
> `install/uninstall` 正由另一条切片迁 Go（制品 + `plugins.control.v1` 状态）。
> 本方案按「**Go 拥有 `plugins.control.v1`**」设计，不重复实现那条切片的 store，只约定它的接口。
> 结论：**P1 把「唯一写者」交给 Go，Node 保留编排；P2 再把操作入口与用例搬进 Go，Node 退化为插件运行时宿主；
> C（Go 接管宿主进程）本轮不做。**

## 0. 结论先行

| 方案 | 一句话 | 判定 |
| --- | --- | --- |
| A：Go 写状态 + Node 轮询 revision 后 reconcile | 接口最少，但状态先落库、候选后准备，必须新增 pending 状态机 | **不采用** |
| B：Node 编排 + Go 做校验/CAS/持久化 | 发布协议零改动，Go 成为唯一写者，失败语义与今天一致 | **P1 采用** |
| B+：Go 拥有操作入口 + Node 暴露 prepare/activate 回调 | 状态机、API、审计、revision 都归 Go；Node 只留运行时宿主 | **P2 采用** |
| C：Go 接管插件进程 supervisor / RPC host | 要重写 `runtime-service` 并给 Node 做 invoke 服务化；且 Go 是 Node 的子进程 | **不做**（除非宿主独立进程化） |

一句话边界：**「状态」归 Go，「代次与进程」留在 Node，「候选的语义」暂时也留在 Node（因为 Ajv 与 JS 属性序指纹）。**

## 1. 现状：一次 enable 到底做了什么

### 1.1 时序（带代码位置）

1. `POST /v0/plugins/enable` → `control.enable(body)`（`lib/server/plugin-management-routes.js:451`）。
2. `publishChange` 读 current、预检 revision（`lib/plugins/control/control.js:165`）。
3. `mutate(clone(current))` 生成候选：校验 `configSchema` 并补默认值、检查权限确认、写入 instance 记录，
   **并在候选计算阶段就写审计**（`control.js:176` 起；`audit.append` 在 mutator 内）。
4. `hostPlugins(candidate)` 只取 `enabled` 实例，解析 `entryPath = installed.directory + manifest.entry`（`control.js:80`）。
5. `runtime.publish(plugins, commit)` 进入串行队列（`lib/plugins/control/runtime-service.js:247`）。
6. 期望集合为空（disable 最后一个实例）：**先 `commit()`**，再按租约退役旧代次或直接停宿主。
7. 非空：`ensureSupervisor` → `host.call('prepare', {generation, plugins})`；被拒则抛错，**不 commit**。
8. 准备成功后构建快照：`collectCatalogAliases(invoke)` 与 `collectProviderDescriptors(invoke)` 都会**调用宿主**；
   任何一步失败 → `dispose` 候选 → 抛 `plugin_candidate_rejected`，**不 commit**。
9. `commit()` = `store.update(() => candidate, expectedRevision)` 的 CAS（`lib/plugins/control/state-store.js:42`）。
10. `activate(candidate, retainPrevious)` → 切换内存快照 → `retire(previous)`（`runtime-service.js:217`）。
11. `syncProviderDescriptors` → Node provider 注册表 `replaceOrigin('plugin', ...)`（`plugin-system.js:22` 装配）。
12. `liveProjections()` 经 `go-projection-sync.js` 推给 Go；Go ack 之后，请求才带代次转发给 Go
    （`lib/server/gateway-plugin-stage.js` 的 `plugin_generation_unacked` 判定）。

### 1.2 三条硬事实

- **持久事实只有一份**：`app-state.db` → `app_kv` → key `plugins.control.v1`（`state-store.js:11`）。
  revision 由写者在同一事务里 `+1`，CAS 用 `BEGIN IMMEDIATE`。
- **发布串行**：`runtime.publish` 用一条 Promise 队列串行化；prepare/commit/activate 之间不能插队，
  否则两个候选会互相覆盖代次顺序。
- **进程归属**：Plugin Host 是 Node 的 `child_process`（`lib/plugins/host/supervisor.js:33`），
  令牌走 stdin、就绪看 stdout、`--exit-with-parent`；Go 只是 RPC 客户端（`internal/adapters/pluginruntime/invoker.go`）。
  同时 **Go 自己也是 Node 的子进程**（`lib/cli/services/server/go-core-supervisor.js`，私网 19550），没有独立守护进程。

### 1.3 运行时耦合清单

| 消费方 | 调用方式 | 迁走要付的代价 |
| --- | --- | --- |
| provider.descriptor 收集 | prepare 阶段 `invoke` 每个贡献项，Node 校验后 `replaceOrigin('plugin')` | 校验器与 provider 注册表都在 Node；迁 Go 需要一套等价的描述符校验与注册表 |
| catalog alias | prepare 阶段 `invoke` `catalog` 贡献 | 与上同：结果要进 Node 的目录视图 |
| gateway.request / gateway.account / gateway.attempt | 请求热路径同步 `runtime.invoke`，SSE/WS 在途持有租约 | 迁走要给 Node 一条 invoke API，并处理取消、超时、协议 v2 反向调用 |
| observe | 请求终态投递，best-effort 有界队列 | Go 侧已有 Observer，但 Node 路由此刻仍在用 Node 队列 |
| pricing.quote | `/v0/plugins/pricing/quote` 同步 invoke | Node 业务服务直接消费 |
| account.source / login / refresh / materialize | `lib/plugins/account/service.js` 同步 invoke | 同上 |
| 投影推送与 ack | Node 是 owner，Go 是消费者 | 方向不能反过来，否则 Go 要理解代次生命周期 |
| status / doctor / runtime 诊断 | `runtime.status()`、`liveProjections()` | 进程内状态，离开 Node 就失真 |

## 2. 不能破坏的语义（设计约束）

| 编号 | 约束 | 今天的实现 |
| --- | --- | --- |
| C1 | 候选被拒（apply 失败、配置非法、目录求值失败）**不写状态**，旧代次继续服务 | prepare 在 commit 之前 |
| C2 | CAS 冲突只丢弃候选，旧代次继续服务 | `store.update(expectedRevision)` 抛错后 dispose 候选 |
| C3 | 停用不打断在途请求；租约归零才 `dispose`，超过 10 分钟强制退役并计数 | `leaseOn` / `retire` / `forcedRetirements` |
| C4 | 没有启用实例不启动宿主；启动恢复异步、失败只降级，不阻塞网关 | `publish` 空集合分支 + `start()` |
| C5 | revision 单写者、单调 `+1`；同一操作重复执行也 `+1` | `store.update` 无条件递增 |
| C6 | prepare → commit → activate 之间不能有第二个发布插队 | `enqueue(task)` 单队列 |
| C7 | Go 的生命周期从属于 Node（子进程 + 崩溃重启循环） | `go-core-supervisor` |
| C8 | **「读不到状态」不能被当成「没有启用实例」** | 今天 `desiredPlugins()` 吞错返回 `[]`（`control.js:92`），见 §8 风险 R5 |
| C9 | 状态文档里有 Go 投影模型不认识的字段（`artifact`、`directory`、`permissionsFingerprint`、`createdAt`、`generations`、`activeGeneration`、`schemaVersion`） | Go 的 `ControlState` 只解码子集（`application/pluginruntime/control_state.go:41-70`） |

## 3. 三种架构的评估

### 3.1 A：Go 拥有状态，Node 保留 runtime，靠 revision 轮询 reconcile

**流程**：CLI/WebUI → Go 的 `POST /v1/management/plugins/instances/{id}/enable` → Go 校验 + 写状态（revision+1）→
Node 的 reconciler 轮询 `GET /v1/management/plugins/state?since=<rev>` → 发现变化 → `publish(desiredPlugins(), null)`。

四个具体问题：

- **轮询精度**：Go 是 Node 的子进程、本机回环，单次读是一次 SQLite `SELECT`（亚毫秒），
  250ms 间隔的成本可以忽略（约 4 次/秒）。更密没有意义，因为一次 prepare 本身就远大于 1ms。
- **延迟**：热路径 enable ≈ 轮询等待（0–250ms）+ prepare（10–300ms）+ activate（<10ms），量级在数百毫秒；
  冷启动还要加宿主拉起（ready 超时 10s，通常在 1s 以内），P95 到秒级。
  今天同步路径没有轮询等待，延迟只受 prepare 耗时约束。
- **race**：reconcile 正在按 revision R 发布时，第二次写入把 revision 推到 R+1 → Node 的 `commit` 撞 CAS →
  丢弃候选、重新按 R+1 prepare。频繁写入会形成「准备—丢弃—再准备」的抖动，
  每个候选都会让 `generationsOnHost+1`，更快撞到 `recycleAfterGenerations=32` 的宿主回收。
  需要在 Go 侧做去抖（例如 100ms 合并窗口），但去抖本身又拉长延迟。
- **如何等待激活完成**：Go 的 HTTP 响应拿不到代次。只有三种补法：
  (a) 返回 `{state:'pending', revision}`，调用方轮询状态；
  (b) Go 写一条 operation 记录，Node 激活后回调 `POST /v1/management/plugins/state/ack`；
  (c) Node 反向 SSE/长轮询给 Go。
  三种都会**改变现有响应契约**（今天返回 `generation` 与 `state`），并新增一条持久或半持久的确认通道。

**致命问题**：状态先落库、候选后准备，直接违反 C1。插件 apply 抛错时，列表会显示「已启用」而运行时是 degraded，
用户必须再执行一次 disable 才能回到干净状态。要补回 C1，就得在状态文档里引入 `pending / failed` 中间态，
让所有读者（Go 列表、Node doctor、WebUI）都理解它——这等于重写发布协议，不是「换个写者」。

### 3.2 B：Node 保留编排，Go 只做状态校验与 CAS

**流程**：完全保留 `publishChange` 的 prepare → commit → activate 顺序，只把 `store.update` 换成一次本机 HTTP：

```
POST /v1/management/plugins/state/commit
{ "operation": "enable",
  "expectedRevision": 12,
  "candidate": { ...完整候选文档，revision 已写为 13... } }
→ 200 { ok:true, revision:13 }
→ 409 { ok:false, error:"plugin_revision_conflict", revision:12 }
→ 400 { ok:false, error:"plugin_state_invalid", issues:[...] }
```

- Go 是唯一写者：`BEGIN IMMEDIATE` → 读 current → 校验 `expectedRevision` → 校验候选不变量 → 原样写入 → `COMMIT`。
- **落盘用原始字节**：Go 只把候选解码成校验模型（或直接对 `map[string]json.RawMessage` 做检查），
  写回的是调用方给的 JSON 文本，只替换 `revision` 字段。这样 `artifact`、`directory` 等未知字段一个都不会丢（C9）。
- 失败语义与今天逐字一致：commit 抛错 → Node `dispose` 候选 → 返回 409/503 → 旧代次继续服务。

**优点**：协议不变、错误码不变、CLI/WebUI/demo 全不动；改动面只有 `state-store.js` 的 `update` 与一个新的 Go 端点。
**缺点**：Go 只拥有「写」，不拥有「操作」；`control.js` 的用例仍在 Node，看起来不像「启停迁走了」。

### 3.3 C：Go 接管插件进程 supervisor / RPC host

要做完至少要拆掉这些（`runtime-service.js` + `host/supervisor.js`，且与进程同生命周期）：

1. 进程层：spawn `node --import hooks host-entry.mjs`、令牌走 stdin、stdout 就绪事件、env 白名单、
   socket/命名管道、`shutdown`、`--exit-with-parent`、stderr 尾部诊断。
2. 代次状态机：`prepare/activate/dispose`、`generation` 自增、`retire`、租约表、`forcedRetirements`、
   `recycleAfterGenerations`（M0 结论：代次模块内存不可回收，只能靠宿主重启）。
3. 快照构建：`buildSnapshot`、catalog alias 求值、provider descriptor 收集（含 Node 注册表写入）。
4. 恢复：宿主退出 → 清空快照 → 按 0.5s→10s 退避 → 按 desired state 重新发布 → 连续失败停 degraded。
5. 对 Node 暴露 invoke：网关热路径、pricing、account、observe 都要一条同步调用通道；
   还要把 `acquire/lease` 的代次语义一起搬过去，否则 Node 无法保证「一个请求只调一代」。
6. 反向通道：provider descriptors 要送回 Node 的注册表；这会在 Go 上再开一条推送。

**拓扑问题**：Go 现在是 Node 的子进程，Node 重启或 Go 崩溃重启都会杀掉它拉起的插件宿主；
而 `go-core-supervisor` 有「二进制不匹配就持续退避重试」的路径，会让宿主反复起落。
要避免这一点，插件宿主必须变成独立常驻进程（或 Go 变成独立守护进程），那是 M5 级工作，不是一条切片。

**结论**：语义上可行，工作量与风险都远超「迁一条用例」；本轮不做。

### 3.4 决策矩阵

| 维度 | A（Go 写 + Node 轮询） | B（Node 编排 + Go CAS） | B+（Go 入口 + Node 回调） | C（Go 接管宿主） |
| --- | --- | --- | --- | --- |
| 语义保真（C1/C2/C6） | 差：提交先于准备，需 pending 状态机 | 优：协议逐字不变 | 优：顺序保留，需跨进程锁 + TTL | 优：可完全实现 |
| 端到端延迟 | 中：+0.25s 轮询，冷启动秒级 | 优：本机 HTTP，毫秒级 | 优：同 B | 优 |
| 故障面 | 差：状态已写、运行时未跟上会长时间分叉 | 优：commit 失败 = 今天 store 抛错 | 中：Go 崩溃会留候选，需 TTL 回收 | 差：Go 重启即重置全部代次 |
| 新增接口面 | 小：1 个读端点 | 小：1 个写端点 | 中：Go 公开 2 个操作 + Node 内部 3 个端点 + 双向鉴权 | 大：invoke/lease/descriptor 服务化 |
| 可删除的 Node 代码 | 少（control 仍在） | 少到中（state-store 写） | 多（control 用例、state-store、audit） | 最多（runtime-service 490 行） |
| 工作量 | 中 | 小 | 中 | 大 |
| 回滚 | 好（flag） | 好（flag 切回 Node 写） | 中（依赖版本回退） | 差 |

## 4. 推荐方案与理由

### 4.1 P1 采用 B：先把「唯一写者」交给 Go

理由：

1. **它只改一个函数**：`createPluginStateStore().update` 从本地 SQLite 写变成一次 Go 调用；`get()` 仍是本地读。
   `control.js` 的用例、`runtime-service` 的协议、审计、错误码全部不动。
2. **它把最危险的两件事分开了**：跨进程写 `app-state.db`（锁、WAL、维护门）与「控制方向反转」。
   先做前者，出问题能一眼归因；两件事一起做，故障面会混在一起。
3. **它让 revision 真正只有一个 owner**：install/uninstall 切片落地后，四个操作共享同一个 Go store，
   Node 不再有任何路径能写 `plugins.control.v1`（见 §6.1 的单写者开关）。
4. **它可回滚**：flag 关掉即回到 Node 写，状态文档没有迁移、没有副本、没有版本分叉。

### 4.2 P2 采用 B+：入口与用例进 Go，Node 只留运行时宿主

B+ 不是 A 的变体，而是**保留 B 的顺序、把驱动者换成 Go**：

```
Go  POST /v1/management/plugins/instances/{id}/enable
  → 读状态、生成 mutation（不写）
  → Node POST /v0/plugins/internal/prepare   （回环 + Go 引导密钥）
       Node: 校验 configSchema/权限 → 生成候选 → 宿主 prepare → 返回 ticket + generation + candidate
  → Go 用 CAS 提交 candidate（revision+1）
       冲突 → Node POST /internal/discard {ticket}
  → Node POST /v0/plugins/internal/activate {ticket, revision}
  → 200 { revision, generation, state }
```

这样 `control.js` 的 enable/disable 用例、权限门、状态写入、审计都归 Go；
Node 侧只保留「候选构建 + 宿主 prepare/activate/dispose」这一层（约等于现在的 `runtime-service` 加一个内部端点）。
**代价**是跨进程的发布锁：prepare 到 activate 之间必须有唯一 owner，否则第二个 prepare 可能先 activate，
让代次倒序。设计上用 ticket + TTL（建议 30s）：`prepare` 取锁并返回 ticket，`activate/discard` 释放；
Go 在 prepare 之后崩溃，Node 到期自动 `dispose` 候选并释放，状态没写，符合 C1。
第二个并发操作立即得到 409 `plugin_publish_busy`，由调用方重试（WebUI 双击、CLI 并发都会看到）。

### 4.3 为什么不在 P1 直接用 A

- 违反 C1，必须补 pending 状态机；一旦有中间态，Go 的只读清单（`inventory.go`）与 WebUI 都要改语义。
- 响应要新增确认通道，CLI 的 `generation` 字段与 demo 的同步断言都破。
- 轮询带来的失败模式（写成功、reconcile 失败、状态长期分叉）比 B 的「一次 503、旧代次继续跑」难排查得多。

### 4.4 为什么不现在做 C

除非同时决定「插件宿主独立进程化」，否则 C 只是把 490 行状态机从一个子进程搬到另一个子进程，
还多出 6 类跨进程接口。它的收益（Node 彻底退出插件运行时）要等 M5 才有意义。
保留判断：**当且仅当插件宿主需要脱离 aih server 独立部署时，重启 C 的评估。**

## 5. 阶段计划与验收判据

### P0：Go 写侧 store（与 install/uninstall 切片共用）

交付：

- `internal/adapters/plugincontrol` 增加可写 store：`Open`（rw）、`Update(ctx, operation, expectedRevision, candidate []byte)`、`Read`。
- 加入 `run/maintenance/access.sqlite` 共享租约与 `run/maintenance/oauth-rekey.lock` 门（见 §6.3）。
- 候选校验（operation 维度）：

| operation | 额外不变量 |
| --- | --- |
| `enable` / `disable` | `installed` 必须与 current 逐字节一致（禁止借启停夹带安装/卸载） |
| `install` | `instances` 必须与 current 一致 |
| `uninstall` | `instances` 必须与 current 一致，且被删记录不被任何实例引用 |

- 通用不变量：`schemaVersion == 1`；`revision == expectedRevision + 1`；实例 id 匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`；
  每个实例的 `pluginId@version` 能唯一解析到 installed；无重复 instanceId；`enabled` 实例的配置是 JSON 对象；
  声明了权限的插件，`permissionsAcceptedFingerprint` 必须等于 installed 的 `permissionsFingerprint`（**启停只比较存储值，
  不重算**；存储值由 install 侧按 Node 字段序计算，见 §7）；文档 ≤ 4MB。

验收：

- CAS 冲突（两并发提交）→ 一个成功、一个 409，revision 只 +1。
- 未知字段 round-trip：写入后 `artifact`、`directory`、`permissionsFingerprint`、`createdAt`、`generations` 原样保留。
- 维护门：gate 文件存在 → `account_maintenance_in_progress`；维护进程持 EXCLUSIVE 时提交在 busy_timeout 后失败，且不写入。
- 缺库/缺表：`install` 沿用 Node 的建库建表语义；`enable`/`disable` 要求库与表已存在（有已安装制品才可能启用），
  否则 `plugin_state_unavailable`——不静默覆盖、不凭空创建。
- 库损坏（非 SQLite、文档非法）→ `plugin_state_invalid`，拒绝写入。

### P1：Node 的 `store.update` 改走 Go（方案 B）

交付：

- Go：`POST /v1/management/plugins/state/commit`（管理密钥鉴权）。
- Node：`state-store.update` 在开关打开时调 Go；`control.js` / `runtime-service.js` / 路由零改动。
- 开关：放在 server config（不是环境变量），默认关；打开前必须确认 install/uninstall 也已走同一 store。

真机验收（必须逐条留证据）：

| 场景 | 步骤 | 通过判据 |
| --- | --- | --- |
| enable | `aih plugin install ...` → `aih plugin enable echo --accept-permissions` | revision +1；`GET /v1/management/plugins` 的 `runtime.activeGeneration` 为新代次，实例 `status=projected`；`GET /v0/plugins/doctor` 的 `runtime.state=active` |
| disable | `aih plugin disable echo` | `activeGeneration=0`、`generations=[]`、`retiringGenerations=[]`、`runtime.leases={}`；没有其它启用实例时宿主进程退出 |
| 租约归零 | 用一个慢插件（或流式请求）持住旧代次后 disable | disable 立即返回；`retiringGenerations` 含旧代次；请求结束后自动消失；`forcedRetirements` 不增加 |
| 候选被拒 | 让插件 apply 抛错，或提交违反 `configSchema` 的配置 | 返回 400/409 + `plugin_candidate_rejected`/`plugin_config_invalid`；`revision` 不变；`activeGeneration` 仍是旧值 |
| 并发 CAS | 两个 enable 并发（`--expected-revision` 相同） | 一个 200、一个 409 `plugin_revision_conflict`；最终 revision 只 +1 |
| 崩溃恢复（宿主） | SIGKILL 插件宿主进程 | Node 按退避重启，`restarts=1`，按同一 desired state 恢复，新代次 active；期间 enable/disable 仍可执行 |
| 崩溃恢复（Go） | kill Go core 子进程 | 宿主与旧代次继续服务；enable 返回 503（不落状态）；Go 重启后清单与 revision 连续 |
| 重启恢复 | 重启 aih server | 启用实例自动回到 active，revision 不变；disable 仍可执行 |

### P2：操作入口进 Go（方案 B+）

交付：

- Go：`POST /v1/management/plugins/instances/{instanceId}/enable|disable`；`/v0/plugins/enable|disable` 改为 Node 代理。
- Node：`/v0/plugins/internal/{prepare,activate,discard}`，只接受回环 + Go 引导密钥；ticket + 30s TTL + 单发布锁。
- 删除：`control.js` 的 enable/disable 写入用例与 `state-store.update`；审计写入口移到 Go（成功提交后写）。
  进程内调用（demo）保留一个同签名的薄壳，只做「转调 Go」，不保留任何本地写入。
- 保留：`control.doctor` 仍读 Node 运行时；`install/uninstall` 走各自切片。

验收：

- 公开响应字段与 P1 完全一致（`revision` / `generation` / `state`），CLI 与 WebUI 无改动。
- **顺序守卫**：在 Go 提交前注入失败 → 状态不落盘、候选被 dispose、旧代次继续服务。
- **锁**：并发 enable → 一个 409 `plugin_publish_busy`；`generationsOnHost` 不因失败操作增长。
- **Go 中途崩溃**：prepare 后 kill Go → TTL 到期 dispose 候选；状态不变；宿主不残留候选代次。
- **demo 仍通过**：`POST /v0/plugins/demo` 的 `enabled → disabled → re-enabled → restart → removed` 五个阶段全绿。

## 6. 兼容性

### 6.1 状态文档：不迁移，只换写者

- **位置不动**：仍是 `app-state.db` 的 `app_kv/plugins.control.v1`，`schemaVersion=1`。
  P1/P2 都不需要数据迁移，回滚只需要把写开关切回 Node。
- **单写者**：开关打开后，Node 的 `store.update` 必须**直接失败**（`plugin_state_writer_moved`），
  不能「Go 失败就本地写」——那是最典型的双写分叉。
- **读侧不动**：Node 的 `get()` 继续本地读；`desiredPlugins()`、`doctor()`、`hostPlugins()` 都不需要改。
  这也保住了 C8：读失败不会变成「空集合」。
- 未来把 key 搬到 `aih.db` 是另一件事：一旦 Node 的 desired state 变成远程读，
  必须先把 `desiredPlugins()` 改成 `{ok, plugins}` 并让恢复路径在 `ok=false` 时**保持现状而不是停宿主**（见 R5）。

### 6.2 双写风险与处置

| 风险 | 表现 | 处置 |
| --- | --- | --- |
| 两个写者 | revision 回退、lost update | 单写者开关；Node 写入路径直接报错；Go store 只暴露一个入口 |
| 未知字段被吃掉 | 卸载找不到 `artifact`、权限门失效（`permissionsFingerprint` 丢）、`createdAt` 重置 | 候选**原样字节落盘**，只替换 `revision` |
| 权限指纹复刻偏差 | Go 与 Node 算出的 `permissionsFingerprint` 不同，已确认的权限被判成未确认 | 固定字段序（network→filesystem{read,write}→secrets→environment）+ `SetEscapeHTML(false)` + 跨语言对拍；启停只比较存储值 |
| 审计重复 | 一次 enable 两条 audit | 审计只由一侧写：P1 仍 Node，P2 移到 Go；切换时删掉另一侧 |
| 两套错误语义 | CLI 看到 `http_400` 而不是领域码 | Go 端点返回与 Node `writeError` 同名的码与状态映射（409/404/400/503） |
| 读快照过期 | 列表显示旧 revision | 写后 Go 的清单必须读同一个 store（不能再用 `immutable=1`，见 6.3） |

### 6.3 库与锁：Go 写 `app-state.db` 的三个硬要求

1. **journal_mode 必须是 WAL**，不能切成 DELETE。Node 每次打开都执行 `PRAGMA journal_mode = WAL`
   （`lib/server/app-state-store.js:145`）；如果 Go 切成别的模式，Node 的读会被阻塞，
   `desiredPlugins()` 吞错返回 `[]`，恢复路径可能把宿主停掉（C8/R5）。
2. **必须加入账号维护协调**：Node 每次打开 app-state 都持有 `run/maintenance/access.sqlite` 的 SHARED 租约，
   并检查 `run/maintenance/oauth-rekey.lock`（`lib/runtime/account-maintenance-lock.js`）。
   Go 写之前必须做同样的事：先查 gate 文件，再开 lease 库（journal_mode=delete、`BEGIN`、`SELECT id FROM lease WHERE id=1`），
   否则账号 rekey 的 EXCLUSIVE 阶段会与插件写入并发。
3. **读连接不能再 `immutable=1`**：`internal/adapters/plugincontrol/reader.go:130` 的 immutable 重试只对「没有写者」安全。
   Go 成为写者后，清单必须读普通 rw/ro 连接，宁可 503 也不能读过期快照。

### 6.4 CLI / WebUI / 演示脚本

- **CLI**：`aih plugin enable/disable` 走 `POST /v0/plugins/enable|disable`，只消费 `revision`/`generation`/`state` 与错误码；
  P1 完全不变；P2 由 Node 代理到 Go，响应形状保持一致。`--expected-revision` 语义不变（仍然是 CAS 的 expected）。
- **WebUI**：`operateAihPlugin` 只 `post` 然后重新拉列表（`web/src/services/api.ts:2536`、`AihPluginPanel.tsx:53`），
  不读响应字段，因此 P1/P2 都不需要改前端。
- **演示脚本**：`scripts/aih-portable-plugin-demo.js` 走**进程内** `system.control.enable/disable`，
  并断言 `plugin_permissions_unacknowledged`、五个阶段（enabled/disabled/re-enabled/restart/removed）。
  P1 不受影响；P2 必须保留一个同签名的 `control.enable/disable` 薄壳（内部调 Go），或同步改写 demo，
  不能出现「demo 还在调一个已删除的 Node 用例」。
- **错误码**：`plugin_revision_conflict`、`plugin_in_use`、`plugin_version_conflict` → 409；
  `plugin_not_installed`、`plugin_instance_unknown` → 404；其余 400；运行时/状态不可用 → 503。

### 6.5 回滚

- P1：关开关 → Node 重新写本地；revision 继续递增，无补偿动作。
- P2：回滚靠版本回退（重新部署上一版 Node），不做运行期双实现。回退后的 Node 仍通过 P1 的
  `/v1/management/plugins/state/commit` 写状态，因此 **Go 的 state 端点不能随 P2 删除**；
  ticket/TTL 未完成的候选由 TTL 自动回收。

## 7. 明确不能（或不应）在没有破坏风险的情况下迁移的部分

| 部分 | 为什么不能迁 | 结论 |
| --- | --- | --- |
| 插件宿主进程监督（spawn/ready/token/env/socket/shutdown） | 与进程同生命周期；Go 自己是 Node 的子进程 | 留 Node（方案 C 才动） |
| 代次状态机（prepare/activate/dispose/retire/lease/recycle） | 依赖进程内快照与在途请求租约；跨进程要重做租约协议 | 留 Node |
| 请求热路径 `invoke`（gateway.request/account/attempt/observe） | Node 网关在 Go 未承接的路由上直接调用；要处理取消与协议 v2 反向调用 | 留 Node |
| provider descriptor 收集与 `replaceOrigin('plugin')` | 校验器与注册表都在 Node，Go 没有对等物 | 留 Node |
| pricing.quote / account.source·login·refresh·materialize | Node 业务服务同步消费 | 留 Node |
| catalog alias 求值 | 在 prepare 阶段调用宿主，结果进 Node 目录视图 | 留 Node |
| 观察队列、失败计数、status/diagnostics | 进程内运行态 | 留 Node |
| 投影推送与 ack | Node 是代次 owner，Go 只消费 | 方向保持 Node → Go |
| 权限指纹算法 | `JSON.stringify(manifest.permissions)` 依赖 JS 属性插入序与不转义 HTML；Go 的 map 序列化会排序，复刻不完整会让存量 `permissionsAcceptedFingerprint` 全部失效 | **存储值由 install 侧计算**（固定字段序 + `SetEscapeHTML(false)` + 跨语言对拍，plugin-artifact 83733557 已用 17+10 fixture 与 Node 真实实现比对）；**启停只比较存储值，不重算** |
| `configSchema` 校验与默认值（Ajv `useDefaults`） | Go 没有等价实现；重写会改变默认值语义与报错文案 | 留 Node；Go 只要求配置是 JSON 对象 |
| `manifest` 全量校验 | 同上，属于插件合同 | 留 Node |

这张表也解释了为什么 B/B+ 的「候选」必须由 Node 生成：**候选里包含的都是 JS 生态的语义**，
Go 的职责是「这份候选能不能成为唯一事实」——CAS、结构不变量、单写者、审计、revision。

## 8. 风险清单

| 编号 | 风险 | 触发条件 | 缓解 |
| --- | --- | --- | --- |
| R1 | 双写导致 revision 回退 | Node 在 Go 失败后本地兜底写 | 开关打开后 Node 写入直接报错；集成测试构造 Go 503 断言本地未写 |
| R2 | 未知字段丢失 | Go 用 `ControlState` 结构体重序列化 | 候选按原始字节落盘 + round-trip 断言 |
| R3 | 权限门失效 | 指纹复刻不完整（字段序/HTML 转义） | 固定字段序 + `SetEscapeHTML(false)` + 跨语言对拍；启停只比较存储值 |
| R4 | 维护期并发写 | Go 绕过 gate/lease | P0 实现同一套 gate + SHARED 租约；维护期提交返回 `account_maintenance_in_progress` |
| R5 | 读失败被当成空集合 | 任意一次 `desiredPlugins()` 抛错 → `[]` → 恢复路径停宿主 | P1 保持本地读；若未来改远程读，先改成 `{ok,plugins}` 并让 recover 在 `ok=false` 时保持现状 |
| R6 | 发布锁死锁（B+） | Go 在 prepare 后崩溃 | ticket TTL 30s；Node 到期 dispose 并释放；Go 启动时清理自己的未完成操作 |
| R7 | 代次 churn | A 方案的 prepare/丢弃循环 | 不采用 A；B+ 的锁让失败操作不产生新代次 |
| R8 | CLI/demo 契约漂移 | P2 删除 `control.enable` | 保留同签名薄壳或同步改 demo；错误码映射表进测试 |
| R9 | SQLite 忙 | Go 长事务 / 维护进程持锁 | `BEGIN IMMEDIATE` + busy_timeout 5000ms；事务内不做 IO、不调用宿主 |
| R10 | commit 已写入但响应丢失 | 本机 HTTP 超时 / Node 在此之前崩溃 | Node 按失败处理并丢弃候选；状态已提交，下一次 `recover()` 按 desired state 收敛。若要把窗口收窄，给 commit 加幂等键（同一 `commitId` 重试返回上次结果） |

## 附录 A：接口草图

### A.1 P1 写入端点

```http
POST /v1/management/plugins/state/commit
Authorization: Bearer <management key>
Content-Type: application/json

{
  "operation": "enable",
  "expectedRevision": 12,
  "candidate": { "schemaVersion": 1, "revision": 13, "installed": [ ... ], "instances": [ ... ] }
}
```

```jsonc
// 200
{ "ok": true, "revision": 13 }
// 409
{ "ok": false, "error": "plugin_revision_conflict", "revision": 12 }
// 400
{ "ok": false, "error": "plugin_state_invalid", "issues": [ { "code": "...", "detail": "..." } ] }
// 503
{ "ok": false, "error": "plugin_state_unavailable" }
```

### A.2 P2 操作端点与内部回调

```http
POST /v1/management/plugins/instances/{instanceId}/enable
{ "pluginId": "echo", "version": "1.0.0", "configuration": {}, "acceptPermissions": true, "expectedRevision": 12 }
→ 200 { "revision": 13, "generation": 7, "state": "active" }

POST /v0/plugins/internal/prepare      # 回环 + Go 引导密钥
{ "operation": "enable", "expectedRevision": 12, "mutation": { ... } }
→ 200 { "ticket": "...", "generation": 7, "candidate": { ... }, "contributions": [ ... ] }
→ 400 { "error": "plugin_candidate_rejected", "diagnostics": [ ... ] }
→ 409 { "error": "plugin_publish_busy" }

POST /v0/plugins/internal/activate
{ "ticket": "...", "revision": 13 }
→ 200 { "generation": 7, "state": "active" }

POST /v0/plugins/internal/discard
{ "ticket": "...", "reason": "commit_conflict" }
→ 200 { "ok": true }
```

## 附录 B：状态机（P2）

```
CLI/WebUI
   │  POST /v1/management/plugins/instances/{id}/enable
   ▼
 Go: 读状态 → 生成 mutation（不写）
   │  POST /v0/plugins/internal/prepare
   ▼
 Node: 校验配置/权限 → 候选文档 → 宿主 prepare
   │  返回 ticket + generation + candidate
   ▼
 Go: CAS 提交 candidate（revision+1）
   ├─ 失败 → Node /internal/discard → 返回 409/503（状态不变，旧代次继续）
   └─ 成功 → Node /internal/activate → 200 { revision, generation, state }
```

不变量：**任何时刻只有一个 ticket 持有发布锁；状态写入永远发生在 prepare 成功之后、activate 之前。**