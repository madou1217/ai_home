package codexappserverapi

import (
	"regexp"
	"strings"
)

const MaxRemoteThreadSummaryItems = 10

var (
	reBearerSecret = regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._~+/=-]+`)
	reJSONSecret   = regexp.MustCompile(`(?i)"((?:access|refresh|id)_token|authToken|token)"\s*:\s*"[^"]+"`)
	reJWTSecret    = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
)

// SanitizeTraceText 对 trace 文本中的 Bearer、JWT 与常见 token 字段做脱敏并限制长度。
func SanitizeTraceText(value string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = 4000
	}
	text := reBearerSecret.ReplaceAllString(value, "Bearer [redacted]")
	text = reJSONSecret.ReplaceAllString(text, `"$1":"[redacted]"`)
	text = reJWTSecret.ReplaceAllString(text, "[jwt-redacted]")
	if len(text) <= maxLength {
		return text
	}
	return text[:maxLength] + "..."
}

func compactThreadListItem(raw any) map[string]any {
	item, ok := raw.(map[string]any)
	if !ok || item == nil {
		return nil
	}
	id := firstNonEmptyString(item, "id", "sessionId", "threadId")
	if id == "" {
		return nil
	}
	out := map[string]any{"id": id}
	if updated := firstNonNil(item, "updatedAt", "updated_at", "updated_at_ms"); updated != nil && updated != "" {
		out["updatedAt"] = updated
	}
	if created := firstNonNil(item, "createdAt", "created_at", "created_at_ms"); created != nil && created != "" {
		out["createdAt"] = created
	}
	if mp := firstNonEmptyString(item, "modelProvider", "model_provider"); mp != "" {
		out["modelProvider"] = mp
	}
	if src, ok := item["source"].(string); ok && src != "" {
		out["source"] = src
	}
	if ts, exists := item["threadSource"]; exists {
		if ts == nil {
			out["threadSource"] = nil
		} else if s, ok := ts.(string); ok {
			out["threadSource"] = s
		}
	}
	if tsSnake, ok := item["thread_source"].(string); ok && tsSnake != "" {
		out["threadSource"] = tsSnake
	}
	if cwd, ok := item["cwd"].(string); ok && cwd != "" {
		out["cwd"] = cwd
	}
	return out
}

func firstNonEmptyString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if s, ok := m[k].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func firstNonNil(m map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, exists := m[k]; exists && v != nil {
			return v
		}
	}
	return nil
}

// SummarizeJSONRPCMessage 生成不包含敏感负荷的 JSON-RPC 诊断摘要。
func SummarizeJSONRPCMessage(message map[string]any) map[string]any {
	if message == nil {
		return map[string]any{"kind": "unknown"}
	}
	summary := make(map[string]any)
	if id := extractJSONRPCIDString(message); id != "" {
		summary["id"] = id
	}
	if method, ok := message["method"].(string); ok && strings.TrimSpace(method) != "" {
		summary["method"] = strings.TrimSpace(method)
	}
	if tid := extractJSONRPCThreadID(message); tid != "" {
		summary["threadId"] = tid
	}
	if method, _ := summary["method"].(string); method == "thread/list" {
		if params, ok := message["params"].(map[string]any); ok {
			if limit, ok := params["limit"]; ok {
				summary["limit"] = limit
			}
			if cursor, exists := params["cursor"]; exists {
				summary["cursor"] = cursor
			}
			if sk, ok := params["sortKey"].(string); ok && sk != "" {
				summary["sortKey"] = sk
			}
			if archived, exists := params["archived"]; exists {
				summary["archived"] = archived == true
			}
			if mp, ok := params["modelProviders"]; ok {
				summary["modelProviders"] = mp
			}
			if sks, ok := params["sourceKinds"]; ok {
				summary["sourceKinds"] = sks
			}
			summary["useStateDbOnly"] = params["useStateDbOnly"] == true
		}
	}
	if result, ok := message["result"].(map[string]any); ok && result != nil {
		if data, ok := result["data"].([]any); ok {
			threads := make([]map[string]any, 0, MaxRemoteThreadSummaryItems)
			ids := make([]string, 0, MaxRemoteThreadSummaryItems)
			for _, item := range data {
				compact := compactThreadListItem(item)
				if compact == nil {
					continue
				}
				threads = append(threads, compact)
				if id, _ := compact["id"].(string); id != "" {
					ids = append(ids, id)
				}
				if len(threads) >= MaxRemoteThreadSummaryItems {
					break
				}
			}
			summary["resultThreads"] = threads
			summary["resultThreadIds"] = ids
			if nc, ok := result["nextCursor"].(string); ok && nc != "" {
				summary["nextCursorValue"] = nc
			}
			if bc, ok := result["backwardsCursor"].(string); ok && bc != "" {
				summary["backwardsCursorValue"] = bc
			}
		}
	}
	return summary
}

// SummarizeRemoteEnvelope 提取 remote-control 信封字段摘要（不记录载荷明文）。
func SummarizeRemoteEnvelope(envelope any) map[string]any {
	m, ok := envelope.(map[string]any)
	if !ok || m == nil {
		return map[string]any{"type": "non_json"}
	}
	t, _ := m["type"].(string)
	t = strings.TrimSpace(t)
	if t == "" {
		t = "unknown"
	}
	summary := map[string]any{"type": t}
	if cid, ok := m["client_id"].(string); ok && cid != "" {
		summary["clientId"] = cid
	}
	if sid, ok := m["stream_id"].(string); ok && sid != "" {
		summary["streamId"] = sid
	}
	if seqID, exists := m["seq_id"]; exists {
		summary["seqId"] = seqID
	}
	if t == "client_message" || t == "server_message" {
		if msg, ok := m["message"].(map[string]any); ok {
			summary["message"] = SummarizeJSONRPCMessage(msg)
		}
	}
	if t == "client_message_chunk" || t == "server_message_chunk" {
		summary["segmentId"] = m["segment_id"]
		summary["segmentCount"] = m["segment_count"]
		summary["messageSizeBytes"] = m["message_size_bytes"]
	}
	return summary
}
