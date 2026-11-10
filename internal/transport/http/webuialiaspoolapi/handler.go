// Package webuialiaspoolapi 提供账号「是否参与别名自动选号池」的只读设置。
//
// 存储是 Node app-state.db 的 app_kv（account:alias-pool:<ref>）。写入口仍在 Node
// （POST /v0/webui/accounts/:provider/:ref/alias-pool），本包只读。
package webuialiaspoolapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	// Path 是账号级别名池设置的管理契约前缀。
	//
	//	GET /v1/management/webui/accounts/{provider}/{accountRef}/alias-pool
	Path = "/v1/management/webui/accounts"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("别名池设置接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 读取账号归属与别名池设置。
type Store interface {
	LookupProvider(ctx context.Context, accountRef string) (string, bool, error)
	// ReadParticipation 返回 participates；没有记录时为默认 true。
	ReadParticipation(ctx context.Context, accountRef string) (bool, error)
	// WriteParticipation 以单事务 upsert 账号的 participates 设置。
	WriteParticipation(ctx context.Context, accountRef string, participates bool, updatedAt int64) error
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
}

// Handler 处理别名池设置读取。
type Handler struct {
	authorizer Authorizer
	store      Store
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, store: dependencies.Store}, nil
}

type settingView struct {
	Participates bool `json:"participates"`
}

type responseView struct {
	OK         bool        `json:"ok"`
	Provider   string      `json:"provider"`
	AccountRef string      `json:"accountRef"`
	Setting    settingView `json:"setting"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 接受 GET/POST：GET 读设置，POST 写入 participates。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "alias_pool_unavailable", "别名池设置服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET/POST")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return
	}
	owner, found, err := handler.store.LookupProvider(request.Context(), accountRef)
	if err != nil || !found {
		writeError(response, http.StatusNotFound, "account_not_found", "")
		return
	}
	if strings.ToLower(strings.TrimSpace(owner)) != provider {
		// 与 Node 一致：账号存在但 Provider 不匹配是冲突，不是「不存在」。
		writeError(response, http.StatusConflict, "account_provider_mismatch", "")
		return
	}
	if request.Method == http.MethodPost {
		var payload any
		decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 16*1024))
		if err := decoder.Decode(&payload); err != nil {
			writeError(response, http.StatusBadRequest, "invalid_json_body", "")
			return
		}
		object, ok := payload.(map[string]any)
		if !ok || object == nil {
			writeError(response, http.StatusBadRequest, "invalid_request_body", "")
			return
		}
		rawParticipates, exists := object["participates"]
		participates, isBool := rawParticipates.(bool)
		if !exists || !isBool {
			writeError(response, http.StatusBadRequest, "invalid_participates", "")
			return
		}
		if err := handler.store.WriteParticipation(request.Context(), accountRef, participates, time.Now().UnixMilli()); err != nil {
			writeError(response, http.StatusInternalServerError, "alias_pool_write_failed", "")
			return
		}
		writeJSON(response, http.StatusOK, responseView{
			OK:         true,
			Provider:   provider,
			AccountRef: accountRef,
			Setting:    settingView{Participates: participates},
		})
		return
	}
	participates, err := handler.store.ReadParticipation(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "alias_pool_read_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, responseView{
		OK:         true,
		Provider:   provider,
		AccountRef: accountRef,
		Setting:    settingView{Participates: participates},
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
