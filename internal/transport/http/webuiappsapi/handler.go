// Package webuiappsapi 提供本机应用列表与「只给本次实例挂代理」的启动接口。
package webuiappsapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
)

const (
	// Path 是应用列表与启动的管理契约。
	//
	//	GET  /v1/management/webui/apps
	//	POST /v1/management/webui/apps/launch
	Path       = "/v1/management/webui/apps"
	LaunchPath = Path + "/launch"

	maxBodyBytes = 16 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权端口。
var ErrInvalidDependencies = errors.New("本机应用接口依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Handler 是本机应用接口的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
}

// NewHandler 创建 Handler。
func NewHandler(authorizer Authorizer) (*Handler, error) {
	if authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: authorizer}, nil
}

// ServeHTTP 处理列表与启动。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || !handler.authorizer.Authorized(request) {
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	switch strings.TrimRight(request.URL.Path, "/") {
	case Path:
		if request.Method != http.MethodGet {
			response.Header().Set("Allow", http.MethodGet)
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		apps, err := appcatalog.List()
		if err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "list_apps_failed"})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "apps": apps})
	case LaunchPath:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		handler.launch(response, request)
	default:
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "route_not_found"})
	}
}

func (handler *Handler) launch(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		Query    string `json:"query"`
		Proxy    bool   `json:"proxy"`
		ProxyURL string `json:"proxyUrl"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
		return
	}
	app, err := appcatalog.Resolve(payload.Query)
	if err != nil {
		code := "app_not_found"
		if errors.Is(err, appcatalog.ErrAmbiguous) {
			code = "app_ambiguous"
		}
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": code})
		return
	}
	proxyURL := ""
	if payload.Proxy {
		proxyURL = strings.TrimSpace(payload.ProxyURL)
		if proxyURL == "" {
			proxyURL = appcatalog.DefaultProxyURL()
		}
	}
	if err := appcatalog.Launch(app, appcatalog.LaunchOptions{ProxyURL: proxyURL}); err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "launch_failed", "message": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "app": app, "proxyUrl": proxyURL})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}