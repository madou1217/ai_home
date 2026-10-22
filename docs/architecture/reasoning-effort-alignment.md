# 推理强度（effort）：一套词汇、一条对齐规则、一个真相源

> 状态：**已实现**（2026-10-22）
> 相关提交：`21ea19a9`（消息显示 model + effort、倒排对齐）、`4a983517`（测试与断链修复）

## 1. 问题：同一个概念，三套词汇，各自收敛

客户端与上游模型各有自己的强度档位语言：

| 来源 | 档位词汇 |
|---|---|
| Claude Code（Anthropic Messages 客户端） | `low` `medium` `high` `xhigh` `max` |
| Codex CLI（OpenAI Responses 客户端） | `none` `minimal` `low` `medium` `high` `xhigh` `max` `ultra` |
| Kimi（k3） | `low` `high` `max` |
| Codex Lite 档（gpt-6-luna 等） | `low` `medium` |
| models.dev 目录里的其他模型 | `[medium, max]`、`[high, max]`、`[low, medium, high, xhigh]` 等各种组合 |

在引入对齐之前，**每个上游适配器各自就地夹取**，而且方向不一致：

- `internal/adapters/claude/messages/request_encoder.go` 的 `anthropicEffort`：`minimal → low`、`xhigh/ultra → max`
- `internal/adapters/codex/responses/reasoning_projection.go` 的 `projectReasoningEffort`：显式值原样透传，不做收敛
- `internal/transport/http/kimirelay/provider.go` 的 `marshalThinking`：零校验，`minimal`/`ultra` 直接发给上游

结果是「用户要的强度到底落实成了什么」没人说得清，而且同一件事在不同路径上得到不同答案（`xhigh` 在 Claude 路径变 `max`，在 Kimi 路径原样出去撞 400）。

## 2. 规则：倒排（顶端对齐）

**唯一一条规则**，实现在 `core/inference/reasoning_effort_ladder.go` 的 `AlignReasoningEffort`，
Node 侧同构实现在 `lib/server/chat-runtime/reasoning-effort-ladder.js`：

两侧各自按强度升序排列，**顶端对齐**后逐级向下配对；目标阶梯先耗尽时，更弱的请求全部收敛到目标最低档。

```
目标 A: 1,2,3        发送方 B: 5,4,3,2,1
  5→3  4→2  3→1  2→1  1→1

目标 A: 1,2,3        发送方 B: 2,1
  2→3  1→2            （A 的最低档不会被选中）
```

三个性质是这条规则存在的理由，都有单测守住：

- **单调**：更强的请求永远不会被映射成更弱的档位；
- **不轮空**：发送方档位不少于目标时，目标每一档都会被某个请求命中；
- **稳定**：已对齐的值再对齐不变（幂等）。

**映射只由两侧阶梯的位置决定，与档位名是否恰好同名无关。** 发送方的 `1` 落在目标第二档时就是第二档，不因为目标也有个叫 `1` 的档位而留在原地——这条是「窄发送方整体上移」的语义来源。

`clientLadder` 传空表示发送方档位未知：此时按目标阶梯自身对齐（受支持的档位原样通过、其余就近向上收敛），**不做整体位移**。发送方档位未知时做位移等于凭空假设它还有更高档位，会把一个合法且受支持的请求降档。

## 3. 真相源：档位来自权威目录，绝不猜

对齐的输入是「目标模型支持哪些档位」，这份数据来自 models.dev 快照的 `reasoning_options`：

- 生成器 `internal/tools/modelsdevmodalities/main.go` 提取 `type=effort` 的档位并按 Canonical 全序排序；
  目录里出现未登记的档位时**失败关闭**（静默丢弃会把「模型支持该档位」变成「模型不支持」）。
- 快照 `internal/adapters/modelmetadata/modelsdev/modalities.json`：864 条中 249 条带档位。
- 查询 `modelsdev.Index.LookupReasoningEfforts`：复用模态那套三层解析（命名空间精确命中 → 基座模型回退 → 裁尾段），
  使 `…-high` / `…-thinking` 这类 provider 自定义后缀落到基座模型的档位表上。

