// Package webuiclaudepreflightapi 提供 Claude Code 首屏检查策略的 WebUI 读写接口。
//
// 策略与最近一次探测结果保存在 app-state 的 config:claude-preflight；探测端点
// 显式执行一次联网检查，避免页面轮询或读接口拖慢设置页。
package webuiclaudepreflightapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/claudepreflight"
)

const (
	// Path 是策略读写契约；PUT/POST 均整份写入。
	Path = "/v1/management/webui/claude-preflight"
	// ProbePath 显式执行一次双端点探测并落盘结果。
	ProbePath = Path + "/probe"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("首屏检查配置接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 读写 config:claude-preflight。
type Store interface {
	ReadClaudePreflight(ctx context.Context) (string, bool, error)
	WriteClaudePreflight(ctx context.Context, value string) error
}

// Prober 执行一次首屏端点探测。
type Prober interface {
	Probe(ctx context.Context) claudepreflight.Result
}

// Dependencies 汇总依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
	Prober     Prober
}

// NetProber 用遵循代理环境变量的 HTTP 客户端做真实探测。
type NetProber struct {
	Timeout time.Duration
}

// Probe 实现 Prober。
func (prober NetProber) Probe(ctx context.Context) claudepreflight.Result {
	timeout := prober.Timeout
	if timeout <= 0 {
		timeout = 4 * time.Second
	}
	return claudepreflight.Probe(ctx, claudepreflight.NewClient(timeout), timeout)
}

// Handler 处理策略读取、写入和显式探测。
type Handler struct {
	authorizer Authorizer
	store      Store
	prober     Prober
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	prober := dependencies.Prober
	if prober == nil {
		prober = NetProber{}
	}
	return &Handler{authorizer: dependencies.Authorizer, store: dependencies.Store, prober: prober}, nil
}

// ConfigView 是 WebUI 可见的完整策略视图。
type ConfigView struct {
	Mode      claudepreflight.Mode `json:"mode"`
	Effective bool                 `json:"effective"`
	Reachable *bool                `json:"reachable"`
	CheckedAt int64                `json:"checked_at"`
	Detail    string               `json:"detail"`
}

type responseView struct {
	OK     bool       `json:"ok"`
	Config ConfigView `json:"config"`
}

// ServeHTTP 按路径分发：GET 读、POST 写、POST /probe 探测。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "claude_preflight_unavailable", "首屏检查配置服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch {
	case request.Method == http.MethodGet && request.URL.Path == Path:
		handler.readConfig(response, request)
	case request.Method == http.MethodPost && request.URL.Path == ProbePath:
		handler.probe(response, request)
	case request.Method == http.MethodPost && request.URL.Path == Path:
		handler.writeConfig(response, request)
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET/POST")
	}
}

func (handler *Handler) readConfig(response http.ResponseWriter, request *http.Request) {
	record, err := handler.readRecord(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_config_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, responseView{OK: true, Config: viewOf(record)})
}

func (handler *Handler) writeConfig(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		Config struct {
			Mode string `json:"mode"`
		} `json:"config"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64*1024))
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	mode, ok := parseMode(payload.Config.Mode)
	if !ok {
		writeError(response, http.StatusBadRequest, "invalid_mode", "mode 必须是 auto/on/off")
		return
	}
	record, err := handler.readRecord(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_config_failed", "")
		return
	}
	record.Mode = mode
	if err := handler.writeRecord(request.Context(), record); err != nil {
		writeError(response, http.StatusInternalServerError, "set_config_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, responseView{OK: true, Config: viewOf(record)})
}

func (handler *Handler) probe(response http.ResponseWriter, request *http.Request) {
	record, err := handler.readRecord(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_config_failed", "")
		return
	}
	result := handler.prober.Probe(request.Context())
	reachable := result.Reachable
	record.Reachable = &reachable
	record.CheckedAt = time.Now().UnixMilli()
	record.Detail = result.Detail
	if err := handler.writeRecord(request.Context(), record); err != nil {
		writeError(response, http.StatusInternalServerError, "set_config_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, responseView{OK: true, Config: viewOf(record)})
}

func (handler *Handler) readRecord(ctx context.Context) (claudepreflight.Record, error) {
	raw, found, err := handler.store.ReadClaudePreflight(ctx)
	if err != nil {
		return claudepreflight.Record{}, err
	}
	return claudepreflight.Normalize(raw, found), nil
}

func (handler *Handler) writeRecord(ctx context.Context, record claudepreflight.Record) error {
	return handler.store.WriteClaudePreflight(ctx, record.Encode())
}

func parseMode(value string) (claudepreflight.Mode, bool) {
	switch claudepreflight.Mode(strings.ToLower(strings.TrimSpace(value))) {
	case claudepreflight.ModeAuto:
		return claudepreflight.ModeAuto, true
	case claudepreflight.ModeOn:
		return claudepreflight.ModeOn, true
	case claudepreflight.ModeOff:
		return claudepreflight.ModeOff, true
	default:
		return "", false
	}
}

func viewOf(record claudepreflight.Record) ConfigView {
	return ConfigView{
		Mode:      record.Mode,
		Effective: record.Effective(),
		Reachable: record.Reachable,
		CheckedAt: record.CheckedAt,
		Detail:    record.Detail,
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, map[string]any{"ok": false, "error": code, "message": message})
}
