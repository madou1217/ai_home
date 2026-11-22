package aihserver

import (
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
	"github.com/madou1217/ai_home/internal/runtime/outboundproxy"
	"github.com/madou1217/ai_home/internal/runtime/sshproxy"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
	runtimeupstreamretry "github.com/madou1217/ai_home/internal/runtime/upstreamretry"
)

// webuiEgressDependencies 收拢 WebUI 的出口、代理与隧道能力。
//
// 它被 webuiRouteDependencies 嵌入，既有调用点继续通过字段提升读取这些依赖，
// 组合根只需在一处嵌套字面量里装配。
type webuiEgressDependencies struct {
	// EgressManager 是进程级出口管理器（出口池、上游地区策略与账号分配）。
	EgressManager *runtimeegress.Manager
	// Upstream429RetryStore 保存上游 429 重试策略，server-config 保存后热更新。
	Upstream429RetryStore *runtimeupstreamretry.Store
	// ProxyPool 是进程级上游代理池，server-config 保存后立即热更新。
	ProxyPool *outboundproxy.Manager
	// ProxyRuntime 为工具箱安装/更新提供任务期代理租约；与 CLI 的命名代理选择器同源。
	ProxyRuntime *sshproxy.LeaseManager
	// SSHProxies 是 ssh_connections 的本机回环 SSH 出口代理监督器。
	SSHProxies *sshproxy.Supervisor
	// ReverseTunnels 维护 ssh_connections.reverseTunnel。
	ReverseTunnels *sshtunnel.Supervisor
}
