package usage

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

// 本文件移植 Node lib/server/agy-usage-snapshot.js 的读回侧：
//
//	isTrustedAgyUsageSnapshot    → parseUsageDocument + trusted
//	listAgyQuotaAvailableModels  → ListAvailableModels / SnapshotFacts.AvailableModels
//	applyAgyUsageSnapshotToAccount → BuildSnapshotFacts（把要写回账号的字段一次算好）
//	isAgyUsageSnapshotStale      → IsSnapshotStale
//	getAgyUsageRefreshTtlMs / TimeoutMs → UsageRefreshTTL / UsageRefreshTimeout
//	scheduleAgyUsageRefreshAfterFailure → ShouldRefreshAfterFailure
//
// 采集端（窗口推断、条目可用性、文档生成）在 strategy.go；这里只读文档、不解释上游响应。
// 默认值与判据逐条对齐，差异在注释里标明「故意不同」。

const (
	// defaultUsageRefreshTTLMS / defaultUsageRefreshTimeoutMS 与 Node agy-usage-snapshot.js 同值。
	defaultUsageRefreshTTLMS     = int64(60_000)
	defaultUsageRefreshTimeoutMS = int64(8_000)
	// Node normalizePositiveInteger 的上下界：TTL 5s–30min，超时 1s–30s。
	minUsageRefreshTTLMS     = int64(5_000)
	maxUsageRefreshTTLMS     = int64(30 * 60_000)
	minUsageRefreshTimeoutMS = int64(1_000)
	maxUsageRefreshTimeoutMS = int64(30_000)
)

// DocumentModel 是展示文档 models[] 的读回投影。
//
// RemainingPct 为 nil 表示条目没有数值（Node 的 null/缺失），与 0（明确耗尽）区分：
// 前者不参与 min 计算，后者会把账号压到 0。
type DocumentModel struct {
	Model            string
	RemainingPct     *float64
	ResetIn          string
	ResetAtMS        *int64
	DisplayName      string
	SupportsThinking bool
	SupportsImages   bool
	MaxTokens        *float64
	MaxOutputTokens  *float64
}

// SnapshotFacts 是 Node applyAgyUsageSnapshotToAccount 会写回账号的那组事实。
//
// Node 直接改 account 对象；Go 的账号模型没有这些字段，所以由调用方拿这份投影去落库/建视图。
type SnapshotFacts struct {
	// CapturedAtMS 对应 account.codeAssistQuotaCapturedAt：非有限或 <=0 时是 0。
	CapturedAtMS int64
	// Models 对应 account.codeAssistQuotaModels（文档 models[] 的可解析子集）。
	Models []DocumentModel
	// AvailableModels 对应 account.availableModels：remainingPct > 0 的模型名。
	AvailableModels []string
	// Project 对应 account.codeAssistProject；空值表示不写回。
	Project string
	// MinRemainingPct 对应 account.codeAssistQuotaMinRemainingPct：
	// 没有数值条目时是 nil（Node 的 null），否则是 0–100 的最小值。
	MinRemainingPct *float64
}

// usageDocument 是展示文档的原始 JSON 投影；字段保持 RawMessage，读写都不丢未知字段。
type usageDocument struct {
	object      map[string]json.RawMessage
	account     map[string]json.RawMessage
	models      []json.RawMessage
	modelsArray bool
}

// parseUsageDocument 解析顶层对象；非对象或非 JSON 一律不受信。
func parseUsageDocument(payload []byte) (usageDocument, bool) {
	object := rawObject(payload)
	if object == nil {
		return usageDocument{}, false
	}
	models, isArray := splitArray(object["models"])
	return usageDocument{
		object:      object,
		account:     rawObject(object["account"]),
		models:      models,
		modelsArray: isArray,
	}, true
}

