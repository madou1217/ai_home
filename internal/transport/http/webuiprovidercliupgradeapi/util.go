package webuiprovidercliupgradeapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

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

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func ledgerGlobalEnabled(ledger map[string]any) bool {
	return object(ledger["global"])["enabled"] != false
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
