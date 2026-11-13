package providercliupgrade

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// LedgerFileName 是升级状态账本相对于 <aiHomeDir>/run 的文件名。
	LedgerFileName = "provider-cli-upgrade.json"
	// LedgerSchemaVersion 标识当前账本格式版本。
	LedgerSchemaVersion = 1
	// LedgerHistoryLimit 限制单个 provider 账本保留的最近历史条数。
	LedgerHistoryLimit = 20
	// ProjectionHistoryLimit 限制状态面板返回的最近历史条数。
	ProjectionHistoryLimit = 5
)

const (
	StateUnknown           = "unknown"
	StateHealthy           = "healthy"
	StateBaselineUnhealthy = "baseline_unhealthy"
	StateDeferred          = "deferred"
	StateRolledBack        = "rolled_back"
	StateBroken            = "broken"
)

// GlobalLedger 描述全局升级开关。
type GlobalLedger struct {
	Enabled        bool   `json:"enabled"`
	DisabledReason string `json:"disabledReason"`
}

// ProviderRecord 描述单个 provider 在账本中的持久记录。
type ProviderRecord struct {
	State                     string           `json:"state"`
	Channel                   string           `json:"channel"`
	OwnerPath                 string           `json:"ownerPath"`
	ResolvedPath              string           `json:"resolvedPath"`
	InstalledVersion          string           `json:"installedVersion"`
	LatestVersion             string           `json:"latestVersion"`
	TargetVersion             string           `json:"targetVersion"`
	KnownGoodVersion          string           `json:"knownGoodVersion"`
	KnownGoodRollbackable     bool             `json:"knownGoodRollbackable"`
	BaselineHealthy           *bool            `json:"baselineHealthy"`
	UserPin                   string           `json:"userPin"`
	Enabled                   bool             `json:"enabled"`
	DisabledReason            string           `json:"disabledReason"`
	BlockedVersions           []string         `json:"blockedVersions"`
	ShadowedNpmInstall        bool             `json:"shadowedNpmInstall"`
	LastCheckAt               int64            `json:"lastCheckAt"`
	LastCheckError            string           `json:"lastCheckError"`
	SoakUnknownCount          int64            `json:"soakUnknownCount"`
	LastApplyAt               int64            `json:"lastApplyAt"`
	LastApplyError            string           `json:"lastApplyError"`
	ConsecutiveFailures       int64            `json:"consecutiveFailures"`
	ConsecutiveDefers         int64            `json:"consecutiveDefers"`
	ConsecutiveQuiescentTicks int64            `json:"consecutiveQuiescentTicks"`
	LastDeferReason           string           `json:"lastDeferReason"`
	History                   []map[string]any `json:"history"`
}

// Ledger 是 provider-cli-upgrade.json 的内存模型。
type Ledger struct {
	SchemaVersion int                       `json:"schemaVersion"`
	Global        GlobalLedger              `json:"global"`
	Providers     map[string]ProviderRecord `json:"providers"`
}

// DefaultProviderRecord 返回缺省字段的 provider 账本记录（enabled 默认 true）。
func DefaultProviderRecord() ProviderRecord {
	return ProviderRecord{
		State:           StateUnknown,
		Enabled:         true,
		BlockedVersions: []string{},
		History:         []map[string]any{},
	}
}

// EmptyLedger 返回空账本（global.enabled 默认 true）。
func EmptyLedger() Ledger {
	return Ledger{
		SchemaVersion: LedgerSchemaVersion,
		Global: GlobalLedger{
			Enabled: true,
		},
		Providers: map[string]ProviderRecord{},
	}
}

// LedgerPath 返回 <aiHomeDir>/run/provider-cli-upgrade.json 的完整路径。
func LedgerPath(aiHomeDir string) string {
	dir := strings.TrimSpace(aiHomeDir)
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "run", LedgerFileName)
}

// ReadLedger 读取账本；文件不存在、损坏或 schemaVersion 不匹配时返回 EmptyLedger。
func ReadLedger(aiHomeDir string) Ledger {
	path := LedgerPath(aiHomeDir)
	if path == "" {
		return EmptyLedger()
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return EmptyLedger()
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil || asInt64(root["schemaVersion"]) != LedgerSchemaVersion {
		return EmptyLedger()
	}
	out := EmptyLedger()
	if globalMap := asMap(root["global"]); len(globalMap) > 0 {
		out.Global = GlobalLedger{
			Enabled:        globalMap["enabled"] != false,
			DisabledReason: asTrimmedText(globalMap["disabledReason"]),
		}
	}
	if providersMap := asMap(root["providers"]); len(providersMap) > 0 {
		for provider, rawRecord := range providersMap {
			recMap := asMap(rawRecord)
			out.Providers[provider] = decodeProviderRecord(recMap)
		}
	}
	return out
}

// WriteLedger 以 tmp + 0600 + rename 原子落盘账本（2 空格缩进）。
func WriteLedger(aiHomeDir string, ledger Ledger) error {
	path := LedgerPath(aiHomeDir)
	if path == "" {
		return errors.New("aiHomeDir 为空，无法写入升级账本")
	}
	runDir := filepath.Dir(path)
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return fmt.Errorf("创建升级账本目录失败: %w", err)
	}
	normalized := Ledger{
		SchemaVersion: LedgerSchemaVersion,
		Global:        ledger.Global,
		Providers:     map[string]ProviderRecord{},
	}
	for k, v := range ledger.Providers {
		normalized.Providers[k] = normalizeProviderRecord(v)
	}

	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(normalized); err != nil {
		return fmt.Errorf("编码升级账本失败: %w", err)
	}
	payload := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))

	tmp, err := os.CreateTemp(runDir, ".provider-cli-upgrade-*.tmp")
	if err != nil {
		return fmt.Errorf("创建升级账本临时文件失败: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("设置升级账本权限失败: %w", err)
	}
	_, writeErr := tmp.Write(payload)
	closeErr := tmp.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return fmt.Errorf("写入升级账本失败: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("替换升级账本失败: %w", err)
	}
	return nil
}

