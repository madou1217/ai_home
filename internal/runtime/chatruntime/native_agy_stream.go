package chatruntime

import (
	"encoding/json"
	"net/http"
	"strings"
)

// AGY's protocol is event/init/step_update/result, not Claude's type/result.
// Its documented text_delta is incremental; never apply cumulative-text dedupe.
func parseAGYNativeStreamLine(line string, state *NativeStreamState) []NativeStreamChunk {
	if state.agyTerminal || state.agyFailure != nil {
		return failAGYNativeStream(state, "agy_stream_after_terminal", "")
	}
	var event map[string]any
	if err := json.Unmarshal([]byte(line), &event); err != nil || event == nil {
		return failAGYNativeStream(state, "agy_stream_invalid_json", "Expected AGY stream-json output, not plain stdout")
	}
	typ := asString(event["event"])
	payload, _ := event[typ].(map[string]any)
	// Some failures are emitted directly as the JSON terminal envelope.
	if typ == "" && asString(event["status"]) != "" && asString(event["status"]) != "SUCCESS" {
		typ, payload = "result", event
	}
	if payload == nil || (typ != "init" && typ != "step_update" && typ != "result") {
		return failAGYNativeStream(state, "agy_stream_event_invalid", "")
	}
	var chunks []NativeStreamChunk
	envelopeID := strings.TrimSpace(asString(event["conversation_id"]))
	payloadID := strings.TrimSpace(asString(payload["conversation_id"]))
	if envelopeID != "" && payloadID != "" && envelopeID != payloadID {
		return failAGYNativeStream(state, "agy_stream_conversation_mismatch", "")
	}
	sessionID := firstNonEmptyStr(envelopeID, payloadID)
	if sessionID != "" {
		if state.SessionID != "" && state.SessionID != sessionID {
			return failAGYNativeStream(state, "agy_stream_conversation_mismatch", "")
		}
		if state.SessionID == "" {
			state.SessionID = sessionID
			chunks = append(chunks, NativeStreamChunk{Type: "session-created", SessionID: sessionID})
		}
	}
	switch typ {
	case "init":
		if state.agyInitialized {
			return failAGYNativeStream(state, "agy_stream_duplicate_init", "")
		}
		if sessionID == "" {
			return failAGYNativeStream(state, "agy_stream_conversation_missing", "")
		}
		state.agyInitialized = true
	case "step_update":
		if !state.agyInitialized {
			return failAGYNativeStream(state, "agy_stream_init_required", "")
		}
		if asString(payload["step_type"]) == "agent_response" {
			if delta := asString(payload["text_delta"]); delta != "" {
				state.Content += delta
				chunks = append(chunks, NativeStreamChunk{Type: "delta", Delta: delta})
			}
		}
	case "result":
		status := asString(payload["status"])
		if status != "SUCCESS" {
			message := strings.TrimSpace(asString(payload["error"]))
			if isAGYAuthenticationFailure(message) {
				return failAGYNativeStream(state, "agy_authentication_required", agyAuthenticationRequired().Message)
			}
			switch status {
			case "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING":
				return failAGYNativeStream(state, "agy_native_"+strings.ToLower(status), "AGY CLI returned a non-success result; raw provider diagnostics are withheld")
			default:
				return failAGYNativeStream(state, "agy_stream_terminal_status_invalid", "")
			}
		}
		if !state.agyInitialized {
			return failAGYNativeStream(state, "agy_stream_init_required", "")
		}
		response, valid := payload["response"].(string)
		if !valid || state.SessionID == "" || asString(payload["error"]) != "" {
			return failAGYNativeStream(state, "agy_stream_result_invalid", "")
		}
		if !strings.HasPrefix(response, state.Content) {
			return failAGYNativeStream(state, "agy_stream_response_mismatch", "AGY terminal response conflicts with text already streamed")
		}
		if len(response) > len(state.Content) {
			chunks = append(chunks, NativeStreamChunk{Type: "delta", Delta: response[len(state.Content):]})
		}
		state.Content = response
		state.Usage = extractAGYNativeUsage(asMap(payload["usage"]))
		state.agyTerminal = true
		chunks = append(chunks, NativeStreamChunk{Type: "result", Content: response, Usage: state.Usage, Terminal: true})
	}
	return chunks
}

func failAGYNativeStream(state *NativeStreamState, code, message string) []NativeStreamChunk {
	err := NewErrorWithMessage(code, http.StatusBadGateway, message, nil)
	state.agyFailure = err
	state.FailureMessage = err.Error()
	return []NativeStreamChunk{{Type: "error", Message: err.Error(), Terminal: true}}
}

func agyNativeCompletionError(state *NativeStreamState) error {
	if state.agyFailure != nil {
		return state.agyFailure
	}
	if !state.agyTerminal {
		return NewError("agy_stream_incomplete", http.StatusBadGateway, nil)
	}
	return nil
}

// Preserve reported counts, including explicit zeroes, without inventing totals
// or deriving thinking/cache counts from a tokenizer or from per-step usage.
func extractAGYNativeUsage(raw map[string]any) map[string]any {
	usage := make(map[string]any)
	for from, to := range map[string]string{
		"input_tokens": "inputTokens", "output_tokens": "outputTokens",
		"thinking_tokens": "thinkingTokens", "cache_read_tokens": "cacheReadTokens",
		"total_tokens": "totalTokens",
	} {
		if value, ok := asSafeInt64(raw[from]); ok && value >= 0 {
			usage[to] = value
		}
	}
	if len(usage) == 0 {
		return nil
	}
	return usage
}
