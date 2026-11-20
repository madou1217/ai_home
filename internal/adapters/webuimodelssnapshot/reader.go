// Package webuimodelssnapshot 提供 WebUI 模型目录快照的只读 Go 视图。
//
// 快照由宿主写入 app-state 的 KV（cache:webui-models-snapshot.json）：目录与探测事实
// 本身来自 Go（aih.db 的 account_models / account_model_probes），宿主只是把它们投影
// 回这个文档。因此这一份不是独立真值源——探测聚合（source/sources/scannedAccounts/
// firstError/accountProbedAt/errorsByAccountRef）都能由 aih.db 直接派生，本包存在的
// 原因是还有两项事实 Go 目前不落库：上游显示名（labels）与上下文窗口（contextLimits）。
// Go 的目录发现契约只有模型 ID（DiscoverModels 返回 []string），要收回这两项得先扩展
// 跨层发现契约，在那之前只能读宿主投影。
//
// 本包只读、只做归一：不写库、不探测上游、不参与推理路由。
//
// 归一遵循「坏数据降级为空」：字段类型不符、条目为空、单个模型值非法，都只丢弃
// 对应内容，不影响同一快照的其它字段；只有数据库层失败才向上返回错误。
package webuimodelssnapshot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/modelsnapshot"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// CacheKey 是 Node webui-cache-store 写入的快照键。
	CacheKey = "cache:webui-models-snapshot.json"

	// MinTrustedProbeVersion 是 accountUpdatedAt 可被采信的最小语义版本。
	//
	// v1（<= 2026-10）按整个刷新作用域打戳，连根本没探测的账号也被标记，读出来
	// 会让冷账号被当成「探测过但为空」，UI 显示「未发现模型」且长时间不再补探。
	// 因此旧版本快照的 accountUpdatedAt 必须整表丢弃。
	MinTrustedProbeVersion = 2

	// maxSafeInteger 与 Node 的 Number.isSafeInteger 对齐：超过它的时间戳与
	// 上下文窗口不再可信。
	maxSafeInteger = 1<<53 - 1
)

// ErrInvalidDatabasePath 表示没有可用的 app-state.db 路径。
var ErrInvalidDatabasePath = errors.New("app-state 数据库路径无效")

// Snapshot 是快照值对象；读模型合同定义在 application/modelsnapshot。
type Snapshot = modelsnapshot.Snapshot

var _ modelsnapshot.Reader = (*Reader)(nil)

// Reader 从 app-state.db 读取快照。
type Reader struct {
	databasePath string
}

// NewReader 按 AIH 数据根目录构造 Reader。
func NewReader(aiHomeDir string) (*Reader, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &Reader{databasePath: path}, nil
}

// NewReaderAt 按 app-state.db 的显式路径构造 Reader（测试与迁移用）。
func NewReaderAt(databasePath string) (*Reader, error) {
	path := strings.TrimSpace(databasePath)
	if path == "" {
		return nil, ErrInvalidDatabasePath
	}
	return &Reader{databasePath: path}, nil
}

// Read 读取并归一快照。
//
// 数据库或 KV 读取失败时返回空快照与错误；快照缺失、为空、JSON 损坏都按空快照
// 处理，不返回错误。
func (r *Reader) Read(ctx context.Context) (*Snapshot, error) {
	if r == nil || strings.TrimSpace(r.databasePath) == "" {
		return &Snapshot{}, nil
	}
	raw, found, err := appstate.ReadKV(ctx, r.databasePath, CacheKey)
	if err != nil {
		return &Snapshot{}, err
	}
	if !found {
		return &Snapshot{}, nil
	}
	return Parse([]byte(raw)), nil
}

