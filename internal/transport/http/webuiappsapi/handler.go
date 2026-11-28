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
	"net/url"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
	"github.com/madou1217/ai_home/internal/runtime/appproxyhealth"
	"github.com/madou1217/ai_home/internal/runtime/appproxyregion"
	"github.com/madou1217/ai_home/internal/runtime/appproxyserve"
	"github.com/madou1217/ai_home/internal/runtime/appsessions"
	"github.com/madou1217/ai_home/internal/runtime/proxycontrol"
	"github.com/madou1217/ai_home/internal/runtime/proxyendpoints"
)

const (
	// Path 是应用列表与启动的管理契约。
	//
	//	GET  /v1/management/webui/apps
	//	POST /v1/management/webui/apps/launch
	Path       = "/v1/management/webui/apps"
	LaunchPath = Path + "/launch"
	// DeskPath 是「应用看台」：已启动实例 + 代理状态 + 续约/结束/热替换。
	//
	//	GET  /v1/management/webui/apps/desk
	//	POST /v1/management/webui/apps/desk/renew
	//	POST /v1/management/webui/apps/desk/kill
	//	POST /v1/management/webui/apps/desk/hot-swap
	//	GET  /v1/management/webui/apps/desk/history
	//	POST /v1/management/webui/apps/desk/history/clear
	DeskPath             = Path + "/desk"
	DeskRenewPath        = DeskPath + "/renew"
	DeskKillPath         = DeskPath + "/kill"
	DeskHotSwapPath      = DeskPath + "/hot-swap"
	DeskHistoryPath      = DeskPath + "/history"
	DeskHistoryClearPath = DeskHistoryPath + "/clear"

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

// ProxyEntries starts/reuses temporary per-selector entries for app launches
// and manual reconnects.
type ProxyEntries interface {
	Ensure(ctx context.Context, selector string) (appproxyserve.Entry, error)
	EnsureOnPort(ctx context.Context, selector string, port int) (appproxyserve.Entry, error)
	RestartOnPort(ctx context.Context, selector string, port int) (appproxyserve.Entry, error)
	Stop(selector string)
}

// Dependencies 汇总 Handler 依赖。
type Dependencies struct {
	Authorizer   Authorizer
	Catalog      AppCatalog
	Launcher     ProxyLauncher
	ProxyEntries ProxyEntries
	AIHomeDir    string
}

// Handler 是本机应用接口的 HTTP 入站适配器。
type Handler struct {
	authorizer   Authorizer
	catalog      AppCatalog
	launcher     ProxyLauncher
	proxyEntries ProxyEntries
	aiHomeDir    string
}

// NewHandler 创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Catalog == nil || dependencies.Launcher == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		catalog:      dependencies.Catalog,
		launcher:     dependencies.Launcher,
		proxyEntries: dependencies.ProxyEntries,
		aiHomeDir:    dependencies.AIHomeDir,
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
	case DeskPath:
		if request.Method != http.MethodGet {
			response.Header().Set("Allow", http.MethodGet)
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		handler.desk(response, request)
	case DeskRenewPath:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		handler.renew(response, request)
	case DeskKillPath:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		handler.kill(response, request)
	case DeskHotSwapPath:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		handler.hotSwap(response, request)
	case DeskHistoryPath:
		if request.Method != http.MethodGet {
			response.Header().Set("Allow", http.MethodGet)
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		handler.history(response, request)
	case DeskHistoryClearPath:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", http.MethodPost)
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
			return
		}
		handler.clearHistory(response, request)
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
		ID            string `json:"id"`
		Query         string `json:"query"`
		Proxy         bool   `json:"proxy"`
		ProxyURL      string `json:"proxyUrl"`
		ProxySelector string `json:"proxySelector"`
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
	selector := strings.TrimSpace(payload.ProxySelector)
	customURL := strings.TrimSpace(payload.ProxyURL)
	if selector != "" && customURL != "" {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload", "message": "proxySelector 与 proxyUrl 只能指定一个"})
		return
	}
	entry := appproxyserve.Entry{}
	proxyURL := ""
	if payload.Proxy || selector != "" {
		if selector != "" {
			if handler.proxyEntries == nil {
				writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "proxy_entries_unavailable", "message": "临时节点/地区入口不可用"})
				return
			}
			ensured, entryErr := handler.proxyEntries.Ensure(request.Context(), selector)
			if entryErr != nil {
				writeJSON(response, http.StatusBadGateway, map[string]any{"ok": false, "error": "proxy_entry_failed", "message": entryErr.Error()})
				return
			}
			entry = ensured
			proxyURL = entry.URL
		} else {
			proxyURL = customURL
			if proxyURL == "" {
				proxyURL = applaunch.DefaultProxyURL(handler.aiHomeDir)
			}
		}
	}
	mode, err := handler.launcher.OpenWithProxy(request.Context(), app, applaunch.ProxyOptions{
		URL:         proxyURL,
		AIHomeDir:   handler.aiHomeDir,
		ProfileDir:  applaunch.ProfileDir(app, proxyURL, handler.aiHomeDir),
		Independent: true,
	})
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "launch_failed", "message": err.Error()})
		return
	}
	instance := appsessions.NewInstance(
		app,
		appsessions.ExecutableFor(app),
		applaunch.ProfileDir(app, proxyURL, handler.aiHomeDir),
		proxyURL,
		string(mode),
	)
	if entry.Selector != "" {
		instance.ProxySelector = entry.Selector
		instance.ProxyPID = entry.PID
		instance.ProxyCountry = entry.Country
		instance.ProxyCity = entry.CityCode
		instance.ProxyRegion = entry.Region
	} else {
		instance.ProxyCountry, instance.ProxyCity, instance.ProxyRegion = appproxyregion.Resolve(request.Context(), handler.aiHomeDir, proxyURL)
	}
	instance, recordErr := appsessions.New(handler.aiHomeDir).Add(request.Context(), instance)
	if recordErr != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "record_failed", "message": recordErr.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":            true,
		"app":           viewFor(app),
		"proxyUrl":      proxyURL,
		"proxyMode":     mode,
		"proxyLabel":    mode.Label(),
		"proxySelector": entry.Selector,
		"proxyRegion":   entry.Region,
		"proxyPid":      entry.PID,
		"instance":      instance,
	})
}

