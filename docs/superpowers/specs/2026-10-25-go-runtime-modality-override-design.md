# Go Runtime Model Modality Override

日期：2026-10-25
状态：设计已确认，等待实现计划

## 目标

补齐 Go 与 Node 的一个已确认运行时差异：Node 会把 OAuth/API `/models` 探测返回的模型能力覆盖写入进程内的 `provider|model` 模态索引，Go 目前只使用启动时嵌入的 models.dev 快照。两端因此可能对同一个 Provider 和模型给出不同的 `vision` / `image_out` 判断。

本次只闭合已经有可靠证据的模态能力链路：Kimi `/models` 返回的 `supports_image_in` 与 `supports_video_in`。覆盖数据只在当前 Go 进程内生效，不进入 SQLite、账号模型关系、凭据或对外持久化协议。未被探测覆盖的模型继续使用现有静态快照和保守家族推断。

## 非目标

- 不新增 `AIH_*` 环境变量、server config 或 WebUI 设置。
- 不修改 `ProviderModelDiscoverer.DiscoverModels() ([]string, error)` 的现有账号模型合同。
- 不把 `display_name`、`context_length`、reasoning 标记、上游错误正文或任何凭据带入 Go 核心。
- 不把 Kimi descriptor 写入 SQLite，不改变账号模型刷新、路由快照或人工模型策略。
- 不为没有可靠 descriptor 合同的 Provider 猜测模态。
- 不扩展 Go 的 context window、定价或推理强度 runtime override；这些能力需要独立合同。

## 设计

### 1. 低敏 descriptor 合同

在 `application/modelmetadata` 增加只表达能力的值对象和注册端口：

- `ModelDescriptor`：规范 `ModelID` 与 `Modalities`；
- `ModelDescriptorRegistrar`：按 Provider 原子替换当前一批 descriptor；
- descriptor 输入必须经过 `runtimecore.NewModelID` 与 `modelmetadata.NewModalities` 校验，并复制切片，调用方不能在发布后改变索引内容。

descriptor 不包含账号引用。相同 Provider 的多个账号探测到的能力集合在进程内合并为该 Provider 的 latest-known-good 能力快照；空结果或解析失败不清空旧覆盖。

### 2. 不可变覆盖快照

`internal/adapters/modelmetadata/modelsdev.Index` 继续作为 `modelmetadata.Reader` 和 `ReasoningLadderReader` 的实现。它增加一个 copy-on-write 的 modality override snapshot：

- key 是规范化的 `provider|model`；模型 ID 使用与静态索引相同的大小写和版本分隔符规则；
- 读取顺序是 runtime override → models.dev provider namespace lookup → base model lookup → 现有家族推断；
- 每次发布构造完整的新 map，再通过原子指针整体替换；读取不持锁、不修改旧 map；
- descriptor replacement 是 Provider 级整体替换，不是逐项删除。新快照缺少旧模型时，旧覆盖随该 Provider 代次一起消失，下一次查询回退静态数据；
- 发布无效 descriptor 时整体拒绝并保持旧快照，避免部分能力污染；
- `reset` 仅供测试使用，生产没有清空入口。

这样保持 Go 现有 immutable catalog 思路，同时把 runtime override 限定在能力索引，不影响 `AtomicCatalog` 的模型路由快照。

### 3. Kimi 探测接线

扩展 `internal/adapters/openaicompat/modelcatalog` 的 Kimi 变体：

- 保留现有 `DiscoverModels()` 返回模型 ID，保证账号模型刷新和持久化行为不变；
- 在解析同一份标准 `/models` JSON 时，额外读取已确认的布尔字段 `supports_image_in`、`supports_video_in`；
- 输出 descriptor 的输入模态从 `text` 开始，按布尔字段追加 `image` / `video`，输出模态固定为 `text`；
- 对每个有效模型 ID 都构造 descriptor；缺失、类型错误或非 `true` 的能力字段按 Node 的 `=== true` 语义视为 false，不把原始字段带入 descriptor；
- 仅当 descriptor 集合非空且全部通过低敏校验时，调用组合根注入的 registrar 做 Kimi Provider 级替换；
- HTTP 失败、空目录、解析失败保持现有 last-known-good 账号模型语义，也不清空模态覆盖。

`Source` 增加可选 descriptor sink，而不是让通用模型发现接口返回两个不同类型的结果。生产组合根创建一次 `modelsdev.Index`，在装配 Kimi source 时注入 registrar；测试注入替身可以观察发布内容而不访问网络。

### 4. 数据流

```text
Kimi GET /models
      |
      v
OpenAI model list parser -----> []string -----> account model refresh (existing path)
      |
      v
low-sensitivity descriptor validation
      |
      v
modelsdev.Index.ReplaceProviderDescriptors("kimi", descriptors)
      |
      v
atomic override snapshot
      |
      +--> /v1/models?include=modalities / capability filter
      +--> vision guard
```

账号模型刷新失败不触发 descriptor replacement；一次成功响应同时更新模型 ID 和能力覆盖，避免两个探测请求产生代次错位。覆盖只属于当前进程，重启后静态快照自然接管，下一次成功探测再建立覆盖。

## 错误与安全边界

- descriptor 解析只允许白名单字段和布尔类型，禁止把原始响应正文、`message`、token 或账号信息放入值对象或日志。
- provider/model key 为空、模型 ID 非法、模态为空或重复时，整批 replacement 失败关闭并保留上一代。
- 版本分隔符归一化、Provider namespace 回退和图像生成补全继续复用 `Index` 现有逻辑；runtime override 只改变首选数据源。
- Kimi 的 `video` 能力会被保留在 descriptor 中，但现有 `visionguard` 仍只按 `image` 判断；这次不改变跨协议附件处理合同。
- 多账号并发刷新通过原子快照发布，不要求调用方串行；后一个成功代次整体替换前一个代次。

## 验证

实现必须先写失败测试，再写生产代码，至少覆盖：

1. descriptor 值对象拒绝空/非法/重复模态，并复制输入切片；
2. `Index` 的 provider+model override 优先于静态快照；未覆盖 key 回退静态快照；
3. Provider 级替换会移除上一代缺失模型，发布失败保持上一代；
4. 读取副本和并发 replacement 不会暴露可变 map 或数据竞争；
5. Kimi JSON 同时解析模型 ID 和 `supports_image_in` / `supports_video_in`，非法 descriptor 不影响 ID 列表；
6. Kimi source 只在成功且有效 descriptor 集合下调用 registrar，HTTP/空响应/解析失败不清覆盖；
7. `/v1/models` 能力过滤与 vision guard 读取 runtime override，未覆盖模型仍保持现有静态/推断行为。

完成前运行：

- `go test ./...`；
- `node --test test/*.test.js`；
- `git diff --check`；
- 若修改 `web/`，额外运行仓库要求的 Web build、改动文件 ESLint 和相关单测；本设计预计不修改 Web。

## 设计模式评审

- **Value Object**：`ModelDescriptor` 与 `Modalities` 在应用边界校验并复制低敏能力数据。
- **Copy-on-write immutable snapshot**：`modelsdev.Index` 用完整 replacement 保证并发读取稳定，避免共享可变 Map。
- **Adapter + optional sink**：OpenAI-compatible Kimi source 保持现有模型 ID 端口，通过可选 registrar 发布额外能力，避免污染账号模型合同。
- **KISS/YAGNI**：只支持已证实的 Kimi modality 字段，不提前设计 context、pricing、reasoning 或持久化 descriptor。
