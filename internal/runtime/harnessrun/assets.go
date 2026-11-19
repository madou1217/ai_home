package harnessrun

import _ "embed"

// 这两个资产是投影的一部分：pi 的 TUI 扩展与 dsh 的模型目录热更新插件必须
// 与 Node 的 lib/harness 源文件逐字一致，否则运行中的 harness 会用不同语义
// 改写 models.json / cordis.patch.yml（写放大或模型目录漂移）。

//go:embed assets/pi-extension.ts
var piExtensionSource string

//go:embed assets/aih-model-refresh.mjs
var dshModelRefreshSource string

// models.dev-meta 是 @opencode-ai/models 离线快照的压缩投影：只保留 AIH 需要的
// 展示名、模态、上下文/输出上限、推理标记与价格。生成来源与 Node 的
// lib/server/models-dev-metadata.js 相同，避免运行时依赖 Node/网络。
//
//go:embed assets/modelsdev-metadata.json
var modelsDevMetadataSource []byte
