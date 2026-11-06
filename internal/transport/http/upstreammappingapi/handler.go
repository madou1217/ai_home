// Package upstreammappingapi 是上游错误映射组的管理 HTTP 边界。
//
// 本包只做鉴权、路径分派、JSON DTO 与错误映射；组与规则的语义在
// core/upstreammapping，事务与版本 CAS 在 sqliteaccount 适配器。Node 的账号级
// 规则链路与本接口无关：这里只读写「组」，不触碰任何账号配置。
//
//	GET    /v1/management/upstream-error-mapping-groups        列出全部组
//	POST   /v1/management/upstream-error-mapping-groups        新建组（可带 id 做幂等重试）
//	GET    /v1/management/upstream-error-mapping-groups/{id}   读取单个组
//	PUT    /v1/management/upstream-error-mapping-groups/{id}   更新组（可带 version 做并发校验）
//	DELETE /v1/management/upstream-error-mapping-groups/{id}   删除组
package upstreammappingapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	mappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// Path 是映射组集合资源的规范路径。
const Path = "/v1/management/upstream-error-mapping-groups"

const (
	// maxBodyBytes 与 Node 的映射组路由保持一致。
	maxBodyBytes = 1 << 20
	// mappingDataVersion 是 Node app-state 里映射组文档的版本号。
	mappingDataVersion = 1
)

// ErrInvalidDependencies 表示 Handler 缺少服务或鉴权。
var ErrInvalidDependencies = errors.New("上游错误映射组 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Service 是映射组用例端口（由 application/upstreammapping.Service 实现）。
type Service interface {
	List(ctx context.Context) ([]mappingcore.Group, error)
	Get(ctx context.Context, id string) (mappingcore.Group, error)
	Create(ctx context.Context, input mappingapp.CreateInput) (mappingcore.Group, error)
	Update(ctx context.Context, id string, input mappingapp.UpdateInput) (mappingcore.Group, error)
	Delete(ctx context.Context, id string, expectedVersion *int64) error
}

// Dependencies 汇总映射组接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    Service
}

// Handler 提供映射组 CRUD。
type Handler struct {
	authorizer Authorizer
	service    Service
}

// NewHandler 创建映射组管理接口。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, service: dependencies.Service}, nil
}

// groupPayload 是创建/更新的请求体；指针字段区分「未提供」与显式零值。
type groupPayload struct {
	ID          *string           `json:"id"`
	Name        *string           `json:"name"`
	Description *string           `json:"description"`
	Provider    *string           `json:"provider"`
	Enabled     *bool             `json:"enabled"`
	Rules       *[]rulescore.Rule `json:"rules"`
	Version     *int64            `json:"version"`
}

// ServeHTTP 只接受 Management Key 鉴权过的 CRUD 请求。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.service == nil {
		writeError(response, http.StatusServiceUnavailable, "mapping_groups_unavailable", "映射组服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	memberID, memberPath, ok := splitPath(request.URL.Path)
	if !ok {
		writeError(response, http.StatusNotFound, "route_not_found", "路径不存在")
		return
	}
	switch {
	case !memberPath && request.Method == http.MethodGet:
		handler.list(response, request)
	case !memberPath && request.Method == http.MethodPost:
		handler.create(response, request)
	case memberPath && request.Method == http.MethodGet:
		handler.get(response, request, memberID)
	case memberPath && request.Method == http.MethodPut:
		handler.update(response, request, memberID)
	case memberPath && request.Method == http.MethodDelete:
		handler.remove(response, request, memberID)
	default:
		response.Header().Set("Allow", "GET, POST, PUT, DELETE")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的映射组操作")
	}
}

// splitPath 返回成员 id 以及是否命中成员路径。
func splitPath(path string) (string, bool, bool) {
	if path != Path && !strings.HasPrefix(path, Path+"/") {
		return "", false, false
	}
	rest := strings.Trim(strings.TrimPrefix(path, Path), "/")
	if rest == "" {
		return "", false, true
	}
	if strings.Contains(rest, "/") {
		return "", false, false
	}
	return rest, true, true
}

