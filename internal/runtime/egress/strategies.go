package egress

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
)

// StrategyStatus 是策略目录 + 当前运行时可满足能力的合并视图。
//
// Status:
//   - ready：现在就能用；
//   - degraded：配置可保存，但当前条件不完整（例如池内核已找到但池未启动、
//     URL 还未填写地址）；
//   - unavailable：当前环境无法使用（没有 mihomo、没有可用 SSH、非 macOS 等）。
type StrategyStatus struct {
	ID             string `json:"id"`
	Label          string `json:"label"`
	Description    string `json:"description"`
	Layer          string `json:"layer"`
	Input          string `json:"input"`
	RequiresMihomo bool   `json:"requiresMihomo"`
	RequiresSSH    bool   `json:"requiresSsh"`
	SupportsLaunch bool   `json:"supportsLaunch"`
	SupportsProbe  bool   `json:"supportsProbe"`
	Available      bool   `json:"available"`
	Status         string `json:"status"`
	Reason         string `json:"reason,omitempty"`
	BoundAccounts  int    `json:"boundAccounts"`
}

// StrategyCatalog 返回全部策略声明与当前可用性。
//
// UI 用它渲染策略面板与出口弹窗，不需要在前端维护模式清单。
func (m *Manager) StrategyCatalog(ctx context.Context) []StrategyStatus {
	definitions := agyegress.ListStrategies()
	out := make([]StrategyStatus, 0, len(definitions))
	bound := m.strategyBindingCounts(ctx)
	for _, definition := range definitions {
		status := StrategyStatus{
			ID:             definition.ID,
			Label:          definition.Label,
			Description:    definition.Description,
			Layer:          definition.Layer,
			Input:          definition.Input,
			RequiresMihomo: definition.RequiresMihomo,
			RequiresSSH:    definition.RequiresSSH,
			SupportsLaunch: definition.SupportsLaunch,
			SupportsProbe:  definition.SupportsProbe,
			BoundAccounts:  bound[definition.ID],
			Status:         "ready",
			Available:      true,
		}
		m.fillStrategyAvailability(ctx, &status)
		out = append(out, status)
	}
	return out
}

func (m *Manager) strategyBindingCounts(ctx context.Context) map[string]int {
	counts := map[string]int{}
	records, err := ReadAccountEgressBindings(ctx, m.aiHomeDir)
	if err != nil {
		return counts
	}
	for _, record := range records {
		if record.Binding.Retired {
			continue
		}
		counts[record.Binding.Mode]++
	}
	return counts
}

