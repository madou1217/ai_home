// Package webuicontrolplaneapi 提供控制面 profiles 与端点提示的读写。
//
// profiles 存 Node app-state.db 的 control-plane:profiles；Go 成为 WebUI 写入口，
// 读路径归一化后返回。端点提示只依赖请求地址、绑定 host 与本机网卡，不碰运行态。
package webuicontrolplaneapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// Path 是控制面管理契约前缀。
	Path = "/v1/management/webui/control-plane"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("控制面接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
}

// Handler 处理控制面 profiles/endpoints。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, aiHomeDir: strings.TrimSpace(dependencies.AIHomeDir)}, nil
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
	path := strings.TrimPrefix(request.URL.Path, Path)
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

func (handler *Handler) handleProfiles(response http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet {
		store, err := handler.readStore(request.Context())
		if err != nil {
			writeError(response, http.StatusInternalServerError, "control_plane_profile_read_failed", "")
			return
		}
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

func (handler *Handler) databasePath() (string, error) {
	return appstate.DatabasePath(handler.aiHomeDir)
}

func (handler *Handler) readStore(ctx context.Context) (map[string]any, error) {
	databasePath, err := handler.databasePath()
	if err != nil {
		return nil, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, profilesKey)
	if err != nil {
		return nil, err
	}
	return decodeStore(raw, found)
}

func (handler *Handler) updateStore(ctx context.Context, mutate func(store map[string]any) (map[string]any, error)) error {
	databasePath, err := handler.databasePath()
	if err != nil {
		return err
	}
	return appstate.UpdateKV(ctx, databasePath, profilesKey, func(current string, found bool) (string, error) {
		store, err := decodeStore(current, found)
		if err != nil {
			return "", err
		}
		next, err := mutate(store)
		if err != nil {
			return "", err
		}
		encoded, err := json.Marshal(next)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
