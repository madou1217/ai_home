package egress

// PoolConfigInput 描述编译出口池配置所需的宿主参数。
type PoolConfigInput struct {
	Nodes          []ProxyNode
	MixedPort      int
	ControllerPort int
	Secret         string
	InterfaceName  *string
	InterfacesFunc func() ([]NetInterfaceEntry, error)
	ProbePort      int
	LanePorts      []int
	// Routing 是用户可视化的出口池规则与 DNS；零值保持内核默认。
	Routing RoutingPolicy
}

// CompiledPoolConfig 包含编译后的配置文本、节点映射与入口网卡；
// Config/YAMLText 仅内置参考适配器填充，插件路径只返回 JSONBytes。
type CompiledPoolConfig struct {
	Config        map[string]any
	JSONBytes     []byte
	YAMLText      string
	NodeNames     []string
	NodeEntries   []RuntimeNodeEntry
	InterfaceName string
}
