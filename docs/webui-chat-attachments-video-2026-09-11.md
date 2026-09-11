# WebUI chat/work 附件：大文本放行与 mp4 视频支持

## 背景与目标

chat/work 输入框把图片以外的附件一律按"文本文件 1 MB"拒绝（如 1.4 MB 的 HTML 导出文件），且没有任何视频通道。本次目标：

- 文本附件上限 1 MB → 16 MB，内容全量交付给模型，不做截断、摘要等任何有损前置处理；
- 新增 mp4/m4v/mov/webm 视频附件（单个 ≤ 100 MB），并在所有能看图的 provider 上可分析；
- 不新增内容理解链路以外的依赖与存储系统。

## 方案

**大文本不需要前置处理。** work 模式本就只注入文件路径（原生 CLI 自行分页读取），天然无损；chat 模式把全文内联进提示词（harness 无文件工具，内联是唯一通道），超长上下文由原生 harness 的 auto-compaction/溢出恢复处理，AIH 不预先裁切内容。

**视频需要前置处理，但处理的是"抽帧"而非"内容"。** chat/work 的 harness（codex app-server）输入只有文本 + 本地图片两类，视频字节无法直传任何 provider。因此上传时服务端执行一次预处理（`lib/server/chat-video-attachments.js`）：

1. 视频按二进制落盘到既有附件根目录（0600，安全文件名）；
2. ffprobe 读取时长/分辨率，ffmpeg 抽取最多 8 张等间隔关键帧（宽度 ≤768，JPEG）写入 `<视频>.frames/`；
3. 发送时关键帧并入既有图片通道（codex `localImage` / legacy `imagePaths`），提示词附加视频块：原始文件路径 + 元数据 + 帧说明。模型由此"看到"视频内容；work 模式提示模型可用 ffmpeg 自行抽更多帧或音轨，chat 模式（无工具）则只陈述帧已随附。
4. ffmpeg 缺失或抽帧失败时优雅降级：视频路径仍注入提示词，帧为空并如实说明。ffmpeg 定位顺序：`AIH_FFMPEG`/`AIH_FFPROBE` 环境变量 → 常见绝对路径（/opt/homebrew、/usr/local、/usr/bin，覆盖 launchd 极简 PATH）→ PATH 查找。

legacy 面（非 codex 的 work 会话）没有独立视频车道：视频随 base64 图片车道上行，服务端按 dataUrl MIME 分流后走同一持久化+抽帧管线。Native Work 得到原视频路径与关键帧；API proxy 只得到原始图片和抽取后的 JPEG 帧，原始 `data:video/*` 字节不会伪装成 `image_url` 上送。

附件批次采用“先完整校验、再物化、失败统一清理”的事务边界。base64 在分配 `Buffer` 前先按编码长度拒绝超过 128 MB 总预算的单项；图片、文档、视频与帧目录使用临时文件/目录原子发布。账号校验、Slash 校验、CLI readiness、native 同步/异步失败、API proxy 建链/流失败时均清理本轮物化文件；SSE 客户端已断开时，后台 native run 的失败结算仍执行清理。

## 限额（contracts/chat-attachments.json，前后端唯一事实来源）

| 项 | 旧值 | 新值 |
| --- | --- | --- |
| maxDocumentBytes | 1 MB | 16 MB |
| maxVideoBytes | —（不支持） | 100 MB |
| maxTotalBytes | 20 MB | 128 MB |
| maxFiles / maxImageBytes | 8 / 10 MB | 不变 |

上传端点 body 上限：canonical `/attachments` 与 legacy `/v0/webui/chat` 均 32 MB → 192 MB（容纳 base64 膨胀后的视频）。所有报错文案与 UI 提示从合同派生，不再硬编码 "1 MB"/"20 MB"。

## 前后端分类一致性

`web/src/components/chat/attachment-files.ts` 的 `resolveChatAttachmentKind` 与后端 `attachment-service.js` 的 `normalizeUploads` 使用同一优先级：图片 MIME → 视频 MIME → 文本 MIME/扩展名 → 视频扩展名兜底（仅当 MIME 缺失或为 application/octet-stream）。避免"前端当文档、后端当视频"的分叉。

## 实机链路追查出的三个隐藏卡口（同日二轮修复）

第一轮上线后实机测试（agy 会话 + claude-opus-4-6-thinking）逐层暴露出三个既有卡口：

1. **harness 模型目录把未知模型当 text-only**：`resolveEntry('claude-opus-4-6-thinking')` 在固定目录里查无此 id（provider 自造 `-thinking`/`-high`/`-tiered` 等后缀变体），`input_modalities` 默认 `['text']`，codex harness 直接拦掉图片/帧附件（模型报"系统禁用了图像输入能力"）。修复：`models-dev-metadata.js` 的 `inferBaseModelIds` 追加"逐步裁尾段"低优先级候选（`…-thinking` → `anthropic/claude-opus-4-6`；目录真实存在的 `-thinking` 本体如 `kimi-k2-thinking` 永远先命中精确 id）；`chat-harness-model-metadata.js` 对目录查无此模型的条目 fail-open 为 `['text','image']`（目录明确 text-only 的仍保持 text-only，如 gpt-oss-120b）。harness 常驻运行时按 `runtimeConfigRevision` 重建：v3 → **v4**，否则旧 model-catalog 继续生效。
2. **codex app-server turn/start 输入硬上限 1,048,576 字符**（`codex_app_server_rpc_error`）：chat 模式全文内联 1.44MB 文档直接触发。实测（scripts/probe-inject-items-limit.js 对存活 harness 直发 JSON-RPC）`thread/inject_items` 无此上限（1.5M 字符单条 ACCEPTED）且注入条目不属任何 turn、不进 thread/read 的 turns，因此不会在 AIH 时间线产生重复气泡。修复：`chat-harness-policy.js` 新增 `needsDocumentInjection` / `injectableDocumentItems`（900K 字符分段，拼接逐字节无损）/ `oversizedTurnPrompt`；`codex-session-driver.js` 在 turn/start 前注入分段、turn 输入只带用户正文+指路语，同一 run 幂等（重试不重复注入）。work 模式只注入路径，天然无此问题。
3. **网关 /v1 请求体默认上限 10MB → 413**：注入历史后 harness 每次请求携带完整历史。`server.js` 的 `DEFAULT_MAX_REQUEST_BODY_BYTES` 提至 32MB（覆盖 16MB 附件 + 帧 base64 + 历史余量）。

