// Package modelsnapshot 定义 WebUI 模型快照元数据的只读合同。
//
// 快照是宿主写入 app-state 的投影：目录与探测事实的源头是 Go 的 account_models /
// account_model_probes，宿主只是把它们连同上游展示信息一起写回这个文档。因此
// Summary 里的探测聚合都能由 aih.db 直接得到；本包仍然需要，是因为 labels
// （上游显示名）与 contextLimits（上下文窗口）Go 目前不落库——Go 的目录发现契约只
// 返回模型 ID。本包只描述归一后的读模型与聚合口径，不读取任何具体存储；具体来源
// （app-state、远程目录或插件）由适配器实现 modelsnapshot.Reader。
package modelsnapshot

import (
	"context"
	"sort"
	"strings"
	"time"
)

// Retained 是离开运行池账号保留的目录。
type Retained struct {
	Provider string
	Models   []string
}

// Snapshot 是归一后的快照读模型。零值可用，所有查找返回零值。
type Snapshot struct {
	// Available 表示快照存在且成功解析；false 时各表为空。
	Available bool
	// UpdatedAtMS 是快照写入时刻（Unix 毫秒），缺失或非法时为 0。
	UpdatedAtMS int64
	// ProbeVersion 是快照声明的账号探测语义版本，缺失时为 0。
	ProbeVersion int

	// ByProvider 是 provider -> 模型 id。
	ByProvider map[string][]string
	// ByAccount 是 accountRef -> 模型 id；空清单不保留（没有条目 = 未知）。
	ByAccount map[string][]string
	// RetainedByAccount 是离开运行池账号 -> 保留目录。
	RetainedByAccount map[string]Retained
	// ErrorsByAccount 是 accountRef -> 上次探测错误；空消息不保留。
	ErrorsByAccount map[string]string
	// IncompleteByAccount 是 accountRef -> 目录不完整原因。
	IncompleteByAccount map[string]string
	// AccountUpdatedAt 是 accountRef -> 该账号真正被探测过的时刻（Unix 毫秒）。
	AccountUpdatedAt map[string]int64
	// AccountSource 是 accountRef -> 最近一次目录来源（local/remote/error/empty）。
	AccountSource map[string]string
	// AccountScanned 是 accountRef -> 最近一次探测扫描到的模型数。
	AccountScanned map[string]int64
	// ContextLimits 是 accountRef -> modelID -> 上游声明的上下文窗口。
	ContextLimits map[string]map[string]int
	// Labels 是 provider -> modelID -> 上游显示名。
	Labels map[string]map[string]string

	// Signature 是 Node 用来判断目录是否变化的指纹。
	Signature string
	// Source 是整份快照的来源（remote/local/error/empty）。
	Source string
	// SourceCount 是产生目录的来源数量。
	SourceCount int
	// ScannedAccounts 是最近一次扫描的账号数。
	ScannedAccounts int
	// FirstError 是整份快照记录的首个探测错误。
	FirstError string
	// GoGeneration / GoSyncedAt 是 Go 目录同步指纹与时刻。
	GoGeneration int64
	GoSyncedAt   int64
}

// Reader 读取并归一快照。实现可以是内置存储或插件来源。
type Reader interface {
	Read(ctx context.Context) (*Snapshot, error)
}

// Summary 是响应级聚合，保持与快照写入方的口径一致。
type Summary struct {
	UpdatedAtMS     int64
	Source          string
	Sources         int
	ScannedAccounts int
	FirstError      string
}

// Summary 返回快照级聚合。FirstError 缺失时按账号引用排序取首个非空错误。
func (s *Snapshot) Summary() Summary {
	if s == nil {
		return Summary{}
	}
	firstError := strings.TrimSpace(s.FirstError)
	if firstError == "" {
		refs := make([]string, 0, len(s.ErrorsByAccount))
		for ref := range s.ErrorsByAccount {
			refs = append(refs, ref)
		}
		sort.Strings(refs)
		for _, ref := range refs {
			if message := strings.TrimSpace(s.ErrorsByAccount[ref]); message != "" {
				firstError = message
				break
			}
		}
	}
	return Summary{
		UpdatedAtMS:     s.UpdatedAtMS,
		Source:          strings.TrimSpace(s.Source),
		Sources:         s.SourceCount,
		ScannedAccounts: s.ScannedAccounts,
		FirstError:      firstError,
	}
}

