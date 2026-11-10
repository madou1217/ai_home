// Package claude 构造 Claude 宿主 settings.json 的托管内容（网关 env 与凭据字段）。
//
// 语义逐条对齐 Node 侧默认账号落点的三处实现：
//
//	buildAihServerProfileEnv('claude', serverConfig)   → GatewayProfileEnv
//	buildClaudeAccountRelayEnv(gatewayEnv, accountRef) → AccountRelayEnv
//	buildClaudeSettingsContent(current, credentialEnv) → BuildSettingsContent
//
// 这里只有纯函数：读写宿主文件、归属哈希与还原仍由 aihdefault 的受管文件原语负责。
// 输出固定按键名排序（Go map 编码），同一输入恒得同一字节，便于外层算内容哈希。
package claude

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

const (
	// DefaultHost / DefaultPort / DefaultClientKey 与 Node server-defaults 一致。
	DefaultHost      = "127.0.0.1"
	DefaultPort      = 9527
	DefaultClientKey = "dummy"

	// APIKeyEnv 是网关档位的客户端密钥槽，TokenEnv 是写进 settings.json 的槽。
	// 两者刻意不同：宿主裸跑 Claude 走 Bearer（AUTH_TOKEN），而 relay profile
	// 生成的是 ANTHROPIC_API_KEY，落盘时改名（见 DefaultLandingPayload）。
	APIKeyEnv  = "ANTHROPIC_API_KEY"
	TokenEnv   = "ANTHROPIC_AUTH_TOKEN"
	BaseURLEnv = "ANTHROPIC_BASE_URL"
	// CustomHeadersEnv 是换行分隔的自定义头，账号钉选也走这里。
	CustomHeadersEnv = "ANTHROPIC_CUSTOM_HEADERS"

	// PinnedAccountHeader 把请求钉到指定账号；大小写与 Node 常量一致。
	PinnedAccountHeader = "x-account-ref"

	envField = "env"
)

// credentialEnvKeys 是 AIH 在 Claude settings.json 里托管的凭据变量：整组先删再写，
// 只换 token 不清 BASE_URL 会把新 key 发到上一个账号的端点。
var credentialEnvKeys = []string{APIKeyEnv, TokenEnv, BaseURLEnv}

var (
	// ErrInvalidSettings 对应 Node 的 invalid_claude_settings。
	ErrInvalidSettings = errors.New("invalid_claude_settings")
	// ErrInvalidAccountRef 对应 Node 的 invalid_claude_relay_account_ref。
	ErrInvalidAccountRef = errors.New("invalid_claude_relay_account_ref")
)

var accountRefPattern = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)

// Env 是写进 settings.json env 的托管字段。
type Env map[string]string

// ServerConfig 是 profile 需要的服务端配置子集：地址与客户端密钥。
// APIKey 优先于 ClientKey，两者都为空时回落 dummy（与 Node 兜底一致）。
type ServerConfig struct {
	Host      string
	Port      int
	APIKey    string
	ClientKey string
}

// RootURL 是网关根地址（不带 /v1）：Anthropic SDK 会自行追加 /v1/messages。
func (config ServerConfig) RootURL() string {
	return "http://" + formatHost(config.Host) + ":" + strconv.Itoa(normalizePort(config.Port))
}

// BaseURL 是带 /v1 的地址，供需要版本段的调用方使用。
func (config ServerConfig) BaseURL() string {
	return config.RootURL() + "/v1"
}

// ClientKeyValue 按 Node 的顺序取客户端密钥：apiKey → clientKey → dummy。
func (config ServerConfig) ClientKeyValue() string {
	for _, candidate := range []string{config.APIKey, config.ClientKey} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			return trimmed
		}
	}
	return DefaultClientKey
}

// GatewayProfileEnv 对应 buildAihServerProfileEnv('claude', serverConfig)。
func GatewayProfileEnv(config ServerConfig) Env {
	return Env{
		APIKeyEnv:  config.ClientKeyValue(),
		BaseURLEnv: config.RootURL(),
	}
}

// AccountRelayEnv 对应 buildClaudeAccountRelayEnv：原样保留网关 env，再叠一行钉选头。
// 与 Node 相同，已有的钉选行由 BuildSettingsContent 统一去重，这里只追加。
func AccountRelayEnv(gateway Env, accountRef string) (Env, error) {
	ref := strings.TrimSpace(accountRef)
	if !ValidAccountRef(ref) {
		return nil, fmt.Errorf("%w: %q", ErrInvalidAccountRef, accountRef)
	}
	relay := make(Env, len(gateway)+1)
	for key, value := range gateway {
		relay[key] = value
	}
	relay[CustomHeadersEnv] = mergeCustomHeaders(
		splitHeaderLines(gateway[CustomHeadersEnv]),
		[]string{PinnedAccountHeader + ": " + ref},
	)
	return relay, nil
}

