package codexappserverapi

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"time"
)

var remoteHydrationNotificationMethods = map[string]struct{}{"thread/started": {}, "thread/status/changed": {}, "thread/tokenUsage/updated": {}}

// RewriteRemoteControlPayload 对 server->client 的 client_message 信封内部消息应用兼容重写。
func RewriteRemoteControlPayload(raw []byte) (payload []byte, changed bool, summary map[string]any) {
	// Preserve every unmodified wire value, especially JSON-RPC integers beyond
	// float64's exact range and opaque future envelope fields.
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimSpace(raw), &envelope); err != nil || envelope == nil {
		return raw, false, map[string]any{"type": "non_json"}
	}
	var kind string
	_ = json.Unmarshal(envelope["type"], &kind)
	if strings.TrimSpace(kind) != "client_message" || len(envelope["message"]) == 0 {
		return raw, false, remotePayloadSummary(raw)
	}
	message := envelope["message"]
	rewritten := RewriteClientMessage(message, "")
	if bytes.Equal(rewritten, message) {
		return raw, false, remotePayloadSummary(raw)
	}
	envelope["message"] = rewritten
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return raw, false, remotePayloadSummary(raw)
	}
	return encoded, true, remotePayloadSummary(encoded)
}

func remotePayloadSummary(raw []byte) map[string]any {
	var envelope map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&envelope) != nil {
		return map[string]any{"type": "non_json"}
	}
	return SummarizeRemoteEnvelope(envelope)
}

// ReadRemoteHydrationSuppressionState 读取当前仍在抑制有效期内的线程 ID 集合。
func ReadRemoteHydrationSuppressionState(filePath string, nowMs int64) map[string]struct{} {
	cleanPath := strings.TrimSpace(filePath)
	out := make(map[string]struct{})
	if cleanPath == "" {
		return out
	}
	if nowMs <= 0 {
		nowMs = time.Now().UnixMilli()
	}
	file, err := os.Open(cleanPath)
	if err != nil {
		return out
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return out
	}
	raw, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 {
		return out
	}
	var state struct {
		Threads []struct {
			ID        string  `json:"id"`
			ExpiresAt float64 `json:"expiresAt"`
		} `json:"threads"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return out
	}
	for _, entry := range state.Threads {
		id := strings.TrimSpace(entry.ID)
		if id != "" && int64(entry.ExpiresAt) > nowMs {
			out[id] = struct{}{}
		}
	}
	return out
}

// ShouldSuppressRemoteHydrationEnvelope 判断当前服务端回放通知是否因后台水合期而应被静默丢弃。
func ShouldSuppressRemoteHydrationEnvelope(
	envelope map[string]any,
	suppressedIDs map[string]struct{},
) bool {
	if envelope == nil || len(suppressedIDs) == 0 {
		return false
	}
	envType, _ := envelope["type"].(string)
	if strings.TrimSpace(envType) != "server_message" {
		return false
	}
	msg, ok := envelope["message"].(map[string]any)
	if !ok || msg == nil {
		return false
	}
	method, _ := msg["method"].(string)
	if _, tracked := remoteHydrationNotificationMethods[strings.TrimSpace(method)]; !tracked {
		return false
	}
	threadID := extractJSONRPCThreadID(msg)
	if threadID == "" {
		return false
	}
	_, suppressed := suppressedIDs[threadID]
	return suppressed
}
