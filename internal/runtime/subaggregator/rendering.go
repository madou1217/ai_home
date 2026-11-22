package subaggregator

import "context"

// RendererInfo 是宿主可见的渲染目标元数据；函数型能力不会跨插件边界。
type RendererInfo struct {
	ID           string
	Name         string
	Note         string
	ContentType  string
	Extension    string
	Capabilities RendererCapabilities
}

// RelayCompileRequest 是宿主中转边车交给渲染引擎的编译输入。
type RelayCompileRequest struct {
	Kernel      string
	Nodes       []ProxyNode
	ListenHost  string
	Auth        *RelayCredentials
	MaxPorts    int
	OnlyIDs     map[string]bool
	BasePort    int
	LogPath     string
	Version     string
	OfficialApp bool
	// PortByNode 非空时按固定端口生成入口；空表示顺序分配。
	PortByNode map[string]int
}

// RenderingEngine 是订阅渲染的宿主入口；中转编译是独立接口。
//
// 生产组合根注入进程插件；测试/无插件开发构建可注入内置参考实现。
// 宿主只依赖接口，不 import 任何具体客户端格式或内核编译器。
type RenderingEngine interface {
	Renderers() []RendererInfo
	Lookup(target string) (RendererInfo, bool)
	Render(ctx context.Context, target string, profile AggregatorProfile, subs []Subscription, nodes []ProxyNode, renderCtx RenderContext) (RenderResult, error)
	Supports(ctx context.Context, target string, entries []PlannedNode) ([]bool, error)
}

// RelayCompiler 负责本机中转边车的配置编译与节点支持性判断。
//
// 与 RenderingEngine 分开，避免中转运行时依赖整套订阅渲染能力。
type RelayCompiler interface {
	SupportsRelayNode(ctx context.Context, kernel string, node ProxyNode, version string) bool
	CompileRelay(ctx context.Context, request RelayCompileRequest) (RelayCompiledOutput, error)
}

// defaultRenderingEngine 由内置参考实现（!no_builtin_renderers）的 init 覆盖；
// 生产构建保持 nil，服务必须显式注入插件目录。
var defaultRenderingEngine = func() RenderingEngine { return nil }
