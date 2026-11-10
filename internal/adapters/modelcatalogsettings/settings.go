// Package modelcatalogsettings 读写 app-state.db 里的 model-catalog-settings 键。
//
// 文档形状与 Node lib/server/model-catalog-settings-store.js 的 v5 保持一致：
// accountModels 以 (accountRef, 小写模型 id) 为身份，legacyModels 以 (provider, 小写 id)
// 为身份；accountModels 按 provider/accountRef/id、legacyModels 按 provider/id 升序落盘。
//
// 归一化对坏数据只做「丢字段、丢记录」，不抛错：这份文档可能由旧版 Node 写入、
// 也可能被人工改过，未知 provider、非法 accountRef、类型不对的布尔/数字一律退化成默认值，
// 与 Node 的宽松读取同语义。
package modelcatalogsettings

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// DatabaseKey 是 Node app-state-store 中保存模型目录设置的 app_kv 键。
	DatabaseKey = "model-catalog-settings"
	// SettingsVersion 是当前持久化文档版本；v5 起「默认模型」按账号维度选择。
	SettingsVersion = 5
)

// CustomPricing 是账号自定义单价（每百万 token 美元）。
//
// 缺省维度用 nil 表示「未设置，回落基础价」，0 是合法价格——不能用零值判断缺失，
// 也不能把未设置的维度写成 0 落盘，否则 Node 侧会把「没改过」读成「免费」。
type CustomPricing struct {
	Input      *float64 `json:"input,omitempty"`
	Output     *float64 `json:"output,omitempty"`
	CacheRead  *float64 `json:"cacheRead,omitempty"`
	CacheWrite *float64 `json:"cacheWrite,omitempty"`
}

// AccountModel 是 (账号, 模型) 维度的设置记录。
type AccountModel struct {
	ID            string         `json:"id"`
	Provider      string         `json:"provider"`
	AccountRef    string         `json:"accountRef"`
	Enabled       bool           `json:"enabled"`
	Manual        bool           `json:"manual"`
	DefaultModel  bool           `json:"defaultModel"`
	Description   string         `json:"description"`
	CustomPricing *CustomPricing `json:"customPricing,omitempty"`
	CreatedAtMS   int64          `json:"createdAt"`
	UpdatedAtMS   int64          `json:"updatedAt"`
}

// LegacyModel 是无账号归属的旧版模型记录，只为读写往返保留。
type LegacyModel struct {
	ID          string `json:"id"`
	Provider    string `json:"provider"`
	Enabled     bool   `json:"enabled"`
	Manual      bool   `json:"manual"`
	Description string `json:"description"`
	CreatedAtMS int64  `json:"createdAt"`
	UpdatedAtMS int64  `json:"updatedAt"`
}

// Settings 是 v5 文档形状。
type Settings struct {
	Version       int            `json:"version"`
	AccountModels []AccountModel `json:"accountModels"`
	LegacyModels  []LegacyModel  `json:"legacyModels"`
	UpdatedAtMS   int64          `json:"updatedAt"`
}

// normalizeTimestampKeys 是记录里时间戳的新旧字段名；旧字段只在缺新字段时生效。
var normalizeTimestampKeys = map[string]string{
	"createdAt": "created_at",
	"updatedAt": "updated_at",
}

// accountScopeMarkerFields 是旧版本用过的账号范围标记。
//
// 带这些标记却没有合法 accountRef 的记录属于「账号范围记录但账号不可识别」，
// 既不能升级成 accountModels，也不能降级成 legacyModels（否则会变成全局生效）。
var accountScopeMarkerFields = []string{"accountRef", "accountKey", "accountId", "uniqueKey"}

// providerCatalog 只构建一次；BuiltinManifest 是静态合同，构建失败说明代码本身有问题。
var providerCatalog = sync.OnceValues(func() (*providers.Catalog, error) {
	return providers.NewCatalog(providers.BuiltinManifest())
})

// Normalize 把任意来源的文档规范化成 v5 形状，缺失的记录时间戳用当前时间补齐。
func Normalize(document any) Settings {
	return normalizeAt(document, time.Now().UnixMilli())
}

