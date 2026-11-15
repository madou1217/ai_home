// Package upstreammappingapi 是上游错误映射组的管理 HTTP 边界。
//
// 本包只做鉴权、路径分派、JSON DTO 与错误映射；组与规则的语义在
// core/upstreammapping，事务与版本 CAS 在 sqliteaccount 适配器。
//
//	GET    /v1/management/upstream-error-mapping-groups          列出全部组
//	POST   /v1/management/upstream-error-mapping-groups          新建组（可带 id 做幂等重试）
//	POST   /v1/management/upstream-error-mapping-groups/import   批量幂等导入映射组（支持显式数组/包装对象/app-state 迁移）
//	GET    /v1/management/upstream-error-mapping-groups/{id}     读取单个组
//	PUT    /v1/management/upstream-error-mapping-groups/{id}     更新组（可带 version 做并发校验）
//	DELETE /v1/management/upstream-error-mapping-groups/{id}     删除组
//	POST   /v1/management/upstream-error-mapping-groups/{id}/toggle 切换组启停状态（CAS）
package upstreammappingapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	mappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// Path 是映射组集合资源的规范路径。
const Path = "/v1/management/upstream-error-mapping-groups"

// WebUIPath 是 WebUI 映射组集合的管理契约路径。
const WebUIPath = "/v1/management/webui/upstream-error-mappings"

// ImportSubpath 是批量导入动作的固定子路径。
const ImportSubpath = "/import"

const (
	// maxBodyBytes 限制单次请求体大小（1 MiB）。
	maxBodyBytes = 1 << 20
	// maxImportGroups 限制单次批量导入的映射组上限。
	maxImportGroups = 100
	// mappingDataVersion 是映射组文档结构版本号。
	mappingDataVersion = 1
	// appStateMappingGroupsKey 是历史 app-state.db 中映射组的存储键，仅在无参迁移导入时读取。
	appStateMappingGroupsKey = "upstream-error-mapping-groups"
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
	// BasePath 允许为 WebUI 挂接独立前缀；留空时使用 Path。
	BasePath string
	// AIHomeDir 可选：当 /import 请求体为空对象或空正文时，用于从 app-state.db 读取历史映射组做一次性迁入。
	AIHomeDir string
}

// Handler 提供映射组 CRUD 与幂等批量导入。
type Handler struct {
	authorizer Authorizer
	service    Service
	basePath   string
	aiHomeDir  string
}

// NewHandler 创建映射组管理接口。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Service == nil {
		return nil, ErrInvalidDependencies
	}
	basePath := strings.TrimRight(strings.TrimSpace(dependencies.BasePath), "/")
	if basePath == "" {
		basePath = Path
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		service:    dependencies.Service,
		basePath:   basePath,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
	}, nil
}

// groupPayload 是创建/更新/导入的组对象；指针字段区分「未提供」与显式零值。
type groupPayload struct {
	ID          *string           `json:"id"`
	Name        *string           `json:"name"`
	Description *string           `json:"description"`
	Provider    *string           `json:"provider"`
	Enabled     *bool             `json:"enabled"`
	Rules       *[]rulescore.Rule `json:"rules"`
	Version     *int64            `json:"version"`
	// position / createdAtMs / updatedAtMs / source 是服务端返回的展示元数据，
	// 前端编辑或导出后再导入时会原样带回：接受并忽略，保证读出对象可直接回写。
	Position    *json.RawMessage `json:"position"`
	CreatedAtMs *json.RawMessage `json:"createdAtMs"`
	UpdatedAtMs *json.RawMessage `json:"updatedAtMs"`
	Source      *json.RawMessage `json:"source"`
}

type importFailureView struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

type routeKind uint8

const (
	routeNotFound routeKind = iota
	routeCollection
	routeImport
	routeMember
	routeToggle
)

