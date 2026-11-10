// Package kimi 构造 Kimi Code 的受管宿主配置（~/.kimi-code/config.toml）。
//
// 语义对齐 Node 的 lib/account/host-gateway-profile.js buildKimiGatewayConfig：
//   - 托管块由起止注释标记；标记不成对、倒序或重复都失败关闭。
//   - 移除旧托管块后重新解析；用户自己已有 providers."aih-server" 或
//     models."aih-server/kimi-for-coding" 时冲突，绝不覆盖。
//   - 根级 default_model 原地改指网关模型；没有则补一行。
//   - 表格及其后面内容原样保留，只对首尾空白做与 JS trimEnd 等价的裁剪。
//
// 本包只做内容构造，不碰文件与档位状态；调用方把它接到
// aihdefault.ActivateProfile / HostFileProjection。
package kimi

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

const (
	// ManagedBlockStart 是 AIH 托管块的起始注释行。
	ManagedBlockStart = "# ai-home managed AIH Server profile"
	// ManagedBlockEnd 是 AIH 托管块的结束注释行。
	ManagedBlockEnd = "# end ai-home managed AIH Server profile"
	// GatewayProviderID 是网关在 config.toml 里的 provider 名。
	GatewayProviderID = "aih-server"
	// GatewayModelID 是 default_model / models 表使用的完整模型名。
	GatewayModelID = "aih-server/kimi-for-coding"
	// GatewayModel 是网关 provider 下的模型名。
	GatewayModel = "kimi-for-coding"
	// MaxContextSize 与 Node 写入的上下文窗口一致。
	MaxContextSize = 262144

	defaultHost = "127.0.0.1"
	defaultPort = 9527
)

// 与 Node throw new Error(...) 的 message 保持一致，便于上层按串映射。
var (
	ErrInvalidManagedBlock = errors.New("invalid_kimi_gateway_block")
	ErrProviderConflict    = errors.New("kimi_gateway_provider_conflict")
	// ErrInvalidTOML 包住具体语法错误；Node 这里抛的是 TOML 解析器错误。
	ErrInvalidTOML = errors.New("invalid_kimi_toml")
)

// ServerConfig 是构造网关地址与鉴权所需的服务器配置子集。
// Port 为零/越界时回落 9527，与 Node normalizeServerPort 对非法值的处理一致。
type ServerConfig struct {
	Host      string
	Port      int
	APIKey    string
	ClientKey string
}

// ContentBuilder 是匿名函数别名，可直接赋给 aihdefault.BuildContent；
// 用别名而不是具名类型，避免调用方还要做一次显式转换。
type ContentBuilder = func(current string, existed bool) (string, error)

var defaultModelLine = regexp.MustCompile("(?m)^default_model\\s*=.*$")

// BaseURL 返回 AIH Server 的 OpenAI 兼容基址（buildAihServerBaseUrl）。
func BaseURL(server ServerConfig) string {
	host := strings.TrimSpace(server.Host)
	if host == "" || host == "0.0.0.0" {
		host = defaultHost
	}
	// formatUrlHost：IPv6 需要方括号，已带括号的不重复包。
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	port := server.Port
	if port <= 0 || port > 65535 {
		port = defaultPort
	}
	return fmt.Sprintf("http://%s:%d/v1", host, port)
}

// BuildGatewayContent 把 BuildGatewayConfig 适配成 BuildContent。
// existed 与 Node 一样不参与内容计算：缺文件时 current 为空串。
func BuildGatewayContent(server ServerConfig) ContentBuilder {
	return func(current string, _ bool) (string, error) {
		return BuildGatewayConfig(current, server)
	}
}