另注：网关侧 `vision-image-guard` 共用 `models-dev-metadata` 的 resolveEntry，修复 1 同时恢复了它对后缀变体的视觉判定（`modelSupportsVision('claude-opus-4-6-thinking', agy)` → true）。

## 实机端到端证据（agy + gemini-3.1-pro-high / claude-opus-4-6-thinking）

- claude-opus-4-6-thinking：test.html 全文注入后正确答出标题「极验 · 设备信息，清晰呈现」及功能模块（IMEI 查询/AI 解读/套餐购买）。
- gemini-3.1-pro-high（目录查无此 id、fail-open 放行图片）：同一回合同时答对 test.html 主题与视频内容——"折叠屏智能手机（折叠屏 iPhone 概念渲染）、铰链结构、展开大屏、iOS 界面"，与帧目检一致。
- 期间的 429/503 为 agy 上游账号限流与模型容量抖动，与链路无关。
- codex 会话 gpt-6-astra（原生 harness 路径）：视频关键帧答对"可折叠屏智能手机，以及拿着并展开手机的双手"。

## 验证（2026-09-11）

- 全量 `npm test`：6621 项，通过 6598、失败 0、跳过 23（含本轮新增的视频/注入/后缀解析及回滚回归用例）。
- `cd web && npm run build`（Umi 全量 TS 编译）成功；改动文件 ESLint 零告警；`bun test` 相关用例通过。
- 真实文件冒烟：`/Users/model/Downloads/test.html`（1,508,814 字节）通过文档校验且内容逐字节一致；`/Users/model/Downloads/large.mp4`（450 KB，3s/840x568）真实 ffmpeg 抽出 3 张关键帧，帧图像经目检清晰有效。
- 本机 9527 服务重启加载当前仓库后，Playwright 在指定 Kimi 会话同时选择上述 HTML 与 MP4：两张附件卡均保留、视频缩略图可见、移除按钮独立，未发送上游请求；新标签页控制台 0 error / 0 warning。截图：`output/playwright/kimi-chat-html-mp4-attachments-2026-09-12.png`（运行证据，不提交）。
- 探针证据（scripts/probe-inject-items-limit.js 对存活 harness 直发 JSON-RPC）：turn/start 输入 >1,048,576 字符报 `codex_app_server_rpc_error`；thread/inject_items 单条 1.5M 字符与 3×500K 均 ACCEPTED；thread/read 的 turns 不含注入条目（不产生重复气泡）。

## 设计审查

| 文件/模块 | 模式 | 原因 | 验证证据 |
| --- | --- | --- | --- |
| contracts/chat-attachments.json | 共享策略（单一事实来源） | 限额/类型/扩展名映射一处定义，前后端同步派生 | 合同断言测试、前端分类测试 |
| lib/server/chat-video-attachments.js | 适配器 + 策略 | 把"视频"适配成 harness 已有的图片通道；抽帧依赖（ffmpeg）可注入、可降级 | 假 execFileAsync 的成功/失败两路单测、真实 ffmpeg 冒烟 |
| chat-harness-policy.js `sessionAttachmentTurnInput` | 组合根 | live turn（codex-session-driver）与历史重建（chat-history-prefix）共用同一附件分流，避免两处漂移 | 双模式单测、driver/branch 既有套件 |
| attachment-service.js | 模板方法（prepareVideo 可注入） | 上传期完成持久化+抽帧，测试可替换耗时外部进程 | chat-runtime-attachments 视频用例 |
| chat-attachment-persistence.js / webui-chat-routes.js（legacy） | 工作单元 + 适配器 | 一个物化批次共享回滚边界；视频转换成 native 路径/帧或 API proxy JPEG data URL | 混合批次、readiness、detached 失败与 API proxy 回归测试 |
| chat-attachment-api-proxy.js | Adapter | 把物化附件统一投影为 API proxy 可理解的图片列表，并排除原始视频字节 | 原始图片 + 视频帧顺序及无 `data:video/*` 断言 |
| models-dev-metadata.js `inferBaseModelIds` | 链式回退（精确 → 逐段裁尾） | provider 后缀变体继承基座模型模态，精确 id 永远优先 | models-dev-metadata 后缀变体用例 |
| chat-harness-model-metadata.js | 放行策略（未知 fail-open、已知从严） | 未知模型不拦用户显式附件；目录明确 text-only 的保持 text-only | chat-harness-model-metadata 三态用例 |
| chat-harness-policy.js 注入三件套 + driver 幂等 | 适配器（传输上限绕行） | turn/start 1M 字符硬上限改走 inject_items 历史通道，分段无损、不产生 UI 重复气泡 | driver 超大文档用例 + 探针实测 |

SOLID：视频持久化/探测/抽帧/提示词各自为独立函数，注入策略按工作区模式分叉。DRY：分类逻辑前后端同构并共享合同；帧复用既有图片链路，未新增协议。KISS/YAGNI：不做音轨转写、不做服务端视频转码、不引入 canonical 协议 video part（harness 无法承载）。
