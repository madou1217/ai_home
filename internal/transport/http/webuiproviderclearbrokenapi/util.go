package webuiproviderclearbrokenapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// 下列取值助手与只读接口 webuiprovidercliupgradeapi 包内的同名私有函数同口径：
// 账本是外部 JSON，类型不可信，取值必须按「缺失即零值」处理。

func object(value any) map[string]any {
	typed, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return typed
}

func text(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func number(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	default:
		return 0
	}
}

func anyList(value any) []any {
	typed, ok := value.([]any)
	if !ok {
		return []any{}
	}
	return typed
}

func stringList(value any) []string {
	list := anyList(value)
	result := make([]string, 0, len(list))
	for _, item := range list {
		if text := text(item); text != "" {
			result = append(result, text)
		}
	}
	return result
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
