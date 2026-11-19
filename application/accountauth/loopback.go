package accountauth

import (
	"context"
	"net/url"
	"strings"
	"time"
)

// 回调捕获状态与 WebUI 的 callbackCaptureStatus 同值。
const (
	// LoopbackStatusListening 表示监听已建立，浏览器回调会被自动接收。
	LoopbackStatusListening = "listening"
	// LoopbackStatusManualOnly 表示 redirect_uri 不是可监听的 HTTP 回环地址，只能手填。
	LoopbackStatusManualOnly = "manual_only"
	// LoopbackStatusUnavailable 表示监听启动失败，保留手动提交回调的兜底路径。
	LoopbackStatusUnavailable = "unavailable"
)

// LoopbackCaptureRequest 是一次 OAuth 作业的本机回调监听参数。
type LoopbackCaptureRequest struct {
	// JobID 是作业标识。
	JobID string
	// RedirectURI 是授权 URL 里的 redirect_uri，决定监听端口与路径。
	RedirectURI string
	// ExpiresAt 是作业过期时刻；零值按默认窗口处理。
	ExpiresAt time.Time
	// IsActive 可选：返回作业是否仍在等待；为 false 时释放监听。
	IsActive func(context.Context) bool
	// Complete 在收到回调 URL 后执行换码与账号写入。
	Complete func(ctx context.Context, callbackURL string) error
}

// LoopbackCaptureResult 是监听启动结果。
type LoopbackCaptureResult struct {
	Status       string
	ListeningURL string
	Error        string
}

// LoopbackCapture 按作业启动本机 OAuth 回调监听。
//
// 实现必须只绑定回环地址，并在作业结束、取消或过期后释放端口；启动失败返回
// LoopbackStatusUnavailable 而不是让整个授权作业失败。
type LoopbackCapture interface {
	Attach(ctx context.Context, request LoopbackCaptureRequest) LoopbackCaptureResult
}

// RedirectURIFromAuthorizationURL 从授权 URL 的查询参数里取 redirect_uri。
//
// 授权地址只在创建响应里交付一次；回调监听和前端展示只需要这一个派生值，
// 不需要传输层各自复制一套解析逻辑。
func RedirectURIFromAuthorizationURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil {
		return ""
	}
	query := parsed.Query()
	for _, key := range []string{"redirect_uri", "redirectUri", "redirect"} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			return value
		}
	}
	return ""
}
