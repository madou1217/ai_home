// Package oauthloopback 在本机回环地址上临时监听 OAuth 授权回调。
//
// 授权 URL 的 redirect_uri 指向 localhost:1455 / localhost:54545 之类的本机端口；
// 浏览器完成授权后需要一个短生命周期监听器接住回调，把完整 URL 交给
// accountauth 作业换码。监听只绑定回环地址，路径必须与 redirect_uri 完全一致，
// 作业结束、取消或过期后立即释放端口。
package oauthloopback

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
)

const (
	callbackTimeout    = 30 * time.Second
	inactivePollPeriod = 2 * time.Second
	maxErrorLength     = 240
)

// Manager 按作业启动独立的回环监听器，本身不持有跨作业状态。
type Manager struct{}

// New 创建监听管理器。
func New() *Manager { return &Manager{} }

// Attach 启动一个短生命周期回调监听。绑定失败返回 unavailable 而不是错误，
// 调用方据此在界面上提示手动粘贴回调地址。
func (manager *Manager) Attach(ctx context.Context, request accountauth.LoopbackCaptureRequest) accountauth.LoopbackCaptureResult {
	if manager == nil {
		return accountauth.LoopbackCaptureResult{Status: accountauth.LoopbackStatusUnavailable, Error: "callback_capture_unavailable"}
	}
	target, ok, err := parseRedirectTarget(request.RedirectURI)
	if err != nil {
		return accountauth.LoopbackCaptureResult{Status: accountauth.LoopbackStatusUnavailable, Error: compactError(err)}
	}
	if !ok {
		// 自定义协议（zcode://）无法监听，只能手填回调。
		return accountauth.LoopbackCaptureResult{Status: accountauth.LoopbackStatusManualOnly}
	}
	if strings.TrimSpace(request.JobID) == "" || request.Complete == nil {
		return accountauth.LoopbackCaptureResult{Status: accountauth.LoopbackStatusUnavailable, Error: "callback_capture_invalid_job"}
	}

	handler := &callbackHandler{
		target:   target,
		jobID:    request.JobID,
		complete: request.Complete,
		finished: make(chan struct{}),
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	listeners, bindErr := bindLoopback(target)
	if len(listeners) == 0 {
		return accountauth.LoopbackCaptureResult{Status: accountauth.LoopbackStatusUnavailable, Error: compactError(bindErr)}
	}
	handler.once = &sync.Once{}
	handler.stop = func(graceful bool) {
		handler.once.Do(func() {
			close(handler.finished)
			if !graceful {
				_ = server.Close()
				return
			}
			// 先让当前回调的响应写回浏览器，再等待连接收尾；直接 Close 会把
			// 正在写出的页面截断成空响应。
			go func() {
				shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				_ = server.Shutdown(shutdownCtx)
			}()
		})
	}
	for _, listener := range listeners {
		go func(listener net.Listener) {
			// 关闭时 Serve 返回 ErrServerClosed，属于正常收尾。
			_ = server.Serve(listener)
		}(listener)
	}
	go handler.watch(request.ExpiresAt, request.IsActive)

	return accountauth.LoopbackCaptureResult{
		Status:       accountauth.LoopbackStatusListening,
		ListeningURL: target.String(),
	}
}

// callbackTarget 是 redirect_uri 解析后的监听目标。
type callbackTarget struct {
	hosts    []string
	port     int
	path     string
	fallback string
}

func (target callbackTarget) String() string {
	return "http://localhost:" + strconv.Itoa(target.port) + target.path
}

// callbackHandler 只接受与 redirect_uri 完全一致的 GET 回调。
type callbackHandler struct {
	target   callbackTarget
	jobID    string
	complete func(context.Context, string) error
	once     *sync.Once
	stop     func(graceful bool)
	finished chan struct{}
}

func (handler *callbackHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet || request.URL.Path != handler.target.path {
		writePage(response, http.StatusNotFound, "页面不存在", "这个本地地址只用于接收当前 OAuth 授权回调。")
		return
	}
	query := request.URL.Query()
	code := strings.TrimSpace(query.Get("code"))
	errorCode := strings.TrimSpace(query.Get("error"))
	errorDescription := strings.TrimSpace(query.Get("error_description"))
	if code == "" && errorCode == "" && errorDescription == "" {
		writePage(response, http.StatusBadRequest, "缺少授权参数", "没有收到 code 或 error，请回到 AI Home 重新发起授权。")
		return
	}
	callbackURL := buildCallbackURL(request, handler.target)

	ctx, cancel := context.WithTimeout(context.Background(), callbackTimeout)
	defer cancel()
	completeErr := handler.complete(ctx, callbackURL)
	if completeErr != nil {
		writePage(response, http.StatusBadGateway, "授权回调处理失败", "请回到 AI Home 查看作业详情，或重新发起授权。")
	} else {
		writePage(response, http.StatusOK, "授权完成", "可以关闭此页面并回到 AI Home。")
	}
	handler.stop(true)
}

// watch 在作业过期或不再等待用户授权时释放端口，避免下一次授权端口被残留占用。
func (handler *callbackHandler) watch(expiresAt time.Time, isActive func(context.Context) bool) {
	if expiresAt.IsZero() {
		expiresAt = time.Now().Add(10 * time.Minute)
	}
	deadline := time.NewTimer(time.Until(expiresAt))
	ticker := time.NewTicker(inactivePollPeriod)
	defer deadline.Stop()
	defer ticker.Stop()
	for {
		select {
		case <-handler.finished:
			return
		case <-deadline.C:
			handler.stop(false)
			return
		case <-ticker.C:
			if isActive == nil {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), inactivePollPeriod)
			active := isActive(ctx)
			cancel()
			if !active {
				handler.stop(false)
				return
			}
		}
	}
}