// BuildGatewayConfig 生成写入 ~/.kimi-code/config.toml 的完整内容。
func BuildGatewayConfig(rawConfig string, server ServerConfig) (string, error) {
	source := rawConfig
	start := strings.Index(source, ManagedBlockStart)
	end := strings.Index(source, ManagedBlockEnd)
	if (start == -1) != (end == -1) {
		return "", ErrInvalidManagedBlock
	}
	if start != -1 {
		duplicate := strings.Contains(source[start+len(ManagedBlockStart):], ManagedBlockStart)
		if end < start || duplicate {
			return "", ErrInvalidManagedBlock
		}
	}

	clean := source
	if start != -1 {
		clean = source[:start] + source[end+len(ManagedBlockEnd):]
	}

	if strings.TrimSpace(clean) != "" {
		paths, err := scanTOML(clean)
		if err != nil {
			return "", err
		}
		if paths.has("providers", GatewayProviderID) ||
			paths.has("models", GatewayModelID) {
			return "", ErrProviderConflict
		}
	}

	root, rest := clean, ""
	if index := firstTableIndex(clean); index >= 0 {
		root, rest = clean[:index], clean[index:]
	}

	selected := root
	replacement := "default_model = \"" + GatewayModelID + "\""
	if loc := defaultModelLine.FindStringIndex(root); loc != nil {
		selected = root[:loc[0]] + replacement + root[loc[1]:]
	} else {
		selected = replacement + "\n" + root
	}

	apiKey := server.APIKey
	if apiKey == "" {
		apiKey = server.ClientKey
	}
	apiKey = strings.TrimSpace(apiKey)
	if apiKey == "" {
		apiKey = "dummy"
	}

	block := strings.Join([]string{
		ManagedBlockStart,
		"[providers.\"" + GatewayProviderID + "\"]",
		"type = \"kimi\"",
		"api_key = " + quoteJSON(apiKey),
		"base_url = " + quoteJSON(BaseURL(server)),
		"",
		"[models.\"" + GatewayModelID + "\"]",
		"provider = \"" + GatewayProviderID + "\"",
		"model = \"" + GatewayModel + "\"",
		"max_context_size = " + strconv.Itoa(MaxContextSize),
		ManagedBlockEnd,
	}, "\n")

	result := trimEnd(selected) + "\n" + trimEnd(rest) + "\n\n" + block + "\n"
	// 与 Node 一样在返回前再解析一次；坏内容绝不落盘。
	if _, err := scanTOML(result); err != nil {
		return "", err
	}
	return result, nil
}

// firstTableIndex 复刻 JS 的 /^\s*\[/m：从行首的空白串开始，到第一个
// 非空白字符为 '[' 的位置；整个匹配的起点作为切分点。
func firstTableIndex(source string) int {
	for index := 0; index < len(source); {
		cursor := index
		for cursor < len(source) {
			switch source[cursor] {
			case ' ', '\t', '\r', '\n':
				cursor++
				continue
			}
			break
		}
		if cursor < len(source) && source[cursor] == '[' {
			return index
		}
		next := strings.IndexByte(source[index:], '\n')
		if next < 0 {
			return -1
		}
		index += next + 1
	}
	return -1
}

// trimEnd 与 JS trimEnd 对齐（Unicode 空白）。
func trimEnd(value string) string {
	return strings.TrimRightFunc(value, unicode.IsSpace)
}

// quoteJSON 复刻 JSON.stringify 对字符串的转义（不转义 <>&，控制字符用 \u00xx）。
func quoteJSON(value string) string {
	var builder strings.Builder
	builder.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			builder.WriteByte('\\')
			builder.WriteByte('"')
		case '\\':
			builder.WriteByte('\\')
			builder.WriteByte('\\')
		case '\b':
			builder.WriteByte('\\')
			builder.WriteByte('b')
		case '\t':
			builder.WriteByte('\\')
			builder.WriteByte('t')
		case '\n':
			builder.WriteByte('\\')
			builder.WriteByte('n')
		case '\f':
			builder.WriteByte('\\')
			builder.WriteByte('f')
		case '\r':
			builder.WriteByte('\\')
			builder.WriteByte('r')
		default:
			if r < 0x20 {
				fmt.Fprintf(&builder, "\\u%04x", r)
				continue
			}
			builder.WriteRune(r)
		}
	}
	builder.WriteByte('"')
	return builder.String()
}
