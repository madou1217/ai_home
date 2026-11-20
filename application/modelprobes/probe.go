// Package modelprobes 把账号模型事实表归一成「一次目录探测」的读模型。
//
// aih.db 的 account_models（本账号可见的模型）与 account_model_probes（最近一次探测
// 的结果）在多个 WebUI 契约里被消费，消费者对同一份事实会做相同的判断：哪些模型是
// 上游真正声明的、这次探测算成功还是失败、错误文本取 message 还是 code、探测发生在
// 什么时候。这些判断此前在每个传输层处理器里各自推导一份，口径漂移的风险随调用方
// 增加而增加。
//
// 本包只负责把事实表翻译成 Probe 值，不决定聚合口径（scannedAccounts/sources 该不该
// 计入未尝试的条目、是否用快照兜底、空数组要不要输出）。那是各契约自己的投影决定，
// 因此留在调用方。
package modelprobes

import (
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// Probe 是一个账号在某个 Provider 下最近一次目录探测的归一事实。
//
// 字段全部来自事实表，不做默认值填充：没有探测过就是零值 ProbedAt 与 Succeeded=false，
// 调用方据此区分「从未探测」与「探测成功但目录为空」。
type Probe struct {
	// AccountRef 是 Go 的稳定账号引用。
	AccountRef string
	// ProviderID 是该事实所属 Provider。
	ProviderID string
	// Discovered 是上游声明可用的模型 ID，按事实表顺序去重；排序由调用方决定。
	Discovered []string
	// ErrorText 是这次探测的错误文本：优先 message，缺失时回落到 code。
	ErrorText string
	// ProbedAt 是最近一次探测时刻；从未探测为零值。
	ProbedAt time.Time
	// Succeeded 表示这次探测拿到了上游目录。
	//
	// 目录非空不等于成功：失败会保留旧模型，所以以错误文本与 LastSource=error 为准。
	Succeeded bool
}

// Probed 报告这个快照是否发生过探测尝试。
func (probe Probe) Probed() bool {
	return !probe.ProbedAt.IsZero()
}

// FromSets 归一账号模型事实表的每个 (账号, Provider) 快照。
//
// 返回顺序与入参一致，便于调用方保持既有输出顺序。
func FromSets(sets []accountapp.AccountModelSet) []Probe {
	probes := make([]Probe, 0, len(sets))
	for _, set := range sets {
		probe := Probe{
			AccountRef: set.AccountRef.String(),
			ProviderID: set.ProviderID,
			ProbedAt:   set.LastAttemptAt,
			ErrorText:  ErrorText(set.LastErrorCode, set.LastErrorMessage),
		}
		probe.Succeeded = probe.ErrorText == "" && strings.TrimSpace(set.LastSource) != "error"
		seen := make(map[string]struct{}, len(set.Models))
		for _, model := range set.Models {
			if !model.UpstreamAvailable() {
				continue
			}
			modelID := model.ModelID().String()
			if _, duplicate := seen[modelID]; duplicate {
				continue
			}
			seen[modelID] = struct{}{}
			probe.Discovered = append(probe.Discovered, modelID)
		}
		probes = append(probes, probe)
	}
	return probes
}

// ErrorText 是探测错误文本的统一口径：message 优先，缺失时回落到 code。
func ErrorText(code, message string) string {
	if trimmed := strings.TrimSpace(message); trimmed != "" {
		return trimmed
	}
	return strings.TrimSpace(code)
}