func (handler *Handler) list(response http.ResponseWriter, request *http.Request) {
	groups, err := handler.service.List(request.Context())
	if err != nil {
		writeServiceError(response, err)
		return
	}
	if groups == nil {
		groups = []mappingcore.Group{}
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":      true,
		"version": mappingDataVersion,
		"groups":  groups,
	})
}

func (handler *Handler) get(response http.ResponseWriter, request *http.Request, id string) {
	group, err := handler.service.Get(request.Context(), id)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "group": group})
}

func (handler *Handler) create(response http.ResponseWriter, request *http.Request) {
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	if payload.Rules == nil {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "每条映射组须有 1–20 条规则")
		return
	}
	input := mappingapp.CreateInput{}
	if payload.ID != nil {
		input.ID = *payload.ID
	}
	if payload.Name != nil {
		input.Name = *payload.Name
	}
	if payload.Description != nil {
		input.Description = *payload.Description
	}
	if payload.Provider != nil {
		input.Provider = *payload.Provider
	}
	input.Enabled = payload.Enabled
	input.Rules = *payload.Rules
	group, err := handler.service.Create(request.Context(), input)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	handler.writeGroup(response, request, group)
}

func (handler *Handler) update(response http.ResponseWriter, request *http.Request, id string) {
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	group, err := handler.service.Update(request.Context(), id, mappingapp.UpdateInput{
		Name:        payload.Name,
		Description: payload.Description,
		Provider:    payload.Provider,
		Enabled:     payload.Enabled,
		Rules:       payload.Rules,
		Version:     payload.Version,
	})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	handler.writeGroup(response, request, group)
}

func (handler *Handler) remove(response http.ResponseWriter, request *http.Request, id string) {
	version, ok := parseVersionQuery(response, request.URL.Query().Get("version"))
	if !ok {
		return
	}
	if err := handler.service.Delete(request.Context(), id, version); err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}

// writeGroup 返回最新单组与整份集合，与 Node 路由的响应形状一致。
func (handler *Handler) writeGroup(response http.ResponseWriter, request *http.Request, group mappingcore.Group) {
	groups, err := handler.service.List(request.Context())
	if err != nil {
		// 写入已经成功，不能把列表读取失败报成写失败；单组仍然返回。
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "group": group})
		return
	}
	if groups == nil {
		groups = []mappingcore.Group{}
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "group": group, "groups": groups})
}

// parseVersionQuery 解析可选的 version 查询参数。
func parseVersionQuery(response http.ResponseWriter, value string) (*int64, bool) {
	if strings.TrimSpace(value) == "" {
		return nil, true
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 1 {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group_version", "version 须为正整数")
		return nil, false
	}
	return &parsed, true
}

func decodePayload(response http.ResponseWriter, request *http.Request) (groupPayload, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || int64(len(body)) > maxBodyBytes {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体无效")
		return groupPayload{}, false
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	var payload groupPayload
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体不是合法 JSON")
		return groupPayload{}, false
	}
	return payload, true
}

func writeServiceError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, mappingcore.ErrGroupNotFound):
		writeError(response, http.StatusNotFound, "mapping_group_not_found", "映射组不存在")
	case errors.Is(err, mappingcore.ErrGroupConflict):
		writeError(response, http.StatusConflict, "mapping_group_conflict", "映射组已被其他请求修改，请刷新后重试")
	case errors.Is(err, mappingcore.ErrGroupExists):
		writeError(response, http.StatusConflict, "mapping_group_exists", "同一 id 的映射组已存在且内容不同")
	case errors.Is(err, mappingcore.ErrGroupLimit):
		writeError(response, http.StatusBadRequest, "mapping_group_limit_exceeded", "映射组数量已达上限")
	case errors.Is(err, mappingcore.ErrUnknownProvider):
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "目标 Provider 不在当前注册表里")
	case errors.Is(err, mappingcore.ErrInvalidGroup):
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", err.Error())
	default:
		writeError(response, http.StatusInternalServerError, "mapping_group_failed", "映射组操作失败")
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}
