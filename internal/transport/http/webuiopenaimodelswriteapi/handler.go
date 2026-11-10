// Package webuiopenaimodelswriteapi 提供 WebUI OpenAI 模型目录的写入接口。
//
// 路由（管理面，只接受 POST）：
//
//	POST /v1/management/webui/openai-models/refresh
//	POST /v1/management/webui/openai-models/delete
//
// refresh 触发一次上游模型目录探测并返回本次统计与时间戳。上游探测不在本包里：
// 只有宿主接线了 Refresher 才可用，未接线时返回 501 与 refresh_unavailable，
// 不用 202 假装刷新已排队。
//
// delete 从 app-state.db 的 model-catalog-settings 文档里删除指定模型的自定义设置。
// 该文档由 Node 同时读写，所以整条写路径必须是 BEGIN IMMEDIATE 事务里的读改写
// （appstate.UpdateKV）：先读再单独写会把并发写入的记录覆盖回旧值。
//
// 存在性判定分两处：设置文档里命中即删除；没命中时再看上游目录是否还有这个模型——
// 目录里仍在说明只是「自定义设置已被删掉」，返回 200 且 deleted=false（幂等），
// 目录里也没有才返回 404 model_not_found。上游目录端口未接线时只能按设置文档判定，
// 重复删除会退化成 404。
package webuiopenaimodelswriteapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

const (
	// Path 是 WebUI OpenAI 模型目录写入契约的公共前缀。
	Path = "/v1/management/webui/openai-models"
	// RefreshSuffix 是触发模型目录刷新的后缀。
	RefreshSuffix = "/refresh"
	// DeleteSuffix 是删除自定义模型设置的后缀。
	DeleteSuffix = "/delete"

	// RefreshPath 是完整的刷新契约路径。
	RefreshPath = Path + RefreshSuffix
	// DeletePath 是完整的删除契约路径。
	DeletePath = Path + DeleteSuffix
)

// maxBodyBytes 限制请求体大小。删除请求只有几个短字段，正常量级远小于此值。
const maxBodyBytes = 1 << 20

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或设置数据源。
var ErrInvalidDependencies = errors.New("WebUI 模型目录写入接口依赖无效")

// errNothingRemoved 由事务回调返回，表示设置文档里没有命中记录。
//
// 用它回滚整笔写入：没有可删的东西时不该刷新 updatedAt，否则会凭空制造一次
// 「设置变更」让 Node 侧缓存失效。
var errNothingRemoved = errors.New("模型目录设置没有命中记录")

// errMissingModel 表示请求没有给出模型 id。
var errMissingModel = errors.New("缺少模型 id")

// errInvalidAccountRef 表示请求给出的账号引用不是合法 acct_ 形式。
var errInvalidAccountRef = errors.New("账号引用格式非法")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 在 BEGIN IMMEDIATE 事务里读改写 model-catalog-settings 文档。
type Store interface {
	UpdateSettings(
		ctx context.Context,
		mutate func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error),
	) (modelcatalogsettings.Settings, error)
}

// ModelCatalogReader 读上游发现的账号模型目录（可选）。
//
// sqliteaccount.Store 直接满足本接口；未接线时删除只能按设置文档判存在性。
type ModelCatalogReader interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
}

// RefreshResult 是一次模型目录刷新的统计。
//
// 字段都由 Refresher 提供，本包不推算：刷新失败与「刷新成功但没有模型」必须
// 能被调用方区分，因此不在这里补默认值。
type RefreshResult struct {
	// UpdatedAtMS 是本次探测结果的时间戳。
	UpdatedAtMS int64
	// Models 是探测到的模型条数。
	Models int
	// Accounts 是参与探测的账号数。
	Accounts int
	// Sources 是本次结果合并的上游来源数。
	Sources int
	// Cached 表示结果来自缓存而不是新发出的探测。
	Cached bool
	// Source 是结果来源标识（例如 probe / cache）。
	Source string
	// FirstError 是部分账号探测失败时的首个错误摘要。
	FirstError string
}

