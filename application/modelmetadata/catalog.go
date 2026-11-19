package modelmetadata

// ContextWindowLookup 按精确 Provider + 模型返回上下文窗口。
//
// 与 ContextWindowReader 的整表快照不同，它面向请求路径上的单次查询；
// 未知模型必须返回未命中，不能用同族或默认窗口冒充。
type ContextWindowLookup interface {
	LookupContextWindow(providerID string, modelID string) (int, bool)
}

// Catalog 是模型元数据插件必须实现的只读最小端口。
//
// 服务器只依赖本接口取模态、推理档位和上下文窗口；具体来源（内置快照、
// 远程目录或第三方插件）由宿主在组合层注入，运行路径不得引用具体适配器。
type Catalog interface {
	Reader
	ReasoningLadderReader
	ContextWindowLookup
	// SourceID 返回该元数据来源的稳定标识，供接口展示来源而不是写死实现名。
	SourceID() string
}
