package sessionevents

import (
	"math"
	"strconv"
	"strings"
)

// RetryStatus 描述一次与 Node native-retry-status.js 同口径的标准化重试状态。
type RetryStatus struct {
	Type         string   `json:"type"`
	Phase        string   `json:"phase"`
	Source       string   `json:"source"`
	Provider     string   `json:"provider"`
	Attempt      int      `json:"attempt,omitempty"`
	MaxAttempts  int      `json:"maxAttempts,omitempty"`
	RetryAfterMs *float64 `json:"retryAfterMs,omitempty"`
	RetryAt      *float64 `json:"retryAt,omitempty"`
	Status       *int     `json:"status,omitempty"`
	Reason       string   `json:"reason,omitempty"`
	Message      string   `json:"message,omitempty"`
}

// NormalizeRetryStatus 把松散的重试状态负载归一为稳定结构。
func NormalizeRetryStatus(raw map[string]any, provider string) RetryStatus {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	if normalizedProvider == "" && raw != nil {
		normalizedProvider = strings.ToLower(strings.TrimSpace(anyString(raw["provider"])))
	}
	phase := strings.TrimSpace(anyString(raw["phase"]))
	if phase == "" {
		phase = "scheduled"
	}
	source := strings.TrimSpace(anyString(raw["source"]))
	if source == "" {
		source = "provider-runtime"
	}

	out := RetryStatus{
		Type:     "retry-status",
		Phase:    phase,
		Source:   source,
		Provider: normalizedProvider,
		Reason:   strings.TrimSpace(anyString(raw["reason"])),
		Message:  strings.TrimSpace(anyString(raw["message"])),
	}
	if raw == nil {
		return out
	}

	if attempt, ok := positiveInt(raw["attempt"]); ok {
		out.Attempt = attempt
	}
	if maxAttempts, ok := positiveInt(raw["maxAttempts"]); ok {
		out.MaxAttempts = maxAttempts
	}
	if retryAfterMs, ok := finiteFloat(raw["retryAfterMs"]); ok && retryAfterMs >= 0 {
		v := retryAfterMs
		out.RetryAfterMs = &v
	}
	if retryAt, ok := finiteFloat(raw["retryAt"]); ok && retryAt > 0 {
		v := retryAt
		out.RetryAt = &v
	}
	if status, ok := finiteFloat(raw["status"]); ok {
		v := int(math.Trunc(status))
		out.Status = &v
	}
	return out
}

// ToMap 把 RetryStatus 转为普通 map，便于写入会话状态快照。
func (status RetryStatus) ToMap() map[string]any {
	result := map[string]any{
		"type":     status.Type,
		"phase":    status.Phase,
		"source":   status.Source,
		"provider": status.Provider,
	}
	if status.Attempt > 0 {
		result["attempt"] = status.Attempt
	}
	if status.MaxAttempts > 0 {
		result["maxAttempts"] = status.MaxAttempts
	}
	if status.RetryAfterMs != nil {
		result["retryAfterMs"] = *status.RetryAfterMs
	}
	if status.RetryAt != nil {
		result["retryAt"] = *status.RetryAt
	}
	if status.Status != nil {
		result["status"] = *status.Status
	}
	if status.Reason != "" {
		result["reason"] = status.Reason
	}
	if status.Message != "" {
		result["message"] = status.Message
	}
	return result
}

func anyString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	default:
		return ""
	}
}

func finiteFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case float32:
		f := float64(typed)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return 0, false
		}
		return f, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

func positiveInt(value any) (int, bool) {
	num, ok := finiteFloat(value)
	if !ok || num <= 0 {
		return 0, false
	}
	trunc := int(math.Trunc(num))
	if trunc <= 0 {
		return 0, false
	}
	return trunc, true
}