// Models 返回账号的模型清单（副本）。空清单或未知账号返回 false。
func (s *Snapshot) Models(accountRef string) ([]string, bool) {
	if s == nil {
		return nil, false
	}
	models, ok := s.ByAccount[strings.TrimSpace(accountRef)]
	if !ok || len(models) == 0 {
		return nil, false
	}
	return append([]string(nil), models...), true
}

// RetainedModels 返回保留目录（副本）。未知账号返回 false。
func (s *Snapshot) RetainedModels(accountRef string) (string, []string, bool) {
	if s == nil {
		return "", nil, false
	}
	retained, ok := s.RetainedByAccount[strings.TrimSpace(accountRef)]
	if !ok || len(retained.Models) == 0 {
		return "", nil, false
	}
	return retained.Provider, append([]string(nil), retained.Models...), true
}

// LastError 返回账号上次探测错误。没有错误与未知账号都返回 false。
func (s *Snapshot) LastError(accountRef string) (string, bool) {
	if s == nil {
		return "", false
	}
	message, ok := s.ErrorsByAccount[strings.TrimSpace(accountRef)]
	if !ok || message == "" {
		return "", false
	}
	return message, true
}

// IncompleteReason 返回账号目录不完整的原因。未知账号返回 false。
func (s *Snapshot) IncompleteReason(accountRef string) (string, bool) {
	if s == nil {
		return "", false
	}
	reason, ok := s.IncompleteByAccount[strings.TrimSpace(accountRef)]
	if !ok || reason == "" {
		return "", false
	}
	return reason, true
}

// SourceOf 返回账号最近一次目录来源。未知账号返回 false。
func (s *Snapshot) SourceOf(accountRef string) (string, bool) {
	if s == nil {
		return "", false
	}
	source, ok := s.AccountSource[strings.TrimSpace(accountRef)]
	if !ok || source == "" {
		return "", false
	}
	return source, true
}

// ScannedAt 返回账号最近一次扫描到的模型数。未知账号返回 false。
func (s *Snapshot) ScannedAt(accountRef string) (int64, bool) {
	if s == nil {
		return 0, false
	}
	count, ok := s.AccountScanned[strings.TrimSpace(accountRef)]
	if !ok || count <= 0 {
		return 0, false
	}
	return count, true
}

// ContextLimit 返回账号 × 模型的上游上下文窗口。未知组合返回 false。
func (s *Snapshot) ContextLimit(accountRef string, modelID string) (int, bool) {
	if s == nil {
		return 0, false
	}
	byModel := s.ContextLimits[strings.TrimSpace(accountRef)]
	if byModel == nil {
		return 0, false
	}
	tokens, ok := byModel[strings.TrimSpace(modelID)]
	if !ok || tokens <= 0 {
		return 0, false
	}
	return tokens, true
}

// Label 返回模型的上游显示名。没有显示名时返回 false，调用方应回落到模型 id。
func (s *Snapshot) Label(provider string, modelID string) (string, bool) {
	if s == nil {
		return "", false
	}
	byModel := s.Labels[strings.TrimSpace(provider)]
	if byModel == nil {
		return "", false
	}
	label, ok := byModel[strings.TrimSpace(modelID)]
	if !ok || label == "" {
		return "", false
	}
	return label, true
}

// ProbedAt 返回账号真正被探测过的时刻。旧语义快照或未知账号返回 false。
func (s *Snapshot) ProbedAt(accountRef string) (time.Time, bool) {
	if s == nil {
		return time.Time{}, false
	}
	milliseconds, ok := s.AccountUpdatedAt[strings.TrimSpace(accountRef)]
	if !ok || milliseconds <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(milliseconds).UTC(), true
}