**刻意不提供家族兜底**（与模态相反）：猜错模态只是多剥或少剥一张图，猜错强度却会把用户明确要求的 `high` 静默降档。
查不到就如实未命中，由调用方决定是去掉强度意图还是拒绝。

`core/inference.CanonicalEffortOrder()` 是 Canonical 全序的唯一声明；生成器不能 import `core`，
因此显式重复了一份，两处一致性由 `TestCanonicalOrderMatchesInferencePackage` 守住。

## 4. 落点

| 层 | 位置 | 行为 |
|---|---|---|
| Go 上游派发前 | `application/effortalign`，由 claude/codex 适配器在 `encodeRequest` 前调用 | 按目标模型阶梯对齐；查不到档位则去掉整个 reasoning 意图 |
| Node harness 目录 | `chat-harness-gateway.js` `resolveTurnSettings` | **取代**原先的 422 拒绝：按规则对齐 |
| Node codex 原生目录 | `codex-native-model-catalog.js` `selectTurnSettings` | 同上；只有无法定序的档位才继续失败关闭 |
| 按轮强度 | `core/inference` 的 `AlignTurnEfforts` | Anthropic 中途 system 消息携带的按轮档位与请求级**同档**，否则一轮内会先 high 后 max |

`application/effortalign.Aligner` 是「什么都不做」的默认实现（`ladders` 为 nil 时原样返回请求），
便于组合根按开关接线，也保证未接线时行为与引入前一致。

## 5. 消息显示 model + effort

每条 message 的 timeline detail 增加可选 `effort`，WebUI 在模型名后渲染，**没有就留空**：

- 写入：`codex-session-event-bridge.js` 的 `withMessageTurnIdentity` 把 `providerEventContext` 里的生效档位
  随消息 detail 落下；`native-session-event-bridge.js` 只记录引擎真的报上来的档位。
- 契约：`timeline-detail-contract.js` / `timeline-details.ts` / `timeline-detail-parser.ts` / `ChatMessage`。
- 渲染：`MessageMetadata.tsx` + `.messageEffort`。

**原生 CLI 会话（kimi/claude CLI 等）的 effort 会留空**：这些 CLI 没有接收 effort 的参数通道，
写「策略里的意图」会让界面撒谎。这是「没有 effort 就空着」的如实呈现，不是没接上。

### 踩过的坑：历史导入会抹掉 effort

`timeline-import-repository.js` 的 `preserveMeasuredMetadata` 用一个白名单决定「历史导入时从实时行继承什么」，
原先只有 `inherited` / `model` / `metrics`。历史导入只带原生记录里有的东西，**它不知道本轮跑的是哪一档强度**，
于是导入覆盖时把刚跑完那轮的 `effort` 抹掉了（2026-10-22 实测：第一轮的 `max` 就是这样丢的）。

**新增「只有实时轮次才知道的事实」字段时，必须同步加进这个白名单。** 回归测试见
`test/chat-runtime.timeline-import.test.js` 的 `a history re-import keeps the live message model and effort`。

## 6. 相关测试

| 文件 | 锁住什么 |
|---|---|
| `core/inference/reasoning_effort_ladder_test.go` | 两条原始例子、单调/幂等/不轮空、三种失败语义、稀疏阶梯 |
| `application/effortalign/aligner_test.go` | 客户端阶梯 → 模型阶梯、按名匹配的坑、未知模型不动请求、按轮强度同步对齐 |
| `test/reasoning-effort-ladder.test.js` | Node 侧同构行为（与 Go 对齐） |
| `internal/tools/modelsdevmodalities/main_test.go` | 阶梯顺序、未知档位失败关闭、Canonical 全序两处一致 |
| `internal/adapters/modelmetadata/modelsdev/index_test.go` | 三层解析（含 `…-high` 后缀回退）、未知模型不猜 |
| `test/codex-native-model-catalog.test.js` | 越阶档位改为对齐而非 422；无法定序才拒绝 |
| `test/chat-harness-gateway.test.js` | harness 目录的 `supported_reasoning_levels` |
| `test/chat-runtime.timeline-import.test.js` | 历史导入保留 model/effort |
| `test/codex-session-driver.test.js` | 消息 detail 带上生效 effort |
