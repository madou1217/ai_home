package desktopprotocol

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
)

var ErrChatOversize = errors.New("chat_event_too_large")

func chatOversize(input map[string]any) map[string]any {
	out := map[string]any{"version": Version, "type": "chat.error", "code": "chat_event_too_large", "message": "这条聊天内容超出桌面窗口传输限制，请在完整聊天页查看。"}
	for _, k := range []string{"requestId", "sessionId", "commandId", "generation"} {
		if v, ok := input[k]; ok {
			out[k] = v
		}
	}
	return out
}

func safeIdentifier(value any, max int) (string, bool) {
	text, ok := value.(string)
	text = strings.TrimSpace(text)
	return text, ok && text != "" && Units(text) <= max
}
func canonicalEvent(input map[string]any) (map[string]any, error) {
	out := map[string]any{}
	for _, key := range []string{"schema", "type", "eventId", "sessionId"} {
		v, ok := safeIdentifier(input[key], 240)
		if !ok {
			return nil, ErrInvalid
		}
		out[key] = v
	}
	for _, key := range []string{"seq", "at"} {
		n, ok := input[key].(float64)
		if !ok || math.Trunc(n) != n || n < 0 || n > 9007199254740991 {
			return nil, ErrInvalid
		}
		out[key] = n
	}
	for _, key := range []string{"itemId", "turnId", "runId"} {
		if raw, exists := input[key]; exists {
			v, ok := safeIdentifier(raw, 240)
			if !ok {
				return nil, ErrInvalid
			}
			out[key] = v
		}
	}
	source, ok := input["source"].(map[string]any)
	if !ok {
		return nil, ErrInvalid
	}
	normalized := map[string]any{}
	for _, key := range []string{"provider", "runtimeId"} {
		v, ok := safeIdentifier(source[key], 240)
		if !ok {
			return nil, ErrInvalid
		}
		normalized[key] = v
	}
	out["source"] = normalized
	payload, ok := input["payload"].(map[string]any)
	if !ok {
		return nil, ErrInvalid
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, ErrInvalid
	}
	if len(raw) > 90000 || !validDepth(payload, 0) {
		return nil, ErrChatOversize
	}
	out["payload"] = redact(payload, 0)
	return out, nil
}
func redact(value any, depth int) any {
	if depth > 64 {
		return nil
	}
	switch v := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, x := range v {
			lower := strings.ToLower(key)
			sensitive := false
			for _, word := range []string{"secret", "token", "credential", "authorization", "password", "apikey", "api_key", "api-key"} {
				if strings.Contains(lower, word) {
					sensitive = true
					break
				}
			}
			if !sensitive {
				out[key] = redact(x, depth+1)
			}
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = redact(x, depth+1)
		}
		return out
	default:
		return v
	}
}
func fileReference(input map[string]any) (map[string]any, error) {
	name, ok := safeIdentifier(input["name"], 240)
	if !ok {
		return nil, ErrInvalid
	}
	mime := Text(input["mimeType"])
	if mime == "" {
		mime = "text/plain"
	}
	if Units(mime) > 120 {
		return nil, ErrInvalid
	}
	out := map[string]any{"name": name, "mimeType": mime}
	path := strings.TrimSpace(Text(input["path"]))
	text := Text(input["text"])
	if path != "" {
		if Units(path) > 2048 {
			return nil, ErrInvalid
		}
		out["path"] = path
	} else {
		if text == "" || len(text) > 16<<10 {
			return nil, ErrInvalid
		}
		out["text"] = text
	}
	return out, nil
}
func chatTarget(input map[string]any) (map[string]any, error) {
	out := map[string]any{}
	for _, key := range []string{"kind", "label", "origin", "serverId"} {
		if raw, ok := input[key]; ok {
			v, ok := raw.(string)
			if !ok {
				return nil, ErrInvalid
			}
			v = strings.TrimSpace(v)
			if v == "" && key != "kind" {
				continue
			}
			if v == "" || Units(v) > 240 {
				return nil, ErrInvalid
			}
			out[key] = v
		}
	}
	if len(out) == 0 {
		return nil, ErrInvalid
	}
	return out, nil
}

func validDepth(value any, depth int) bool {
	if depth > 64 {
		return false
	}
	switch v := value.(type) {
	case map[string]any:
		for _, x := range v {
			if !validDepth(x, depth+1) {
				return false
			}
		}
	case []any:
		for _, x := range v {
			if !validDepth(x, depth+1) {
				return false
			}
		}
	}
	return true
}
