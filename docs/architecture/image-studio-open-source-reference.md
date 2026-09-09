# Image Studio 开源参考与实现边界

状态：已研究并映射（2026-08-23）

范围：记录 AIH Image Studio 的会话式生成/编辑工作台参考来源、源码固定点、许可证边界、当前实现映射和明确未实现项。本文不是“与某个上游产品完全等价”的声明，也不把 GPL 项目的代码复制进本仓库。

## 1. 需求边界

Image Studio 当前解决的是 AIH 已有 provider 账号上的图片工作流，而不是重新实现一套扩散模型运行时：

- 生成与编辑使用同一会话，保存提示词、模型、参数、输入资产、输出资产和失败状态。
- 一个会话包含有序修订；成功输出可以继续编辑，也可以复用历史参数重新运行。
- 会话由 URL 中的精确 `session` 标识寻址，可在多个浏览器窗口分别处理不同需求。
- 模型和控件来自当前账号的真实能力；不可调度原因需要可见，不支持的参数必须显式拒绝。
- 图片字节需要持久化到 AIH 自己的状态库，不能依赖会过期的上游 URL。

这一定义刻意排除模型安装、采样器、LoRA、节点图执行器和本地 GPU 调度。它们属于 InvokeAI / ComfyUI 的推理产品边界，不属于 AIH 账号网关的当前职责。

## 2. 固定源码与许可证

