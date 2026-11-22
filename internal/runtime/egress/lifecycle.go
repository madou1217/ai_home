package egress

import (
	"context"
	"strings"
)

// PoolPhase 是出口池控制面的显式生命周期状态。
type PoolPhase string

const (
	PoolPhaseStopped  PoolPhase = "stopped"
	PoolPhaseStarting PoolPhase = "starting"
	PoolPhaseReady    PoolPhase = "ready"
	PoolPhaseDegraded PoolPhase = "degraded"
	PoolPhaseFailed   PoolPhase = "failed"
)

// PoolLifecycle 是生命周期状态与可解释原因。
type PoolLifecycle struct {
	Phase        PoolPhase `json:"phase"`
	Reason       string    `json:"reason,omitempty"`
	CoreKind     string    `json:"coreKind,omitempty"`
	CoreVersion  string    `json:"coreVersion,omitempty"`
	Ready        bool      `json:"ready"`
	FreshHealthy int       `json:"freshHealthy"`
	NodeCount    int       `json:"nodeCount"`
}

// PoolLifecycle 汇总当前出口池状态；UI/策略目录/诊断共用这一份判定。
func (m *Manager) PoolLifecycle(ctx context.Context) PoolLifecycle {
	out := PoolLifecycle{Phase: PoolPhaseStopped}
	if m == nil || m.supervisor == nil {
		return out
	}
	state, liveReason := ReadLivePoolState(m.aiHomeDir, m.pidAlive)
	if state != nil {
		out.CoreKind = state.CoreKind
		out.CoreVersion = state.CoreVersion
		if out.CoreKind == "" {
			out.CoreKind = "mihomo"
		}
	}
	out.NodeCount = len(m.health.Nodes())
	policy := ReadNodePolicy(ctx, m.aiHomeDir)
	snapshots, _ := m.health.Snapshot(&policy)
	now := m.nowMS()
	for _, snapshot := range snapshots {
		if snapshot.Probe != nil && snapshot.Probe.OK && now-snapshot.Probe.At <= ProbeFreshMS {
			out.FreshHealthy++
		}
	}
	switch {
	case m.supervisor.IsStarting():
		out.Phase = PoolPhaseStarting
		out.Reason = "egress_pool_starting"
	case m.IsPoolReady():
		out.Ready = true
		if out.FreshHealthy == 0 {
			out.Phase = PoolPhaseDegraded
			out.Reason = "no_fresh_healthy_node"
		} else {
			out.Phase = PoolPhaseReady
		}
	case state != nil:
		out.Phase = PoolPhaseFailed
		out.Reason = firstNonEmpty(liveReason, m.supervisor.LastError(), "egress_pool_not_ready")
	case strings.TrimSpace(m.supervisor.LastError()) != "":
		out.Phase = PoolPhaseFailed
		out.Reason = m.supervisor.LastError()
	default:
		out.Phase = PoolPhaseStopped
	}
	return out
}