// parseRedirectTarget 只接受 http(s) 回环 redirect_uri；自定义协议返回 ok=false。
func parseRedirectTarget(raw string) (callbackTarget, bool, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil {
		return callbackTarget{}, false, errors.New("callback_redirect_invalid")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return callbackTarget{}, false, nil
	}
	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	if !isLoopbackHost(host) {
		return callbackTarget{}, false, errors.New("callback_redirect_not_loopback")
	}
	port := 0
	if rawPort := parsed.Port(); rawPort != "" {
		parsedPort, parseErr := strconv.Atoi(rawPort)
		if parseErr != nil || parsedPort <= 0 || parsedPort > 65535 {
			return callbackTarget{}, false, errors.New("callback_redirect_port_invalid")
		}
		port = parsedPort
	} else if scheme == "https" {
		port = 443
	} else {
		port = 80
	}
	path := parsed.Path
	if path == "" {
		path = "/"
	}
	hosts := []string{host}
	if host == "localhost" {
		hosts = []string{"127.0.0.1", "::1"}
	}
	return callbackTarget{
		hosts:    hosts,
		port:     port,
		path:     path,
		fallback: scheme + "://" + parsed.Host,
	}, true, nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}

// bindLoopback 尽量同时绑定 IPv4 与 IPv6；只要有一个成功就可用。
func bindLoopback(target callbackTarget) ([]net.Listener, error) {
	listeners := make([]net.Listener, 0, len(target.hosts))
	var lastErr error
	for _, host := range target.hosts {
		listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(target.port)))
		if err != nil {
			lastErr = err
			continue
		}
		listeners = append(listeners, listener)
	}
	if len(listeners) == 0 {
		if lastErr == nil {
			lastErr = errors.New("callback_listen_failed")
		}
		return nil, lastErr
	}
	return listeners, nil
}

// buildCallbackURL 用 redirect_uri 的 origin 拼接回调 URL，不信任请求的 Host 头，
// 避免本机其它进程伪造 Host 改变换码参数来源。
func buildCallbackURL(request *http.Request, target callbackTarget) string {
	return target.fallback + request.URL.RequestURI()
}

func compactError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Error())
	if len(message) > maxErrorLength {
		message = message[:maxErrorLength]
	}
	if message == "" {
		return "callback_capture_unavailable"
	}
	return message
}

func writePage(response http.ResponseWriter, status int, title string, message string) {
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_, _ = fmt.Fprintf(response, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>%s</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f9;color:#111827}main{max-width:520px;padding:28px;background:#fff;border:1px solid #e5e7eb;border-radius:8px}h1{font-size:20px;margin:0 0 10px}p{font-size:14px;line-height:1.7;margin:0;color:#4b5563}</style></head><body><main><h1>%s</h1><p>%s</p></main></body></html>`, title, title, message)
}