// ServeHTTP 只接受 Management Key 鉴权过的请求。
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
	kind, memberID := handler.classifyPath(request.URL.Path)
	switch kind {
	case routeNotFound:
		writeError(response, http.StatusNotFound, "route_not_found", "路径不存在")
	case routeCollection:
		switch request.Method {
		case http.MethodGet:
			handler.list(response, request)
		case http.MethodPost:
			handler.create(response, request)
		default:
			response.Header().Set("Allow", "GET, POST")
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的映射组操作")
		}
	case routeImport:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", "POST")
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "导入接口仅支持 POST")
			return
		}
		handler.importGroups(response, request)
	case routeToggle:
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", "POST")
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "启停切换仅支持 POST")
			return
		}
		handler.toggle(response, request, memberID)
	case routeMember:
		switch request.Method {
		case http.MethodGet:
			handler.get(response, request, memberID)
		case http.MethodPut:
			handler.update(response, request, memberID)
		case http.MethodDelete:
			handler.remove(response, request, memberID)
		default:
			response.Header().Set("Allow", "GET, PUT, DELETE")
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的映射组操作")
		}
	}
}

// classifyPath 解析路由语义，确保保留动作路径（/import）优先于动态成员 {id}。
func (handler *Handler) classifyPath(rawPath string) (routeKind, string) {
	base := handler.basePath
	if base == "" {
		base = Path
	}
	if rawPath != base && !strings.HasPrefix(rawPath, base+"/") {
		return routeNotFound, ""
	}
	rest := strings.Trim(strings.TrimPrefix(rawPath, base), "/")
	if rest == "" {
		return routeCollection, ""
	}
	parts := strings.Split(rest, "/")
	if len(parts) == 1 && parts[0] != "" {
		if parts[0] == "import" {
			return routeImport, ""
		}
		decoded, err := url.PathUnescape(parts[0])
		if err != nil || strings.TrimSpace(decoded) == "" {
			return routeNotFound, ""
		}
		return routeMember, decoded
	}
	if len(parts) == 2 && parts[1] == "toggle" && parts[0] != "" {
		decoded, err := url.PathUnescape(parts[0])
		if err != nil || strings.TrimSpace(decoded) == "" {
			return routeNotFound, ""
		}
		return routeToggle, decoded
	}
	return routeNotFound, ""
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
		"source":  "go",
	})
}

func (handler *Handler) get(response http.ResponseWriter, request *http.Request, id string) {
	group, err := handler.service.Get(request.Context(), id)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "group": group, "source": "go"})
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
	group, err := handler.service.Create(request.Context(), toCreateInput(payload))
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
	version := payload.Version
	if version == nil {
		queryVersion, ok := parseVersionQuery(response, request.URL.Query().Get("version"))
		if !ok {
			return
		}
		version = queryVersion
	}
	group, err := handler.service.Update(request.Context(), id, mappingapp.UpdateInput{
		Name:        payload.Name,
		Description: payload.Description,
		Provider:    payload.Provider,
		Enabled:     payload.Enabled,
		Rules:       payload.Rules,
		Version:     version,
	})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	handler.writeGroup(response, request, group)
}

func (handler *Handler) toggle(response http.ResponseWriter, request *http.Request, id string) {
	expectedVersion, ok := parseVersionQuery(response, request.URL.Query().Get("version"))
	if !ok {
		return
	}
	if expectedVersion == nil && request.Body != nil && request.Body != http.NoBody {
		body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
		if err != nil || int64(len(body)) > maxBodyBytes {
			writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体无效")
			return
		}
		trimmed := bytes.TrimSpace(body)
		if len(trimmed) > 0 {
			if trimmed[0] != '{' {
				writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体须为 JSON 对象")
				return
			}
			decoder := json.NewDecoder(bytes.NewReader(trimmed))
			decoder.DisallowUnknownFields()
			var payload struct {
				Version *int64 `json:"version"`
			}
			if err := decoder.Decode(&payload); err != nil {
				writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体不是合法 JSON")
				return
			}
			if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
				writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体包含多余内容")
				return
			}
			expectedVersion = payload.Version
		}
	}
	current, err := handler.service.Get(request.Context(), id)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	if expectedVersion != nil && current.Version() != *expectedVersion {
		writeServiceError(response, mappingcore.ErrGroupConflict)
		return
	}
	// toggle 先读取当前组，再用读取时的 version 作为 CAS 条件写入，防止并发静默覆盖。
	versionToUse := current.Version()
	if expectedVersion != nil {
		versionToUse = *expectedVersion
	}
	nextEnabled := !current.Enabled()
	updated, err := handler.service.Update(request.Context(), id, mappingapp.UpdateInput{
		Enabled: &nextEnabled,
		Version: &versionToUse,
	})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	handler.writeGroup(response, request, updated)
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
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "source": "go"})
}