// Refresher 触发一次上游模型目录刷新（可选）。
type Refresher interface {
	Refresh(ctx context.Context) (RefreshResult, error)
}

// Dependencies 汇总写入依赖。
//
// Store 与 AIHomeDir 二选一：显式 Store 优先，否则按 AIHomeDir 推导 app-state.db。
// Refresher 与 Catalog 都是可选端口，缺失时各自降级（501 / 只按设置文档判存在性）。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	Store      Store
	Refresher  Refresher
	Catalog    ModelCatalogReader
}

// Handler 处理模型目录刷新与自定义模型删除。
type Handler struct {
	authorizer Authorizer
	store      Store
	refresher  Refresher
	catalog    ModelCatalogReader
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	store := dependencies.Store
	if store == nil {
		if strings.TrimSpace(dependencies.AIHomeDir) == "" {
			return nil, ErrInvalidDependencies
		}
		databasePath, err := appstate.DatabasePath(dependencies.AIHomeDir)
		if err != nil {
			return nil, ErrInvalidDependencies
		}
		store = DatabaseStore{DatabasePath: databasePath}
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		store:      store,
		refresher:  dependencies.Refresher,
		catalog:    dependencies.Catalog,
	}, nil
}

// refreshResponse 是刷新成功的响应。
type refreshResponse struct {
	OK          bool   `json:"ok"`
	Refreshed   bool   `json:"refreshed"`
	UpdatedAtMS int64  `json:"updated_at_ms"`
	Models      int    `json:"models"`
	Accounts    int    `json:"accounts"`
	Sources     int    `json:"sources"`
	Cached      bool   `json:"cached"`
	Source      string `json:"source"`
	FirstError  string `json:"first_error,omitempty"`
}

