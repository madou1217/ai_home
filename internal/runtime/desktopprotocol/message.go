// Package desktopprotocol owns the versioned native desktop JSONL boundary.
// It contains no process, UI, HTTP or credential storage operations.
package desktopprotocol

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"unicode/utf16"
)

const Version = 1
const MaxFrameBytes = 100000
const MaxTextUnits = 8000

var ErrInvalid = errors.New("desktop_protocol_invalid")
var ErrVersion = errors.New("desktop_protocol_version_unsupported")
var allowed = map[string]bool{"hello": true, "ready": true, "configure": true, "status": true, "selection-state": true, "translate": true, "translate-intent": true, "cancel": true, "settings": true, "confirmation": true, "start": true, "attempt_start": true, "delta": true, "done": true, "error": true, "server-target": true, "server-target-error": true, "webui-focus": true, "request-permission": true, "host-translate": true, "shutdown": true, "chat.open": true, "chat.submit": true, "chat.stop": true, "chat.close": true, "chat.event": true, "chat.error": true}

func Decode(line []byte) (map[string]any, error) {
	if len(line) == 0 || len(line) > MaxFrameBytes {
		return nil, ErrInvalid
	}
	var message map[string]any
	if json.Unmarshal(line, &message) != nil || message == nil {
		return nil, ErrInvalid
	}
	return Normalize(message)
}
func Encode(message map[string]any) ([]byte, error) {
	initial, err := json.Marshal(message)
	if err != nil {
		return nil, ErrInvalid
	}
	if len(initial) > MaxFrameBytes && message["type"] == "chat.event" {
		return Encode(chatOversize(message))
	}
	// Configure can contain a full host catalog; project it deterministically below.
	if len(initial) > 4<<20 {
		return nil, ErrInvalid
	}
	if len(initial) > MaxFrameBytes && message["type"] != "configure" {
		return nil, ErrInvalid
	}
	var copied map[string]any
	if json.Unmarshal(initial, &copied) != nil {
		return nil, ErrInvalid
	}
	safe, err := Normalize(copied)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(safe)
	if err != nil || len(data) > MaxFrameBytes {
		return nil, ErrInvalid
	}
	return append(data, '\n'), nil
}
func Text(value any) string { s, _ := value.(string); return s }
func Units(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}
func bounded(value any, max int) string {
	s := Text(value)
	if Units(s) <= max {
		return s
	}
	n := 0
	for i, r := range s {
		n += utf16.RuneLen(r)
		if n > max {
			return s[:i]
		}
	}
	return s
}
func integer(v any) (int64, bool) {
	switch n := v.(type) {
	case float64:
		if !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && n >= 0 && n <= 2147483647 {
			return int64(n), true
		}
	case int:
		return int64(n), n >= 0 && int64(n) <= 2147483647
	case int64:
		return n, n >= 0 && n <= 2147483647
	case uint64:
		return int64(n), n <= 2147483647
	}
	return 0, false
}
func Normalize(input map[string]any) (map[string]any, error) {
	if input == nil {
		return nil, ErrInvalid
	}
	if raw, exists := input["version"]; exists {
		v, ok := integer(raw)
		if !ok || v != Version {
			return nil, ErrVersion
		}
	}
	kind := strings.TrimSpace(Text(input["type"]))
	if !allowed[kind] {
		return nil, ErrInvalid
	}
	result := map[string]any{"version": Version, "type": kind}
	if id := strings.TrimSpace(bounded(input["id"], 160)); id != "" {
		result["id"] = id
	}
	if raw, exists := input["generation"]; exists {
		n, ok := integer(raw)
		if !ok {
			return nil, ErrInvalid
		}
		result["generation"] = n
	}
	copyStrings := func(keys []string, limit int) {
		for _, key := range keys {
			if _, ok := input[key]; ok {
				result[key] = bounded(input[key], limit)
			}
		}
	}
	switch kind {
	case "translate", "translate-intent", "host-translate":
		text := Text(input["text"])
		if result["id"] == nil || text == "" || Units(text) > MaxTextUnits {
			return nil, ErrInvalid
		}
		result["text"] = text
		copyStrings([]string{"source", "target", "targetPolicy", "provider", "model"}, 200)
	case "delta":
		text := Text(input["content"])
		if len(text) > 90000 {
			return nil, ErrInvalid
		}
		result["content"] = text
	case "done":
		if text, ok := input["text"]; ok {
			value := Text(text)
			if len(value) > 90000 {
				return nil, ErrInvalid
			}
			result["text"] = value
		}
		if input["usage"] != nil {
			result["usage"] = limited(input["usage"], 0, new(int))
		}
	case "error", "server-target-error":
		copyStrings([]string{"code"}, 120)
		copyStrings([]string{"message"}, 1000)
		if v, ok := input["retryable"].(bool); ok {
			result["retryable"] = v
		}
	case "status":
		copyStrings([]string{"detail"}, 1000)
		copyStrings([]string{"platform", "permission", "shortcut", "nativeShortcut"}, 120)
		if v, ok := input["trusted"].(bool); ok {
			result["trusted"] = v
		}
		if input["captureModes"] != nil {
			result["captureModes"] = limited(input["captureModes"], 0, new(int))
		}
	case "selection-state":
		copyStrings([]string{"outcome", "application"}, 120)
		for _, k := range []string{"hitPID", "focusPID", "x", "y"} {
			if n, ok := input[k].(float64); ok && !math.IsNaN(n) && !math.IsInf(n, 0) {
				result[k] = n
			}
		}
	case "server-target":
		copyStrings([]string{"origin", "serverId", "label"}, 240)
	case "webui-focus":
		if n, ok := input["until"].(float64); ok && !math.IsNaN(n) && !math.IsInf(n, 0) {
			result["until"] = n
		} else if n, ok := input["until"].(int64); ok {
			result["until"] = n
		}
	case "confirmation":
		copyStrings([]string{"state", "detected", "confidence", "target"}, 120)
		result["suggestedTargets"] = limited(input["suggestedTargets"], 0, new(int))
	case "start", "attempt_start":
		copyStrings([]string{"from", "to", "fromLabel", "toLabel", "model", "provider"}, 240)
	case "settings":
		action := Text(input["action"])
		if action != "save" && action != "close" {
			return nil, ErrInvalid
		}
		result["action"] = action
		if action == "save" {
			patch, ok := input["patch"].(map[string]any)
			if !ok {
				return nil, ErrInvalid
			}
			result["patch"] = SettingsPatch(patch)
		}
	case "configure":
		for _, k := range []string{"target", "autoCopy", "copyScope", "executionTarget", "shortcut", "shortcutEnabled", "chatShortcut", "chatShortcutEnabled", "serverTarget", "serverTargets", "chatTarget", "chatModel", "defaultModel", "defaultProvider", "model", "provider", "port", "platform", "captureModes", "permission", "nativeShortcut", "largePasteChars", "readingTheme", "quickChatOrigin", "quickChatKey"} {
			if v, ok := input[k]; ok {
				switch value := v.(type) {
				case string:
					result[k] = bounded(value, 1000)
				case bool, float64, int, int64:
					result[k] = value
				default:
					result[k] = limited(v, 0, new(int))
				}
			}
		}
		if value, ok := input["models"]; ok {
			list, ok := value.([]any)
			if !ok {
				return nil, ErrInvalid
			}
			models := make([]any, 0, min(len(list), 256))
			for i, item := range list {
				if i >= 256 {
					break
				}
				model, ok := item.(map[string]any)
				if !ok {
					continue
				}
				id := bounded(model["id"], 200)
				if id == "" {
					continue
				}
				label := bounded(model["label"], 240)
				if label == "" {
					label = id
				}
				models = append(models, map[string]any{"id": id, "provider": bounded(model["provider"], 100), "label": label})
			}
			result["models"] = models
		}
		if value, ok := input["languages"]; ok {
			list, ok := value.([]any)
			if !ok || len(list) > 256 {
				return nil, ErrInvalid
			}
			result["languages"] = list
		}
	default:
		if strings.HasPrefix(kind, "chat.") {
			for _, k := range []string{"requestId", "sessionId", "commandId"} {
				if raw, ok := input[k]; ok {
					s := strings.TrimSpace(Text(raw))
					if s == "" || Units(s) > 160 {
						return nil, ErrInvalid
					}
					result[k] = s
				}
			}
			if result["requestId"] == nil {
				return nil, ErrInvalid
			}
			switch kind {
			case "chat.open":
				target, ok := input["target"].(map[string]any)
				if !ok {
					return nil, ErrInvalid
				}
				normalized, err := chatTarget(target)
				if err != nil {
					return nil, err
				}
				result["target"] = normalized
			case "chat.submit":
				text := strings.TrimSpace(Text(input["text"]))
				if result["sessionId"] == nil || result["commandId"] == nil || text == "" || Units(text) > MaxTextUnits {
					return nil, ErrInvalid
				}
				result["text"] = text
				if ref, ok := input["fileReference"].(map[string]any); ok {
					raw, _ := json.Marshal(ref)
					if len(raw) > 18<<10 {
						return nil, ErrInvalid
					}
					normalized, err := fileReference(ref)
					if err != nil {
						return nil, err
					}
					result["fileReference"] = normalized
				}
			case "chat.stop":
				if result["sessionId"] == nil || result["commandId"] == nil {
					return nil, ErrInvalid
				}
			case "chat.event":
				event, ok := input["event"].(map[string]any)
				if !ok || result["sessionId"] == nil {
					return nil, ErrInvalid
				}
				normalized, err := canonicalEvent(event)
				if err != nil {
					if errors.Is(err, ErrChatOversize) {
						return chatOversize(result), nil
					}
					return nil, err
				}
				result["event"] = normalized
			case "chat.error":
				copyStrings([]string{"code"}, 160)
				copyStrings([]string{"message"}, 1000)
			}
		}
	}
	return result, nil
}

