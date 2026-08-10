// Package responseswebsocket 连接 Codex Responses WebSocket 上游。
//
// 该适配器只负责凭据投影、官方握手头、端点安全和压缩协商，不处理客户端
// Upgrade、账号选择或业务终态。
package responseswebsocket

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/coder/websocket"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	// OAuthEndpoint 是官方 Codex Responses WebSocket 地址。
	OAuthEndpoint = "wss://chatgpt.com/backend-api/codex/responses"
	// BetaHeaderValue 来自当前官方 Codex Responses WS v2 握手合同。
	BetaHeaderValue = "responses_websockets=2026-02-06"
	// HopHeader 防止 API Key 自定义端点经代理重新进入当前 Gateway。
	HopHeader = "X-AIH-Codex-Responses-WebSocket-Hop"
	// HopValue 是当前单跳代理唯一允许发送的值。
	HopValue = "1"
	// 当前 HTTP Responses Adapter 已按同一官方 Codex 客户端版本验收。
	codexProtocolVersion = "0.146.0"
	codexOriginator      = "codex_cli_rs"
	codexUserAgent       = codexOriginator + "/" + codexProtocolVersion
	responsesPath        = "responses"
)

var (
	// ErrInvalidDependencies 表示 Dialer 缺少拒绝重定向的 HTTP Client。
	ErrInvalidDependencies = errors.New("Codex Responses WebSocket Dialer 依赖无效")
	// ErrUnsupportedCredential 表示凭据不是 Codex OAuth 或 API Key。
	ErrUnsupportedCredential = errors.New("Codex Responses WebSocket 凭据不受支持")
	// ErrInvalidEndpoint 表示账号端点不能形成安全 WebSocket URL。
	ErrInvalidEndpoint = errors.New("Codex Responses WebSocket 上游端点无效")
	// ErrSelfLoop 表示自定义端点会重新进入当前 Gateway。
	ErrSelfLoop = errors.New("Codex Responses WebSocket 检测到代理自循环")
)

// Connection 是代理帧所需的最小 WebSocket 连接端口。
type Connection interface {
	Read(ctx context.Context) (websocket.MessageType, []byte, error)
	Write(ctx context.Context, messageType websocket.MessageType, payload []byte) error
	SetReadLimit(limit int64)
	Close(code websocket.StatusCode, reason string) error
	CloseNow() error
}

// Dialer 使用独立 HTTP Client 建立上游 WebSocket，连接期不设置总请求超时。
type Dialer struct {
	client *http.Client
}

// NewDialer 创建默认失败关闭的 Codex Responses WebSocket Dialer。
func NewDialer(client *http.Client) (*Dialer, error) {
	if client == nil {
		return nil, ErrInvalidDependencies
	}
	return &Dialer{client: client}, nil
}

// SupportsCredential 声明当前 WS 适配器可承载的 Codex 凭据集合。
func (dialer *Dialer) SupportsCredential(
	credential accountapp.Credential,
) bool {
	if dialer == nil || dialer.client == nil || credential == nil {
		return false
	}
	_, _, err := projectCredential(credential)
	return err == nil
}

// Connect 使用数据库凭据和客户端低敏会话头建立上游连接。
func (dialer *Dialer) Connect(
	ctx context.Context,
	credential accountapp.Credential,
	clientHeader http.Header,
	localAuthority string,
) (Connection, *http.Response, error) {
	if dialer == nil || dialer.client == nil || ctx == nil {
		return nil, nil, ErrInvalidDependencies
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	endpoint, authHeader, err := projectCredential(credential)
	if err != nil {
		return nil, nil, err
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" {
		return nil, nil, ErrInvalidEndpoint
	}
	if localAuthority != "" && strings.EqualFold(
		parsed.Host,
		localAuthority,
	) {
		return nil, nil, ErrSelfLoop
	}
	header := projectHandshakeHeaders(clientHeader)
	for name, values := range authHeader {
		header[name] = append([]string(nil), values...)
	}
	connection, response, err := websocket.Dial(
		ctx,
		endpoint,
		&websocket.DialOptions{
			HTTPClient:      dialer.client,
			HTTPHeader:      header,
			CompressionMode: websocket.CompressionContextTakeover,
		},
	)
	if err != nil {
		return nil, response, err
	}
	return connection, response, nil
}

// projectCredential 返回不含查询参数的 WS 端点和只存在于内存中的认证头。
func projectCredential(
	credential accountapp.Credential,
) (string, http.Header, error) {
	header := make(http.Header)
	switch auth := credential.(type) {
	case *codexauth.OAuthAuth:
		if auth == nil || auth.AccessToken() == "" {
			return "", nil, ErrUnsupportedCredential
		}
		header.Set("Authorization", "Bearer "+auth.AccessToken())
		if accountID := auth.UpstreamAccountID(); accountID != "" {
			header.Set("ChatGPT-Account-ID", accountID)
		}
		if auth.IsFedRAMP() {
			header.Set("X-OpenAI-Fedramp", "true")
		}
		return OAuthEndpoint, header, nil
	case *codexauth.APIKeyAuth:
		if auth == nil || auth.APIKey() == "" || auth.BaseURL() == "" {
			return "", nil, ErrUnsupportedCredential
		}
		endpoint, err := websocketEndpoint(auth.BaseURL())
		if err != nil {
			return "", nil, err
		}
		header.Set("Authorization", "Bearer "+auth.APIKey())
		return endpoint, header, nil
	default:
		return "", nil, ErrUnsupportedCredential
	}
}

// websocketEndpoint 在账号级 Base URL 后追加一次 responses 并转换协议。
func websocketEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil ||
		parsed.Host == "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", ErrInvalidEndpoint
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	default:
		return "", ErrInvalidEndpoint
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/" + responsesPath
	parsed.RawPath = ""
	return parsed.String(), nil
}

// projectHandshakeHeaders 只转发官方源码确认的低敏关联头，认证和协议身份由
// Server 覆盖，避免客户端注入其它逐跳或上游权限头。
func projectHandshakeHeaders(source http.Header) http.Header {
	destination := make(http.Header)
	for _, name := range []string{
		"x-client-request-id",
		"session-id",
		"thread-id",
		"x-codex-routing-hint",
		"traceparent",
		"tracestate",
	} {
		values := source.Values(name)
		if len(values) == 1 {
			destination.Set(name, values[0])
		}
	}
	destination.Set("OpenAI-Beta", BetaHeaderValue)
	destination.Set("Originator", codexOriginator)
	destination.Set("User-Agent", codexUserAgent)
	destination.Set("Version", codexProtocolVersion)
	destination.Set(HopHeader, HopValue)
	return destination
}