func (handler *Handler) desk(response http.ResponseWriter, request *http.Request) {
	view, err := handler.deskView(request)
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "desk_failed", "message": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "desk": view})
}

type deskView struct {
	Instances []appsessions.Instance `json:"instances"`
	// HistoryCount lets the desk label the history switch without shipping the
	// full history on every poll; rows are fetched lazily.
	HistoryCount int                 `json:"historyCount"`
	Proxy        proxycontrol.Status `json:"proxy"`
	HotSwap      bool                `json:"hotSwap"`
	ProxyError   string              `json:"proxyError,omitempty"`
}

func (handler *Handler) deskView(request *http.Request) (deskView, error) {
	instances, err := appsessions.New(handler.aiHomeDir).List(request.Context())
	if err != nil {
		return deskView{}, err
	}
	instances = appproxyregion.Enrich(request.Context(), instances, handler.aiHomeDir)
	active, history := appsessions.SplitActive(instances)
	active = appproxyhealth.Enrich(request.Context(), active)
	view := deskView{
		Instances:    active,
		HistoryCount: len(history),
		HotSwap:      proxycontrol.LoadSettings(handler.aiHomeDir).HotSwap,
	}
	client, loadErr := proxycontrol.Load(handler.aiHomeDir)
	if loadErr != nil {
		view.ProxyError = loadErr.Error()
		return view, nil
	}
	status, statusErr := client.Status(request.Context())
	if statusErr != nil {
		view.ProxyError = statusErr.Error()
		view.Proxy = status
		return view, nil
	}
	view.Proxy = status
	view.Proxy.HTTPURL = stripURLUserinfo(status.HTTPURL)
	view.Proxy.SOCKS5URL = stripURLUserinfo(status.SOCKS5URL)
	view.HotSwap = status.HotSwap
	return view, nil
}