func SettingsPatch(input map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"source", "target", "model", "provider", "targetPolicy", "autoCopy", "copyScope", "executionTarget", "shortcut", "chatShortcut", "shortcutEnabled", "chatShortcutEnabled", "routes", "serverTarget", "serverTargets", "readingTheme"} {
		if value, ok := input[key]; ok {
			out[key] = limited(value, 0, new(int))
		}
	}
	return out
}
func limited(value any, depth int, used *int) any {
	if depth > 4 || *used > 16<<10 {
		return nil
	}
	switch v := value.(type) {
	case nil, bool, float64, int, int64:
		*used += 16
		return v
	case string:
		s := bounded(v, 400)
		*used += len(s)
		return s
	case []any:
		out := make([]any, 0, min(32, len(v)))
		for i, x := range v {
			if i >= 32 || *used > 16<<10 {
				break
			}
			out = append(out, limited(x, depth+1, used))
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, x := range v {
			if len(out) >= 32 || *used > 16<<10 {
				break
			}
			out[bounded(k, 80)] = limited(x, depth+1, used)
		}
		return out
	default:
		raw, err := json.Marshal(value)
		if err != nil || len(raw) > 16<<10 {
			return nil
		}
		var decoded any
		if json.Unmarshal(raw, &decoded) != nil {
			return nil
		}
		return limited(decoded, depth, used)
	}
}
