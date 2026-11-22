// Package profilerender 定义订阅配置渲染插件契约。
//
// 宿主只负责选点、健康、中转规划与 HTTP 出口；具体节点的协议编译、
// 策略组/规则生成、客户端格式差异全部由渲染插件实现。契约中的
// profile/subscriptions/nodes/context 使用宿主序列化后的 JSON，
// 避免应用层依赖 runtime 的具体类型。
package profilerender

import "encoding/json"

// Capabilities 声明目标格式对聚合规划的约束（JSON 可传输的子集）。
type Capabilities struct {
	RejectInGroups bool     `json:"rejectInGroups,omitempty"`
	Groups         bool     `json:"groups,omitempty"`
	GroupTypes     []string `json:"groupTypes,omitempty"`
	Protocols      []string `json:"protocols,omitempty"`
	ProxyChain     string   `json:"proxyChain,omitempty"`
	RuleSetFormat  string   `json:"ruleSetFormat,omitempty"`
	RelayFallback  bool     `json:"relayFallback,omitempty"`
	CoreProtocols  []string `json:"coreProtocols,omitempty"`
	// SanitizeName 声明名称清洗策略（当前仅 "surge"）；空表示不处理。
	SanitizeName string `json:"sanitizeName,omitempty"`
}

// Format 描述一个可渲染的目标格式。
type Format struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Note         string       `json:"note,omitempty"`
	ContentType  string       `json:"contentType,omitempty"`
	Extension    string       `json:"extension,omitempty"`
	Capabilities Capabilities `json:"capabilities"`
}

// Descriptor 是插件自报的能力：格式集合 + 可承载的中转内核。
type Descriptor struct {
	ID           string   `json:"id"`
	Label        string   `json:"label"`
	Formats      []Format `json:"formats"`
	RelayKernels []string `json:"relayKernels,omitempty"`
}

// RenderRequest 是一次完整订阅渲染输入；内部字段均为宿主 JSON。
type RenderRequest struct {
	Target        string          `json:"target"`
	Profile       json.RawMessage `json:"profile"`
	Subscriptions json.RawMessage `json:"subscriptions"`
	Nodes         json.RawMessage `json:"nodes"`
	Context       json.RawMessage `json:"context"`
}

// RenderResult 是渲染输出；stats/skippedNodes/userInfo 为宿主 JSON。
type RenderResult struct {
	Content      string          `json:"content"`
	Format       string          `json:"format"`
	ContentType  string          `json:"contentType"`
	Stats        json.RawMessage `json:"stats,omitempty"`
	SkippedNodes json.RawMessage `json:"skippedNodes,omitempty"`
	Warnings     []string        `json:"warnings,omitempty"`
	UserInfo     json.RawMessage `json:"userInfo,omitempty"`
}

// SupportsRequest 询问目标格式能否编译给定节点（按输入顺序返回）。
type SupportsRequest struct {
	Target  string          `json:"target"`
	Entries json.RawMessage `json:"entries"`
}

// SupportsResult 与 SupportsRequest.Entries 等长。
type SupportsResult struct {
	Supported []bool `json:"supported"`
}

// RelayCredentials 是本机中转的入口凭据。
type RelayCredentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Source   string `json:"source,omitempty"`
}

// RelayEndpoint 描述单个节点的本机中转入口。
type RelayEndpoint struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	UDP      bool   `json:"udp,omitempty"`
}

// RelaySkipped 记录未进入中转配置的节点与原因。
type RelaySkipped struct {
	NodeID string `json:"nodeId"`
	Reason string `json:"reason"`
}

// RelayCompileRequest 编译一套本机中转配置。
type RelayCompileRequest struct {
	Kernel      string            `json:"kernel"`
	Nodes       json.RawMessage   `json:"nodes"`
	ListenHost  string            `json:"listenHost,omitempty"`
	Auth        *RelayCredentials `json:"auth,omitempty"`
	MaxPorts    int               `json:"maxPorts,omitempty"`
	OnlyIDs     map[string]bool   `json:"onlyIds,omitempty"`
	BasePort    int               `json:"basePort,omitempty"`
	LogPath     string            `json:"logPath,omitempty"`
	Version     string            `json:"version,omitempty"`
	OfficialApp bool              `json:"officialApp,omitempty"`
	// PortByNode 非空时按指定端口生成入口；空表示由插件顺序分配。
	PortByNode map[string]int `json:"portByNode,omitempty"`
}

// RelayCompileResult 与宿主 RelayCompiledOutput 对应。
type RelayCompileResult struct {
	Text      string                   `json:"text"`
	Endpoints map[string]RelayEndpoint `json:"endpoints"`
	Skipped   []RelaySkipped           `json:"skipped,omitempty"`
}

// RelaySupportRequest 询问中转内核能否编译单个节点。
type RelaySupportRequest struct {
	Kernel  string          `json:"kernel"`
	Node    json.RawMessage `json:"node"`
	Version string          `json:"version,omitempty"`
}

// RelaySupportResult 是单节点支持性回答。
type RelaySupportResult struct {
	Supported bool `json:"supported"`
}