// Record 返回指定 provider 的账本记录副本；不存在则返回默认值。
func (ledger Ledger) Record(provider string) ProviderRecord {
	if ledger.Providers == nil {
		return DefaultProviderRecord()
	}
	rec, ok := ledger.Providers[provider]
	if !ok {
		return DefaultProviderRecord()
	}
	return normalizeProviderRecord(rec)
}

// WithProvider 返回更新了单个 provider 记录后的新账本。
func (ledger Ledger) WithProvider(provider string, next ProviderRecord) Ledger {
	providers := make(map[string]ProviderRecord, len(ledger.Providers)+1)
	for k, v := range ledger.Providers {
		providers[k] = v
	}
	providers[provider] = normalizeProviderRecord(next)
	return Ledger{
		SchemaVersion: LedgerSchemaVersion,
		Global:        ledger.Global,
		Providers:     providers,
	}
}

// AppendHistory 追加一条历史并裁剪至 LedgerHistoryLimit。
func AppendHistory(record ProviderRecord, entry map[string]any) []map[string]any {
	history := make([]map[string]any, 0, len(record.History)+1)
	for _, item := range record.History {
		if item != nil {
			history = append(history, cloneMap(item))
		}
	}
	if entry != nil {
		history = append(history, cloneMap(entry))
	}
	if len(history) > LedgerHistoryLimit {
		history = history[len(history)-LedgerHistoryLimit:]
	}
	return history
}

func normalizeProviderRecord(record ProviderRecord) ProviderRecord {
	if record.State == "" {
		record.State = StateUnknown
	}
	if record.BlockedVersions == nil {
		record.BlockedVersions = []string{}
	} else {
		record.BlockedVersions = append([]string(nil), record.BlockedVersions...)
	}
	if record.History == nil {
		record.History = []map[string]any{}
	} else {
		cloned := make([]map[string]any, 0, len(record.History))
		for _, item := range record.History {
			if item != nil {
				cloned = append(cloned, cloneMap(item))
			}
		}
		if len(cloned) > LedgerHistoryLimit {
			cloned = cloned[len(cloned)-LedgerHistoryLimit:]
		}
		record.History = cloned
	}
	return record
}

func decodeProviderRecord(raw map[string]any) ProviderRecord {
	rec := DefaultProviderRecord()
	if state := asTrimmedText(raw["state"]); state != "" {
		rec.State = state
	}
	rec.Channel = asTrimmedText(raw["channel"])
	rec.OwnerPath = asTrimmedText(raw["ownerPath"])
	rec.ResolvedPath = asTrimmedText(raw["resolvedPath"])
	rec.InstalledVersion = asTrimmedText(raw["installedVersion"])
	rec.LatestVersion = asTrimmedText(raw["latestVersion"])
	rec.TargetVersion = asTrimmedText(raw["targetVersion"])
	rec.KnownGoodVersion = asTrimmedText(raw["knownGoodVersion"])
	rec.KnownGoodRollbackable = raw["knownGoodRollbackable"] == true
	if raw["baselineHealthy"] != nil {
		if b, ok := raw["baselineHealthy"].(bool); ok {
			rec.BaselineHealthy = &b
		}
	}
	rec.UserPin = asTrimmedText(raw["userPin"])
	rec.Enabled = raw["enabled"] != false
	rec.DisabledReason = asTrimmedText(raw["disabledReason"])
	rec.BlockedVersions = asStringSlice(raw["blockedVersions"])
	rec.ShadowedNpmInstall = raw["shadowedNpmInstall"] == true
	rec.LastCheckAt = asInt64(raw["lastCheckAt"])
	rec.LastCheckError = asTrimmedText(raw["lastCheckError"])
	rec.SoakUnknownCount = asInt64(raw["soakUnknownCount"])
	rec.LastApplyAt = asInt64(raw["lastApplyAt"])
	rec.LastApplyError = asTrimmedText(raw["lastApplyError"])
	rec.ConsecutiveFailures = asInt64(raw["consecutiveFailures"])
	rec.ConsecutiveDefers = asInt64(raw["consecutiveDefers"])
	rec.ConsecutiveQuiescentTicks = asInt64(raw["consecutiveQuiescentTicks"])
	rec.LastDeferReason = asTrimmedText(raw["lastDeferReason"])
	if rawHistory, ok := raw["history"].([]any); ok {
		hist := make([]map[string]any, 0, len(rawHistory))
		for _, item := range rawHistory {
			if m := asMap(item); len(m) > 0 {
				hist = append(hist, cloneMap(m))
			}
		}
		if len(hist) > LedgerHistoryLimit {
			hist = hist[len(hist)-LedgerHistoryLimit:]
		}
		rec.History = hist
	}
	return rec
}

func cloneMap(src map[string]any) map[string]any {
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func asMap(value any) map[string]any {
	if m, ok := value.(map[string]any); ok && m != nil {
		return m
	}
	return map[string]any{}
}

func asTrimmedText(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func asInt64(value any) int64 {
	switch v := value.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case json.Number:
		parsed, _ := v.Int64()
		return parsed
	default:
		return 0
	}
}

func asStringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text := asTrimmedText(item); text != "" {
			out = append(out, text)
		}
	}
	return out
}