// importGroups 幂等批量导入映射组：
//   - 支持 { "groups": [...] }、{ "data": { "groups": [...] } } 与顶层 [...] 数组；
//   - 支持空正文或 {} 无参触发（若配置 AIHomeDir，则尝试从历史 app-state.db 迁入；无历史记录时幂等返回 imported=0）；
//   - 已存在且内容一致计入 skipped，同 id 内容不同计入 conflicts，单条校验错误记入 errors 而不中断其余合法组。
func (handler *Handler) importGroups(response http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	rawItems, fromFallback, ok := handler.parseImportItems(ctx, response, request)
	if !ok {
		return
	}
	if len(rawItems) > maxImportGroups {
		writeError(response, http.StatusBadRequest, "mapping_group_limit_exceeded", "单次最多导入 100 个映射组")
		return
	}

	existingGroups, err := handler.service.List(ctx)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	existingIDs := make(map[string]struct{}, len(existingGroups)+len(rawItems))
	for _, group := range existingGroups {
		existingIDs[group.ID()] = struct{}{}
	}

	imported := 0
	skipped := 0
	conflicts := 0
	failures := make([]importFailureView, 0)

	for _, rawItem := range rawItems {
		trimmed := bytes.TrimSpace(rawItem)
		if len(trimmed) == 0 || trimmed[0] != '{' {
			failures = append(failures, importFailureView{Error: "映射组条目须为 JSON 对象"})
			continue
		}
		var item groupPayload
		decoder := json.NewDecoder(bytes.NewReader(trimmed))
		if !fromFallback {
			decoder.DisallowUnknownFields()
		}
		if decodeErr := decoder.Decode(&item); decodeErr != nil {
			failures = append(failures, importFailureView{
				ID:    extractRawGroupID(trimmed),
				Error: "映射组 JSON 字段不合法: " + decodeErr.Error(),
			})
			continue
		}
		rawID := strings.TrimSpace(valueOrEmpty(item.ID))
		if item.Rules == nil {
			failures = append(failures, importFailureView{
				ID:    rawID,
				Error: "每条映射组须有 1–20 条规则",
			})
			continue
		}
		_, existedBefore := existingIDs[rawID]
		created, createErr := handler.service.Create(ctx, toCreateInput(item))
		switch {
		case createErr == nil:
			if existedBefore {
				skipped++
			} else {
				imported++
				existingIDs[created.ID()] = struct{}{}
			}
		case errors.Is(createErr, mappingcore.ErrGroupExists):
			conflicts++
		default:
			failures = append(failures, importFailureView{
				ID:    rawID,
				Error: createErr.Error(),
			})
		}
	}

	latestGroups, listErr := handler.service.List(ctx)
	if listErr != nil || latestGroups == nil {
		latestGroups = []mappingcore.Group{}
	}

	result := map[string]any{
		"ok":        len(failures) == 0,
		"imported":  imported,
		"skipped":   skipped,
		"conflicts": conflicts,
		"groups":    latestGroups,
		"source":    "go",
	}
	if len(failures) > 0 {
		result["failed"] = len(failures)
		result["errors"] = failures
	}
	writeJSON(response, http.StatusOK, result)
}

