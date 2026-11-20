package modelsapi

import "github.com/madou1217/ai_home/application/modelmetadata"

// 模型归属（`owned_by`）的解析与厂商词表只在 application/modelmetadata 定义。
//
// 本包保留这个调用形态：`owned_by` 必须是厂商名而不是 AIH 的 Provider ID——写
// `claude`/`agy`/`zcode` 会让 WebUI 反查归属时的分组整块落空。词表与「模型 ID 优先、
// Provider 兜底」的分支顺序都属于跨契约事实，不能在这个传输层再写一份（此前就存在
// 两份实现，大小写归一与取值已经在漂移）。
func resolveModelOwner(providerID string, modelID string) string {
	return modelmetadata.ResolveModelOwner(providerID, modelID)
}
