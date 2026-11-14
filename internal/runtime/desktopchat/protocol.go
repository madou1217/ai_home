package desktopchat

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

const maxSafeInteger int64 = 9007199254740991
const maxMessageBytes = 1 << 20

var safeErrorCode = regexp.MustCompile(`^[a-z][a-z0-9_.:-]{0,95}$`)

type Error struct{ Code string }

func (err *Error) Error() string { return err.Code }
func failure(code string) error  { return &Error{Code: code} }
func codeOf(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "chat_runtime_timeout"
	}
	var local *Error
	if errors.As(err, &local) {
		return local.Code
	}
	if runtimeErr, ok := chatruntime.AsRuntimeError(err); ok && safeErrorCode.MatchString(runtimeErr.Code) {
		return runtimeErr.Code
	}
	// The desktop host's existing settings resolver reports this stable sentinel
	// as errors.New; never reflect arbitrary transport/provider messages.
	if err != nil && err.Error() == "chat_target_unconfigured" {
		return "chat_target_unconfigured"
	}
	return "chat_runtime_failed"
}

type message struct {
	typ, requestID, sessionID, commandID, text string
	generation                                 int64
	hasGeneration                              bool
	target                                     map[string]any
	reference                                  *fileReference
}
type fileReference struct{ name, mime, path, text string }

func text(value any) string { valueString, _ := value.(string); return strings.TrimSpace(valueString) }
func safeInteger(value any) (int64, bool) {
	var n int64
	switch v := value.(type) {
	case int:
		n = int64(v)
	case int64:
		n = v
	case int32:
		n = int64(v)
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Trunc(v) != v || v < 0 || v > float64(maxSafeInteger) {
			return 0, false
		}
		n = int64(v)
	case json.Number:
		parsed, err := v.Int64()
		if err != nil {
			return 0, false
		}
		n = parsed
	default:
		return 0, false
	}
	return n, n >= 0 && n <= maxSafeInteger
}
func identity(value any) (string, error) {
	s := text(value)
	if s == "" || len(s) > 512 || strings.IndexByte(s, 0) >= 0 {
		return "", failure("chat_identity_required")
	}
	return s, nil
}
func normalize(input map[string]any) (message, error) {
	var m message
	if input == nil {
		return m, failure("chat_protocol_message_invalid")
	}
	m.typ = text(input["type"])
	var err error
	m.requestID, err = identity(input["requestId"])
	if err != nil {
		return m, err
	}
	if value, exists := input["generation"]; exists {
		m.generation, m.hasGeneration = safeInteger(value)
		if !m.hasGeneration {
			return m, failure("chat_command_generation_stale")
		}
	}
	switch m.typ {
	case "chat.open":
		raw, ok := input["target"].(map[string]any)
		if !ok {
			return m, failure("chat_protocol_target_required")
		}
		m.target = map[string]any{}
		// No destination, authorization, executable or filesystem values cross the
		// helper trust boundary. The resolver maps only these selectors to host facts.
		for _, key := range []string{"provider", "model", "executionAccountRef", "serverId", "kind", "label"} {
			if v := text(raw[key]); v != "" {
				if len(v) > 2048 {
					return m, failure("chat_protocol_target_invalid")
				}
				m.target[key] = v
			}
		}
	case "chat.submit", "chat.stop":
		if m.sessionID, err = identity(input["sessionId"]); err != nil {
			return m, err
		}
		if m.commandID, err = identity(input["commandId"]); err != nil {
			return m, err
		}
		if !m.hasGeneration {
			return m, failure("chat_command_generation_stale")
		}
		if m.typ == "chat.submit" {
			if value, exists := input["fileReference"]; exists {
				m.reference, err = normalizeReference(value)
				if err != nil {
					return m, err
				}
			}
			m.text = text(input["text"])
			if m.text == "" && m.reference != nil {
				m.text = "[附件: " + m.reference.name + "]"
			}
			if m.text == "" {
				return m, failure("chat_protocol_text_required")
			}
			if len(m.text) > maxMessageBytes {
				return m, failure("chat_protocol_text_too_large")
			}
		}
	case "chat.close":
	default:
		return m, failure("chat_protocol_type_unsupported")
	}
	return m, nil
}
func normalizeReference(value any) (*fileReference, error) {
	object, ok := value.(map[string]any)
	if !ok {
		return nil, failure("chat_file_reference_invalid")
	}
	ref := &fileReference{name: text(object["name"]), mime: text(object["mimeType"]), path: text(object["path"])}
	ref.text, _ = object["text"].(string)
	if ref.name == "" {
		return nil, failure("chat_protocol_file_reference_name_invalid")
	}
	ref.name = truncate(ref.name, 240)
	if ref.mime == "" {
		ref.mime = "text/plain"
	}
	ref.mime = truncate(ref.mime, 120)
	if strings.ContainsAny(ref.mime, "\r\n;,\x00") {
		return nil, failure("chat_protocol_file_reference_mime_invalid")
	}
	if ref.path == "" && ref.text == "" {
		return nil, failure("chat_protocol_file_reference_source_required")
	}
	if len(ref.path) > 2048 {
		return nil, failure("chat_protocol_file_reference_path_invalid")
	}
	if ref.path == "" && len(ref.text) > 16*1024 {
		return nil, failure("chat_protocol_file_reference_text_too_large")
	}
	if !utf8.ValidString(ref.text) {
		return nil, failure("chat_file_reference_invalid")
	}
	return ref, nil
}
func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) > n {
		return string(runes[:n])
	}
	return s
}
func commandEvent(typ string) bool {
	return strings.HasPrefix(typ, "turn.") || strings.HasPrefix(typ, "timeline.") || typ == "stream.error"
}
func terminalEvent(typ string) bool {
	return typ == "turn.completed" || typ == "turn.failed" || typ == "turn.interrupted"
}
func messageError(m message, err error) map[string]any {
	code := codeOf(err)
	out := map[string]any{"type": "chat.error", "requestId": m.requestID, "code": code, "message": code}
	if m.sessionID != "" {
		out["sessionId"] = m.sessionID
	}
	if m.commandID != "" {
		out["commandId"] = m.commandID
	}
	if m.hasGeneration {
		out["generation"] = m.generation
	}
	return out
}
