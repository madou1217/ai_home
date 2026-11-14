// Package providersessionhook 实现 Provider 官方 hook 的会话事件发送器。
//
// 背景：Codex / Claude / Gemini / agy 等 CLI 的 hook 会在会话事件发生时执行一条
// 外部命令。aih 原先让这条命令跑一份 Node 脚本（scripts/aih-provider-session-hook-sender.js），
// 于是 Go 的会话事件链在 provider 侧仍然依赖 Node。本包把同一协议搬进 Go 宿主二进制：
// 子命令 __provider-hook 由 aih-server 自己提供，安装器把托管 hook 的 command
// 指向宿主二进制。
//
// 行为与 Node 版本逐字对齐（lib/server/provider-session-hook-sender.js）：
//   - 只白名单透传短字段，tool_input 只保留命令/路径等描述字段；
//   - correlation 来自 AIH_SESSION_INTENT，accountRef 来自 AIH_PROVIDER_ACCOUNT_REF；
//   - POST 失败只写 stderr，stdout 仍输出 provider 期望的 noop 决策并以 0 退出。
package providersessionhook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// Marker 是托管 hook 的唯一识别标记（与 Node/安装器同值）。
	Marker = "--aih-provider-session-hook"
	// DefaultReceiverURL 与 Node 的 DEFAULT_RECEIVER_URL 一致。
	DefaultReceiverURL = "http://127.0.0.1:9527/v0/webui/session-events/provider-hook"
	// SessionIntentEnv 携带 correlation 字段。
	SessionIntentEnv = "AIH_SESSION_INTENT"
	// AccountRefEnv 携带当前账号引用。
	AccountRefEnv = "AIH_PROVIDER_ACCOUNT_REF"

	defaultTimeout = 2000 * time.Millisecond
	minTimeout     = 100 * time.Millisecond
	maxBodyBytes   = 256 * 1024
)

var accountRefPattern = regexp.MustCompile("^acct_[a-f0-9]{20}$")

var (
	safeScalarFields = []string{
		"session_id", "sessionId", "conversationId", "conversation_id",
		"transcriptPath", "transcript_path", "projectPath", "project_path",
		"projectDirName", "project_dir_name", "cwd", "turn_id", "turnId",
		"invocationNum", "executionNum", "stepIdx", "timestamp", "at",
		"eventName", "hookEventName", "hook_event_name", "event", "source",
	}
	safePathArrayFields = []string{"workspacePaths", "workspace_paths"}
	safeQuestionFields  = []string{"question", "prompt", "text", "interrupted", "requiresAnswer", "questionCleared", "question_cleared"}
	safeWaitingFields   = []string{"notification_type", "notificationType", "message", "title", "tool_name", "toolName"}
	safeToolInputFields = []string{"command", "file_path", "path", "url", "pattern"}
)

// Options 是一次发送的输入。
type Options struct {
	Args   []string
	Stdin  []byte
	Getenv func(string) string
	Now    func() time.Time
}

// Result 是发送结果：stdout 永远给 provider 一个合法决策，stderr 只放投递失败信息。
type Result struct {
	Stdout string
	Stderr string
}

type parsedArgs struct {
	provider  string
	eventName string
	url       string
	timeout   time.Duration
}

// Run 执行一次 hook 发送；任何投递失败都不影响 provider 的退出码。
func Run(options Options) Result {
	parsed := parseArgs(options.Args)
	stdout := buildNoopOutput(parsed.provider, parsed.eventName)
	body := buildReceiverBody(parsed, options.Stdin, options.Getenv)
	delivery := postJSON(parsed.url, body, parsed.timeout)
	if delivery.ok {
		return Result{Stdout: stdout}
	}
	reason := delivery.err
	if reason == "" && delivery.statusCode > 0 {
		reason = strconv.Itoa(delivery.statusCode)
	}
	if reason == "" {
		reason = "unknown"
	}
	return Result{
		Stdout: stdout,
		Stderr: fmt.Sprintf("[aih-provider-session-hook] delivery failed provider=%s event=%s error=%s\n",
			fallbackText(parsed.provider, "unknown"), fallbackText(parsed.eventName, "unknown"), reason),
	}
}

