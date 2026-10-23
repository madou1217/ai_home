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
	"strconv"
	"strings"

	"github.com/coder/websocket"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
)

const (
	// OAuthEndpoint 是官方 Codex Responses WebSocket 地址。
	OAuthEndpoint = "wss://chatgpt.com/backend-api/codex/responses"
	// BetaHeaderValue 来自当前官方 Codex Responses WS v2 握手合同。
	BetaHeaderValue = "responses_websockets=2026-02-06"
	// HopHeader 记录本请求已被几台 aih 网关转发过（防 A→B→A 无限环）。
	HopHeader = "X-AIH-Codex-Responses-WebSocket-Hop"
	// MaxRelayHops 是允许经过的网关跳数上限。一跳中转（本机网关 → 远程 server
	// 网关）是正常拓扑：历史上这里把「头存在」直接当成自环并 508，于是把远程 server
	// 当上游时 WebSocket 永远打不通，WebUI 会话表现为
	// `stream disconnected before completion`。与 HTTP 侧同口径
	// （internal/adapters/codex/responses/native.go 的 MaxNativeRelayHops）以及
	// lib/server/codex-relay-hop.js 的 MAX_CODEX_RELAY_HOPS 保持一致。
	MaxRelayHops  = 1
	responsesPath = "responses"
)

// RelayHop 解析请求已走过的网关跳数；缺失/非法一律按 0（未中转���。
func RelayHop(header http.Header) int {
	raw := strings.TrimSpace(header.Get(HopHeader))
	if raw == "" {
		return 0
	}
	hop, err := strconv.Atoi(raw)
	if err != nil || hop < 0 {
		return 0
	}
	return hop
}

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
	client   *http.Client
	versions clientversion.Source
}

// NewDialer 创建默认失败关闭的 Codex Responses WebSocket Dialer。
func NewDialer(client *http.Client) (*Dialer, error) {
	return NewDialerWithClientVersion(client, clientversion.Static(codexidentity.Floor))
}

// NewDialerWithClientVersion 创建兜底身份按版本来源自报的 Dialer。
func NewDialerWithClientVersion(client *http.Client, versions clientversion.Source) (*Dialer, error) {
	if client == nil || versions == nil {
		return nil, ErrInvalidDependencies
	}
	return &Dialer{client: client, versions: versions}, nil
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
	header := projectHandshakeHeaders(clientHeader, dialer.versions.Current())
	for name, values := range authHeader {
		header[name] = append([]string(nil), values...)
	}
	options := &websocket.DialOptions{
		HTTPClient:      dialer.client,
		HTTPHeader:      header,
		CompressionMode: websocket.CompressionContextTakeover,
	}
	connection, response, err := websocket.Dial(ctx, endpoint, options)
	// 仅握手路由缺失时尝试同源别名一次；复用原 ctx 的剩余预算和账号认证。
	// Host 缓存的首帧尚未发往上游；401/403/超时和业务错误不重试。
	if err != nil && response != nil &&
		response.StatusCode == http.StatusNotFound && ctx.Err() == nil {
		parsed.Path += "/ws"
		connection, response, err = websocket.Dial(ctx, parsed.String(), options)
	}
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

// projectHandshakeHeaders 只转发官方源码确认的低敏关联头；认证由 Server 覆盖，
// 客户端身份只在可信 Codex 客户端时跟随客户端，避免注入其它逐跳或上游权限头。
//
// fallbackVersion 是无法识别真实 Codex 客户端时自报的版本（来自版本解析器）。
func projectHandshakeHeaders(source http.Header, fallbackVersion string) http.Header {
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
	if identity, ok := codexClientIdentity(source); ok {
		// 帧由真实 Codex 客户端生成，握手身份与会话元数据跟随它，见 client_identity.go。
		for name, values := range identity {
			destination[name] = values
		}
	} else {
		if fallbackVersion == "" {
			fallbackVersion = codexidentity.Floor
		}
		destination.Set("Originator", codexidentity.Originator)
		destination.Set("User-Agent", codexidentity.UserAgent(fallbackVersion))
		destination.Set("Version", fallbackVersion)
	}
	// 递增而不是写死 1：对端据此判断这条链还能不能再往下转（见 MaxRelayHops）。
	destination.Set(HopHeader, strconv.Itoa(RelayHop(source)+1))
	return destination
}
