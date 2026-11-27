// Package webuiappsapi 提供本机应用列表与「只给本次实例挂代理」的启动接口。
//
// 应用目录来自 alt+space 工作台同一个 launcher.Service；这里只增加代理启动
// 语义，不维护第二份扫描或别名表。
package webuiappsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
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

// ErrInvalidDependencies 表示 Handler 缺少鉴权或应用目录端口。
var ErrInvalidDependencies = errors.New("本机应用接口依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AppCatalog 是工作台的应用目录（排序、别名、frecency 全由它提供）。
type AppCatalog interface {
	List(ctx context.Context, options launcher.ListOptions) (launcher.ListResult, error)
}

// ProxyLauncher 启动一个带代理的独立应用实例。
type ProxyLauncher interface {
	OpenWithProxy(ctx context.Context, app launcher.App, options applaunch.ProxyOptions) (applaunch.ProxyMode, error)
}

// Dependencies 汇总 Handler 依赖。
type Dependencies struct {
	Authorizer Authorizer
	Catalog    AppCatalog
	Launcher   ProxyLauncher
	AIHomeDir  string
}

// Handler 是本机应用接口的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	catalog    AppCatalog
	launcher   ProxyLauncher
	aiHomeDir  string
}

// NewHandler 创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Catalog == nil || dependencies.Launcher == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		catalog:    dependencies.Catalog,
		launcher:   dependencies.Launcher,
		aiHomeDir:  dependencies.AIHomeDir,
	}, nil
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
		handler.list(response, request)
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

func (handler *Handler) list(response http.ResponseWriter, request *http.Request) {
	result, err := handler.catalog.List(request.Context(), launcher.ListOptions{})
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "list_apps_failed", "message": err.Error()})
		return
	}
	apps := make([]appView, 0, len(result.Apps))
	for _, app := range result.Apps {
		apps = append(apps, viewFor(app))
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":          true,
		"platform":    result.Platform,
		"generatedAt": result.GeneratedAt,
		"apps":        apps,
	})
}

func (handler *Handler) launch(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		ID       string `json:"id"`
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
	result, err := handler.catalog.List(request.Context(), launcher.ListOptions{})
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "list_apps_failed", "message": err.Error()})
		return
	}
	app, err := resolveApp(result.Apps, strings.TrimSpace(payload.ID), strings.TrimSpace(payload.Query))
	if err != nil {
		code := "app_not_found"
		if errors.Is(err, launcher.ErrQueryAmbiguous) {
			code = "app_ambiguous"
		}
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": code})
		return
	}
	proxyURL := ""
	if payload.Proxy {
		proxyURL = strings.TrimSpace(payload.ProxyURL)
		if proxyURL == "" {
			proxyURL = applaunch.DefaultProxyURL(handler.aiHomeDir)
		}
	}
	mode, err := handler.launcher.OpenWithProxy(request.Context(), app, applaunch.ProxyOptions{
		URL:       proxyURL,
		AIHomeDir: handler.aiHomeDir,
	})
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "launch_failed", "message": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":         true,
		"app":        viewFor(app),
		"proxyUrl":   proxyURL,
		"proxyMode":  mode,
		"proxyLabel": mode.Label(),
	})
}

func resolveApp(apps []launcher.App, id, query string) (launcher.App, error) {
	if id != "" {
		for _, app := range apps {
			if app.ID == id {
				return app, nil
			}
		}
		return launcher.App{}, launcher.ErrNotFound
	}
	return launcher.ResolveQuery(apps, query)
}

// appView 是 WebUI 需要的稳定投影；不返回内部 DesktopID/Exec。
type appView struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Subtitle   string `json:"subtitle,omitempty"`
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	Icon       string `json:"icon,omitempty"`
	Terminal   bool   `json:"terminal,omitempty"`
	ProxyMode  string `json:"proxyMode"`
	ProxyLabel string `json:"proxyLabel"`
}

func viewFor(app launcher.App) appView {
	mode := applaunch.ProxyModeFor(app)
	return appView{
		ID:         app.ID,
		Name:       app.Name,
		Subtitle:   app.Subtitle,
		Path:       app.Path,
		Kind:       string(app.Kind),
		Icon:       app.Icon,
		Terminal:   app.Terminal,
		ProxyMode:  string(mode),
		ProxyLabel: mode.Label(),
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
