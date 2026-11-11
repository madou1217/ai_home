package nativeaccount

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// SanitizeClineProvidersDocument 把 providers.json 整库收窄成账号自己的槽位。
//
// 该文件同时装着 anthropic / openrouter / gemini 等其它 Provider 的明文密钥，
// 整份入库等于把别人的登录态抄进 cline 账号记录。这里与 Node 的
// sanitizeClineProvidersDocument 同口径：只保留 cline / cline-pass 两个槽位，
// version 归一回数字，expiresAt 归一回毫秒数字，并保留 CLI 自己的 modes 书签。
//
// 收窄在删除投影采纳凭据时执行：投影文件可能被 CLI 或网关 profile 写入额外槽位
// （如 openai-compatible），不能因为「文件在账号沙箱里」就整份信任。
func SanitizeClineProvidersDocument(document []byte) ([]byte, error) {
	var source map[string]any
	if err := decodeStrictJSON(document, &source); err != nil || source == nil {
		return nil, ErrInvalidNativeArtifacts
	}
	sourceProviders := object(source["providers"])
	providers := make(map[string]any, len(clineSlots))
	for _, slotID := range clineSlots {
		slot := object(sourceProviders[slotID])
		if slot == nil {
			continue
		}
		providers[slotID] = normalizeClineSlot(slot)
	}
	lastUsed := text(source["lastUsedProvider"])
	if lastUsed != clineSlots[0] && lastUsed != clineSlots[1] {
		if providers[clineSlots[1]] != nil {
			lastUsed = clineSlots[1]
		} else {
			lastUsed = clineSlots[0]
		}
	}
	next := map[string]any{
		"version":          normalizeClineDocumentVersion(source["version"]),
		"lastUsedProvider": lastUsed,
		"providers":        providers,
	}
	// modes 是 CLI 的会话模式书签，不是凭据；保留以免投影回沙箱时被清掉。
	if modes := object(source["modes"]); modes != nil {
		next["modes"] = modes
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		return nil, ErrInvalidNativeArtifacts
	}
	return encoded, nil
}

// normalizeClineSlot 只把 expiresAt 归一成毫秒数字，其余设置原样保留。
func normalizeClineSlot(slot map[string]any) map[string]any {
	settings := object(slot["settings"])
	if settings == nil {
		return slot
	}
	auth := object(settings["auth"])
	if auth == nil {
		return slot
	}
	raw, present := auth["expiresAt"]
	if !present || raw == nil {
		return slot
	}
	if _, isNumber := raw.(float64); isNumber {
		return slot
	}
	expiresAt := normalizeClineExpiresAtMS(raw)
	if expiresAt <= 0 {
		return slot
	}
	nextAuth := copyClineObject(auth)
	nextAuth["expiresAt"] = expiresAt
	nextSettings := copyClineObject(settings)
	nextSettings["auth"] = nextAuth
	nextSlot := copyClineObject(slot)
	nextSlot["settings"] = nextSettings
	return nextSlot
}

func copyClineObject(source map[string]any) map[string]any {
	cloned := make(map[string]any, len(source)+1)
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

// normalizeClineDocumentVersion 把 CLI schema 要求的数字版本号归一。
func normalizeClineDocumentVersion(value any) float64 {
	if number, ok := value.(float64); ok && number > 0 && !math.IsInf(number, 0) && !math.IsNaN(number) {
		return number
	}
	if parsed, err := strconv.ParseFloat(text(value), 64); err == nil && parsed > 0 {
		return parsed
	}
	return 1
}

// normalizeClineExpiresAtMS 接受毫秒/秒时间戳与 RFC3339 字符串；无法解析返回 0。
func normalizeClineExpiresAtMS(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return clineSecondsOrMillis(typed)
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0
		}
		if parsed, err := strconv.ParseFloat(trimmed, 64); err == nil {
			return clineSecondsOrMillis(parsed)
		}
		if parsed, err := time.Parse(time.RFC3339, trimmed); err == nil {
			return float64(parsed.UnixMilli())
		}
	}
	return 0
}

func clineSecondsOrMillis(value float64) float64 {
	if value <= 0 || math.IsInf(value, 0) || math.IsNaN(value) {
		return 0
	}
	if value < 1e12 {
		return math.Round(value * 1000)
	}
	return math.Round(value)
}
