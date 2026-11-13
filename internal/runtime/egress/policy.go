package egress

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
)

const (
	// PolicyKey 是 app_kv 里节点拦截策略的持久化键，与 Node egress-pool-node-policy.js 一致。
	PolicyKey = "egress:node-policy"
	// DefaultLatencyMaxMS 是默认的探测延迟拦截上限（ms）。
	DefaultLatencyMaxMS = 3000
	// MinLatencyMaxMS 是允许设置的最小延迟阈值（ms）。
	MinLatencyMaxMS = 100
	// MaxLatencyMaxMS 是允许设置的最大延迟阈值（ms）。
	MaxLatencyMaxMS = 15000
	// ProbeTimeoutMarginMS 保证探测超时比延迟阈值更宽，能区分「慢」与「超时」。
	ProbeTimeoutMarginMS = 1000
	// MaxDisabledNodes 限制手动关闭列表上限，超限时淘汰最旧条目。
	MaxDisabledNodes = 2000

	// BlockReasonSlow 表示因探测延迟超过阈值被拦截。
	BlockReasonSlow = "node_blocked_slow"
	// BlockReasonUnreachable 表示因探测不可达被拦截。
	BlockReasonUnreachable = "node_blocked_unreachable"
	// BlockReasonManual 表示由用户在 WebUI 手动关闭。
	BlockReasonManual = "node_blocked_manual"
)

// LatencyPolicy 描述延迟阈值拦截配置。
type LatencyPolicy struct {
	Enabled bool `json:"enabled"`
	MaxMS   int  `json:"maxMs"`
}

// UnreachablePolicy 描述探测不通拦截配置。
type UnreachablePolicy struct {
	Enabled bool `json:"enabled"`
}

// DisabledNodeEntry 记录一条手动关闭节点信息（按出口身份持久化）。
type DisabledNodeEntry struct {
	At     int64  `json:"at"`
	Label  string `json:"label"`
	Reason string `json:"reason"`
}

// NodePolicy 是完整的节点拦截策略快照。
type NodePolicy struct {
	Latency     LatencyPolicy                `json:"latency"`
	Unreachable UnreachablePolicy            `json:"unreachable"`
	Disabled    map[string]DisabledNodeEntry `json:"disabled"`
	UpdatedAt   int64                        `json:"updatedAt"`
}

// NodePolicyPatch 表示局部更新策略时的可选补丁字段。
type NodePolicyPatch struct {
	Latency     *LatencyPatch                `json:"latency,omitempty"`
	Unreachable *UnreachablePatch            `json:"unreachable,omitempty"`
	Disabled    map[string]DisabledNodeEntry `json:"disabled,omitempty"`
}

// LatencyPatch 是延迟阈值局部补丁。
type LatencyPatch struct {
	Enabled *bool    `json:"enabled,omitempty"`
	MaxMS   *float64 `json:"maxMs,omitempty"`
}

// UnreachablePatch 是不可达拦截局部补丁。
type UnreachablePatch struct {
	Enabled *bool `json:"enabled,omitempty"`
}

// NodePolicySummary 是前端与日志消费的可读摘要。
type NodePolicySummary struct {
	Latency       LatencyPolicy     `json:"latency"`
	Unreachable   UnreachablePolicy `json:"unreachable"`
	DisabledCount int               `json:"disabledCount"`
	Summary       string            `json:"summary"`
}

// NodeDecision 是单个节点的策略判定结论。
type NodeDecision struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
	Detail string `json:"detail"`
}

// ProbeFact 汇总节点最近一次探测结果，供拦截判定复用。
type ProbeFact struct {
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latencyMs"`
	At        int64  `json:"at"`
	Error     string `json:"error"`
	Source    string `json:"source,omitempty"`
}

// DefaultNodePolicy 返回全部不拦截的默认策略。
func DefaultNodePolicy() NodePolicy {
	return NodePolicy{
		Latency:     LatencyPolicy{Enabled: false, MaxMS: DefaultLatencyMaxMS},
		Unreachable: UnreachablePolicy{Enabled: false},
		Disabled:    map[string]DisabledNodeEntry{},
		UpdatedAt:   0,
	}
}

// NormalizeLatencyMaxMS 将延迟阈值夹到 [MinLatencyMaxMS, MaxLatencyMaxMS]。
func NormalizeLatencyMaxMS(value float64) int {
	if math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return DefaultLatencyMaxMS
	}
	ms := int(math.Round(value))
	if ms <= 0 {
		return DefaultLatencyMaxMS
	}
	if ms < MinLatencyMaxMS {
		return MinLatencyMaxMS
	}
	if ms > MaxLatencyMaxMS {
		return MaxLatencyMaxMS
	}
	return ms
}