// Parse 归一快照 JSON。非对象或损坏的 JSON 返回不可用快照，不 panic。
func Parse(raw []byte) *Snapshot {
	snapshot := &Snapshot{}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return snapshot
	}
	var envelope struct {
		UpdatedAt           json.RawMessage `json:"updatedAt"`
		AccountProbeVersion json.RawMessage `json:"accountProbeVersion"`
		ByProvider          json.RawMessage `json:"byProvider"`
		ByAccount           json.RawMessage `json:"byAccount"`
		RetainedByAccount   json.RawMessage `json:"retainedByAccount"`
		ErrorsByAccount     json.RawMessage `json:"errorsByAccount"`
		IncompleteByAccount json.RawMessage `json:"incompleteByAccount"`
		AccountUpdatedAt    json.RawMessage `json:"accountUpdatedAt"`
		AccountSource       json.RawMessage `json:"accountSource"`
		AccountScanned      json.RawMessage `json:"accountScanned"`
		ContextLimits       json.RawMessage `json:"contextLimits"`
		Labels              json.RawMessage `json:"labels"`
		Signature           json.RawMessage `json:"signature"`
		Source              json.RawMessage `json:"source"`
		SourceCount         json.RawMessage `json:"sourceCount"`
		ScannedAccounts     json.RawMessage `json:"scannedAccounts"`
		FirstError          json.RawMessage `json:"firstError"`
		GoGeneration        json.RawMessage `json:"goGeneration"`
		GoSyncedAt          json.RawMessage `json:"goSyncedAt"`
	}
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return snapshot
	}
	snapshot.Available = true
	snapshot.UpdatedAtMS, _ = positiveInteger(envelope.UpdatedAt)
	version, _ := positiveInteger(envelope.AccountProbeVersion)
	snapshot.ProbeVersion = int(version)
	snapshot.ByProvider = normalizeModelLists(envelope.ByProvider)
	snapshot.ByAccount = normalizeModelLists(envelope.ByAccount)
	snapshot.RetainedByAccount = normalizeRetained(envelope.RetainedByAccount)
	snapshot.ErrorsByAccount = normalizeTrimmedStrings(envelope.ErrorsByAccount)
	snapshot.IncompleteByAccount = normalizeTrimmedStrings(envelope.IncompleteByAccount)
	snapshot.ContextLimits = normalizeContextLimits(envelope.ContextLimits)
	snapshot.Labels = normalizeLabels(envelope.Labels)
	if snapshot.ProbeVersion >= MinTrustedProbeVersion {
		snapshot.AccountUpdatedAt = normalizeAccountUpdatedAt(envelope.AccountUpdatedAt)
	}
	snapshot.AccountSource = normalizeTrimmedStrings(envelope.AccountSource)
	snapshot.AccountScanned = normalizeAccountScanned(envelope.AccountScanned)
	snapshot.Signature = stringValue(envelope.Signature)
	snapshot.Source = stringValue(envelope.Source)
	snapshot.SourceCount = int(nonNegativeInteger(envelope.SourceCount))
	snapshot.ScannedAccounts = int(nonNegativeInteger(envelope.ScannedAccounts))
	snapshot.FirstError = stringValue(envelope.FirstError)
	snapshot.GoGeneration = nonNegativeInteger(envelope.GoGeneration)
	snapshot.GoSyncedAt = nonNegativeInteger(envelope.GoSyncedAt)
	return snapshot
}

// objectEntries 解析 JSON 对象为逐字段原始值；形状不对时返回空表。
func objectEntries(raw json.RawMessage) map[string]json.RawMessage {
	entries := map[string]json.RawMessage{}
	if len(raw) == 0 {
		return entries
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return map[string]json.RawMessage{}
	}
	return entries
}

func normalizeModelLists(raw json.RawMessage) map[string][]string {
	out := map[string][]string{}
	for accountRef, value := range objectEntries(raw) {
		ref := strings.TrimSpace(accountRef)
		if ref == "" {
			continue
		}
		var entries []json.RawMessage
		if err := json.Unmarshal(value, &entries); err != nil {
			continue
		}
		models := make([]string, 0, len(entries))
		seen := make(map[string]struct{}, len(entries))
		for _, entry := range entries {
			var model string
			if err := json.Unmarshal(entry, &model); err != nil {
				continue
			}
			model = strings.TrimSpace(model)
			if model == "" {
				continue
			}
			if _, duplicate := seen[model]; duplicate {
				continue
			}
			seen[model] = struct{}{}
			models = append(models, model)
		}
		if len(models) > 0 {
			out[ref] = models
		}
	}
	return out
}

func normalizeTrimmedStrings(raw json.RawMessage) map[string]string {
	out := map[string]string{}
	for accountRef, value := range objectEntries(raw) {
		ref := strings.TrimSpace(accountRef)
		if ref == "" {
			continue
		}
		var message string
		if err := json.Unmarshal(value, &message); err != nil {
			continue
		}
		message = strings.TrimSpace(message)
		if message == "" {
			continue
		}
		out[ref] = message
	}
	return out
}

