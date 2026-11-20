// Package webuicontrolplaneapi 提供控制面 profiles 读写、局域网端点提示与跨 Server 透明流式代理。
//
// profiles 持久化于 app-state.db 的 control-plane:profiles，进程内由 profileCache 提供
// 基于文件指纹的 O(1) 内存索引，并供 RemoteProxy 一行正交挂载以实现零缓冲跨节点代理。
package webuicontrolplaneapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

const (
	// Path 是控制面管理契约前缀。
	Path = "/v1/management/webui/control-plane"
	// PublicPath 是浏览器直连的控制面公开前缀。
	PublicPath = "/v0/webui/control-plane"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("控制面接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总控制面接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	// BindHost 是服务配置的监听地址（如 127.0.0.1 或 0.0.0.0），供浏览器无参直连 /endpoints 时判定局域网可达性。
	BindHost string
	// ListenPort 返回服务实际监听端口（可选），供无显式端口的场景拼装局域网候选地址。
	ListenPort func() int
	// ManagementKey 返回服务端当前生效的 Management Key；用于覆盖本机 profile
	// 里可能过期的密钥快照，避免轮换后浏览器继续拿旧 Key 打 401。
	ManagementKey func() string
}

// Handler 处理控制面 profiles/endpoints，并持有可与 RemoteProxy 共享的内存缓存。
type Handler struct {
	authorizer    Authorizer
	aiHomeDir     string
	bindHost      string
	listenPort    func() int
	managementKey func() string
	cache         *profileCache
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	home := strings.TrimSpace(dependencies.AIHomeDir)
	if dependencies.Authorizer == nil || home == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:    dependencies.Authorizer,
		aiHomeDir:     home,
		bindHost:      strings.TrimSpace(dependencies.BindHost),
		listenPort:    dependencies.ListenPort,
		managementKey: dependencies.ManagementKey,
		cache:         newProfileCache(home),
	}, nil
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 负责 profiles 的 CRUD 与 endpoints 提示。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "control_plane_unavailable", "控制面服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	path := trimControlPlanePrefix(request.URL.Path)
	switch {
	case path == "/profiles":
		handler.handleProfiles(response, request)
	case path == "/profiles/active":
		handler.handleActive(response, request)
	case strings.HasPrefix(path, "/profiles/"):
		handler.handleRemove(response, request, strings.TrimPrefix(path, "/profiles/"))
	case path == "/endpoints":
		handler.handleEndpoints(response, request)
	default:
		writeError(response, http.StatusNotFound, "not_found", "")
	}
}

func trimControlPlanePrefix(requestPath string) string {
	if requestPath == Path || strings.HasPrefix(requestPath, Path+"/") {
		return strings.TrimPrefix(requestPath, Path)
	}
	if requestPath == PublicPath || strings.HasPrefix(requestPath, PublicPath+"/") {
		return strings.TrimPrefix(requestPath, PublicPath)
	}
	return requestPath
}

func (handler *Handler) handleProfiles(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet {
		store, err := handler.readStore(request.Context())
		if err != nil {
			writeError(response, http.StatusInternalServerError, "control_plane_profile_read_failed", "")
			return
		}
		handler.overlayLocalManagementKey(store, request.Host)
		writeJSON(response, http.StatusOK, map[string]any{
			"ok": true, "profiles": store["profiles"], "activeProfileId": store["activeProfileId"],
		})
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}
	var payload map[string]any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 1024*1024))
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	profileValue := payload["profile"]
	if profileValue == nil {
		profileValue = payload
	}
	options := map[string]any{"active": payload["active"] == true, "activeProfileId": payload["activeProfileId"]}
	var savedProfile map[string]any
	var nextStore map[string]any
	err := handler.updateStore(request.Context(), func(store map[string]any) (map[string]any, error) {
		next, profile, err := saveProfileInStore(store, profileValue, options)
		if err != nil {
			return nil, err
		}
		savedProfile, nextStore = profile, next
		return next, nil
	})
	if err != nil {
		status := http.StatusInternalServerError
		code := "control_plane_profile_save_failed"
		if err.Error() == "invalid_control_plane_profile" {
			status, code = http.StatusBadRequest, "invalid_control_plane_profile"
		}
		writeError(response, status, code, err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok": true, "profile": savedProfile,
		"profiles": nextStore["profiles"], "activeProfileId": nextStore["activeProfileId"],
	})
}

func (handler *Handler) handleActive(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}
	var payload map[string]any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64*1024))
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	var nextStore map[string]any
	err := handler.updateStore(request.Context(), func(store map[string]any) (map[string]any, error) {
		nextStore = setActiveInStore(store, text(payload["profileId"], 96))
		return nextStore, nil
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "control_plane_profile_set_active_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok": true, "profiles": nextStore["profiles"], "activeProfileId": nextStore["activeProfileId"],
	})
}

func (handler *Handler) handleRemove(response http.ResponseWriter, request *http.Request, profileID string) {
	if request.Method != http.MethodDelete {
		response.Header().Set("Allow", http.MethodDelete)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}
	decodedID, err := url.PathUnescape(profileID)
	if err != nil {
		decodedID = profileID
	}
	var nextStore map[string]any
	err = handler.updateStore(request.Context(), func(store map[string]any) (map[string]any, error) {
		nextStore = removeFromStore(store, decodedID)
		return nextStore, nil
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "control_plane_profile_remove_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok": true, "profiles": nextStore["profiles"], "activeProfileId": nextStore["activeProfileId"],
	})
}

func (handler *Handler) readStore(ctx context.Context) (map[string]any, error) {
	return handler.cache.ReadStore(ctx)
}

func (handler *Handler) updateStore(ctx context.Context, mutate func(store map[string]any) (map[string]any, error)) error {
	return handler.cache.UpdateStore(ctx, mutate)
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

// overlayLocalManagementKey 用服务端当前 Key 替换本机 profile 的旧快照。
//
// profile store 只在用户连接时写入 managementKey；服务端轮换 Key 后，旧值会
// 一直留在 store 里，浏览器同步 profile 时又会拿回旧 Key。这里仅覆盖 loopback
// 或与当前请求同 host 的 profile，远端 profile 的凭据不受影响。
func (handler *Handler) overlayLocalManagementKey(store map[string]any, requestHost string) {
	if handler == nil || handler.managementKey == nil {
		return
	}
	key := strings.TrimSpace(handler.managementKey())
	if key == "" {
		return
	}
	profiles, _ := store["profiles"].([]map[string]any)
	for _, profile := range profiles {
		if profile == nil {
			continue
		}
		if !isLocalProfileEndpoint(text(profile["endpoint"], 0), requestHost) {
			continue
		}
		profile["managementKey"] = key
	}
}

func isLocalProfileEndpoint(endpoint string, requestHost string) bool {
	parsed, err := url.Parse(strings.TrimSpace(endpoint))
	if err != nil || parsed.Host == "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	return strings.EqualFold(parsed.Host, strings.TrimSpace(requestHost))
}