func stripURLUserinfo(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil {
		return raw
	}
	parsed.User = nil
	return parsed.String()
}

// renew manually reconnects the selected app proxies.
//
// Temporary node/region entries are restarted on the port the already-running
// app was launched with; the resident 6152 entry is renewed through its control
// API. Custom URL proxies cannot be renewed by AIH and report a clear error.
func (handler *Handler) renew(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		IDs []string `json:"ids"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes)).Decode(&payload)
	store := appsessions.New(handler.aiHomeDir)
	instances, err := store.List(request.Context())
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "desk_failed", "message": err.Error()})
		return
	}
	wanted := make(map[string]struct{}, len(payload.IDs))
	for _, id := range payload.IDs {
		wanted[strings.TrimSpace(id)] = struct{}{}
	}
	selected := make([]appsessions.Instance, 0, len(instances))
	for _, instance := range instances {
		if !instance.Proxied || !instance.ActiveNow() {
			continue
		}
		if len(wanted) > 0 {
			if _, ok := wanted[instance.ID]; !ok {
				continue
			}
		}
		selected = append(selected, instance)
	}
	if len(selected) == 0 {
		writeJSON(response, http.StatusConflict, map[string]any{"ok": false, "error": "app_not_proxied", "message": "选中的应用没有使用代理"})
		return
	}

	client, _ := proxycontrol.Load(handler.aiHomeDir)
	residentStatus := proxycontrol.Status{}
	residentMatches := func(proxyURL string) bool {
		if client == nil {
			return false
		}
		status, statusErr := client.Status(request.Context())
		if statusErr != nil && status.HTTPURL == "" {
			return false
		}
		residentStatus = status
		return sameProxyEndpoint(status.HTTPURL, proxyURL)
	}

	type selectorGroup struct {
		selector  string
		port      int
		instances []appsessions.Instance
	}
	selectors := make(map[string]*selectorGroup)
	residentSelected := false
	errorsList := make([]string, 0)
	for _, instance := range selected {
		selector := strings.TrimSpace(instance.ProxySelector)
		if selector == "" {
			// Legacy entries launched with --proxy-url: the published endpoint
			// metadata now carries the selector the serve process was started
			// with, so the same port can be restored without guessing.
			if info, ok := proxyendpoints.Lookup(handler.aiHomeDir, instance.ProxyURL); ok {
				selector = strings.TrimSpace(info.Selector)
			}
		}
		switch strings.ToLower(selector) {
		case "", "auto", "pool":
			selector = ""
		}
		if selector != "" {
			port := proxyPort(instance.ProxyURL)
			if port <= 0 {
				errorsList = append(errorsList, instance.Name+"：代理地址缺少端口，请重新启动应用")
				continue
			}
			key := selector + "|" + strconv.Itoa(port)
			group := selectors[key]
			if group == nil {
				group = &selectorGroup{selector: selector, port: port}
				selectors[key] = group
			}
			group.instances = append(group.instances, instance)
			continue
		}
		if residentMatches(instance.ProxyURL) {
			residentSelected = true
			continue
		}
		errorsList = append(errorsList, instance.Name+"：自定义代理 URL 无法由 AIH 重连，请重新启动应用")
	}

	renewed := 0
	for _, group := range selectors {
		if handler.proxyEntries == nil {
			errorsList = append(errorsList, "临时节点/地区入口不可用")
			break
		}
		entry, ensureErr := handler.proxyEntries.RestartOnPort(request.Context(), group.selector, group.port)
		if ensureErr != nil {
			errorsList = append(errorsList, group.selector+":"+strconv.Itoa(group.port)+"："+ensureErr.Error())
			continue
		}
		for _, instance := range group.instances {
			if updateErr := store.SetProxyEntry(request.Context(), instance.ID, appsessions.ProxyEntry{
				URL:      entry.URL,
				Selector: group.selector,
				Country:  entry.Country,
				City:     entry.CityCode,
				Region:   entry.Region,
				PID:      entry.PID,
			}); updateErr != nil {
				errorsList = append(errorsList, instance.Name+"："+updateErr.Error())
				continue
			}
			renewed++
		}
	}
	if residentSelected {
		if client == nil {
			errorsList = append(errorsList, "本机代理入口未运行")
		} else {
			status, renewErr := client.Renew(request.Context())
			if renewErr != nil {
				errorsList = append(errorsList, "本机代理入口："+renewErr.Error())
			} else {
				residentStatus = status
				renewed++
			}
		}
	}
	if renewed == 0 {
		writeJSON(response, http.StatusBadGateway, map[string]any{"ok": false, "error": "renew_failed", "message": strings.Join(errorsList, "；"), "errors": errorsList})
		return
	}
	view, viewErr := handler.deskView(request)
	result := map[string]any{"ok": true, "proxy": residentStatus, "renewed": renewed}
	if len(errorsList) > 0 {
		result["errors"] = errorsList
	}
	if viewErr == nil {
		result["desk"] = view
	}
	writeJSON(response, http.StatusOK, result)
}

func sameProxyEndpoint(left, right string) bool {
	a, err := url.Parse(strings.TrimSpace(left))
	if err != nil || a == nil || a.Host == "" {
		return false
	}
	b, err := url.Parse(strings.TrimSpace(right))
	if err != nil || b == nil || b.Host == "" {
		return false
	}
	return strings.EqualFold(a.Host, b.Host)
}

func proxyPort(raw string) int {
	endpoint, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || endpoint == nil || endpoint.Port() == "" {
		return 0
	}
	port, err := strconv.Atoi(endpoint.Port())
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

func (handler *Handler) kill(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		IDs []string `json:"ids"`
	}
	if json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes)).Decode(&payload) != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
		return
	}
	results, err := appsessions.New(handler.aiHomeDir).Kill(request.Context(), payload.IDs)
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "kill_failed", "message": err.Error()})
		return
	}
	view, viewErr := handler.deskView(request)
	payloadOut := map[string]any{"ok": true, "results": results}
	if viewErr == nil {
		payloadOut["desk"] = view
	}
	writeJSON(response, http.StatusOK, payloadOut)
}

func (handler *Handler) hotSwap(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		Enabled bool `json:"enabled"`
	}
	if json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes)).Decode(&payload) != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
		return
	}
	client, loadErr := proxycontrol.Load(handler.aiHomeDir)
	if loadErr != nil {
		// No running entry: persist the preference for the next start.
		if err := proxycontrol.SaveSettings(handler.aiHomeDir, proxycontrol.Settings{HotSwap: payload.Enabled}); err != nil {
			writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "save_failed", "message": err.Error()})
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "hotSwap": payload.Enabled, "running": false})
		return
	}
	status, err := client.SetHotSwap(request.Context(), payload.Enabled)
	if err != nil {
		writeJSON(response, http.StatusConflict, map[string]any{"ok": false, "error": "hot_swap_failed", "message": err.Error(), "proxy": status})
		return
	}
	_ = proxycontrol.SaveSettings(handler.aiHomeDir, proxycontrol.Settings{HotSwap: payload.Enabled})
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "hotSwap": payload.Enabled, "proxy": status})
}

// history returns ended launches only; the live desk never includes them.
func (handler *Handler) history(response http.ResponseWriter, request *http.Request) {
	history, err := appsessions.New(handler.aiHomeDir).History(request.Context())
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "history_failed", "message": err.Error()})
		return
	}
	history = appproxyregion.Enrich(request.Context(), history, handler.aiHomeDir)
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "instances": history})
}

// clearHistory removes exited records without touching processes.
func (handler *Handler) clearHistory(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		IDs []string `json:"ids"`
	}
	if request.Body != nil && request.ContentLength != 0 {
		if json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes)).Decode(&payload) != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
			return
		}
	}
	removed, err := appsessions.New(handler.aiHomeDir).RemoveHistory(request.Context(), payload.IDs)
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": "clear_history_failed", "message": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "removed": removed})
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
