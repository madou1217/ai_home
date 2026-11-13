// Package subaggregatorpublicapi 暴露聚合订阅与规则集转换的公开免鉴权 HTTP 端点。
//
// 路由前缀固定为 /sub/：
//   - GET|HEAD /sub/{token}
//   - GET|HEAD /sub/{token}/rules/{ruleSet}
//
// 客户端为 Surge / Clash / sing-box / Loon / QX 等外部代理工具，凭据即 URL 中的随机 token；
// 未知 token 或非法路径统一返回 404 纯文本，不暴露内部配置或区分"不存在"与"已重置"。
package subaggregatorpublicapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

// Prefix 是公开聚合订阅入口的路径前缀。
const Prefix = "/sub/"

// ErrInvalidDependencies 表示构造 Handler 所需的聚合服务缺失。
var ErrInvalidDependencies = errors.New("subaggregatorpublicapi: 订阅聚合服务无效")

var (
	tokenPattern       = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)
	ruleSetPathPattern = regexp.MustCompile(`^([A-Za-z0-9_-]{16,128})/rules/((?:geosite|geoip)-[A-Za-z0-9@._-]{1,128})$`)
)

// Service 定义公开聚合订阅处理器依赖的聚合服务抽象。
type Service interface {
	ServeSubscription(ctx context.Context, token string, req subaggregator.ServeRequest) (subaggregator.ServeResponse, error)
	ServeRuleSet(ctx context.Context, token, tag, target string) (subaggregator.ServeResponse, error)
}

// Dependencies 声明构造公开订阅 Handler 所需的依赖项。
type Dependencies struct {
	Service Service
}

// Handler 处理 /sub/{token} 与 /sub/{token}/rules/{ruleSet} 公开请求。
type Handler struct {
	service Service
}

// NewHandler 校验依赖并构造公开订阅 Handler。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{service: deps.Service}, nil
}

// ServeHTTP 实现 http.Handler。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.service == nil {
		writePlain(w, r, http.StatusServiceUnavailable, "subaggregator unavailable")
		return
	}
	reqPath := requestPath(r)
	if !strings.HasPrefix(reqPath, Prefix) {
		writePlain(w, r, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writePlain(w, r, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	rest := strings.TrimPrefix(reqPath, Prefix)
	if ruleSetMatch := ruleSetPathPattern.FindStringSubmatch(rest); len(ruleSetMatch) == 3 {
		h.handleRuleSet(w, r, ruleSetMatch[1], ruleSetMatch[2])
		return
	}
	if !tokenPattern.MatchString(rest) {
		writePlain(w, r, http.StatusNotFound, "not found")
		return
	}
	h.handleSubscription(w, r, rest)
}

func (h *Handler) handleSubscription(w http.ResponseWriter, r *http.Request, token string) {
	var u *url.URL
	if r != nil {
		u = r.URL
	}
	view := ""
	if u != nil {
		view = u.Query().Get("view")
	}
	resp, err := h.service.ServeSubscription(r.Context(), token, subaggregator.ServeRequest{
		Target:        readTarget(u),
		View:          view,
		UserAgent:     r.Header.Get("User-Agent"),
		Origin:        subaggregator.RequestOrigin(r),
		RemoteAddress: resolveRemoteAddress(r),
		Relay:         readRelayFlag(u),
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeServiceResponse(w, r, resp)
}

func (h *Handler) handleRuleSet(w http.ResponseWriter, r *http.Request, token, tag string) {
	var u *url.URL
	if r != nil {
		u = r.URL
	}
	resp, err := h.service.ServeRuleSet(r.Context(), token, tag, readTarget(u))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeServiceResponse(w, r, resp)
}

func requestPath(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	if r.URL.RawPath != "" {
		return r.URL.RawPath
	}
	return r.URL.Path
}

func readTarget(u *url.URL) string {
	if u == nil {
		return ""
	}
	q := u.Query()
	if v := q.Get("target"); v != "" {
		return v
	}
	return q.Get("format")
}

// readRelayFlag 解析 ?relay=1|true|0|false 三态开关；未提供或非法时返回 nil 交由服务层判定。
func readRelayFlag(u *url.URL) *bool {
	if u == nil {
		return nil
	}
	raw := strings.ToLower(strings.TrimSpace(u.Query().Get("relay")))
	switch raw {
	case "1", "true":
		v := true
		return &v
	case "0", "false":
		v := false
		return &v
	default:
		return nil
	}
}

// resolveRemoteAddress 提取真实客户端远端地址；仅当 TCP 直连来自本机回环反代时信任转发头，
// 防止外部直连伪造 X-AIH-Remote-Addr / X-Forwarded-For 绕过远端中转与鉴权判定。
func resolveRemoteAddress(r *http.Request) string {
	if r == nil {
		return ""
	}
	if subaggregator.IsLoopbackRemoteAddress(r.RemoteAddr) {
		if aihAddr := firstHeaderToken(r.Header.Get("X-AIH-Remote-Addr")); aihAddr != "" {
			return aihAddr
		}
		if xff := firstHeaderToken(r.Header.Get("X-Forwarded-For")); xff != "" {
			return xff
		}
		if realIP := firstHeaderToken(r.Header.Get("X-Real-IP")); realIP != "" {
			return realIP
		}
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func firstHeaderToken(raw string) string {
	head, _, _ := strings.Cut(raw, ",")
	return strings.TrimSpace(head)
}

func writeServiceResponse(w http.ResponseWriter, r *http.Request, resp subaggregator.ServeResponse) {
	header := w.Header()
	for k, v := range resp.Headers {
		header.Set(k, v)
	}
	if header.Get("Content-Length") == "" {
		header.Set("Content-Length", strconv.Itoa(len(resp.Body)))
	}
	status := resp.Status
	if status <= 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	if r != nil && r.Method == http.MethodHead {
		return
	}
	_, _ = io.WriteString(w, resp.Body)
}

func writeServiceError(w http.ResponseWriter, r *http.Request, err error) {
	if de, ok := subaggregator.AsDomainError(err); ok {
		switch de.Code {
		case "aggregator_subscription_not_found", "aggregator_rule_set_not_found":
			writePlain(w, r, http.StatusNotFound, "not found")
			return
		case "unsupported_aggregator_format":
			writePlain(w, r, http.StatusBadRequest, "unsupported target")
			return
		case "aggregator_rule_set_fetch_failed":
			writePlain(w, r, http.StatusBadGateway, "not found")
			return
		default:
			status := subaggregator.MapErrorStatus(de.Code)
			if status == http.StatusNotFound {
				writePlain(w, r, http.StatusNotFound, "not found")
				return
			}
			if status == http.StatusBadRequest || status == http.StatusUnprocessableEntity {
				writePlain(w, r, http.StatusBadRequest, "not found")
				return
			}
			code := strings.TrimSpace(de.Code)
			if code == "" {
				code = "internal_error"
			}
			writePlain(w, r, http.StatusInternalServerError, "subscription render failed: "+code)
			return
		}
	}
	writePlain(w, r, http.StatusInternalServerError, "subscription render failed: internal_error")
}

func writePlain(w http.ResponseWriter, r *http.Request, status int, text string) {
	header := w.Header()
	header.Set("Content-Type", "text/plain; charset=utf-8")
	header.Set("Cache-Control", "no-store")
	header.Set("Content-Length", strconv.Itoa(len(text)))
	w.WriteHeader(status)
	if r != nil && r.Method == http.MethodHead {
		return
	}
	_, _ = io.WriteString(w, text)
}
