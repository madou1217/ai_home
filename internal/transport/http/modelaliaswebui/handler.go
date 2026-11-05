package modelaliaswebui

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/modelalias"
)

// Path 是别名 CRUD 的 WebUI 契约前缀。
//
//	GET    /v1/management/webui/model-aliases
//	POST   /v1/management/webui/model-aliases
//	PUT    /v1/management/webui/model-aliases/{id}
//	DELETE /v1/management/webui/model-aliases/{id}
//	POST   /v1/management/webui/model-aliases/{id}/enabled
const Path = "/v1/management/webui/model-aliases"

const maxBodyBytes = 64 * 1024

var ErrInvalidDependencies = errors.New("模型别名 WebUI 接口依赖无效")

type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Service 是别名写用例端口（由 application/modelalias.Service 实现）。
type Service interface {
	List() []modelalias.Record
	Create(ctx context.Context, input modelalias.CreateInput) (modelalias.Record, int64, error)
	Update(ctx context.Context, id string, input modelalias.UpdateInput) (modelalias.Record, int64, error)
	Delete(ctx context.Context, id string) (int64, error)
	SetEnabled(ctx context.Context, id string, enabled bool) (int64, error)
}

// Dependencies 汇总别名 CRUD 的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    Service
	// Refresh 触发一次路由目录重建，让写入立刻生效；为 nil 时只落库，等下次刷新。
	//
	// 为什么刷新失败不报错：别名已经安全落库，下一次目录构建仍会带上它；
	// 把刷新失败报成写失败会让用户以为没保存，反而去重复操作。
	Refresh func(context.Context) error
}

type Handler struct {
	authorizer Authorizer
	service    Service
	refresh    func(context.Context) error
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		service:    dependencies.Service,
		refresh:    dependencies.Refresh,
	}, nil
}

// refreshCatalog 在写入成功后让新别名立刻参与路由；失败静默（见 Dependencies.Refresh）。
func (handler *Handler) refreshCatalog(ctx context.Context) {
	if handler.refresh == nil {
		return
	}
	_ = handler.refresh(ctx)
}

// aliasPayload 是创建/更新的请求体；指针字段用于区分「未提供」与「显式零值」。
type aliasPayload struct {
	Alias          *string `json:"alias"`
	Target         *string `json:"target"`
	Provider       *string `json:"provider"`
	TargetProvider *string `json:"targetProvider"`
	Priority       *int32  `json:"priority"`
	Enabled        *bool   `json:"enabled"`
	Description    *string `json:"description"`
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.service == nil {
		writeError(response, http.StatusServiceUnavailable, "model_aliases_unavailable", "别名服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, Path), "/")
	parts := []string{}
	if rest != "" {
		parts = strings.Split(rest, "/")
	}
	switch {
	case len(parts) == 0 && request.Method == http.MethodGet:
		handler.list(response)
	case len(parts) == 0 && request.Method == http.MethodPost:
		handler.create(response, request)
	case len(parts) == 1 && request.Method == http.MethodPut:
		handler.update(response, request, parts[0])
	case len(parts) == 1 && request.Method == http.MethodDelete:
		handler.remove(response, request, parts[0])
	case len(parts) == 2 && parts[1] == "enabled" && request.Method == http.MethodPost:
		handler.setEnabled(response, request, parts[0])
	default:
		response.Header().Set("Allow", "GET, POST, PUT, DELETE")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的别名操作")
	}
}

func (handler *Handler) list(response http.ResponseWriter) {
	records := handler.service.List()
	if records == nil {
		records = []modelalias.Record{}
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "aliases": records})
}

func (handler *Handler) create(response http.ResponseWriter, request *http.Request) {
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	if payload.Alias == nil || payload.Target == nil {
		writeError(response, http.StatusBadRequest, "invalid_alias", "别名与目标不能为空")
		return
	}
	record, generation, err := handler.service.Create(request.Context(), modelalias.CreateInput{
		Alias:          *payload.Alias,
		Target:         *payload.Target,
		Provider:       valueOr(payload.Provider),
		TargetProvider: valueOr(payload.TargetProvider),
		Priority:       int32OrZero(payload.Priority),
		Enabled:        payload.Enabled,
		Description:    valueOr(payload.Description),
	})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	handler.refreshCatalog(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "alias": record, "generation": generation})
}

func (handler *Handler) update(response http.ResponseWriter, request *http.Request, id string) {
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	record, generation, err := handler.service.Update(request.Context(), id, modelalias.UpdateInput{
		Alias:          payload.Alias,
		Target:         payload.Target,
		Provider:       payload.Provider,
		TargetProvider: payload.TargetProvider,
		Priority:       payload.Priority,
		Enabled:        payload.Enabled,
		Description:    payload.Description,
	})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	handler.refreshCatalog(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "alias": record, "generation": generation})
}

func (handler *Handler) remove(response http.ResponseWriter, request *http.Request, id string) {
	generation, err := handler.service.Delete(request.Context(), id)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	handler.refreshCatalog(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "generation": generation})
}

func (handler *Handler) setEnabled(response http.ResponseWriter, request *http.Request, id string) {
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	if payload.Enabled == nil {
		writeError(response, http.StatusBadRequest, "invalid_alias", "缺少 enabled")
		return
	}
	generation, err := handler.service.SetEnabled(request.Context(), id, *payload.Enabled)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	handler.refreshCatalog(request.Context())
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "generation": generation})
}

func writeServiceError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, modelalias.ErrAliasNotFound):
		writeError(response, http.StatusNotFound, "alias_not_found", "别名不存在")
	case errors.Is(err, modelalias.ErrDuplicateAlias):
		writeError(response, http.StatusConflict, "alias_conflict", "同作用域下已存在同名别名")
	case errors.Is(err, modelalias.ErrInvalidAlias), errors.Is(err, modelalias.ErrInvalidProjection):
		writeError(response, http.StatusBadRequest, "invalid_alias", "别名参数无效")
	default:
		writeError(response, http.StatusInternalServerError, "model_aliases_failed", "别名操作失败")
	}
}

func decodePayload(response http.ResponseWriter, request *http.Request) (aliasPayload, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || int64(len(body)) > maxBodyBytes {
		writeError(response, http.StatusBadRequest, "invalid_alias", "请求体无效")
		return aliasPayload{}, false
	}
	var payload aliasPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_alias", "请求体不是合法 JSON")
		return aliasPayload{}, false
	}
	return payload, true
}

func valueOr(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func int32OrZero(value *int32) int32 {
	if value == nil {
		return 0
	}
	return *value
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"ok":    false,
		"error": map[string]string{"code": code, "message": message},
	})
}
