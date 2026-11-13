package egress

import (
	"strings"
	"time"
)

func currentUnixMS() int64 {
	return time.Now().UnixMilli()
}

// Nodes 返回当前绑定的运行节点摘要列表副本。
func (l *NodeHealthLedger) Nodes() []RuntimeNodeEntry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]RuntimeNodeEntry, len(l.nodes))
	copy(out, l.nodes)
	return out
}

// IsCooling 判断指定节点在给定时刻是否处于有效冷却期（已废弃的 ip_blocked 除外）。
func (l *NodeHealthLedger) IsCooling(name string, atMS int64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.isCoolingLocked(strings.TrimSpace(name), l.effectiveAtLocked(atMS))
}

func (l *NodeHealthLedger) effectiveAtLocked(atMS int64) int64 {
	if atMS > 0 {
		return atMS
	}
	return l.now()
}

func (l *NodeHealthLedger) isCoolingLocked(name string, at int64) bool {
	entry, found := l.entryByNameLocked(name)
	if !found {
		return false
	}
	stats := l.byIdentity[entry.Identity]
	if stats == nil {
		return false
	}
	return stats.CooldownKind != legacyIPBlockedKind && stats.CooldownUntil > at
}

// CoolingCount 统计当前处于冷却状态的节点数。
func (l *NodeHealthLedger) CoolingCount(atMS int64) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	at := l.effectiveAtLocked(atMS)
	count := 0
	for _, entry := range l.nodes {
		if l.isCoolingLocked(entry.Name, at) {
			count++
		}
	}
	return count
}

// BlockedReason 基于节点策略与最近一次探测（优先核心探测，其次节点库实测）返回拦截结论。
func (l *NodeHealthLedger) BlockedReason(name string, policy *NodePolicy) NodeDecision {
	if policy == nil {
		return NodeDecision{Status: "allow"}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.blockedReasonLocked(strings.TrimSpace(name), policy)
}

func (l *NodeHealthLedger) blockedReasonLocked(name string, policy *NodePolicy) NodeDecision {
	if policy == nil {
		return NodeDecision{Status: "allow"}
	}
	entry, found := l.entryByNameLocked(name)
	if !found {
		return NodeDecision{Status: "allow"}
	}
	stats := l.byIdentity[entry.Identity]
	var effectiveProbe *ProbeFact
	if stats != nil && stats.Probe != nil {
		effectiveProbe = stats.Probe
	} else if entry.LibraryProbe != nil {
		effectiveProbe = entry.LibraryProbe
	}
	return DecideNode(*policy, entry.Identity, effectiveProbe)
}

// PickNext 从 fromIndex 之后按顺序寻找下一个未被冷却也未被拦截的节点索引；
// allowed 非 nil 时仅从中挑选（空集合返回 -1）；avoid 为尽量避开集合，无可避开时放宽。
// 若所有候选均不可用，优先返回虽被拦截但不在冷却的节点，否则返回最早解冻的节点。
func (l *NodeHealthLedger) PickNext(fromIndex int, allowed map[string]bool, avoid map[string]bool, policy *NodePolicy, atMS int64) int {
	l.mu.Lock()
	defer l.mu.Unlock()

	count := len(l.nodes)
	if count == 0 {
		return -1
	}
	if allowed != nil && len(allowed) == 0 {
		return -1
	}
	at := l.effectiveAtLocked(atMS)
	start := fromIndex
	ordered := make([]int, 0, count)
	for step := 1; step <= count; step++ {
		idx := ((start+step)%count + count) % count
		if allowed == nil || allowed[l.nodes[idx].Name] {
			ordered = append(ordered, idx)
		}
	}
	if len(ordered) == 0 {
		return -1
	}

	usable := make([]int, 0, len(ordered))
	for _, idx := range ordered {
		name := l.nodes[idx].Name
		if !l.isCoolingLocked(name, at) && l.blockedReasonLocked(name, policy).Status != "blocked" {
			usable = append(usable, idx)
		}
	}
	for _, idx := range usable {
		if len(avoid) == 0 || !avoid[l.nodes[idx].Name] {
			return idx
		}
	}
	if len(usable) > 0 {
		return usable[0]
	}

	for _, idx := range ordered {
		if !l.isCoolingLocked(l.nodes[idx].Name, at) {
			return idx
		}
	}

	best := ordered[0]
	bestUntil := int64(1<<62 - 1)
	for _, idx := range ordered {
		entry := l.nodes[idx]
		until := int64(0)
		if stats := l.byIdentity[entry.Identity]; stats != nil {
			until = stats.CooldownUntil
		}
		if until < bestUntil {
			bestUntil = until
			best = idx
		}
	}
	return best
}

// DueForProbe 返回待探测节点名（网络类冷却中 + 被策略拦截 + 从未核心探测）。
func (l *NodeHealthLedger) DueForProbe(limit int, policy *NodePolicy, atMS int64) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if limit <= 0 {
		limit = 8
	}
	at := l.effectiveAtLocked(atMS)
	var out []string
	for _, entry := range l.nodes {
		stats := l.byIdentity[entry.Identity]
		if stats == nil {
			continue
		}
		due := (stats.CooldownUntil > at && stats.CooldownKind == "network") ||
			l.blockedReasonLocked(entry.Name, policy).Status == "blocked" ||
			stats.Probe == nil
		if due {
			out = append(out, entry.Name)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}