func fallbackText(value string, fallback string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return fallback
	}
	return text
}

// parseArgs 与 Node 的 parseSenderArgs 同口径：跳过标记，未知参数忽略。
func parseArgs(argv []string) parsedArgs {
	parsed := parsedArgs{timeout: defaultTimeout}
	for index := 0; index < len(argv); index++ {
		arg := argv[index]
		switch arg {
		case Marker:
			continue
		case "--provider":
			if index+1 < len(argv) {
				parsed.provider = strings.ToLower(strings.TrimSpace(argv[index+1]))
				index++
			}
		case "--event", "--eventName":
			if index+1 < len(argv) {
				parsed.eventName = strings.TrimSpace(argv[index+1])
				index++
			}
		case "--url":
			if index+1 < len(argv) {
				parsed.url = strings.TrimSpace(argv[index+1])
				index++
			}
		case "--timeout-ms":
			if index+1 < len(argv) {
				if number, err := strconv.Atoi(strings.TrimSpace(argv[index+1])); err == nil {
					timeout := time.Duration(number) * time.Millisecond
					if timeout < minTimeout {
						timeout = minTimeout
					}
					parsed.timeout = timeout
				}
				index++
			}
		}
	}
	return parsed
}

// buildReceiverBody 组装接收端契约；payload 只含白名单字段。
func buildReceiverBody(parsed parsedArgs, stdin []byte, getenv func(string) string) map[string]any {
	var source map[string]any
	text := strings.TrimSpace(string(stdin))
	if text != "" {
		var decoded any
		if json.Unmarshal([]byte(text), &decoded) == nil {
			if object, ok := decoded.(map[string]any); ok {
				source = object
			}
		}
	}
	body := map[string]any{
		"provider":  strings.ToLower(strings.TrimSpace(parsed.provider)),
		"eventName": strings.TrimSpace(parsed.eventName),
		"payload":   sanitizePayload(source),
	}
	if getenv != nil {
		if correlation := readSessionIntentField(getenv(SessionIntentEnv), "correlation"); correlation != "" {
			body["correlationId"] = correlation
		}
		if accountRef := normalizeProviderAccountRef(getenv(AccountRefEnv)); accountRef != "" {
			body["accountRef"] = accountRef
		}
	}
	return body
}

// sanitizePayload 只保留短字段；完整 tool_input 不离开宿主。
func sanitizePayload(source map[string]any) map[string]any {
	payload := map[string]any{}
	if source == nil {
		return payload
	}
	for _, field := range safeScalarFields {
		copySafeScalar(source, payload, field)
	}
	if value, ok := source["fullyIdle"].(bool); ok {
		payload["fullyIdle"] = value
	}
	for _, field := range safePathArrayFields {
		raw, ok := source[field].([]any)
		if !ok {
			continue
		}
		paths := make([]string, 0, len(raw))
		for _, item := range raw {
			text, ok := item.(string)
			if !ok {
				continue
			}
			trimmed := strings.TrimSpace(text)
			if trimmed == "" {
				continue
			}
			paths = append(paths, sliceRunes(trimmed, 4096))
			if len(paths) >= 16 {
				break
			}
		}
		if len(paths) > 0 {
			payload[field] = paths
		}
	}
	for _, field := range safeQuestionFields {
		switch value := source[field].(type) {
		case bool:
			payload[field] = value
		case string:
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				payload[field] = sliceRunes(trimmed, 4096)
			}
		}
	}
	for _, field := range safeWaitingFields {
		if value, ok := source[field].(string); ok {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				payload[field] = sliceRunes(trimmed, 512)
			}
		}
	}
	toolInput := source["tool_input"]
	if toolInput == nil {
		toolInput = source["toolInput"]
	}
	if object, ok := toolInput.(map[string]any); ok {
		picked := map[string]any{}
		for _, field := range safeToolInputFields {
			if value, ok := object[field].(string); ok {
				if trimmed := strings.TrimSpace(value); trimmed != "" {
					picked[field] = sliceRunes(trimmed, 200)
				}
			}
		}
		if len(picked) > 0 {
			payload["tool_input"] = picked
		}
	}
	if raw, ok := source["options"].([]any); ok {
		options := make([]string, 0, len(raw))
		for _, item := range raw {
			text, ok := item.(string)
			if !ok {
				continue
			}
			trimmed := strings.TrimSpace(text)
			if trimmed == "" {
				continue
			}
			options = append(options, sliceRunes(trimmed, 512))
			if len(options) >= 32 {
				break
			}
		}
		if len(options) > 0 {
			payload["options"] = options
		}
	}
	if statusline, ok := source["statusline"].(map[string]any); ok {
		entries := map[string]any{}
		count := 0
		for key, value := range statusline {
			if count >= 32 {
				break
			}
			entryKey := sliceRunes(strings.TrimSpace(key), 128)
			if text, ok := value.(string); ok {
				entries[entryKey] = sliceRunes(strings.TrimSpace(text), 1024)
			} else {
				entries[entryKey] = value
			}
			count++
		}
		payload["statusline"] = entries
	}
	if _, ok := source["toolCall"].(map[string]any); ok {
		payload["toolCall"] = map[string]any{}
	}
	if value, exists := source["error"]; exists && value != nil {
		if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
			payload["error"] = true
			payload["errorMessage"] = sliceRunes(text, 1024)
		}
	}
	if value, exists := source["terminationReason"]; exists && value != nil {
		if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
			if strings.ToLower(text) == "error" {
				payload["terminationReason"] = "error"
			} else {
				payload["terminationReason"] = "reported"
			}
		}
	}
	return payload
}