// trusted 复刻 Node isTrustedAgyUsageSnapshot：
// schemaVersion === 2（严格数字，字符串 "2" 不受信）、kind、source 逐字相等、models 是数组。
func (document usageDocument) trusted() bool {
	version := bytes.TrimSpace(document.object["schemaVersion"])
	if len(version) == 0 || !isJSONNumberToken(version) {
		return false
	}
	numeric, err := strconv.ParseFloat(string(version), 64)
	if err != nil || numeric != schemaVersion {
		return false
	}
	if readText(document.object["kind"]) != documentKind {
		return false
	}
	if readText(document.object["source"]) != sourceID {
		return false
	}
	return document.modelsArray
}

// capturedAtMS 复刻 Node Number(snapshot.capturedAt) || 0：非有限或 <=0 归零。
func (document usageDocument) capturedAtMS() int64 {
	value, ok := jsNumber(firstField(document.object, "capturedAt"))
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	return int64(math.Trunc(value))
}

// availableModels 复刻 Node listAgyQuotaAvailableModels：
// Number(model.remainingPct) > 0 的条目，取 model 文本并去掉空值。
func (document usageDocument) availableModels() []string {
	models := make([]string, 0, len(document.models))
	for _, raw := range document.models {
		object := rawObject(raw)
		if object == nil {
			continue
		}
		remaining, ok := jsNumber(firstField(object, "remainingPct"))
		if !ok || math.IsNaN(remaining) || !(remaining > 0) {
			continue
		}
		if model := readText(firstField(object, "model")); model != "" {
			models = append(models, model)
		}
	}
	return models
}

// parseDocumentModel 读取 models[] 的单项。字段名只认 Node 写出的 camelCase 形态。
func parseDocumentModel(raw json.RawMessage) (DocumentModel, bool) {
	object := rawObject(raw)
	if object == nil {
		return DocumentModel{}, false
	}
	model := readText(firstField(object, "model"))
	if model == "" {
		return DocumentModel{}, false
	}
	entry := DocumentModel{
		Model:            model,
		RemainingPct:     optionalNumberValue(firstField(object, "remainingPct")),
		ResetIn:          readText(firstField(object, "resetIn")),
		DisplayName:      readText(firstField(object, "displayName")),
		SupportsThinking: jsTruthy(firstField(object, "supportsThinking")),
		SupportsImages:   jsTruthy(firstField(object, "supportsImages")),
		MaxTokens:        nullableJSNumeric(firstField(object, "maxTokens")),
		MaxOutputTokens:  nullableJSNumeric(firstField(object, "maxOutputTokens")),
	}
	if resetAtMS := nullableJSNumeric(firstField(object, "resetAtMs")); resetAtMS != nil {
		value := int64(math.Trunc(*resetAtMS))
		entry.ResetAtMS = &value
	}
	return entry, true
}

// BuildSnapshotFacts 复刻 Node applyAgyUsageSnapshotToAccount 的派生部分。
//
// 不受信的文档返回 false，调用方应保持账号原状（Node 也是直接 return account）。
func BuildSnapshotFacts(payload []byte) (SnapshotFacts, bool) {
	document, ok := parseUsageDocument(payload)
	if !ok || !document.trusted() {
		return SnapshotFacts{}, false
	}
	facts := SnapshotFacts{
		CapturedAtMS:    document.capturedAtMS(),
		AvailableModels: document.availableModels(),
		Project:         readText(firstField(document.account, "project")),
	}
	for _, raw := range document.models {
		if model, ok := parseDocumentModel(raw); ok {
			facts.Models = append(facts.Models, model)
		}
	}
	facts.MinRemainingPct = minRemainingPct(facts.Models)
	return facts, true
}

// ListAvailableModels 复刻 Node listAgyQuotaAvailableModels 的公开入口。
func ListAvailableModels(payload []byte) []string {
	document, ok := parseUsageDocument(payload)
	if !ok || !document.trusted() {
		return nil
	}
	return document.availableModels()
}

