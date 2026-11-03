// Package inferenceapi 提供 HTTP 入站适配器共享的请求边界工具。
package inferenceapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/inferencegateway"
)

// maxSessionKeyLength 是原样保留的会话标识上限；更长时哈希，避免无界内存。
const maxSessionKeyLength = 128

// sessionKeyHeaders 是请求头中的会话标识候选，顺序与 Node session-key.js 一致。
var sessionKeyHeaders = []string{
	"x-opencode-session",
	"x-session-id",
	"x-conversation-id",
	"x-thread-id",
	"openai-session-id",
}

// sessionKeyBodyPaths 是请求体中的会话标识候选路径，顺序与 Node session-key.js 一致。
var sessionKeyBodyPaths = [][]string{
	{"session_id"},
	{"session", "id"},
	{"conversation_id"},
	{"conversation", "id"},
	{"thread_id"},
	{"thread", "id"},
	{"previous_response_id"},
	{"response_id"},
	{"metadata", "session_id"},
	{"metadata", "conversation_id"},
	{"metadata", "thread_id"},
}

// RequestSessionKey 按 Node 同构的候选顺序从请求头与请求体提取会话标识。
//
// 请求头优先于请求体；返回空字符串表示该请求没有可用的会话标识。超过 128 字符的标识
// 会被 sha256 归一化，避免无界内存，且与 Node 的 normalizeSessionToken 一致。
func RequestSessionKey(headers http.Header, body []byte) string {
	for _, name := range sessionKeyHeaders {
		if normalized := normalizeSessionToken(headerValue(headers, name)); normalized != "" {
			return normalized
		}
	}
	if len(body) == 0 {
		return ""
	}
	root, err := decodeTopLevel(body)
	if err != nil {
		return ""
	}
	for _, path := range sessionKeyBodyPaths {
		if normalized := normalizeSessionToken(bodyString(root, path)); normalized != "" {
			return normalized
		}
	}
	return ""
}

// ContextWithRequestSessionKey 提取会话标识并注入请求 Context；无标识时原样返回。
func ContextWithRequestSessionKey(
	ctx context.Context,
	headers http.Header,
	body []byte,
) context.Context {
	return inferencegateway.WithRequestSessionKey(ctx, RequestSessionKey(headers, body))
}

// headerValue 返回请求头首个非空值；Go 的 Header 已做规范化。
func headerValue(headers http.Header, name string) string {
	if headers == nil {
		return ""
	}
	values := headers.Values(name)
	for _, value := range values {
		if text := strings.TrimSpace(value); text != "" {
			return text
		}
	}
	return ""
}

// decodeTopLevel 只把顶层键物化为 RawMessage，避免为大请求体做完整深解析。
func decodeTopLevel(body []byte) (map[string]json.RawMessage, error) {
	root := make(map[string]json.RawMessage)
	if err := json.Unmarshal(body, &root); err != nil {
		return nil, err
	}
	return root, nil
}

// bodyString 按路径读取请求体里的字符串值；数字按原文本返回，其他类型返回空串。
func bodyString(root map[string]json.RawMessage, path []string) string {
	if len(path) == 0 {
		return ""
	}
	current, ok := root[path[0]]
	if !ok {
		return ""
	}
	for _, key := range path[1:] {
		var nested map[string]json.RawMessage
		if err := json.Unmarshal(current, &nested); err != nil {
			return ""
		}
		current, ok = nested[key]
		if !ok {
			return ""
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(current))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	default:
		return ""
	}
}

// normalizeSessionToken 裁剪空白，超长标识哈希，与 Node normalizeSessionToken 同构。
func normalizeSessionToken(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	if len(text) <= maxSessionKeyLength {
		return text
	}
	sum := sha256.Sum256([]byte(text))
	return "sha256:" + hex.EncodeToString(sum[:])
}
