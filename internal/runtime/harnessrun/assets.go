package harnessrun

import _ "embed"

// 这两个资产是投影的一部分：pi 的 TUI 扩展与 dsh 的模型目录热更新插件必须
// 与 Node 的 lib/harness 源文件逐字一致，否则运行中的 harness 会用不同语义
// 改写 models.json / cordis.patch.yml（写放大或模型目录漂移）。

//go:embed assets/pi-extension.ts
var piExtensionSource string

//go:embed assets/aih-model-refresh.mjs
var dshModelRefreshSource string