// IsSnapshotStale 复刻 Node isAgyUsageSnapshotStale：
// 不可信、capturedAt 缺失/非正、或 now-capturedAt >= ttl 都算过期。
func IsSnapshotStale(payload []byte, ttlMS int64, nowMS int64) bool {
	document, ok := parseUsageDocument(payload)
	if !ok || !document.trusted() {
		return true
	}
	capturedAt := document.capturedAtMS()
	if capturedAt <= 0 {
		return true
	}
	if ttlMS < 0 {
		ttlMS = 0
	}
	return nowMS-capturedAt >= ttlMS
}

// UsageRefreshTTL 复刻 Node getAgyUsageRefreshTtlMs（默认 60s，夹在 5s–30min）。
//
// configured=false 对应 Node 的「值不是有限数字」（未配置/非法文本）→ 返回默认值；
// 已配置的 0 或负数会被夹到下限，与 Math.max(min, Math.min(max, Math.floor(x))) 一致。
func UsageRefreshTTL(configuredMS int64, configured bool) int64 {
	if !configured {
		return defaultUsageRefreshTTLMS
	}
	return clampInt64(configuredMS, minUsageRefreshTTLMS, maxUsageRefreshTTLMS)
}

// UsageRefreshTimeout 复刻 Node getAgyUsageRefreshTimeoutMs（默认 8s，夹在 1s–30s）。
func UsageRefreshTimeout(configuredMS int64, configured bool) int64 {
	if !configured {
		return defaultUsageRefreshTimeoutMS
	}
	return clampInt64(configuredMS, minUsageRefreshTimeoutMS, maxUsageRefreshTimeoutMS)
}

// ShouldRefreshAfterFailure 复刻 Node scheduleAgyUsageRefreshAfterFailure 的触发条件：
// 只有 agy 的限流 / 模型额度耗尽 / 模型容量不可用 / 地区不支持需要强制刷新额度快照。
func ShouldRefreshAfterFailure(provider, failureKind string) bool {
	if strings.TrimSpace(provider) != agy.ProviderID {
		return false
	}
	switch strings.TrimSpace(failureKind) {
	case "rate_limited", "model_quota_exhausted", "model_capacity_unavailable", "location_unsupported":
		return true
	default:
		return false
	}
}

// minRemainingPct 复刻 Node getMinRemainingPctFromUsageSnapshot 的 models[] 分支：
// 没有数值条目返回 nil；否则取最小值并夹到 0–100。
func minRemainingPct(models []DocumentModel) *float64 {
	minimum := math.Inf(1)
	found := false
	for _, model := range models {
		if model.RemainingPct == nil {
			continue
		}
		value := *model.RemainingPct
		if math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		if value < minimum {
			minimum = value
			found = true
		}
	}
	if !found {
		return nil
	}
	clamped := math.Max(0, math.Min(100, minimum))
	return &clamped
}

func clampInt64(value int64, minimum int64, maximum int64) int64 {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

// rawObject 只接受 JSON 对象；其余（数组/标量/null/非法 JSON）返回 nil。
func rawObject(payload []byte) map[string]json.RawMessage {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return nil
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(trimmed, &object) != nil || object == nil {
		return nil
	}
	return object
}

// splitArray 区分「不是数组」和「空数组」。
func splitArray(payload json.RawMessage) ([]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) < 2 || trimmed[0] != '[' {
		return nil, false
	}
	var list []json.RawMessage
	if json.Unmarshal(trimmed, &list) != nil {
		return nil, false
	}
	return list, true
}

// arrayOf 是 splitArray 的宽松形态：非数组返回 nil。
func arrayOf(payload json.RawMessage) []json.RawMessage {
	list, _ := splitArray(payload)
	return list
}

// readText 对字符串字段做 trim；非字符串（数字/布尔/对象）按缺失处理。
//
// 故意不同：Node normalizeText 会 String() 一切值；额度文档里这些字段本该是字符串，
// 把数字当 ID/邮箱只会在后续产生难以解释的键，Go 直接视为缺失。
func readText(payload json.RawMessage) string {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) < 2 || trimmed[0] != '"' {
		return ""
	}
	var text string
	if json.Unmarshal(trimmed, &text) != nil {
		return ""
	}
	return strings.TrimSpace(text)
}