func normalizeLabels(raw json.RawMessage) map[string]map[string]string {
	out := map[string]map[string]string{}
	for provider, value := range objectEntries(raw) {
		providerID := strings.TrimSpace(provider)
		if providerID == "" {
			continue
		}
		byModel := map[string]string{}
		for modelID, labelValue := range objectEntries(value) {
			model := strings.TrimSpace(modelID)
			if model == "" {
				continue
			}
			var label string
			if err := json.Unmarshal(labelValue, &label); err != nil {
				continue
			}
			label = strings.TrimSpace(label)
			if label == "" {
				continue
			}
			byModel[model] = label
		}
		if len(byModel) > 0 {
			out[providerID] = byModel
		}
	}
	return out
}

func normalizeContextLimits(raw json.RawMessage) map[string]map[string]int {
	out := map[string]map[string]int{}
	for accountRef, value := range objectEntries(raw) {
		ref := strings.TrimSpace(accountRef)
		if ref == "" {
			continue
		}
		byModel := map[string]int{}
		for modelID, limitValue := range objectEntries(value) {
			model := strings.TrimSpace(modelID)
			if model == "" {
				continue
			}
			tokens, ok := positiveInteger(limitValue)
			if !ok {
				continue
			}
			byModel[model] = int(tokens)
		}
		if len(byModel) > 0 {
			out[ref] = byModel
		}
	}
	return out
}

func normalizeAccountUpdatedAt(raw json.RawMessage) map[string]int64 {
	out := map[string]int64{}
	for accountRef, value := range objectEntries(raw) {
		ref := strings.TrimSpace(accountRef)
		if ref == "" {
			continue
		}
		milliseconds, ok := positiveInteger(value)
		if !ok {
			continue
		}
		out[ref] = milliseconds
	}
	return out
}

// normalizeRetained 解析离开运行池账号的保留目录，兼容数组与 {provider, models} 两种形状。
func normalizeRetained(raw json.RawMessage) map[string]modelsnapshot.Retained {
	out := map[string]modelsnapshot.Retained{}
	for accountRef, value := range objectEntries(raw) {
		ref := strings.TrimSpace(accountRef)
		if ref == "" {
			continue
		}
		var models []string
		provider := ""
		var list []json.RawMessage
		if err := json.Unmarshal(value, &list); err == nil {
			for _, entry := range list {
				var model string
				if json.Unmarshal(entry, &model) == nil {
					models = append(models, model)
				}
			}
		} else {
			var object struct {
				Provider json.RawMessage `json:"provider"`
				Models   []string        `json:"models"`
			}
			if json.Unmarshal(value, &object) != nil {
				continue
			}
			provider = strings.ToLower(stringValue(object.Provider))
			models = object.Models
		}
		normalized := make([]string, 0, len(models))
		seen := make(map[string]struct{}, len(models))
		for _, model := range models {
			trimmed := strings.TrimSpace(model)
			if trimmed == "" {
				continue
			}
			if _, duplicate := seen[trimmed]; duplicate {
				continue
			}
			seen[trimmed] = struct{}{}
			normalized = append(normalized, trimmed)
			if len(normalized) >= 500 {
				break
			}
		}
		if len(normalized) == 0 {
			continue
		}
		out[ref] = modelsnapshot.Retained{Provider: provider, Models: normalized}
	}
	if len(out) <= 200 {
		return out
	}
	refs := make([]string, 0, len(out))
	for ref := range out {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	trimmed := make(map[string]modelsnapshot.Retained, 200)
	for _, ref := range refs[len(refs)-200:] {
		trimmed[ref] = out[ref]
	}
	return trimmed
}

func normalizeAccountScanned(raw json.RawMessage) map[string]int64 {
	out := map[string]int64{}
	for accountRef, value := range objectEntries(raw) {
		ref := strings.TrimSpace(accountRef)
		if ref == "" {
			continue
		}
		count, ok := positiveInteger(value)
		if !ok {
			continue
		}
		out[ref] = count
	}
	return out
}

func stringValue(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func nonNegativeInteger(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0
	}
	if number < 0 || number > maxSafeInteger || math.Trunc(number) != number {
		return 0
	}
	return int64(number)
}

// positiveInteger 只接受正的、整数的、安全范围内的 JSON 数字。
func positiveInteger(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0, false
	}
	if number <= 0 || number > maxSafeInteger || math.Trunc(number) != number {
		return 0, false
	}
	return int64(number), true
}
