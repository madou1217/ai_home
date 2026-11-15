package codexappserverws

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
)

// RewriteOptions 控制客户端 JSON-RPC 报文的重写行为。
type RewriteOptions struct {
	// Cwd 指定当 thread/list 未显式传入 cwd 时注入的工作目录（来自查询参数 aih_cwd）。
	Cwd string
	// SkipInjectCwd 为 true 时禁用 thread/list 的 cwd 注入（对应 Node injectCwd: false）。
	SkipInjectCwd bool
	// ServiceTier is an optional effective caller-owned launch preference.
	// Only missing resume/fork fields inherit it; explicit values/null win.
	ServiceTier *string
}

// RewriteClientMessage preserves the scoped app-server compatibility contract:
//   - thread/list：按需注入 cwd，强制清空 modelProviders=[] 与 useStateDbOnly=true；
//   - thread/start、thread/resume、thread/fork：剥离非空 config.profile（若 config 变空则移除 config）；
//   - caller-local resume/fork inherits an explicitly resolved launch service tier only when omitted;
//   - 未发生变化或非合法 JSON 对象时原样返回原始字节。
func RewriteClientMessage(raw []byte, opts RewriteOptions) []byte {
	raw = inheritResumeServiceTier(raw, opts.ServiceTier)
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return raw
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &payload); err != nil || payload == nil {
		return raw
	}

	method := extractTrimmedMethod(payload["method"])
	if method == "" {
		return raw
	}

	params := parseRawObjectOrEmpty(payload["params"])

	switch method {
	case "thread/list":
		allProjects := isJSONTrue(params["allProjects"])
		_, changed := params["allProjects"]
		// Strip AIH scope intent before forwarding to native Codex.
		delete(params, "allProjects")
		injectedCwd := strings.TrimSpace(opts.Cwd)
		if injectedCwd != "" && !opts.SkipInjectCwd && !allProjects {
			curCwdRaw, hasCwd := params["cwd"]
			if !hasCwd || isJSONNull(curCwdRaw) || isJSONEmptyString(curCwdRaw) {
				encodedCwd, err := marshalNoEscapeHTML(injectedCwd)
				if err == nil {
					params["cwd"] = encodedCwd
					changed = true
				}
			}
		}

		curProviders, hasProviders := params["modelProviders"]
		if !hasProviders || isJSONNull(curProviders) || !isJSONEmptyArray(curProviders) {
			params["modelProviders"] = json.RawMessage("[]")
			changed = true
		}

		curUseStateDB, hasUseStateDB := params["useStateDbOnly"]
		if !hasUseStateDB || !isJSONTrue(curUseStateDB) {
			params["useStateDbOnly"] = json.RawMessage("true")
			changed = true
		}

		if !changed {
			return raw
		}
		encodedParams, err := marshalNoEscapeHTML(params)
		if err != nil {
			return raw
		}
		payload["params"] = encodedParams
		encoded, err := marshalNoEscapeHTML(payload)
		if err != nil {
			return raw
		}
		return encoded

	case "thread/start", "thread/resume", "thread/fork":
		cfgRaw, hasCfg := params["config"]
		if !hasCfg {
			return raw
		}
		cfg := parseRawObjectOrNil(cfgRaw)
		if cfg == nil {
			return raw
		}
		profileRaw, hasProfile := cfg["profile"]
		if !hasProfile {
			return raw
		}
		var profile string
		if err := json.Unmarshal(profileRaw, &profile); err != nil || strings.TrimSpace(profile) == "" {
			return raw
		}
		delete(cfg, "profile")
		if len(cfg) > 0 {
			encodedCfg, err := marshalNoEscapeHTML(cfg)
			if err != nil {
				return raw
			}
			params["config"] = encodedCfg
		} else {
			delete(params, "config")
		}
		encodedParams, err := marshalNoEscapeHTML(params)
		if err != nil {
			return raw
		}
		payload["params"] = encodedParams
		encoded, err := marshalNoEscapeHTML(payload)
		if err != nil {
			return raw
		}
		return encoded

	default:
		return raw
	}
}