func normalizeAt(document any, nowMS int64) Settings {
	source := documentFields(document)
	accountModelsByKey := make(map[string]AccountModel)
	legacyModelsByKey := make(map[string]LegacyModel)

	for _, item := range arrayField(source, "accountModels") {
		record, ok := normalizeAccountModel(item, nowMS)
		if !ok {
			continue
		}
		accountModelsByKey[accountModelKey(record)] = record
	}

	// models 是旧版写入位置，legacyModels 是本包的落盘位置。两者都按同一套三分法处理：
	// 能升级成账号记录就升级，带账号范围标记但账号不可识别的丢弃，其余归为旧版记录。
	// 只读 models 会让本包 Save 后再次 Load 丢掉全部 legacyModels。
	for _, key := range []string{"models", "legacyModels"} {
		for _, item := range arrayField(source, key) {
			object, ok := itemObject(item)
			if !ok {
				continue
			}
			if record, ok := normalizeAccountModel(object, nowMS); ok {
				accountModelsByKey[accountModelKey(record)] = record
				continue
			}
			if hasAccountScopeMarker(object) {
				continue
			}
			if record, ok := normalizeLegacyModel(object, nowMS); ok {
				legacyModelsByKey[legacyModelKey(record)] = record
			}
		}
	}

	accountModels := make([]AccountModel, 0, len(accountModelsByKey))
	for _, record := range accountModelsByKey {
		accountModels = append(accountModels, record)
	}
	sort.Slice(accountModels, func(left, right int) bool {
		if accountModels[left].Provider != accountModels[right].Provider {
			return accountModels[left].Provider < accountModels[right].Provider
		}
		if accountModels[left].AccountRef != accountModels[right].AccountRef {
			return accountModels[left].AccountRef < accountModels[right].AccountRef
		}
		return accountModels[left].ID < accountModels[right].ID
	})

	legacyModels := make([]LegacyModel, 0, len(legacyModelsByKey))
	for _, record := range legacyModelsByKey {
		legacyModels = append(legacyModels, record)
	}
	sort.Slice(legacyModels, func(left, right int) bool {
		if legacyModels[left].Provider != legacyModels[right].Provider {
			return legacyModels[left].Provider < legacyModels[right].Provider
		}
		return legacyModels[left].ID < legacyModels[right].ID
	})

	updatedAt, _ := finiteNumber(field(source, "updatedAt"))
	return Settings{
		Version:       SettingsVersion,
		AccountModels: accountModels,
		LegacyModels:  legacyModels,
		UpdatedAtMS:   int64(updatedAt),
	}
}

func normalizeAccountModel(item any, nowMS int64) (AccountModel, bool) {
	source, ok := itemObject(item)
	if !ok {
		return AccountModel{}, false
	}
	id := modelIdentifier(source)
	if id == "" {
		return AccountModel{}, false
	}
	accountRef := normalizeAccountRef(field(source, "accountRef"))
	if accountRef == "" {
		return AccountModel{}, false
	}
	return AccountModel{
		ID:            id,
		Provider:      normalizeProvider(field(source, "provider")),
		AccountRef:    accountRef,
		Enabled:       enabledFlag(source),
		Manual:        manualFlag(source),
		DefaultModel:  defaultFlag(source),
		Description:   strings.TrimSpace(textField(source, "description")),
		CustomPricing: normalizeCustomPricing(field(source, "customPricing")),
		CreatedAtMS:   recordTimestamp(source, "createdAt", nowMS),
		UpdatedAtMS:   recordTimestamp(source, "updatedAt", nowMS),
	}, true
}

func normalizeLegacyModel(source map[string]any, nowMS int64) (LegacyModel, bool) {
	id := modelIdentifier(source)
	if id == "" {
		return LegacyModel{}, false
	}
	return LegacyModel{
		ID:          id,
		Provider:    normalizeProvider(field(source, "provider")),
		Enabled:     enabledFlag(source),
		Manual:      manualFlag(source),
		Description: strings.TrimSpace(textField(source, "description")),
		CreatedAtMS: recordTimestamp(source, "createdAt", nowMS),
		UpdatedAtMS: recordTimestamp(source, "updatedAt", nowMS),
	}, true
}

// normalizeCustomPricing 只保留 4 个已知维度的非负有限数；没有任何有效值返回 nil
// （语义 = 未设置），避免把「没有自定义价」持久化成空对象。
func normalizeCustomPricing(value any) *CustomPricing {
	source, ok := itemObject(value)
	if !ok {
		return nil
	}
	input := pricePointer(source, "input", "")
	output := pricePointer(source, "output", "")
	cacheRead := pricePointer(source, "cacheRead", "cache_read")
	cacheWrite := pricePointer(source, "cacheWrite", "cache_write")
	if input == nil && output == nil && cacheRead == nil && cacheWrite == nil {
		return nil
	}
	return &CustomPricing{Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite}
}

// pricePointer 读一个价格维度：现代键存在时不再回落到旧键（与 Node 的
// 「value[key] !== undefined ? value[key] : value[legacyKey]」一致）。
func pricePointer(source map[string]any, key string, legacyKey string) *float64 {
	raw, present := source[key]
	if !present && legacyKey != "" {
		raw, present = source[legacyKey]
	}
	if !present {
		return nil
	}
	number, ok := finiteNumber(raw)
	if !ok || number < 0 {
		return nil
	}
	return &number
}