| 项目 | 固定 commit | 许可证 | 本轮用途 |
|---|---|---|---|
| [InvokeAI](https://github.com/invoke-ai/InvokeAI/tree/e431d249e09290b241c45ad340addebc1bfc7737) | `e431d249e09290b241c45ad340addebc1bfc7737` | Apache-2.0 | 主要结构参考：Gallery、Canvas Project、元数据召回 |
| [ComfyUI frontend](https://github.com/Comfy-Org/ComfyUI_frontend/tree/b1ebe660f9a3afbc0e632c71e457e2a9e1868223) | `b1ebe660f9a3afbc0e632c71e457e2a9e1868223` | GPL-3.0 | 概念参考：queue/history/result gallery 的状态分层 |
| [Fooocus](https://github.com/lllyasviel/Fooocus/tree/ae05379cc97bc4361ec8b4ec90193dab21be763f) | `ae05379cc97bc4361ec8b4ec90193dab21be763f` | GPL-3.0 | 概念参考：把 inpaint/outpaint/image prompt 收敛到低门槛工作台 |
| [Krita AI Diffusion](https://github.com/Acly/krita-ai-diffusion/tree/dda58d1c63e361207ccec085efbc34dbd32f1654) | `dda58d1c63e361207ccec085efbc34dbd32f1654` | GPL-3.0 | 概念参考：selection/region 驱动的局部编辑 |

许可证决策：InvokeAI 的 Apache-2.0 允许在满足许可证要求时复用代码，但当前实现仍只复用产品结构和数据边界；三个 GPL-3.0 项目只用于行为和信息架构研究，没有复制源码、样式或资源。

## 3. InvokeAI：主要结构参考

### 3.1 Gallery 是可复用资产库，不只是结果列表

固定证据：

- [`gallery.mdx`](https://github.com/invoke-ai/InvokeAI/blob/e431d249e09290b241c45ad340addebc1bfc7737/docs/src/content/docs/features/gallery.mdx) 把 Gallery 分成 Boards，并区分生成结果与外部上传资产。
- 同一文档的 Image Interaction 定义了下载、在新标签页打开、把图片送入 Image-to-Image / Canvas，以及从图片元数据恢复提示词或全部生成参数。
- [`useRecallAllImageMetadata.ts`](https://github.com/invoke-ai/InvokeAI/blob/e431d249e09290b241c45ad340addebc1bfc7737/invokeai/frontend/web/src/features/gallery/hooks/useRecallAllImageMetadata.ts) 将“读取元数据”和“把元数据应用到当前工作台”分开，并按当前 tab / staging 状态决定哪些字段可恢复。

AIH 映射：

- `image_studio_assets` 保存 source / mask / output 三类资产；历史结果可以下载、继续编辑或复用修订参数。
- `ImageStudioCanvas` 负责结果查看和资产动作，`ImageStudioComposer` 只负责当前输入；不把历史数据复制成另一套页面状态。
- 当前没有 Boards、标签和搜索。会话 rail 是最小可用分组，避免在没有真实管理需求前提前引入第二套组织模型。

### 3.2 Canvas Project 的关键是“完整状态快照”

固定证据：[`canvas-projects.mdx`](https://github.com/invoke-ai/InvokeAI/blob/e431d249e09290b241c45ad340addebc1bfc7737/docs/src/content/docs/features/Canvas/canvas-projects.mdx) 将图层、遮罩、参考图、生成参数和实际图片字节一起保存；加载时对已存在图片做去重，并限制并发传输。

AIH 映射：

- `image_studio_sessions.payload_json` 是会话/修订元数据快照，`image_studio_assets.content` 是同一 SQLite 数据库中的持久 BLOB。
- 修订只保存资产 ID，不在每个修订里重复 Base64；事务同时更新资产行和会话 payload。
- 上游只返回临时 URL 时，`image-studio-remote-image.js` 先做 URL/重定向/地址安全检查，再把真实字节落库。
- 当前没有 `.invk` 等导入导出格式。没有跨 AIH 实例迁移需求前不增加归档协议。

## 4. ComfyUI frontend：只借鉴 queue/history/result 的分层

固定证据：

- [`queueStore.ts`](https://github.com/Comfy-Org/ComfyUI_frontend/blob/b1ebe660f9a3afbc0e632c71e457e2a9e1868223/src/stores/queueStore.ts) 将 Running、Pending、History 和输出资产建模为不同状态，并从任务输出派生可预览结果。
- [`useResultGallery.ts`](https://github.com/Comfy-Org/ComfyUI_frontend/blob/b1ebe660f9a3afbc0e632c71e457e2a9e1868223/src/composables/queue/useResultGallery.ts) 只管理结果 gallery 的激活状态；任务获取和输出缓存由其他模块负责。

AIH 映射：

- `image-studio-store.js` 持久化 `running | succeeded | failed` 修订；Server 重启时把遗留 `running` 修订恢复为可观察的 `image_studio_run_interrupted` 失败。
- `webui-image-studio-routes.js` 负责编排一次运行，`image-generation-executor.js` 负责 provider 策略、换号和账号故障策略，UI 不复制这些服务端规则。
- `use-image-studio-assets.ts` 单独管理 Blob URL 生命周期和有限重试，workspace 只消费资产 URL。

不映射节点图、队列暂停/重排、执行预估和插件节点输出。AIH 当前一次 HTTP run 就是一条修订；在没有后台任务协议前增加“假队列”只会制造两套状态源。

## 5. Fooocus 与 Krita AI Diffusion：交互概念边界

- Fooocus 的价值是把 image prompt、inpaint、outpaint 等复杂扩散能力压缩为少量高层动作。AIH 采用相同的产品原则：按模型能力显示生成、编辑、参考图、遮罩和输出控制，而不是暴露 provider 私有字段集合。
- Krita AI Diffusion 展示了 selection / region 对局部编辑的重要性。AIH 当前只接受 PNG mask 上传；没有图层编辑器、画笔或选区引擎，因此不能宣称拥有 Krita 式局部编辑体验。

这两个项目均为 GPL-3.0；上述内容是概念结论，不是代码移植依据。

## 6. Codex 图片合同固定证据

Codex 图片策略不再经过 `/responses` 的 `image_generation` tool 请求。固定源码：

- OpenAI Codex `0.142.3` 对应 commit [`e2b60462a7321517895dd94920661599303a7539`](https://github.com/openai/codex/tree/e2b60462a7321517895dd94920661599303a7539)。
- [`ext/image-generation/src/tool.rs`](https://github.com/openai/codex/blob/e2b60462a7321517895dd94920661599303a7539/codex-rs/ext/image-generation/src/tool.rs) 固定 `gpt-image-2`，最多 5 张编辑参考图，并构造 `ImageGenerationRequest` / `ImageEditRequest`。
- [`codex-api/src/endpoint/images.rs`](https://github.com/openai/codex/blob/e2b60462a7321517895dd94920661599303a7539/codex-rs/codex-api/src/endpoint/images.rs) 直接 POST `images/generations` 与 `images/edits`。
- [`codex-api/src/images.rs`](https://github.com/openai/codex/blob/e2b60462a7321517895dd94920661599303a7539/codex-rs/codex-api/src/images.rs) 的请求字段只有 `prompt`、`background`、`model`、`n`、`quality`、`size`；编辑额外使用 `images: Vec<ImageUrl>`。
- 本机 Codex `0.149.0` 固定 commit [`758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`](https://github.com/openai/codex/tree/758ef40f50c1a458425c7cfbf1eb12cbc07af0b0)，同一图片合同仍成立。

因此 AIH 的 Codex 原生模型目录只列 `gpt-image-2`，最多 5 张参考图，支持多输出、size、quality、background；不宣称支持 mask、output format、compression 或 moderation。api-key passthrough 账号仍可暴露其上游真实支持的其他图片模型。

2026-09-09 原生 OAuth 实测发现，`chatgpt.com/backend-api/codex/images/generations` 会返回 HTTP 200 的 Brotli 压缩 JSON，但没有 `content-type` / `content-encoding`。公共 `image-generation-response.js` 必须保留二进制字节，再通过 `response-body.js` 解码，不能先转 UTF-8；网络字节和解压后 JSON 均受 `imageGenMaxResponseBytes` 限制。原生接口的 `data[].b64_json` 合同不变，该修复与 `llm-api` 的协议适配相互独立。

### 6.1 API-key 账号的图片协议策略

图片协议是账号上游的属性，与聊天用 `OPENAI_WIRE_API` 独立。账号凭证 env 的 `AIH_IMAGE_API` 未配置或为 `openai` 时使用标准 OpenAI 透传；显式 `llm-api` 选择独立适配器，未知值拒绝路由。策略不通过域名推测，也不改变 OAuth 账号路径。

`llm-api` 契约核对来源：本机 `llm_api` 仓库 commit `61efadd99ea8036b6a9090d37b200cb2263edc46`，`sdk/api/handlers/openai/openai_images_handlers.go` 的 `buildImageGenerationRequest`、`buildImageEditRequest`、`normalizeCodexImageGenerationResponse`。其专用图片模型为 `gpt-image-2`，聊天 `/models` 不保证包含该模型，所以图片目录从显式账号协议补充能力，仅计入声明该协议的账号。

- 客户端保持标准 `/v1/images/generations`、`/v1/images/edits`；JSON 和 multipart 编辑输入均进入同一规范请求，再由策略输出 JSON `images[].image_url` 与可选 `mask`。
- 适配器补充非空 `purpose`、对象 `metadata`、默认 `output_format: png`；`size` 转成整数 `width` / `height`，每边 64–4096，未指定或 `auto` 使用 1024×1024。该范围是上游请求契约，返回像素尺寸仍取决于上游实际生成结果。
- 上游根级 `b64_json` 转为规范图片结果，再由公共 renderer 返回 OpenAI `data[]` 或 AIH 图片 URL。公共传输层复用账号凭证、代理、错误诊断、响应大小限制，等待时间至少十分钟。
- 支持单图输出、最多 16 张编辑参考图、PNG mask 和 png/jpeg/webp 输出格式。显式多输出、质量、背景、压缩和审核控制会在上游请求前拒绝，不静默丢弃。

实现边界：`image-generation-api-profiles.js` 是策略/模型/能力声明源，`image-generation-strategy-registry.js` 按账号选择，`image-generation-llm-api.js` 只转换协议，`image-generation-api-transport.js` 只处理公共传输。

## 7. 当前实现映射

| AIH 模块 | 职责 | 参考来源 |
|---|---|---|
| `lib/server/image-studio-model-catalog.js` | 合并原生合同、发现模型、账号可用性和不可用原因 | InvokeAI 的能力驱动 UI；不复制其模型运行时 |
| `lib/server/image-studio-store.js` | 会话、修订、资产元数据与 BLOB 的事务持久化 | Canvas Project 的完整状态快照思想 |
| `lib/server/webui-image-studio-routes.js` | 会话 CRUD、运行编排、输出物化和错误落盘 | ComfyUI queue/history/result 职责分离 |
| `lib/server/image-generation-executor.js` | 策略选择、能力校验、账号换号、故障策略 | AIH 既有 gateway 架构，不来自外部项目 |
| `web/src/features/image-studio/ImageStudioWorkspace.tsx` | 精确 session 寻址、轮询同步、新窗口、页面状态 | InvokeAI project/workspace 信息架构 |
| `ImageStudioSessionRail` / `RevisionStrip` / `Canvas` / `Composer` | 会话、历史、结果、输入四个受控渲染边界 | Gallery + result gallery 的职责拆分 |

## 8. 明确未实现项与进入条件

| 未实现项 | 当前决策 | 进入条件 |
|---|---|---|
| Boards、标签、搜索、收藏 | 暂不实现 | 会话数量和检索需求出现真实规模证据 |
| 画笔、图层、选区、mask 编辑器 | 暂不实现 | 至少一个可调度 provider 稳定支持 mask，且产品确认需要浏览器内局部绘制 |
| 后台队列、暂停、取消、重排 | 暂不实现 | Server 先拥有可恢复的异步 job 协议与取消语义 |
| 节点图、LoRA、采样器、本地模型管理 | 不属于当前范围 | 独立推理产品立项，不扩张 AIH 网关职责 |
| 会话归档导入/导出 | 暂不实现 | 出现跨主机迁移或共享会话的明确需求 |

该边界遵循 KISS/YAGNI：先保证真实账号、真实模型合同、持久会话和可追踪失败，再按实际使用数据扩展组织与编辑能力。
