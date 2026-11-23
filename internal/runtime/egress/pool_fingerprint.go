package egress

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"
)

// PoolFingerprint 描述“用户当前希望池里有哪些节点”，用于发现 proxy-pool.json
// 的订阅/节点变化并触发池配置重建。
//
// 只纳入订阅可见性、节点退出身份、显示名与凭据指纹，不含延迟、最近探测时间等
// 高频字段，避免健康探测本身导致池反复重载。凭据只以哈希形式参与比较。
func PoolFingerprint(aiHomeDir string) string {
	data, err := ReadProxyPoolData(aiHomeDir)
	if err != nil {
		return ""
	}
	subscriptions := make([]string, 0, len(data.Subscriptions))
	for _, sub := range data.Subscriptions {
		state := "on"
		if data.DisabledSubs[sub.ID] {
			state = "off"
		}
		subscriptions = append(subscriptions, sub.ID+"="+state)
	}
	sort.Strings(subscriptions)

	nodes := make([]string, 0, len(data.Nodes))
	for _, node := range data.Nodes {
		if node.Port <= 0 || !IsUsableNode(node) || IsInformationalNode(node.Name) {
			continue
		}
		if data.DisabledSubs[node.SubscriptionID] {
			continue
		}
		credential := sha256.Sum256([]byte(node.CredentialTag()))
		nodes = append(nodes, NodeExitIdentity(node)+"|"+strings.TrimSpace(node.Name)+"|"+
			hex.EncodeToString(credential[:8]))
	}
	sort.Strings(nodes)

	sum := sha256.Sum256([]byte(strings.Join(subscriptions, "\n") + "\n--\n" + strings.Join(nodes, "\n")))
	return hex.EncodeToString(sum[:])
}

// reloadPoolIfChanged 在池配置需要重建时重启内核；失败会保留旧指纹以便下个 tick 重试。
func (m *Manager) reloadPoolIfChanged(ctx context.Context) bool {
	if m == nil || m.supervisor == nil {
		return false
	}
	fingerprint := PoolFingerprint(m.aiHomeDir)
	if fingerprint == "" {
		return false
	}
	m.poolMu.Lock()
	previous := m.poolFingerprint
	if previous == "" {
		m.poolFingerprint = fingerprint
		m.poolMu.Unlock()
		return false
	}
	if previous == fingerprint {
		m.poolMu.Unlock()
		return false
	}
	m.poolFingerprint = fingerprint
	m.poolMu.Unlock()

	if m.logger != nil {
		m.logger("egress pool nodes changed; reloading")
	}
	if !m.IsPoolReady() {
		_ = m.StartPool(ctx)
		return false
	}
	m.StopPool()
	result := m.StartPool(ctx)
	if !result.OK {
		m.poolMu.Lock()
		m.poolFingerprint = previous
		m.poolMu.Unlock()
		if m.logger != nil {
			m.logger("egress pool reload failed: " + result.Error)
		}
		return false
	}
	_ = m.ReconcileLanes(ctx)
	return true
}