// deleteResponse 是删除的响应。
//
// deleted=false 表示模型仍然存在（上游目录里还有），只是没有自定义设置可删；
// 这是幂等重试的正常结果，不是失败。
type deleteResponse struct {
	OK                  bool  `json:"ok"`
	Deleted             bool  `json:"deleted"`
	SettingsUpdatedAtMS int64 `json:"settings_updated_at_ms,omitempty"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

// deleteRequest 是删除请求体，字段与 Node 的 handleDeleteOpenAIModelRequest 一致。
type deleteRequest struct {
	ID         string `json:"id"`
	Model      string `json:"model"`
	ModelID    string `json:"modelId"`
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
}

// ServeHTTP 按路径分派刷新与删除。
func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "webui_openai_models_write_unavailable", "WebUI 模型目录写入接口不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		responseWriter.Header().Set("Allow", http.MethodPost)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST")
		return
	}
	switch request.URL.Path {
	case RefreshPath:
		handler.refresh(responseWriter, request)
	case DeletePath:
		handler.deleteModel(responseWriter, request)
	default:
		writeError(responseWriter, http.StatusNotFound, "unknown_path", "未知的 WebUI 模型目录写入路径")
	}
}

// refresh 触发一次模型目录刷新。
func (handler *Handler) refresh(responseWriter http.ResponseWriter, request *http.Request) {
	if handler.refresher == nil {
		writeError(responseWriter, http.StatusNotImplemented, "refresh_unavailable", "模型目录刷新未接线，无法触发上游探测")
		return
	}
	result, err := handler.refresher.Refresh(request.Context())
	if err != nil {
		writeError(responseWriter, http.StatusInternalServerError, "refresh_failed", "模型目录刷新失败")
		return
	}
	writeJSON(responseWriter, http.StatusOK, refreshResponse{
		OK:          true,
		Refreshed:   true,
		UpdatedAtMS: result.UpdatedAtMS,
		Models:      result.Models,
		Accounts:    result.Accounts,
		Sources:     result.Sources,
		Cached:      result.Cached,
		Source:      result.Source,
		FirstError:  result.FirstError,
	})
}

// deleteModel 删除指定模型的自定义设置。
func (handler *Handler) deleteModel(responseWriter http.ResponseWriter, request *http.Request) {
	payload, ok := decodeDeleteRequest(responseWriter, request)
	if !ok {
		return
	}
	target, err := newDeleteTarget(payload)
	switch {
	case errors.Is(err, errMissingModel):
		writeError(responseWriter, http.StatusBadRequest, "missing_model", "缺少要删除的模型 id")
		return
	case errors.Is(err, errInvalidAccountRef):
		writeError(responseWriter, http.StatusBadRequest, "invalid_account_ref", "账号引用格式非法")
		return
	case err != nil:
		writeError(responseWriter, http.StatusBadRequest, "invalid_request_body", "删除请求无效")
		return
	}
	removed := false
	saved, err := handler.store.UpdateSettings(request.Context(), func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error) {
		next, count := removeModelSettings(current, target)
		if count == 0 {
			return current, errNothingRemoved
		}
		removed = true
		return next, nil
	})
	if err != nil && !errors.Is(err, errNothingRemoved) {
		writeError(responseWriter, http.StatusInternalServerError, "save_model_catalog_settings_failed", "模型目录设置保存失败")
		return
	}
	if !removed {
		if !handler.modelExists(request.Context(), target) {
			writeError(responseWriter, http.StatusNotFound, "model_not_found", "未找到要删除的模型")
			return
		}
		writeJSON(responseWriter, http.StatusOK, deleteResponse{OK: true, Deleted: false})
		return
	}
	writeJSON(responseWriter, http.StatusOK, deleteResponse{
		OK:                  true,
		Deleted:             true,
		SettingsUpdatedAtMS: saved.UpdatedAtMS,
	})
}

// modelExists 判断上游目录里是否还有这个模型。
//
// 目录端口未接线或读取失败时按「目录里没有」处理：删除本身只依赖设置文档，
// 不能因为 aih.db 读不到就把一次幂等重试变成 5xx。
func (handler *Handler) modelExists(ctx context.Context, target deleteTarget) bool {
	if handler.catalog == nil {
		return false
	}
	catalog, err := handler.catalog.ListAllAccountModels(ctx)
	if err != nil {
		return false
	}
	for _, set := range catalog.Sets {
		if target.provider != "" && strings.ToLower(strings.TrimSpace(set.ProviderID)) != target.provider {
			continue
		}
		for _, model := range set.Models {
			if strings.ToLower(strings.TrimSpace(model.ModelID().String())) == target.modelKey {
				return true
			}
		}
	}
	return false
}

// decodeDeleteRequest 读取删除请求体；失败时已经写好响应。
func decodeDeleteRequest(responseWriter http.ResponseWriter, request *http.Request) (deleteRequest, bool) {
	decoder := json.NewDecoder(http.MaxBytesReader(responseWriter, request.Body, maxBodyBytes))
	var payload deleteRequest
	if err := decoder.Decode(&payload); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(responseWriter, http.StatusRequestEntityTooLarge, "request_body_too_large", "")
			return deleteRequest{}, false
		}
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "")
		return deleteRequest{}, false
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "")
		return deleteRequest{}, false
	}
	return payload, true
}

// newDeleteTarget 把请求体归一成匹配条件。
func newDeleteTarget(payload deleteRequest) (deleteTarget, error) {
	modelKey := strings.ToLower(strings.TrimSpace(firstNonEmpty(payload.ID, payload.Model, payload.ModelID)))
	if modelKey == "" {
		return deleteTarget{}, errMissingModel
	}
	target := deleteTarget{
		modelKey: modelKey,
		provider: strings.ToLower(strings.TrimSpace(payload.Provider)),
	}
	raw := strings.TrimSpace(payload.AccountRef)
	if raw == "" {
		return target, nil
	}
	accountRef, err := accountcore.ParseAccountRef(raw)
	if err != nil {
		return deleteTarget{}, errInvalidAccountRef
	}
	target.accountRef = accountRef.String()
	return target, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: errorBody{Code: code, Message: message}})
}