// SplitJSONRPCLines 1:1 复刻 splitJsonRpcLines：将缓冲文本按 \r\n 或 \n 切分为完整非空行与剩余不完整尾片段。
func SplitJSONRPCLines(buffer string) (lines []string, rest string) {
	if buffer == "" {
		return nil, ""
	}
	normalized := strings.ReplaceAll(buffer, "\r\n", "\n")
	parts := strings.Split(normalized, "\n")
	if len(parts) <= 1 {
		return nil, parts[0]
	}
	for _, part := range parts[:len(parts)-1] {
		if len(part) > 0 {
			lines = append(lines, part)
		}
	}
	rest = parts[len(parts)-1]
	return lines, rest
}

func extractTrimmedMethod(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || isJSONNull(trimmed) {
		return ""
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err == nil {
		return strings.TrimSpace(s)
	}
	return ""
}

func parseRawObjectOrNil(raw json.RawMessage) map[string]json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil || obj == nil {
		return nil
	}
	return obj
}

func parseRawObjectOrEmpty(raw json.RawMessage) map[string]json.RawMessage {
	if obj := parseRawObjectOrNil(raw); obj != nil {
		return obj
	}
	return make(map[string]json.RawMessage)
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func isJSONTrue(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("true"))
}

func isJSONEmptyString(raw json.RawMessage) bool {
	var s string
	if err := json.Unmarshal(bytes.TrimSpace(raw), &s); err != nil {
		return false
	}
	return s == ""
}

func isJSONEmptyArray(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return false
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(trimmed, &arr); err != nil {
		return false
	}
	return len(arr) == 0
}

func extractJSONRPCIDKey(payload map[string]json.RawMessage) string {
	rawID, exists := payload["id"]
	if !exists {
		return ""
	}
	trimmed := bytes.TrimSpace(rawID)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		var s string
		if err := json.Unmarshal(trimmed, &s); err == nil {
			return strings.TrimSpace(s)
		}
		return ""
	}
	if bytes.Equal(trimmed, []byte("true")) || bytes.Equal(trimmed, []byte("false")) {
		return string(trimmed)
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.UseNumber()
	var num json.Number
	if err := dec.Decode(&num); err == nil && num != "" {
		if i, err := strconv.ParseInt(string(num), 10, 64); err == nil {
			return strconv.FormatInt(i, 10)
		}
		if f, err := strconv.ParseFloat(string(num), 64); err == nil {
			return strconv.FormatFloat(f, 'f', -1, 64)
		}
		return string(num)
	}
	return strings.TrimSpace(string(trimmed))
}

func extractRequestThreadID(paramsRaw json.RawMessage) string {
	params := parseRawObjectOrNil(paramsRaw)
	if params == nil {
		return ""
	}
	for _, key := range []string{"threadId", "thread_id", "id"} {
		if val := unmarshalTrimmedString(params[key]); val != "" {
			return val
		}
	}
	if threadObj := parseRawObjectOrNil(params["thread"]); threadObj != nil {
		if val := unmarshalTrimmedString(threadObj["id"]); val != "" {
			return val
		}
	}
	return ""
}

func unmarshalTrimmedString(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return ""
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err != nil {
		return ""
	}
	return strings.TrimSpace(s)
}

func marshalNoEscapeHTML(v any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	out := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	return out, nil
}

// ExtractJSONRPCIDFromMap 从已反序列化的 JSON-RPC 对象提取规范化请求 id 字符串。
func ExtractJSONRPCIDFromMap(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	rawID, exists := payload["id"]
	if !exists || rawID == nil {
		return ""
	}
	switch v := rawID.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strconv.FormatFloat(v, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(v, 10)
	case int:
		return strconv.Itoa(v)
	case json.Number:
		return strings.TrimSpace(string(v))
	case bool:
		return strconv.FormatBool(v)
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(encoded))
	}
}

// ExtractJSONRPCThreadIDFromMap 从已反序列化的 JSON-RPC 对象提取关联的 threadId。
func ExtractJSONRPCThreadIDFromMap(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	params, _ := payload["params"].(map[string]any)
	if params == nil {
		return ""
	}
	for _, key := range []string{"threadId", "thread_id", "id"} {
		if s, ok := params[key].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	if thread, ok := params["thread"].(map[string]any); ok && thread != nil {
		if s, ok := thread["id"].(string); ok && strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}