func (handler *Handler) parseImportItems(
	ctx context.Context,
	response http.ResponseWriter,
	request *http.Request,
) ([]json.RawMessage, bool, bool) {
	var body []byte
	if request.Body != nil && request.Body != http.NoBody {
		readBytes, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
		if err != nil || int64(len(readBytes)) > maxBodyBytes {
			writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体无效或超过大小上限")
			return nil, false, false
		}
		body = bytes.TrimSpace(readBytes)
	}
	if len(body) == 0 {
		items, err := handler.loadLegacyAppStateGroups(ctx)
		if err != nil {
			writeError(response, http.StatusInternalServerError, "mapping_group_failed", "读取历史映射组失败")
			return nil, false, false
		}
		return items, true, true
	}
	switch body[0] {
	case '[':
		var items []json.RawMessage
		decoder := json.NewDecoder(bytes.NewReader(body))
		if err := decoder.Decode(&items); err != nil {
			writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体不是合法 JSON 数组")
			return nil, false, false
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体包含多余内容")
			return nil, false, false
		}
		return items, false, true
	case '{':
		var envelope struct {
			Groups *[]json.RawMessage `json:"groups"`
			Data   *struct {
				Groups *[]json.RawMessage `json:"groups"`
			} `json:"data"`
			Version *json.RawMessage `json:"version"`
			Mode    *string          `json:"mode"`
			Force   *bool            `json:"force"`
			Source  *json.RawMessage `json:"source"`
		}
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&envelope); err != nil {
			writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体不是合法的映射组导入对象")
			return nil, false, false
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体包含多余内容")
			return nil, false, false
		}
		if envelope.Groups != nil {
			return *envelope.Groups, false, true
		}
		if envelope.Data != nil && envelope.Data.Groups != nil {
			return *envelope.Data.Groups, false, true
		}
		items, err := handler.loadLegacyAppStateGroups(ctx)
		if err != nil {
			writeError(response, http.StatusInternalServerError, "mapping_group_failed", "读取历史映射组失败")
			return nil, false, false
		}
		return items, true, true
	default:
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体须为 JSON 对象或数组")
		return nil, false, false
	}
}

func (handler *Handler) loadLegacyAppStateGroups(ctx context.Context) ([]json.RawMessage, error) {
	if handler.aiHomeDir == "" {
		return nil, nil
	}
	dbPath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		return nil, nil
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, appStateMappingGroupsKey)
	if err != nil || !found {
		return nil, err
	}
	trimmed := bytes.TrimSpace([]byte(raw))
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return nil, nil
		}
		return items, nil
	}
	var doc struct {
		Groups []json.RawMessage `json:"groups"`
	}
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return nil, nil
	}
	return doc.Groups, nil
}

func extractRawGroupID(raw []byte) string {
	var probe struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &probe)
	return strings.TrimSpace(probe.ID)
}

func toCreateInput(payload groupPayload) mappingapp.CreateInput {
	input := mappingapp.CreateInput{
		ID:          valueOrEmpty(payload.ID),
		Name:        valueOrEmpty(payload.Name),
		Description: valueOrEmpty(payload.Description),
		Provider:    valueOrEmpty(payload.Provider),
		Enabled:     payload.Enabled,
	}
	if payload.Rules != nil {
		input.Rules = *payload.Rules
	}
	return input
}

func valueOrEmpty(ptr *string) string {
	if ptr == nil {
		return ""
	}
	return *ptr
}

// writeGroup 返回最新单组与整份集合。
func (handler *Handler) writeGroup(response http.ResponseWriter, request *http.Request, group mappingcore.Group) {
	groups, err := handler.service.List(request.Context())
	if err != nil {
		// 写入已经成功，不能把列表读取失败报成写失败；单组仍然返回。
		writeJSON(response, http.StatusOK, map[string]any{"ok": true, "group": group, "source": "go"})
		return
	}
	if groups == nil {
		groups = []mappingcore.Group{}
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "group": group, "groups": groups, "source": "go"})
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
	if request.Body == nil || request.Body == http.NoBody {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体不能为空")
		return groupPayload{}, false
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || int64(len(body)) > maxBodyBytes {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体无效")
		return groupPayload{}, false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体须为合法 JSON 对象")
		return groupPayload{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	var payload groupPayload
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体不是合法 JSON")
		return groupPayload{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_mapping_group", "请求体包含多余内容")
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
