# 请求级账号分配与容量退避

适用范围：Node 网关的 HTTP 账号选择器与 Codex Responses WebSocket。Go Core 已同步「容量/限流冷却不得绕过」；Go 的选号仍是原有剩余额度加权策略，尚无下述负载权重与 WS 每轮重新选号。不能把 Node 的验证宣称为 Go 完整对齐。

## 分配顺序

1. 先排除被停用、凭据失效、配额耗尽、模型不支持/禁用，以及当前模型仍处于容量/限流冷却的账号。
2. 会话键命中时优先沿用上次账号，30 分钟滑动 TTL。账号剩余不高于 5% 且有更充足的候选，或请求压力比最空闲候选高出 2 时，释放该偏好并从其它账号选。5% 和 2 是本地调度参数，不是上游限额。
3. 插件/明确偏好遵守同样的健康与负载约束。CLI 的默认账号不再自动成为整个网关池的固定首选；显式单账号请求保持原有入口语义。
4. 默认 random 策略按 `weight = remaining / (1 + inFlight + starts10s / 10)^2` 抽取。remaining 在 1–100 之间，未知取中性权重 50，绝不把未知说成耗尽。显式 round-robin 仍按游标轮转。
5. HTTP 在 attempt 进入/退出计数；WS 在 response.create/终态/断开计数，换号建立连接前先预留请求负载。空闲 socket、窗口和 detached 会话不算推理负载。

因此 session 1/2/3 不保证一人一号，4/5/6/7 也不分配固定槽位：每次真正需要推理时重新评估，再考虑软亲和。没有失败、没有明显压力差的老会话保持原账号，保护缓存与连续性。

## 百分比的边界

假设有效 remaining 分别为 10/80/15，三个账号均空闲且没有会话亲和，首选概率约为 9.5%/76.2%/14.3%。这只是本地保守的剩余比例权重，不表示实际可用请求容量的比例。多个适用窗口取最小剩余比例（现有 usage 投影）；不能用 Plus 五小时 80% 推导它比 Pro 周额度 15% 容量大。

当前官方 Codex 文档说明 Pro 没有五小时限制、周限额可能适用，任务成本还取决于模型和任务。现有快照没有可比较的「绝对剩余 tokens」或统一套餐容量，故不硬编码 Pro/Max 倍数、不伪造 QPS/TPS 上限。未来绝对容量或可靠消费速率的估计必须携带来源与窗口，才能替代比例启发式。

## 容量错误与冷却

- HTTP、SSE、WS 的结构化错误共用策略。`Selected model is at capacity...`、`model_at_capacity`、`server_is_overloaded` 都进入模型容量分支，未向客户端交付输出时可以换账号重放。
- 安全拒绝、参数错误不换号；已经输出正文/工具事件后不重放，避免重复工具执行。
- 容量错误只冷却 `(account, model)`，其它模型仍可服务。有 Retry-After 时遵守上游提示；无提示时从 60 秒开始，连续失败为 120/240/480/600 秒，上限 10 分钟，成功清零。失败记忆窗口为 20 分钟。
- 容量/限流/明确配额及模型权限冷却不能被「全池均冷却」或加密推理亲和逃生阀绕过。网络类软冷却仍保留旧的末路尝试。
- Node 容量冷却到期后，同一账号同一模型只允许一个在途恢复请求；并发请求等它结束或走其它号。失败重新冷却，成功清除连击。HTTP 与 WS 共用 accountActivity。
- WS 每轮在可安全展开公开上下文时重新评估账号。换号时展开 previous_response_id 并保留公开历史；无法安全重建上下文时，只能保留仍健康的原账号，原账号不可用则明确返回 replay_context_unavailable。
- 换号与不可恢复原因默认打印低敏日志，不依赖 debug。没有把每条正常请求正文写进日志。
- Responses Lite 的 `additional_tools` 是可携带的工具定义，换号时保留原位置、namespace、schema 和已完成工具结果；不把工具 schema 内的 `file_id` 属性名当作已上传文件引用。真实输入里的账号绑定文件引用、未知历史类型和不成对的工具结果仍拒绝重放。
- Node WS 同时接收/透传原生 `session-id`（Mac Go 中继的写法）与兼容 `session_id`，保留 `thread-id`。换号日志为单行 JSON，携带时间、请求/会话/线程标识；失败细分为不支持的历史项、缺少 previous_response、未完成工具结果、已输出等，不记录正文或工具定义。

容量错误可能是上游共享模型资源紧张，不一定由账号并发引起。负载分流与退避能减少重复冲击，不能承诺任意请求量都成功；现有队列/并发闸门仍有边界。本轮没有新增伪造的每号 QPS/TPS 硬限制，也没有降低模型、推理强度或输出质量来掩盖失败。

## Codex 额度耗尽与代理消息恢复