// NormalizeNodePolicy 清洗并补全 NodePolicy 的默认值与边界。
func NormalizeNodePolicy(raw NodePolicy) NodePolicy {
	disabled := make(map[string]DisabledNodeEntry)
	if len(raw.Disabled) > 0 {
		keys := make([]string, 0, len(raw.Disabled))
		for k := range raw.Disabled {
			if trimmed := strings.TrimSpace(k); trimmed != "" {
				keys = append(keys, trimmed)
			}
		}
		sort.Strings(keys)
		if len(keys) > MaxDisabledNodes {
			keys = keys[:MaxDisabledNodes]
		}
		for _, key := range keys {
			entry := raw.Disabled[key]
			disabled[key] = DisabledNodeEntry{
				At:     maxInt64(0, entry.At),
				Label:  truncateString(strings.TrimSpace(entry.Label), 120),
				Reason: truncateString(strings.TrimSpace(entry.Reason), 200),
			}
		}
	}
	maxMS := raw.Latency.MaxMS
	if maxMS <= 0 {
		maxMS = DefaultLatencyMaxMS
	} else {
		maxMS = NormalizeLatencyMaxMS(float64(maxMS))
	}
	return NodePolicy{
		Latency: LatencyPolicy{
			Enabled: raw.Latency.Enabled,
			MaxMS:   maxMS,
		},
		Unreachable: UnreachablePolicy{
			Enabled: raw.Unreachable.Enabled,
		},
		Disabled:  disabled,
		UpdatedAt: maxInt64(0, raw.UpdatedAt),
	}
}

// ReadNodePolicy 从 app-state.db 读取节点拦截策略；读取失败或缺失时返回默认空策略。
func ReadNodePolicy(ctx context.Context, aiHomeDir string) NodePolicy {
	var raw NodePolicy
	found, err := readJSONKV(ctx, aiHomeDir, PolicyKey, &raw)
	if err != nil || !found {
		return DefaultNodePolicy()
	}
	return NormalizeNodePolicy(raw)
}

// WriteNodePolicy 局部更新并持久化节点拦截策略，返回归一化后的完整策略。
func WriteNodePolicy(ctx context.Context, aiHomeDir string, patch NodePolicyPatch, nowMS int64) (NodePolicy, error) {
	current := ReadNodePolicy(ctx, aiHomeDir)
	next := current
	if patch.Latency != nil {
		if patch.Latency.Enabled != nil {
			next.Latency.Enabled = *patch.Latency.Enabled
		}
		if patch.Latency.MaxMS != nil {
			next.Latency.MaxMS = NormalizeLatencyMaxMS(*patch.Latency.MaxMS)
		}
	}
	if patch.Unreachable != nil && patch.Unreachable.Enabled != nil {
		next.Unreachable.Enabled = *patch.Unreachable.Enabled
	}
	if patch.Disabled != nil {
		next.Disabled = patch.Disabled
	}
	next.UpdatedAt = nowMS
	normalized := NormalizeNodePolicy(next)
	normalized.UpdatedAt = nowMS
	if err := writeJSONKV(ctx, aiHomeDir, PolicyKey, normalized, nowMS); err != nil {
		return NodePolicy{}, fmt.Errorf("node_policy_write_failed: %w", err)
	}
	return normalized, nil
}

// SetNodeDisabled 手动关闭或放行一个按出口身份标识的节点。
func SetNodeDisabled(ctx context.Context, aiHomeDir string, identity string, disabled bool, label string, reason string, nowMS int64) (NodePolicy, error) {
	key := strings.TrimSpace(identity)
	if key == "" {
		return NodePolicy{}, fmt.Errorf("invalid_node_identity")
	}
	current := ReadNodePolicy(ctx, aiHomeDir)
	nextDisabled := make(map[string]DisabledNodeEntry, len(current.Disabled)+1)
	for k, v := range current.Disabled {
		nextDisabled[k] = v
	}
	if disabled {
		trimmedReason := truncateString(strings.TrimSpace(reason), 200)
		if trimmedReason == "" {
			trimmedReason = "manual"
		}
		nextDisabled[key] = DisabledNodeEntry{
			At:     nowMS,
			Label:  truncateString(strings.TrimSpace(label), 120),
			Reason: trimmedReason,
		}
		if len(nextDisabled) > MaxDisabledNodes {
			type item struct {
				key string
				at  int64
			}
			items := make([]item, 0, len(nextDisabled))
			for k, v := range nextDisabled {
				items = append(items, item{key: k, at: v.At})
			}
			sort.Slice(items, func(i, j int) bool { return items[i].at < items[j].at })
			for _, victim := range items[:len(nextDisabled)-MaxDisabledNodes] {
				delete(nextDisabled, victim.key)
			}
		}
	} else {
		delete(nextDisabled, key)
	}
	return WriteNodePolicy(ctx, aiHomeDir, NodePolicyPatch{Disabled: nextDisabled}, nowMS)
}