// DefaultLandingPayload 是默认账号落点写进宿主 settings.json 的内容：
// 网关 token + 根地址，accountRef 非空时再钉账号；随后整组替换托管凭据字段。
// accountRef 为空即「AIH Server 默认」（不钉账号）。
func DefaultLandingPayload(config ServerConfig, accountRef string, current []byte) ([]byte, error) {
	gateway := GatewayProfileEnv(config)
	credential := Env{
		TokenEnv:   gateway[APIKeyEnv],
		BaseURLEnv: gateway[BaseURLEnv],
	}
	if strings.TrimSpace(accountRef) != "" {
		pinned, err := AccountRelayEnv(credential, accountRef)
		if err != nil {
			return nil, err
		}
		credential = pinned
	}
	return BuildSettingsContent(current, credential)
}

// BuildSettingsContent 对应 buildClaudeSettingsContent：保留宿主其它设置与自己写的
// 非钉选头，删掉旧凭据变量后写入 credential，并把 BASE_URL 规范成 SDK 期望的形态。
// 无法解析的文档返回 ErrInvalidSettings（调用方失败关闭，不覆盖用户文件）。
func BuildSettingsContent(current []byte, credential Env) ([]byte, error) {
	document := make(map[string]json.RawMessage)
	if trimmed := bytes.TrimSpace(current); len(trimmed) > 0 {
		if err := json.Unmarshal(trimmed, &document); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidSettings, err)
		}
		if document == nil {
			document = make(map[string]json.RawMessage)
		}
	}

	env := make(map[string]any)
	if raw, ok := document[envField]; ok {
		var stored map[string]json.RawMessage
		if err := json.Unmarshal(raw, &stored); err != nil {
			return nil, fmt.Errorf("%w: env: %v", ErrInvalidSettings, err)
		}
		for key, value := range stored {
			env[key] = value
		}
	}

	for _, key := range credentialEnvKeys {
		delete(env, key)
	}
	headers := mergeCustomHeaders(
		splitHeaderLines(envText(env[CustomHeadersEnv])),
		splitHeaderLines(credential[CustomHeadersEnv]),
	)
	delete(env, CustomHeadersEnv)
	if headers != "" {
		env[CustomHeadersEnv] = headers
	}
	for key, value := range credential {
		if key == CustomHeadersEnv {
			continue
		}
		env[key] = value
	}
	// 宿主裸跑 Claude 同样由 SDK 追加 /v1/messages，必须与 AIH 启动链共用规范化。
	if baseURL, ok := envTextValue(env[BaseURLEnv]); ok && baseURL != "" {
		env[BaseURLEnv] = NormalizeBaseURL(baseURL)
	}

	encodedEnv, err := encodeJSON(env)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidSettings, err)
	}
	document[envField] = json.RawMessage(bytes.TrimSpace(encodedEnv))
	return encodeJSON(document)
}

// NormalizeBaseURL 剥掉一层末尾的 /v1（先去掉尾部斜杠），避免 /v1/v1/messages。
// 不以版本段结尾的地址（.../anthropic、.../apps/anthropic）原样保留。
func NormalizeBaseURL(baseURL string) string {
	text := strings.TrimSpace(baseURL)
	if text == "" {
		return text
	}
	trimmed := strings.TrimRight(text, "/")
	if len(trimmed) >= 3 && strings.EqualFold(trimmed[len(trimmed)-3:], "/v1") {
		trimmed = trimmed[:len(trimmed)-3]
	}
	return trimmed
}

// ValidAccountRef 与 Node isAccountRef 一致：acct_ + 20 位小写十六进制。
func ValidAccountRef(accountRef string) bool {
	return accountRefPattern.MatchString(strings.TrimSpace(accountRef))
}

func normalizePort(port int) int {
	if port > 0 && port <= 65535 {
		return port
	}
	return DefaultPort
}

func formatHost(host string) string {
	normalized := strings.TrimSpace(host)
	if normalized == "" || normalized == "0.0.0.0" {
		return DefaultHost
	}
	if strings.Contains(normalized, ":") && !strings.HasPrefix(normalized, "[") {
		return "[" + normalized + "]"
	}
	return normalized
}

// mergeCustomHeaders 让钉选行归 AIH 管：先去掉旧的钉选行，再按本次投影加回；
// 用户自己的其它头原样保留。
func mergeCustomHeaders(existing, projected []string) string {
	pinPrefix := PinnedAccountHeader + ":"
	kept := make([]string, 0, len(existing)+len(projected))
	for _, line := range existing {
		if strings.HasPrefix(strings.ToLower(line), pinPrefix) {
			continue
		}
		kept = append(kept, line)
	}
	kept = append(kept, projected...)
	return strings.Join(kept, "\n")
}

func splitHeaderLines(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	lines := make([]string, 0, 4)
	for _, line := range strings.Split(value, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines
}

// envText 取出 env 里的文本值：本次写入的是 string，来自宿主文件的是原始 JSON。
func envText(value any) string {
	text, _ := envTextValue(value)
	return text
}

func envTextValue(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case json.RawMessage:
		var text string
		if len(typed) > 0 && json.Unmarshal(typed, &text) == nil {
			return text, true
		}
	}
	return "", false
}

// encodeJSON 输出 2 空格缩进、不转义 HTML 的 JSON，末尾带换行（与 Node 输出同形）。
func encodeJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
