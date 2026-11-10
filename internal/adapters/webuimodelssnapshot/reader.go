// Package webuimodelssnapshot 提供 WebUI 模型目录快照的只读 Go 视图。
//
// 快照由 Node 侧写入 app-state 的 KV（cache:webui-models-snapshot.json），是
// WebUI 模型管理页与模型选择器的展示证据，不是 Go 的可路由模型表。本包只读、
// 只做归一：不写库、不探测上游、不参与推理路由。
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
	"strings"
	"time"

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

// Snapshot 是归一后的快照读模型。零值可用，所有查找返回零值。
type Snapshot struct {
	// Available 表示快照存在、是 JSON 对象且成功解析；false 时各表为空。
	Available bool
	// UpdatedAtMS 是快照写入时刻（Unix 毫秒），缺失或非法时为 0。
	UpdatedAtMS int64
	// ProbeVersion 是快照声明的账号探测语义版本，缺失时为 0。
	ProbeVersion int

	// ContextLimits 是 accountRef -> modelID -> 上游声明的上下文窗口。
	ContextLimits map[string]map[string]int
	// ByAccount 是 accountRef -> 模型 id；空清单不保留（没有条目 = 未知）。
	ByAccount map[string][]string
	// ErrorsByAccount 是 accountRef -> 上次探测错误；空消息不保留。
	ErrorsByAccount map[string]string
	// Labels 是 provider -> modelID -> 上游显示名。
	Labels map[string]map[string]string
	// AccountUpdatedAt 是 accountRef -> 该账号真正被探测过的时刻（Unix 毫秒）。
	// 仅当 ProbeVersion >= MinTrustedProbeVersion 时才有内容。
	AccountUpdatedAt map[string]int64
}

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
		ContextLimits       json.RawMessage `json:"contextLimits"`
		ByAccount           json.RawMessage `json:"byAccount"`
		ErrorsByAccount     json.RawMessage `json:"errorsByAccount"`
		Labels              json.RawMessage `json:"labels"`
		AccountUpdatedAt    json.RawMessage `json:"accountUpdatedAt"`
	}
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return snapshot
	}
	snapshot.Available = true
	snapshot.UpdatedAtMS, _ = positiveInteger(envelope.UpdatedAt)
	version, _ := positiveInteger(envelope.AccountProbeVersion)
	snapshot.ProbeVersion = int(version)
	snapshot.ContextLimits = normalizeContextLimits(envelope.ContextLimits)
	snapshot.ByAccount = normalizeByAccount(envelope.ByAccount)
	snapshot.ErrorsByAccount = normalizeErrors(envelope.ErrorsByAccount)
	snapshot.Labels = normalizeLabels(envelope.Labels)
	if snapshot.ProbeVersion >= MinTrustedProbeVersion {
		snapshot.AccountUpdatedAt = normalizeAccountUpdatedAt(envelope.AccountUpdatedAt)
	}
	return snapshot
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

func normalizeByAccount(raw json.RawMessage) map[string][]string {
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

func normalizeErrors(raw json.RawMessage) map[string]string {
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