// firstField 取第一个「存在且不是 null」的字段，对应 Node 的 a ?? b 与 a || b（对象场景）。
func firstField(source map[string]json.RawMessage, keys ...string) json.RawMessage {
	for _, key := range keys {
		raw, ok := source[key]
		if ok && !isJSONNull(raw) {
			return raw
		}
	}
	return nil
}

// firstTextField 取第一个 trim 后非空的字符串字段，对应 Node 的 a || b（字符串场景）。
func firstTextField(source map[string]json.RawMessage, keys ...string) string {
	for _, key := range keys {
		if text := readText(source[key]); text != "" {
			return text
		}
	}
	return ""
}

// isJSONNull 判断原始值是否是 null。
func isJSONNull(payload json.RawMessage) bool {
	return string(bytes.TrimSpace(payload)) == "null"
}

// isJSONNumberToken 判断原始值是否是 JSON 数字（Node === 2 不会接受字符串 "2"）。
func isJSONNumberToken(payload json.RawMessage) bool {
	if len(payload) == 0 {
		return false
	}
	first := payload[0]
	return (first >= '0' && first <= '9') || first == '-'
}

// jsNumber 复刻 JS 的 Number(value)：number 原样、字符串按 ParseFloat（"" → 0）、
// bool → 1/0、null → 0。
//
// 故意不同：object/array 的隐式转换（{} → NaN、[] → 0、[1] → 1）没有业务含义，
// 一律按非数值处理；bool 仍然保留，因为 Number(true) === 1 会影响「是否可用」的判据。
func jsNumber(payload json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return 0, false
	}
	switch trimmed[0] {
	case '"':
		text := readText(trimmed)
		if text == "" {
			return 0, true
		}
		value, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0, false
		}
		return value, true
	case 't':
		return 1, true
	case 'f':
		return 0, true
	case 'n':
		return 0, true
	case '{', '[':
		return 0, false
	default:
		var value float64
		if json.Unmarshal(trimmed, &value) != nil {
			return 0, false
		}
		return value, true
	}
}

// jsTruthy 复刻 JS 的 Boolean(value)：{} / [] 也是真值。
func jsTruthy(payload json.RawMessage) bool {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return false
	}
	switch trimmed[0] {
	case 'n':
		return false
	case 't':
		return true
	case 'f':
		return false
	case '"':
		return readText(trimmed) != ""
	case '{', '[':
		return true
	default:
		value, ok := jsNumber(trimmed)
		return ok && !math.IsNaN(value) && value != 0
	}
}

// nullableJSNumeric 复刻 Node toNullableNumber：Number(x) 有限则取数值，否则 nil。
func nullableJSNumeric(payload json.RawMessage) *float64 {
	value, ok := jsNumber(payload)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}

// optionalNumberValue 复刻 Node usage-remaining.js 的 readOptionalNumber：
// null/缺失/空串/非数值都是 nil（未知），与 0（明确耗尽）区分。
func optionalNumberValue(payload json.RawMessage) *float64 {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || isJSONNull(trimmed) {
		return nil
	}
	if trimmed[0] == '"' {
		var text string
		if json.Unmarshal(trimmed, &text) != nil {
			return nil
		}
		text = strings.TrimSpace(text)
		if text == "" {
			return nil
		}
		value, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil
		}
		return &value
	}
	if trimmed[0] == '{' || trimmed[0] == '[' {
		return nil
	}
	value, ok := jsNumber(trimmed)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	return &value
}

// usageRefreshNow 只在调用方没有给出时间时兜底；生产调用必须传确定性时间。
func usageRefreshNow(nowMS int64) int64 {
	if nowMS > 0 {
		return nowMS
	}
	return time.Now().UnixMilli()
}
