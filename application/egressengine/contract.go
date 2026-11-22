// Package egressengine 定义出口内核插件契约。
//
// 主体（egress 包）只依赖这里的接口与 JSON 结构，不 import mihomo/sing-box
// 的配置编译器。生产构建（-tags no_builtin_engines）只有进程插件实现；
// 插件通过行分隔 JSON-RPC 交换 CompileRequest/LaunchSpec，宿主负责进程、
// 控制面、健康与回收。
package egressengine

import "context"

// Node 是插件编译配置所需的节点事实。
//
// Options 保留协议私有字段（密码、UUID、传输、TLS 等）；插件不得把 Options
// 回传到结果或日志。主体只保证 ID/Name/Protocol/Server/Port 稳定。
type Node struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Protocol string         `json:"protocol"`
	Server   string         `json:"server"`
	Port     int            `json:"port"`
	Options  map[string]any `json:"options,omitempty"`
}

// Rule 是内核无关的路由规则片段。
type Rule struct {
	Type   string `json:"type"` // domain/domain-suffix/domain-keyword/ip-cidr
	Value  string `json:"value"`
	Action string `json:"action"` // proxy/direct/reject
}

// DNS 是内核无关的 DNS 策略。
type DNS struct {
	Mode    string   `json:"mode"` // default/doh/plain
	Servers []string `json:"servers,omitempty"`
	Route   string   `json:"route,omitempty"` // proxy/direct
}

// ResolveRequest 让插件定位内核并统计当前节点可编译数量。
type ResolveRequest struct {
	AIHomeDir string `json:"aiHomeDir"`
	Platform  string `json:"platform,omitempty"`
	Nodes     []Node `json:"nodes"`
}

// ResolveResult 是插件对内核可用性的回答；宿主据此选择引擎。
type ResolveResult struct {
	Binary         string `json:"binary,omitempty"`
	Version        string `json:"version,omitempty"`
	UsableNodes    int    `json:"usableNodes"`
	GlobalGroup    string `json:"globalGroup,omitempty"`
	ConfigFileName string `json:"configFileName,omitempty"`
}

// CompileRequest 是主体交给内核插件的唯一输入。
type CompileRequest struct {
	// AIHomeDir/Platform 供插件定位内核与工作目录，不包含宿主凭据。
	AIHomeDir      string `json:"aiHomeDir,omitempty"`
	Platform       string `json:"platform,omitempty"`
	Nodes          []Node `json:"nodes"`
	MixedPort      int    `json:"mixedPort"`
	ControllerPort int    `json:"controllerPort"`
	ProbePort      int    `json:"probePort,omitempty"`
	LanePorts      []int  `json:"lanePorts,omitempty"`
	Secret         string `json:"secret"`
	InterfaceName  string `json:"interfaceName,omitempty"`
	Rules          []Rule `json:"rules,omitempty"`
	DNS            DNS    `json:"dns"`
	// Lease 非空表示这是单节点租约配置：只监听回环，入口必须独立认证。
	// 插件应把鉴权放进监听器自身，而不是依赖控制面的选路。
	Lease *Lease `json:"lease,omitempty"`
	// Version 是插件自报的内核版本（可为空；插件可自行探测）。
	Version string `json:"version,omitempty"`
}

// Lease 描述一次单节点租约的入口约束。
type Lease struct {
	BindAddress string   `json:"bindAddress,omitempty"`
	IngressAuth []string `json:"ingressAuth,omitempty"` // user:password
}

// NodeTag 把运行时标签与稳定节点身份绑定；主体据此建立健康/车道索引。
type NodeTag struct {
	Tag      string `json:"tag"`
	NodeID   string `json:"nodeId"`
	Identity string `json:"identity"`
	Label    string `json:"label"`
	Protocol string `json:"protocol"`
	Server   string `json:"server"`
	Port     int    `json:"port"`
}

// LaunchSpec 是插件编译出的启动事实；主体负责启动/监督/控制面调用。
type LaunchSpec struct {
	// Config 是内核配置文件正文（JSON/YAML 由插件决定）。
	Config         []byte `json:"config"`
	ConfigFileName string `json:"configFileName"`
	// Binary 为空时由主体按插件描述符/运行环境解析；非空时必须是插件确认的路径。
	Binary      string    `json:"binary,omitempty"`
	Args        []string  `json:"args,omitempty"`
	GlobalGroup string    `json:"globalGroup"`
	NodeTags    []NodeTag `json:"nodeTags"`
	// Controller 固定为 "clash-api"（当前主体的控制面协议）。
	Controller string `json:"controller,omitempty"`
	Version    string `json:"version,omitempty"`
}

// Descriptor 是插件自报的静态能力。
type Descriptor struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Version   string   `json:"version,omitempty"`
	Protocols []string `json:"protocols,omitempty"`
	// Capabilities 声明插件支持的配置形态：pool（多节点池）、lease（单节点租约）。
	// 空列表按 pool 处理，避免旧插件意外承接租约。
	Capabilities []string `json:"capabilities,omitempty"`
	Priority     int      `json:"priority,omitempty"`
	Controller   string   `json:"controller"` // clash-api
}

// Engine 是内核插件的最小契约。
//
// 宿主负责：进程启动/停止、Clash 控制面选择节点、健康探测、车道规划、
// 失败关闭与进程身份校验。插件只负责：描述能力、把节点编译成配置与启动参数。
type Engine interface {
	Descriptor() Descriptor
	Resolve(ctx context.Context, request ResolveRequest) (ResolveResult, error)
	Compile(ctx context.Context, request CompileRequest) (LaunchSpec, error)
}