func modelIdentifier(source map[string]any) string {
	for _, key := range []string{"id", "model", "modelId"} {
		if value := identifierText(field(source, key)); value != "" {
			return value
		}
	}
	return ""
}

// identifierText 只接受能安全转成模型 id 的标量；布尔和对象一律视为缺失。
func identifierText(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return ""
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case json.Number:
		return typed.String()
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	}
	return ""
}

// recordTimestamp 取第一个可解析的正数时间戳，缺失或非法时用 nowMS 补齐。
func recordTimestamp(source map[string]any, key string, nowMS int64) int64 {
	for _, candidate := range []string{key, normalizeTimestampKeys[key]} {
		if candidate == "" {
			continue
		}
		number, ok := finiteNumber(field(source, candidate))
		if ok && number > 0 {
			return int64(number)
		}
	}
	return nowMS
}

// enabledFlag 只有字面布尔 false 才表示停用（Node：source.enabled !== false）。
func enabledFlag(source map[string]any) bool {
	if value, ok := field(source, "enabled").(bool); ok {
		return value
	}
	return true
}

// manualFlag 只有字面布尔 true 才算手动模型（Node：source.manual === true）。
func manualFlag(source map[string]any) bool {
	value, ok := field(source, "manual").(bool)
	return ok && value
}

// defaultFlag 同时接受 v5 的 defaultModel 和旧版的 default 别名。
func defaultFlag(source map[string]any) bool {
	for _, key := range []string{"defaultModel", "default"} {
		if value, ok := field(source, key).(bool); ok && value {
			return true
		}
	}
	return false
}

func hasAccountScopeMarker(source map[string]any) bool {
	for _, key := range accountScopeMarkerFields {
		if truthy(field(source, key)) {
			return true
		}
	}
	return false
}

// truthy 复刻 JS 对标记字段的 Boolean() 判断：空串/0/null=false，数组和对象恒为真。
func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	case int:
		return typed != 0
	case int64:
		return typed != 0
	}
	return true
}

func normalizeProvider(value any) string {
	catalog, err := providerCatalog()
	if err != nil || catalog == nil {
		return ""
	}
	id, ok := catalog.CanonicalID(textFieldValue(value))
	if !ok {
		return ""
	}
	return id
}

// normalizeAccountRef 只接受规范公开账号引用（acct_ + 20 位小写十六进制）。
func normalizeAccountRef(value any) string {
	parsed, err := accountcore.ParseAccountRef(strings.TrimSpace(textFieldValue(value)))
	if err != nil {
		return ""
	}
	return parsed.String()
}

func accountModelKey(record AccountModel) string {
	return record.AccountRef + "\x00" + strings.ToLower(record.ID)
}

func legacyModelKey(record LegacyModel) string {
	return record.Provider + "\x00" + strings.ToLower(record.ID)
}

// documentFields 把调用方给的文档统一成 map：支持解码后的对象、JSON 文本和 Settings 本身。
func documentFields(document any) map[string]any {
	switch typed := document.(type) {
	case nil:
		return nil
	case map[string]any:
		return typed
	case string:
		return decodeFields(typed)
	case []byte:
		return decodeFields(string(typed))
	case Settings:
		return structFields(typed)
	case *Settings:
		if typed == nil {
			return nil
		}
		return structFields(*typed)
	}
	return nil
}

// structFields 借 JSON 标签把 Go 结构体还原成归一化入口用的通用形状。
func structFields(value any) map[string]any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return decodeFields(string(encoded))
}

// decodeFields 空文本、null、非法 JSON 和顶层非对象都按「没有设置」处理（Node 同款容错）。
func decodeFields(text string) map[string]any {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var document any
	if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
		return nil
	}
	fields, _ := document.(map[string]any)
	return fields
}

func arrayField(source map[string]any, key string) []any {
	values, _ := field(source, key).([]any)
	return values
}

func field(source map[string]any, key string) any {
	if source == nil {
		return nil
	}
	return source[key]
}

// itemObject 只接受对象；数组、标量和 nil 都不是一条记录。
func itemObject(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	return object, true
}

func textField(source map[string]any, key string) string {
	return textFieldValue(field(source, key))
}

// textFieldValue 只接受字符串；数字/布尔不参与 id、provider、描述这类文本字段。
func textFieldValue(value any) string {
	text, _ := value.(string)
	return text
}

// finiteNumber 把 JSON 数字、数字字符串和 Go 整型统一成有限 float64。
func finiteNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return finiteOrZero(typed)
	case float32:
		return finiteOrZero(float64(typed))
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return finiteOrZero(parsed)
	case string:
		return parseNumericString(typed)
	}
	return 0, false
}

func parseNumericString(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return finiteOrZero(parsed)
}

func finiteOrZero(number float64) (float64, bool) {
	if math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}
