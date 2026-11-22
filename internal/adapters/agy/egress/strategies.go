package egress

import "strings"

// StrategyDefinition 是账号出口策略的唯一声明。
//
// 新增策略只应改这里 + 对应解析器（runtime/egress）与前端 AccountEgressMode：
// UI 的选项、说明、需要的输入和可用性都从这份目录渲染，不再各自维护清单。
//
// Layer 说明：
//   - application：AIH 自己在应用层下发代理（direct/url/ssh/pool）；
//   - system：复用操作系统系统代理；
//   - network：复用外部 TUN。
type StrategyDefinition struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	Description    string `json:"description"`
	Layer          string `json:"layer"`
	Input          string `json:"input"`
	RequiresMihomo bool   `json:"requiresMihomo"`
	RequiresSSH    bool   `json:"requiresSsh"`
	SupportsLaunch bool   `json:"supportsLaunch"`
	SupportsProbe  bool   `json:"supportsProbe"`
}

const (
	StrategyLayerApplication = "application"
	StrategyLayerSystem      = "system"
	StrategyLayerNetwork     = "network"

	StrategyInputNone          = "none"
	StrategyInputProxyURL      = "proxy_url"
	StrategyInputSSHConnection = "ssh_connection"
	StrategyInputPoolScope     = "pool_scope"
)

// strategyDefinitions 的顺序就是 UI 的展示顺序。
var strategyDefinitions = []StrategyDefinition{
	{
		ID:             ModeDirect,
		Label:          "直连",
		Description:    "不走任何代理；网关请求绕开全局上游代理，CLI 清除宿主代理变量；外部 TUN 仍由系统接管。",
		Layer:          StrategyLayerApplication,
		Input:          StrategyInputNone,
		SupportsLaunch: true,
		SupportsProbe:  true,
	},
	{
		ID:             ModeSystem,
		Label:          "系统代理",
		Description:    "按 HTTPS > HTTP > SOCKS5 读取当前操作系统代理；只读复用，不修改系统设置。",
		Layer:          StrategyLayerSystem,
		Input:          StrategyInputNone,
		SupportsLaunch: true,
		SupportsProbe:  true,
	},
	{
		ID:             ModeURL,
		Label:          "代理地址",
		Description:    "使用 HTTP(S) 或 SOCKS5 代理地址；不支持带账号密码的地址。",
		Layer:          StrategyLayerApplication,
		Input:          StrategyInputProxyURL,
		SupportsLaunch: true,
		SupportsProbe:  true,
	},
	{
		ID:             ModeSSH,
		Label:          "SSH 出口（AWS 等）",
		Description:    "使用 AIH 管理的 SSH 环回隧道，不需要 mihomo；在 SSH 主机里启用“作为代理”即可。",
		Layer:          StrategyLayerApplication,
		Input:          StrategyInputSSHConnection,
		RequiresSSH:    true,
		SupportsLaunch: true,
		SupportsProbe:  true,
	},
	{
		ID:             ModePool,
		Label:          "AIH 出口池（mihomo）",
		Description:    "用订阅节点组成出口池并按车道自动轮换；需要本机 mihomo 内核。",
		Layer:          StrategyLayerApplication,
		Input:          StrategyInputPoolScope,
		RequiresMihomo: true,
		SupportsLaunch: true,
		SupportsProbe:  true,
	},
	{
		ID:             ModeTUN,
		Label:          "外部 TUN",
		Description:    "仅在检测到外部 TUN 已激活时使用；AIH 不创建、不启停、不接管 TUN。",
		Layer:          StrategyLayerNetwork,
		Input:          StrategyInputNone,
		SupportsLaunch: true,
		SupportsProbe:  true,
	},
}

// ListStrategies 返回全部策略声明的副本。
func ListStrategies() []StrategyDefinition {
	return append([]StrategyDefinition(nil), strategyDefinitions...)
}

// StrategyByID 按 ID 查找策略声明。
func StrategyByID(id string) (StrategyDefinition, bool) {
	normalized := strings.ToLower(strings.TrimSpace(id))
	for _, definition := range strategyDefinitions {
		if definition.ID == normalized {
			return definition, true
		}
	}
	return StrategyDefinition{}, false
}

// knownBindingModes 由策略目录派生，避免模式清单与 UI/解析器漂移。
var knownBindingModes = func() map[string]struct{} {
	modes := make(map[string]struct{}, len(strategyDefinitions))
	for _, definition := range strategyDefinitions {
		modes[definition.ID] = struct{}{}
	}
	return modes
}()