func copySafeScalar(source map[string]any, target map[string]any, field string) {
	value, exists := source[field]
	if !exists {
		return
	}
	switch typed := value.(type) {
	case float64:
		target[field] = typed
	case string:
		if text := strings.TrimSpace(typed); text != "" {
			target[field] = sliceRunes(text, 4096)
		}
	}
}

// readSessionIntentField 解析 key=value 逗号串（与 Node 的 parseSessionIntent 同口径）。
func readSessionIntentField(raw string, key string) string {
	for _, part := range strings.Split(raw, ",") {
		index := strings.Index(part, "=")
		if index <= 0 {
			continue
		}
		name := strings.TrimSpace(part[:index])
		value := strings.TrimSpace(part[index+1:])
		if name == "" || value == "" {
			continue
		}
		decoded, err := url.QueryUnescape(value)
		if err != nil {
			decoded = value
		}
		if name == key {
			return decoded
		}
	}
	return ""
}

func normalizeProviderAccountRef(value string) string {
	text := strings.TrimSpace(value)
	if !accountRefPattern.MatchString(text) {
		return ""
	}
	return text
}

func buildNoopOutput(providerRaw string, eventNameRaw string) string {
	provider := strings.ToLower(strings.TrimSpace(providerRaw))
	eventName := strings.TrimSpace(eventNameRaw)
	output := map[string]any{}
	if provider == "agy" {
		switch eventName {
		case "Stop":
			output["decision"] = ""
		case "PreToolUse":
			output["decision"] = "allow"
		}
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

type deliveryOutcome struct {
	ok         bool
	statusCode int
	err        string
}

// postJSON 投递事件；与 Node 一致，超时/连接失败都只作为投递失败返回。
func postJSON(rawURL string, body map[string]any, timeout time.Duration) deliveryOutcome {
	target := strings.TrimSpace(rawURL)
	if target == "" {
		target = DefaultReceiverURL
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return deliveryOutcome{err: "invalid_url"}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return deliveryOutcome{err: "encode_failed"}
	}
	client := newHTTPClient(timeout)
	response, err := client.Post(parsed.String(), "application/json", bytes.NewReader(encoded))
	if err != nil {
		return deliveryOutcome{err: err.Error()}
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxBodyBytes))
	outcome := deliveryOutcome{ok: response.StatusCode >= 200 && response.StatusCode < 300, statusCode: response.StatusCode}
	return outcome
}

func newHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout}
}

func sliceRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