- `usage_limit_reached` / `insufficient_quota` / `quota_exceeded` 是明确额度拒绝，默认按 Codex 共享套餐额度阻塞账号，而不是按某一个模型短时限流。上游明确标记 `scope` / `limit_scope = model` 时仍只冷却该模型；`rate_limit_exceeded` 保持普通模型级限流。没有足够信息推断更细的额度桶时采用账号级保守隔离，不通过降级模型继续碰撞同一额度池。
- `routingBlock` 中保存额度原因、观察时间和 `until`，沿现有账号运行态事件链持久化。恢复时间取结构化 `resets_at` / `resets_in_seconds` / Retry-After 中较晚的有效提示；无提示按现有 5 分钟复核，不猜终端日期的时区，也不套 24 小时封锁。冷却不能被会话亲和或全池兜底绕过。
- 到期允许一个账号级恢复请求（HTTP / Node WS 共用 accountActivity）；旧池快照的 `blocked_by_runtime_status` 不得盖过已重算的运行态。成功请求清除已过期额度块；到期前的其它在途请求即使成功，也不能撤销该块。更新且可信、额度为正的用量快照仍可提前恢复。
- 握手阶段的 HTTP 429 与已连接后的 WS 错误走同一个记账入口，保留 Retry-After，不再只对自定义规则执行握手换号。全池额度耗尽的 HTTP 可用性响应为 429 `account_pool_usage_exhausted`，包含已知最早复核时间。
- 远程网关边界：第三方/自建 API Key 账号代表上游账号池，不等同于池内某个 OAuth 账号；透出的结构化套餐额度错误只产生本地模型级短退避（最多 60 秒），不继承某个成员的数小时账号级额度块。上游真实账号仍按其重置时刻隔离。自定义规则优先、普通 `rate_limit_exceeded` 保持原有限流语义；旧版已持久化的网关额度冷却在确认远程池恢复后通过账号恢复调度入口清理。
- `agent_message` 保留作者、接收者和全部内容。其 `content[].encrypted_content` 是代理间消息正文，不是可丢弃的 reasoning 缓存；不能只留 `Message Type...Payload:` 的文本前缀。仅对这个已验证的协议位置放行密文，真实文件引用、其它类型的密文引用和未完成工具仍拒绝跨号重放。

2026-10-26 运行证据：Mac 失败子会话 124 条历史在内存中生成 92 条可重放项（仅略去 reasoning），6 条代理消息内容逐字保留，`xhigh` 未变；另一主会话完整落盘历史包含未完成工具，仍被 `pending_tool_output` 拒绝，不以落盘全历史代替实际单次请求。取原生历史中的一条代理消息，两个不同官方账号均接受并返回 OK。隔离双 WS 链路验证第二轮额度耗尽后换号及第三轮续接、握手 429、全池耗尽、已输出后禁止重放、持久化和重置单飞；现有 Node 检查 105/105 通过。

真实官方额度故障验证：仅在隔离探针池中选择当前耗尽账号发出一次最小请求，上游真实返回 `usage_limit_reached`（2420 秒恢复提示），随后经生产模块自动换到另一官方账号，两轮 `response.completed` / OK，客户端错误数 0，结束后两号 inFlight 均为 0。未改生产账号状态、未重放用户整段任务。代理消息协议依据：[OpenAI Multi-agent](https://developers.openai.com/api/docs/guides/responses-multi-agent)。

## 依据与验证

- 官方 Codex 用量说明：https://developers.openai.com/codex/pricing/ （2026-10-26 获取）。
- 官方 API RPM/TPM 等说明：https://developers.openai.com/api/docs/guides/rate-limits （API organization/project 限额，不能直接套到订阅登录账号）。
- 本地真实 HTTP upgrade / WebSocket 双上游：容量拒绝后换号完成；次轮沿用账号；低额度触发安全展开历史并切换；终态负载归零。该冒烟不等于官方上游容量压测。
- 实际选择器 10,000 次抽样：空闲 10/80/15 约为 10%/76%/14%；80% 账号有十个在途请求时降至约 2%。
- 真实运行态方法验证：模型 A 冷却不能被 allowModelCooled 越过，模型 B 可用；无提示的连续容量失败退避为 60/120/240/480/600/600 秒。

- 官方真实上游小请求：通过当前改动的 Node WS 处理链两轮 `gpt-6.1-sol`（low，短输入），两次 response.completed，输出 OK/OK，previous_response_id 续接正常，结束后全部 inFlight=0。未进行生产容量压测。
- AWS 生效验证（2026-10-26）：经 `aih server restart` 加载已提交代码，仍使用 Node 路径、监听 9527；完整生产网关的两轮 WebSocket 小请求均 response.completed，输出 OK/OK，previous_response_id 续接正常。现有 Node 检查 105/105，通过 `go test ./...`。
- 同次生产观察中，一条 HTTP Responses 请求先收到 `server_is_overloaded`（分类 `model_capacity_unavailable`，冷却 60 秒），随后换到另一账号，同一 requestId 最终返回 200。此记录证明实际 HTTP 换号生效；WS 容量故障换号证据仍来自本地双上游验证，不将正常官方 WS 续接宣称为容量故障验证。
- 动态工具恢复补充验证（2026-10-26）：原生长会话的 116 条历史项在内存中经新版重放器处理成功，4 组工具定义完整保留，未把该长会话发往上游。隔离真实 WS 链路先由本地端点返回 capacity，再由真实官方账号接收带 `additional_tools` 的小请求并返回 OK；容量拒绝为本地注入，官方返回为真实响应。