func (m *Manager) fillStrategyAvailability(ctx context.Context, status *StrategyStatus) {
	switch status.ID {
	case agyegress.ModeDirect:
		status.Status = "ready"
		status.Reason = "显式绕开代理；外部 TUN 由系统接管"
	case agyegress.ModeURL:
		status.Status = "degraded"
		status.Reason = "保存时需要填写代理地址"
	case agyegress.ModeSSH:
		if count, err := m.managedSSHOutletCount(); err == nil && count > 0 {
			status.Status = "ready"
			status.Reason = "可用 SSH 出口 " + strconv.Itoa(count) + " 个"
		} else {
			status.Status = "unavailable"
			status.Available = false
			status.Reason = "没有已启用的 SSH 代理主机；请先在 SSH 主机设置里启用“作为代理”"
		}
	case agyegress.ModePool:
		lifecycle := m.PoolLifecycle(ctx)
		if lifecycle.Ready {
			kind := firstNonEmpty(lifecycle.CoreKind, "mihomo")
			status.Status = "ready"
			if lifecycle.Phase == PoolPhaseDegraded {
				status.Status = "degraded"
				status.Reason = kind + " 出口池已运行，但没有新鲜健康节点（仍在轮换/探测）"
			} else {
				status.Reason = kind + " 出口池已运行"
			}
			if lifecycle.CoreVersion != "" {
				status.Reason += "（" + lifecycle.CoreVersion + "）"
			}
			return
		}
		if lifecycle.Phase == PoolPhaseStarting {
			status.Status = "degraded"
			status.Reason = "出口池启动中"
			return
		}
		if labels := m.pluginEngineLabels(); len(labels) > 0 {
			status.Status = "degraded"
			status.Reason = "已找到引擎插件：" + strings.Join(labels, "、") + "；池尚未启动"
			return
		}
		if labels := poolKernelLabels(m.aiHomeDir, m.platform); len(labels) > 0 {
			status.Status = "degraded"
			status.Reason = "已找到代理内核：" + strings.Join(labels, "、") + "；池尚未启动"
			return
		}
		if count := EndpointPoolNodeCount(m.aiHomeDir); count > 0 {
			status.Status = "ready"
			status.Reason = "无可用内核；使用 " + strconv.Itoa(count) + " 个 HTTP/SOCKS/SSH 直连节点池"
			return
		}
		status.Status = "unavailable"
		status.Available = false
		status.Reason = "没有可用的代理内核（mihomo/sing-box）或直连节点（HTTP/SOCKS/SSH）；可改用 SSH 出口"
	case agyegress.ModeSystem, agyegress.ModeTUN:
		decision, err := m.resolveSyntheticStrategy(ctx, status.ID)
		if err != nil {
			status.Status = "unavailable"
			status.Available = false
			status.Reason = strategyErrorReason(err)
			return
		}
		if strings.TrimSpace(decision.Target.ProxyURL) != "" {
			status.Status = "ready"
			status.Reason = "当前系统代理可用"
			return
		}
		if decision.Target.Direct {
			status.Status = "ready"
			status.Reason = "当前 TUN 已激活"
			return
		}
		status.Status = "degraded"
		status.Reason = "尚未探测到可用出口"
	}
}

// resolveSyntheticStrategy 复用与账号解析相同的模式实现，只回答“当前环境是否可用”。
func (m *Manager) resolveSyntheticStrategy(ctx context.Context, mode string) (agyegress.Decision, error) {
	raw, err := json.Marshal(map[string]any{"mode": mode})
	if err != nil {
		return agyegress.Decision{}, err
	}
	resolver := agyegress.NewResolver(agyegress.Options{
		AIHomeDir:         m.aiHomeDir,
		Platform:          m.platform,
		DetectSystemProxy: m.systemProxyDetector,
		DetectTUN:         m.tunDetector,
		PidAlive:          m.pidAlive,
		ResolveManagedSSH: func(reference string) (string, error) {
			return ManagedSSHProxyURL(m.aiHomeDir, reference)
		},
		ReadBinding: func(context.Context, string) (string, bool, error) {
			return string(raw), true, nil
		},
	})
	return resolver.Resolve(ctx, syntheticDetectAcctRef)
}

func strategyErrorReason(err error) string {
	if err == nil {
		return ""
	}
	var egressErr *agyegress.Error
	if errors.As(err, &egressErr) {
		reason := strings.TrimSpace(egressErr.Reason)
		if reason != "" {
			return reason
		}
		return egressErr.Code
	}
	return err.Error()
}

func (m *Manager) pluginEngineLabels() []string {
	if m == nil {
		return nil
	}
	labels := make([]string, 0, len(m.enginePlugins))
	for _, engine := range m.enginePlugins {
		descriptor := engine.Descriptor()
		label := firstNonEmpty(descriptor.Label, descriptor.ID)
		if descriptor.Version != "" {
			label += " " + descriptor.Version
		}
		labels = append(labels, label)
	}
	return labels
}

func (m *Manager) managedSSHOutletCount() (int, error) {
	data, err := ReadProxyPoolData(m.aiHomeDir)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, node := range data.Nodes {
		if data.DisabledSubs[node.SubscriptionID] {
			continue
		}
		if node.Raw["managedBy"] != "sshproxy" {
			continue
		}
		if verifiedManagedSSH(m.aiHomeDir, node) {
			count++
		}
	}
	return count, nil
}