// ClearDisabledNodes 清空全部手动关闭记录，返回移除数量。
func ClearDisabledNodes(ctx context.Context, aiHomeDir string, nowMS int64) (int, NodePolicy, error) {
	current := ReadNodePolicy(ctx, aiHomeDir)
	removed := len(current.Disabled)
	empty := map[string]DisabledNodeEntry{}
	updated, err := WriteNodePolicy(ctx, aiHomeDir, NodePolicyPatch{Disabled: empty}, nowMS)
	if err != nil {
		return 0, NodePolicy{}, err
	}
	return removed, updated, nil
}

// DecideNode 根据拦截策略和最近一次探测结果判定节点是否允许出网。
func DecideNode(policy NodePolicy, identity string, probe *ProbeFact) NodeDecision {
	key := strings.TrimSpace(identity)
	if key != "" {
		if _, closed := policy.Disabled[key]; closed {
			return NodeDecision{Status: "blocked", Reason: BlockReasonManual, Detail: "手动关闭"}
		}
	}
	if probe == nil || probe.At == 0 {
		return NodeDecision{Status: "allow", Detail: "尚未探测"}
	}
	if !probe.OK {
		if !policy.Unreachable.Enabled {
			return NodeDecision{Status: "allow", Detail: "探测不通（未启用拦截）"}
		}
		detail := "探测不通"
		if probe.Error != "" {
			detail = fmt.Sprintf("探测不通（%s）", probe.Error)
		}
		return NodeDecision{Status: "blocked", Reason: BlockReasonUnreachable, Detail: detail}
	}
	if policy.Latency.Enabled && probe.LatencyMS > int64(policy.Latency.MaxMS) {
		return NodeDecision{
			Status: "blocked",
			Reason: BlockReasonSlow,
			Detail: fmt.Sprintf("延迟 %dms 超过阈值 %dms", probe.LatencyMS, policy.Latency.MaxMS),
		}
	}
	if probe.LatencyMS > 0 {
		return NodeDecision{Status: "allow", Detail: fmt.Sprintf("%dms", probe.LatencyMS)}
	}
	return NodeDecision{Status: "allow"}
}

// EffectiveProbeTimeoutMS 保证探测超时高于延迟阈值，能分辨慢节点和超时节点。
func EffectiveProbeTimeoutMS(policy NodePolicy, baseTimeoutMS int) int {
	base := baseTimeoutMS
	if base <= 0 {
		base = 5000
	}
	if !policy.Latency.Enabled {
		return base
	}
	threshold := policy.Latency.MaxMS + ProbeTimeoutMarginMS
	if threshold > base {
		return threshold
	}
	return base
}

// DescribeNodePolicy 生成用于 UI 展示的策略摘要。
func DescribeNodePolicy(policy NodePolicy) NodePolicySummary {
	normalized := NormalizeNodePolicy(policy)
	disabledCount := len(normalized.Disabled)
	var parts []string
	if normalized.Latency.Enabled {
		parts = append(parts, fmt.Sprintf("延迟 > %dms", normalized.Latency.MaxMS))
	}
	if normalized.Unreachable.Enabled {
		parts = append(parts, "连不上")
	}
	if disabledCount > 0 {
		parts = append(parts, fmt.Sprintf("手动关闭 %d 个", disabledCount))
	}
	summary := "未启用任何拦截"
	if len(parts) > 0 {
		summary = "拦截：" + strings.Join(parts, " · ")
	}
	return NodePolicySummary{
		Latency:       normalized.Latency,
		Unreachable:   normalized.Unreachable,
		DisabledCount: disabledCount,
		Summary:       summary,
	}
}

func truncateString(value string, maxRunes int) string {
	if maxRunes <= 0 || value == "" {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
