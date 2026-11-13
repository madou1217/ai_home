// Package webuimodelsyncapi 提供 WebUI 模型管理页的完整 Go 读写与实时观测接口。
//
// 路由前缀与职责：
//
//	GET   /v1/management/webui/openai-models/catalog          读取完整 OpenAI/WebUI 模型目录（支持 ?accountRef= 与 ETag 304）
//	POST  /v1/management/webui/openai-models                  手动添加账号模型（app-state + aih.db 策略双写）
//	PATCH /v1/management/webui/openai-models                  更新账号模型启停/默认/备注/自定义单价
//	POST  /v1/management/webui/openai-models/catalog/delete   删除自定义模型设置并还原 inherit 策略
//	POST  /v1/management/webui/openai-models/catalog/refresh  异步 202 触发单账号或全局模型目录刷新
//	GET   /v1/management/webui/openai-models/watch            SSE 推送目录刷新作业快照与状态事件
//
// 为何不使用 /openai-models、/openai-models/refresh、/openai-models/delete：
// 既有 webuiopenaimodelsapi 与 webuiopenaimodelswriteapi 已在 webuiroutes.go 挂载这三条
// 契约路径且有独立单测守门；本包采用同源非冲突路径承接完整 WebUI 代理，零回退到 Node 缓存。
package webuimodelsyncapi

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
)

const (
	// BasePath 是手动模型创建（POST）与模型更新（PATCH）的规范路径。
	BasePath = "/v1/management/webui/openai-models"
	// CatalogPath 是完整 WebUI 模型目录读取路径（避免与旧只读契约冲突）。
	CatalogPath = "/v1/management/webui/openai-models/catalog"
	// CatalogDeletePath 是删除自定义模型设置并还原账号策略的路径。
	CatalogDeletePath = "/v1/management/webui/openai-models/catalog/delete"
	// CatalogRefreshPath 是异步 202 触发模型目录刷新的路径。
	CatalogRefreshPath = "/v1/management/webui/openai-models/catalog/refresh"
	// WatchPath 是模型目录刷新作业的 SSE 事件流路径。
	WatchPath = "/v1/management/webui/openai-models/watch"
)

const (
	maxBodyBytes          = 1 << 20
	maxModelCatalogJobs   = 12
	defaultRefreshTimeout = 90 * time.Second
	defaultRefreshWorkers = 4
	defaultWatchKeepalive = 25 * time.Second
	maxRefreshErrorLen    = 240
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权器或核心 Store。
var ErrInvalidDependencies = errors.New("WebUI 模型同步接口依赖无效")

var errInvalidCustomPricing = errors.New("自定义单价字段非法")

// Authorizer 是管理面请求鉴权接口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 是读取与更新账号模型、账号摘要和别名表的最小存储端口（sqliteaccount.Store 直接满足）。
type Store interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
	ListAccountOverviews(ctx context.Context, query accountapp.OverviewQuery) ([]accountapp.AccountOverview, error)
	GetAccountOverview(ctx context.Context, accountRef accountcore.AccountRef) (accountapp.AccountOverview, error)
	SetManualModelPolicy(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		modelID runtimecore.ModelID,
		policy accountapp.ModelManualPolicy,
		updatedAt time.Time,
	) ([]accountapp.AccountModel, error)
	ListModelAliases(ctx context.Context) ([]modelalias.Record, int64, error)
}

// SettingsStore 在 app-state.db 上原子读写 model-catalog-settings 文档。
type SettingsStore interface {
	Load(ctx context.Context) (modelcatalogsettings.Settings, error)
	Update(
		ctx context.Context,
		mutate func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error),
	) (modelcatalogsettings.Settings, error)
}

// SnapshotReader 读取可选的 WebUI 快照显示名（labels）。
type SnapshotReader interface {
	ReadSnapshot(ctx context.Context) (*webuimodelssnapshot.Snapshot, error)
}

// AccountRefMapper 读取可选的 Node/Go 账号引用映射表。
type AccountRefMapper interface {
	LoadTable(ctx context.Context) (accountrefmap.Table, error)
}

// DatabaseSettingsStore 基于 appstate 数据库实现 SettingsStore。
type DatabaseSettingsStore struct {
	DatabasePath string
}

// Load 读取并归一当前模型目录设置。
func (store DatabaseSettingsStore) Load(ctx context.Context) (modelcatalogsettings.Settings, error) {
	if strings.TrimSpace(store.DatabasePath) == "" {
		return modelcatalogsettings.Normalize(nil), nil
	}
	return modelcatalogsettings.Load(ctx, store.DatabasePath)
}

// Update 在 BEGIN IMMEDIATE 事务中安全更新 model-catalog-settings。
func (store DatabaseSettingsStore) Update(
	ctx context.Context,
	mutate func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error),
) (modelcatalogsettings.Settings, error) {
	if strings.TrimSpace(store.DatabasePath) == "" {
		return modelcatalogsettings.Settings{}, errors.New("app-state 数据库路径未配置")
	}
	var saved modelcatalogsettings.Settings
	err := appstate.UpdateKV(ctx, store.DatabasePath, modelcatalogsettings.DatabaseKey, func(current string, _ bool) (string, error) {
		next, mutateErr := mutate(modelcatalogsettings.Normalize(current))
		if mutateErr != nil {
			return "", mutateErr
		}
		next.Version = modelcatalogsettings.SettingsVersion
		next.UpdatedAtMS = time.Now().UnixMilli()
		encoded, marshalErr := json.Marshal(next)
		if marshalErr != nil {
			return "", marshalErr
		}
		saved = next
		return string(encoded), nil
	})
	if err != nil {
		return modelcatalogsettings.Settings{}, err
	}
	return saved, nil
}

// SnapshotFile 基于 app-state.db 路径实现 SnapshotReader。
type SnapshotFile struct {
	DatabasePath string
}

// ReadSnapshot 读取并归一快照显示名。
func (file SnapshotFile) ReadSnapshot(ctx context.Context) (*webuimodelssnapshot.Snapshot, error) {
	if strings.TrimSpace(file.DatabasePath) == "" {
		return &webuimodelssnapshot.Snapshot{}, nil
	}
	reader, err := webuimodelssnapshot.NewReaderAt(file.DatabasePath)
	if err != nil {
		return nil, err
	}
	return reader.Read(ctx)
}

// AccountRefMapDir 基于 AIHomeDir 加载 go-account-sync 映射表。
type AccountRefMapDir struct {
	AIHomeDir string
}

// LoadTable 读取当前映射表；无记录时返回空映射。
func (dir AccountRefMapDir) LoadTable(ctx context.Context) (accountrefmap.Table, error) {
	if strings.TrimSpace(dir.AIHomeDir) == "" {
		return accountrefmap.Table{}, nil
	}
	return accountrefmap.Load(ctx, dir.AIHomeDir)
}

// Dependencies 汇总 Handler 全部依赖。
type Dependencies struct {
	Authorizer     Authorizer
	Store          Store
	AIHomeDir      string
	Settings       SettingsStore
	Snapshot       SnapshotReader
	RefMapper      AccountRefMapper
	Catalog        *providers.Catalog
	Modalities     *modelsdev.Index
	AccountRows    webuiaccountsapi.Source
	ModelRefresher accountapp.AccountModelRefresher
	Now            func() time.Time
	RefreshTimeout time.Duration
	WatchKeepalive time.Duration
}

// Handler 提供模型目录读取、手动增改删、异步刷新与 SSE 监听。
type Handler struct {
	authorizer     Authorizer
	store          Store
	settings       SettingsStore
	snapshot       SnapshotReader
	refMapper      AccountRefMapper
	catalog        *providers.Catalog
	modalities     *modelsdev.Index
	accountRows    webuiaccountsapi.Source
	modelRefresher accountapp.AccountModelRefresher
	now            func() time.Time
	refreshTimeout time.Duration
	watchKeepalive time.Duration

	jobsMu     sync.Mutex
	jobs       map[string]*catalogJobState
	jobOrder   []string
	nextJobSeq atomic.Uint64
	watchers   map[chan ModelCatalogJob]struct{}
}

// ModelCatalogJob 对齐 WebUiOpenAIModelsJob 契约。
type ModelCatalogJob struct {
	ID           string           `json:"id"`
	Status       string           `json:"status"`
	AccountScope *AccountScope    `json:"accountScope"`
	StartedAt    int64            `json:"startedAt"`
	FinishedAt   int64            `json:"finishedAt"`
	Catalog      *CatalogResponse `json:"catalog"`
	Error        string           `json:"error"`
}

type catalogJobState struct {
	job      ModelCatalogJob
	scopeKey string
}

// NewHandler 创建 WebUI 模型管理同步 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	settings := dependencies.Settings
	snapshot := dependencies.Snapshot
	refMapper := dependencies.RefMapper
	if strings.TrimSpace(dependencies.AIHomeDir) != "" {
		if dbPath, err := appstate.DatabasePath(dependencies.AIHomeDir); err == nil {
			if settings == nil {
				settings = DatabaseSettingsStore{DatabasePath: dbPath}
			}
			if snapshot == nil {
				snapshot = SnapshotFile{DatabasePath: dbPath}
			}
		}
		if refMapper == nil {
			refMapper = AccountRefMapDir{AIHomeDir: dependencies.AIHomeDir}
		}
	}
	if settings == nil {
		settings = DatabaseSettingsStore{}
	}
	catalog := dependencies.Catalog
	if catalog == nil {
		if built, err := providers.NewCatalog(providers.BuiltinManifest()); err == nil {
			catalog = built
		}
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	refreshTimeout := dependencies.RefreshTimeout
	if refreshTimeout <= 0 {
		refreshTimeout = defaultRefreshTimeout
	}
	watchKeepalive := dependencies.WatchKeepalive
	if watchKeepalive <= 0 {
		watchKeepalive = defaultWatchKeepalive
	}
	return &Handler{
		authorizer:     dependencies.Authorizer,
		store:          dependencies.Store,
		settings:       settings,
		snapshot:       snapshot,
		refMapper:      refMapper,
		catalog:        catalog,
		modalities:     dependencies.Modalities,
		accountRows:    dependencies.AccountRows,
		modelRefresher: dependencies.ModelRefresher,
		now:            now,
		refreshTimeout: refreshTimeout,
		watchKeepalive: watchKeepalive,
		jobs:           make(map[string]*catalogJobState),
		watchers:       make(map[chan ModelCatalogJob]struct{}),
	}, nil
}

// ServeHTTP 按路径与方法分派模型管理接口请求。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "models_service_unavailable", "模型管理服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch {
	case request.URL.Path == CatalogPath && request.Method == http.MethodGet:
		handler.handleGetCatalog(response, request)
	case request.URL.Path == BasePath && request.Method == http.MethodPost:
		handler.handleCreateManual(response, request)
	case request.URL.Path == BasePath && request.Method == http.MethodPatch:
		handler.handlePatchModel(response, request)
	case request.URL.Path == CatalogDeletePath && request.Method == http.MethodPost:
		handler.handleCatalogDelete(response, request)
	case request.URL.Path == CatalogRefreshPath && request.Method == http.MethodPost:
		handler.handleCatalogRefresh(response, request)
	case request.URL.Path == WatchPath && request.Method == http.MethodGet:
		handler.handleWatch(response, request)
	case request.URL.Path == CatalogPath ||
		request.URL.Path == BasePath ||
		request.URL.Path == CatalogDeletePath ||
		request.URL.Path == CatalogRefreshPath ||
		request.URL.Path == WatchPath:
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
	default:
		writeError(response, http.StatusNotFound, "route_not_found", "路径不存在")
	}
}

func (handler *Handler) handleGetCatalog(response http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	rawRef := strings.TrimSpace(request.URL.Query().Get("accountRef"))
	scopedRef := ""
	if rawRef != "" {
		resolved, ok := handler.resolveExistingAccountRef(ctx, rawRef)
		if !ok {
			writeError(response, http.StatusNotFound, "account_not_found", "未找到要读取的账号")
			return
		}
		scopedRef = resolved.String()
	}

	catalog, err := handler.buildCatalog(ctx, scopedRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_openai_models_failed", "读取模型目录失败")
		return
	}
	body, err := json.Marshal(catalog)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_openai_models_failed", "序列化模型目录失败")
		return
	}
	sum := sha1.Sum(body)
	etag := `"` + hex.EncodeToString(sum[:])[:20] + `"`
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "private, max-age=3, stale-while-revalidate=30")
	response.Header().Set("ETag", etag)
	if strings.TrimSpace(request.Header.Get("If-None-Match")) == etag {
		response.WriteHeader(http.StatusNotModified)
		return
	}
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(body)
}

type modelMutationPayload struct {
	ID            string          `json:"id"`
	Model         string          `json:"model"`
	ModelID       string          `json:"modelId"`
	Provider      string          `json:"provider"`
	AccountRef    string          `json:"accountRef"`
	Enabled       *bool           `json:"enabled"`
	DefaultModel  *bool           `json:"defaultModel"`
	Description   *string         `json:"description"`
	CustomPricing json.RawMessage `json:"customPricing"`
}

func (handler *Handler) handleCreateManual(response http.ResponseWriter, request *http.Request) {
	payload, ok := decodeJSONPayload(response, request)
	if !ok {
		return
	}
	modelID, runtimeID, providerID, accountRef, valid := handler.parseModelTarget(request.Context(), payload)
	if !valid {
		writeError(response, http.StatusBadRequest, "missing_account_model", "缺少账号或模型参数")
		return
	}
	hasPricing, customPricing, err := parseOptionalCustomPricing(payload.CustomPricing)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_custom_pricing", "自定义单价必须为非负数字")
		return
	}
	overview, err := handler.store.GetAccountOverview(request.Context(), accountRef)
	if err != nil || overview.Account().ProviderID() != providerID {
		if err != nil && !errors.Is(err, accountapp.ErrAccountNotFound) {
			writeError(response, http.StatusInternalServerError, "lookup_account_failed", "查询账号失败")
			return
		}
		writeError(response, http.StatusNotFound, "account_not_found", "未找到要添加模型的账号")
		return
	}

	isDefault := payload.DefaultModel != nil && *payload.DefaultModel
	enabled := true
	if !isDefault && payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	description := ""
	if payload.Description != nil {
		description = strings.TrimSpace(*payload.Description)
	}

	var savedRecord *modelcatalogsettings.AccountModel
	nowMS := handler.now().UnixMilli()
	refTable := handler.loadRefTableBestEffort(request.Context())
	savedSettings, err := handler.settings.Update(request.Context(), func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error) {
		var existing *modelcatalogsettings.AccountModel
		nextModels := make([]modelcatalogsettings.AccountModel, 0, len(current.AccountModels)+1)
		for i := range current.AccountModels {
			item := current.AccountModels[i]
			if sameAccountRef(item.AccountRef, accountRef.String(), refTable) && strings.EqualFold(strings.TrimSpace(item.ID), modelID) {
				copyItem := item
				existing = &copyItem
				continue
			}
			if isDefault && sameAccountRef(item.AccountRef, accountRef.String(), refTable) {
				item.DefaultModel = false
			}
			nextModels = append(nextModels, item)
		}
		pricingToUse := (*modelcatalogsettings.CustomPricing)(nil)
		if hasPricing {
			pricingToUse = customPricing
		} else if existing != nil {
			pricingToUse = existing.CustomPricing
		}
		createdAt := nowMS
		if existing != nil && existing.CreatedAtMS > 0 {
			createdAt = existing.CreatedAtMS
		}
		record := modelcatalogsettings.AccountModel{
			ID:            modelID,
			Provider:      providerID,
			AccountRef:    accountRef.String(),
			Enabled:       enabled,
			Manual:        true,
			DefaultModel:  enabled && isDefault,
			Description:   description,
			CustomPricing: pricingToUse,
			CreatedAtMS:   createdAt,
			UpdatedAtMS:   nowMS,
		}
		nextModels = append(nextModels, record)
		savedRecord = &record
		current.AccountModels = nextModels
		return modelcatalogsettings.Normalize(current), nil
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "save_model_catalog_settings_failed", "保存模型设置失败")
		return
	}

	policy := accountapp.ModelPolicyForceEnable
	if !enabled {
		policy = accountapp.ModelPolicyForceDisable
	}
	syncID := handler.matchAccountModelID(request.Context(), accountRef, runtimeID)
	if _, policyErr := handler.store.SetManualModelPolicy(request.Context(), accountRef, syncID, policy, handler.now()); policyErr != nil {
		writeError(response, http.StatusInternalServerError, "save_model_catalog_settings_failed", "同步账号模型策略失败")
		return
	}

	writeJSON(response, http.StatusOK, map[string]any{
		"ok":                true,
		"model":             findSavedAccountModel(savedSettings, accountRef.String(), modelID, savedRecord),
		"settingsUpdatedAt": savedSettings.UpdatedAtMS,
	})
}

func (handler *Handler) handlePatchModel(response http.ResponseWriter, request *http.Request) {
	payload, ok := decodeJSONPayload(response, request)
	if !ok {
		return
	}
	modelID, runtimeID, providerID, accountRef, valid := handler.parseModelTarget(request.Context(), payload)
	if !valid {
		writeError(response, http.StatusBadRequest, "missing_account_model", "缺少账号或模型参数")
		return
	}
	hasPricing, customPricing, err := parseOptionalCustomPricing(payload.CustomPricing)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_custom_pricing", "自定义单价必须为非负数字")
		return
	}

	ctx := request.Context()
	accountFound := false
	overview, err := handler.store.GetAccountOverview(ctx, accountRef)
	if err == nil {
		if overview.Account().ProviderID() != providerID {
			writeError(response, http.StatusNotFound, "account_not_found", "未找到要更新模型的账号")
			return
		}
		accountFound = true
	} else if !errors.Is(err, accountapp.ErrAccountNotFound) {
		writeError(response, http.StatusInternalServerError, "lookup_account_failed", "查询账号失败")
		return
	}

	refTable := handler.loadRefTableBestEffort(ctx)
	if !accountFound {
		settingsSnapshot := handler.loadSettingsBestEffort(ctx)
		if findExistingAccountModel(settingsSnapshot, accountRef.String(), modelID, refTable) == nil {
			writeError(response, http.StatusNotFound, "account_not_found", "未找到要更新模型的账号")
			return
		}
	}

	var savedRecord *modelcatalogsettings.AccountModel
	var nextEnabledResult bool
	nowMS := handler.now().UnixMilli()
	savedSettings, err := handler.settings.Update(ctx, func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error) {
		existing := findExistingAccountModel(current, accountRef.String(), modelID, refTable)

		nextEnabled := true
		if payload.DefaultModel != nil && *payload.DefaultModel {
			nextEnabled = true
		} else if payload.Enabled != nil {
			nextEnabled = *payload.Enabled
		} else if existing != nil {
			nextEnabled = existing.Enabled
		}
		nextEnabledResult = nextEnabled

		nextDefault := false
		if payload.DefaultModel != nil {
			nextDefault = nextEnabled && *payload.DefaultModel
		} else if existing != nil {
			nextDefault = nextEnabled && existing.DefaultModel
		}

		nextManual := existing != nil && existing.Manual
		nextDescription := ""
		if payload.Description != nil {
			nextDescription = strings.TrimSpace(*payload.Description)
		} else if existing != nil {
			nextDescription = existing.Description
		}
		nextPricing := (*modelcatalogsettings.CustomPricing)(nil)
		if hasPricing {
			nextPricing = customPricing
		} else if existing != nil {
			nextPricing = existing.CustomPricing
		}
		createdAt := nowMS
		if existing != nil && existing.CreatedAtMS > 0 {
			createdAt = existing.CreatedAtMS
		}
		preservedID := modelID
		if existing != nil && strings.TrimSpace(existing.ID) != "" {
			preservedID = existing.ID
		}

		nextModels := make([]modelcatalogsettings.AccountModel, 0, len(current.AccountModels)+1)
		for i := range current.AccountModels {
			item := current.AccountModels[i]
			if sameAccountRef(item.AccountRef, accountRef.String(), refTable) && strings.EqualFold(strings.TrimSpace(item.ID), modelID) {
				continue
			}
			if nextDefault && sameAccountRef(item.AccountRef, accountRef.String(), refTable) {
				item.DefaultModel = false
			}
			nextModels = append(nextModels, item)
		}
		record := modelcatalogsettings.AccountModel{
			ID:            preservedID,
			Provider:      providerID,
			AccountRef:    accountRef.String(),
			Enabled:       nextEnabled,
			Manual:        nextManual,
			DefaultModel:  nextDefault,
			Description:   nextDescription,
			CustomPricing: nextPricing,
			CreatedAtMS:   createdAt,
			UpdatedAtMS:   nowMS,
		}
		nextModels = append(nextModels, record)
		savedRecord = &record
		current.AccountModels = nextModels
		return modelcatalogsettings.Normalize(current), nil
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "save_model_catalog_settings_failed", "保存模型设置失败")
		return
	}

	if accountFound {
		syncID, upstreamAvailable, _ := handler.findAccountModelDetails(ctx, accountRef, runtimeID)
		var policy accountapp.ModelManualPolicy
		switch {
		case !nextEnabledResult:
			policy = accountapp.ModelPolicyForceDisable
		case upstreamAvailable && (savedRecord == nil || !savedRecord.Manual):
			policy = accountapp.ModelPolicyInherit
		default:
			policy = accountapp.ModelPolicyForceEnable
		}
		if _, policyErr := handler.store.SetManualModelPolicy(ctx, accountRef, syncID, policy, handler.now()); policyErr != nil {
			writeError(response, http.StatusInternalServerError, "save_model_catalog_settings_failed", "同步账号模型策略失败")
			return
		}
	}

	writeJSON(response, http.StatusOK, map[string]any{
		"ok":                true,
		"model":             findSavedAccountModel(savedSettings, accountRef.String(), modelID, savedRecord),
		"settingsUpdatedAt": savedSettings.UpdatedAtMS,
	})
}

func (handler *Handler) handleCatalogDelete(response http.ResponseWriter, request *http.Request) {
	payload, ok := decodeJSONPayload(response, request)
	if !ok {
		return
	}
	modelID, runtimeID, _, accountRef, valid := handler.parseModelTarget(request.Context(), payload)
	if !valid {
		writeError(response, http.StatusBadRequest, "missing_account_model", "缺少账号或模型参数")
		return
	}
	ctx := request.Context()
	refTable := handler.loadRefTableBestEffort(ctx)
	savedSettings, err := handler.settings.Update(ctx, func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error) {
		nextModels := make([]modelcatalogsettings.AccountModel, 0, len(current.AccountModels))
		for i := range current.AccountModels {
			item := current.AccountModels[i]
			if sameAccountRef(item.AccountRef, accountRef.String(), refTable) && strings.EqualFold(strings.TrimSpace(item.ID), modelID) {
				continue
			}
			nextModels = append(nextModels, item)
		}
		current.AccountModels = nextModels
		return modelcatalogsettings.Normalize(current), nil
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "save_model_catalog_settings_failed", "删除模型设置失败")
		return
	}

	if _, overviewErr := handler.store.GetAccountOverview(ctx, accountRef); overviewErr == nil {
		syncID := handler.matchAccountModelID(ctx, accountRef, runtimeID)
		if _, policyErr := handler.store.SetManualModelPolicy(ctx, accountRef, syncID, accountapp.ModelPolicyInherit, handler.now()); policyErr != nil {
			writeError(response, http.StatusInternalServerError, "save_model_catalog_settings_failed", "同步账号模型策略失败")
			return
		}
	}

	writeJSON(response, http.StatusOK, map[string]any{
		"ok":                true,
		"settingsUpdatedAt": savedSettings.UpdatedAtMS,
	})
}

func (handler *Handler) handleCatalogRefresh(response http.ResponseWriter, request *http.Request) {
	if handler.modelRefresher == nil {
		writeError(response, http.StatusNotImplemented, "refresh_unavailable", "模型目录刷新器不可用")
		return
	}
	ctx := request.Context()
	rawRef := strings.TrimSpace(request.URL.Query().Get("accountRef"))
	var scope *AccountScope
	scopeKey := "global"
	var scopedRef accountcore.AccountRef

	if rawRef != "" {
		resolved, ok := handler.resolveExistingAccountRef(ctx, rawRef)
		if !ok {
			writeError(response, http.StatusNotFound, "account_not_found", "未找到要探测的账号")
			return
		}
		scopedRef = resolved
		scope = &AccountScope{AccountRef: resolved.String()}
		scopeKey = resolved.String()
	}

	job, alreadyRunning := handler.enqueueRefreshJob(scopeKey, scope, scopedRef)
	writeJSON(response, http.StatusAccepted, map[string]any{
		"ok":             true,
		"accepted":       !alreadyRunning,
		"alreadyRunning": alreadyRunning,
		"job":            job,
	})
}

func (handler *Handler) handleWatch(response http.ResponseWriter, request *http.Request) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "streaming_unsupported", "当前连接不支持流式响应")
		return
	}
	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	events := make(chan ModelCatalogJob, 32)
	snapshot := handler.registerWatcher(events)
	defer handler.unregisterWatcher(events)

	if !writeSSEEvent(response, flusher, map[string]any{"type": "connected"}) {
		return
	}
	if !writeSSEEvent(response, flusher, map[string]any{"type": "model-catalog-snapshot", "jobs": snapshot}) {
		return
	}

	ticker := time.NewTicker(handler.watchKeepalive)
	defer ticker.Stop()

	for {
		select {
		case <-request.Context().Done():
			return
		case job := <-events:
			if !writeSSEEvent(response, flusher, map[string]any{
				"type": "model-catalog-job",
				"job":  job,
			}) {
				return
			}
		case <-ticker.C:
			if _, err := io.WriteString(response, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (handler *Handler) enqueueRefreshJob(
	scopeKey string,
	scope *AccountScope,
	scopedRef accountcore.AccountRef,
) (ModelCatalogJob, bool) {
	handler.jobsMu.Lock()
	for _, id := range handler.jobOrder {
		state := handler.jobs[id]
		if state == nil {
			continue
		}
		if (state.job.Status == "queued" || state.job.Status == "running") && state.scopeKey == scopeKey {
			jobCopy := cloneJob(state.job)
			handler.jobsMu.Unlock()
			return jobCopy, true
		}
	}

	seq := handler.nextJobSeq.Add(1)
	jobID := fmt.Sprintf("model-catalog-%d-%d", handler.now().UnixMilli(), seq)
	state := &catalogJobState{
		scopeKey: scopeKey,
		job: ModelCatalogJob{
			ID:           jobID,
			Status:       "queued",
			AccountScope: cloneAccountScope(scope),
			StartedAt:    0,
			FinishedAt:   0,
			Catalog:      nil,
			Error:        "",
		},
	}
	handler.jobs[jobID] = state
	handler.jobOrder = append(handler.jobOrder, jobID)
	initial := cloneJob(state.job)
	handler.jobsMu.Unlock()

	handler.broadcastJob(initial)
	go handler.runRefreshJob(jobID, scopedRef)
	return initial, false
}

func (handler *Handler) runRefreshJob(jobID string, scopedRef accountcore.AccountRef) {
	ctx, cancel := context.WithTimeout(context.Background(), handler.refreshTimeout)
	defer cancel()

	handler.updateJob(jobID, func(job *ModelCatalogJob) {
		job.Status = "running"
		job.StartedAt = handler.now().UnixMilli()
	})

	var runErr error
	if scopedRef.IsValid() {
		_, runErr = handler.modelRefresher.RefreshAccountModels(ctx, scopedRef)
	} else {
		runErr = handler.refreshAllAccounts(ctx)
	}

	scopeFilter := ""
	if scopedRef.IsValid() {
		scopeFilter = scopedRef.String()
	}
	catalogResp, catalogErr := handler.buildCatalog(ctx, scopeFilter)

	handler.jobsMu.Lock()
	state := handler.jobs[jobID]
	if state != nil {
		if catalogErr == nil {
			respCopy := catalogResp
			state.job.Catalog = &respCopy
		}
		switch {
		case runErr != nil:
			state.job.Status = "failed"
			state.job.Error = truncateJobError(runErr.Error())
		case catalogErr != nil:
			state.job.Status = "failed"
			state.job.Error = truncateJobError(catalogErr.Error())
		default:
			state.job.Status = "succeeded"
		}
		state.job.FinishedAt = handler.now().UnixMilli()
	}
	final := ModelCatalogJob{}
	hasState := state != nil
	if hasState {
		final = cloneJob(state.job)
	}
	handler.trimFinishedJobsLocked()
	handler.jobsMu.Unlock()

	if hasState {
		handler.broadcastJob(final)
	}
}

func (handler *Handler) refreshAllAccounts(ctx context.Context) error {
	overviews, err := listAllAccountOverviews(ctx, handler.store)
	if err != nil {
		return err
	}
	_, providerSet := resolveModelCatalogProviders(handler.catalog)
	var refs []accountcore.AccountRef
	for _, overview := range overviews {
		if providerSet[overview.Account().ProviderID()] {
			refs = append(refs, overview.Account().Ref())
		}
	}
	if len(refs) == 0 {
		return nil
	}

	var waitGroup sync.WaitGroup
	semaphore := make(chan struct{}, defaultRefreshWorkers)
	for _, ref := range refs {
		if ctx.Err() != nil {
			break
		}
		select {
		case semaphore <- struct{}{}:
		case <-ctx.Done():
			waitGroup.Wait()
			return ctx.Err()
		}
		waitGroup.Add(1)
		go func(target accountcore.AccountRef) {
			defer func() {
				<-semaphore
				waitGroup.Done()
			}()
			_, _ = handler.modelRefresher.RefreshAccountModels(ctx, target)
		}(ref)
	}
	waitGroup.Wait()
	return nil
}

func (handler *Handler) updateJob(jobID string, mutate func(*ModelCatalogJob)) {
	handler.jobsMu.Lock()
	state := handler.jobs[jobID]
	if state == nil {
		handler.jobsMu.Unlock()
		return
	}
	mutate(&state.job)
	snapshot := cloneJob(state.job)
	handler.jobsMu.Unlock()
	handler.broadcastJob(snapshot)
}

func (handler *Handler) trimFinishedJobsLocked() {
	if len(handler.jobOrder) <= maxModelCatalogJobs {
		return
	}
	excess := len(handler.jobOrder) - maxModelCatalogJobs
	nextOrder := make([]string, 0, len(handler.jobOrder))
	for _, id := range handler.jobOrder {
		state := handler.jobs[id]
		if excess > 0 && state != nil && state.job.Status != "queued" && state.job.Status != "running" {
			delete(handler.jobs, id)
			excess--
			continue
		}
		nextOrder = append(nextOrder, id)
	}
	handler.jobOrder = nextOrder
}

func (handler *Handler) registerWatcher(ch chan ModelCatalogJob) []ModelCatalogJob {
	handler.jobsMu.Lock()
	defer handler.jobsMu.Unlock()
	handler.watchers[ch] = struct{}{}
	snapshot := make([]ModelCatalogJob, 0, len(handler.jobOrder))
	for _, id := range handler.jobOrder {
		if state := handler.jobs[id]; state != nil {
			snapshot = append(snapshot, cloneJob(state.job))
		}
	}
	return snapshot
}

func (handler *Handler) unregisterWatcher(ch chan ModelCatalogJob) {
	handler.jobsMu.Lock()
	defer handler.jobsMu.Unlock()
	delete(handler.watchers, ch)
}

func (handler *Handler) broadcastJob(job ModelCatalogJob) {
	handler.jobsMu.Lock()
	targets := make([]chan ModelCatalogJob, 0, len(handler.watchers))
	for ch := range handler.watchers {
		targets = append(targets, ch)
	}
	handler.jobsMu.Unlock()

	for _, ch := range targets {
		select {
		case ch <- cloneJob(job):
		default:
			// 慢客户端满队时丢弃最旧一帧再尝试投递，绝不阻塞目录刷新协程。
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- cloneJob(job):
			default:
			}
		}
	}
}

func (handler *Handler) resolveExistingAccountRef(ctx context.Context, rawRef string) (accountcore.AccountRef, bool) {
	trimmed := strings.TrimSpace(rawRef)
	if trimmed == "" {
		return "", false
	}
	refTable := handler.loadRefTableBestEffort(ctx)
	candidates := []string{trimmed}
	if mapped := refTable.GoRef(trimmed); mapped != "" && mapped != trimmed {
		candidates = append([]string{mapped}, candidates...)
	}
	for _, candidate := range candidates {
		parsed, err := accountcore.ParseAccountRef(candidate)
		if err != nil {
			continue
		}
		if _, overviewErr := handler.store.GetAccountOverview(ctx, parsed); overviewErr == nil {
			return parsed, true
		}
	}
	return "", false
}

func (handler *Handler) parseModelTarget(
	ctx context.Context,
	payload modelMutationPayload,
) (string, runtimecore.ModelID, string, accountcore.AccountRef, bool) {
	modelID := firstNonEmpty(payload.ID, payload.Model, payload.ModelID)
	runtimeID, err := runtimecore.NewModelID(modelID)
	if err != nil {
		return "", "", "", "", false
	}
	rawProvider := strings.ToLower(strings.TrimSpace(payload.Provider))
	if rawProvider == "" {
		return "", "", "", "", false
	}
	canonicalProvider := rawProvider
	if handler.catalog != nil {
		id, ok := handler.catalog.CanonicalID(rawProvider)
		if !ok {
			return "", "", "", "", false
		}
		canonicalProvider = id
	}
	rawRef := strings.TrimSpace(payload.AccountRef)
	if rawRef == "" {
		return "", "", "", "", false
	}
	refTable := handler.loadRefTableBestEffort(ctx)
	if mapped := refTable.GoRef(rawRef); mapped != "" {
		rawRef = mapped
	}
	parsedRef, err := accountcore.ParseAccountRef(rawRef)
	if err != nil {
		return "", "", "", "", false
	}
	return modelID, runtimeID, canonicalProvider, parsedRef, true
}

func (handler *Handler) findAccountModelDetails(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	requested runtimecore.ModelID,
) (runtimecore.ModelID, bool, bool) {
	catalog, err := handler.store.ListAllAccountModels(ctx)
	if err != nil {
		return requested, false, false
	}
	targetRef := accountRef.String()
	for _, set := range catalog.Sets {
		if set.AccountRef.String() != targetRef {
			continue
		}
		for _, m := range set.Models {
			if m.ModelID() == requested || strings.EqualFold(m.ModelID().String(), requested.String()) {
				return m.ModelID(), m.UpstreamAvailable(), true
			}
		}
	}
	return requested, false, false
}

func (handler *Handler) matchAccountModelID(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	requested runtimecore.ModelID,
) runtimecore.ModelID {
	matched, _, _ := handler.findAccountModelDetails(ctx, accountRef, requested)
	return matched
}

func (handler *Handler) loadSettingsBestEffort(ctx context.Context) modelcatalogsettings.Settings {
	if handler.settings == nil {
		return modelcatalogsettings.Normalize(nil)
	}
	loaded, err := handler.settings.Load(ctx)
	if err != nil {
		return modelcatalogsettings.Normalize(nil)
	}
	return loaded
}

func (handler *Handler) loadSnapshotLabelsBestEffort(ctx context.Context) map[string]map[string]string {
	if handler.snapshot == nil {
		return map[string]map[string]string{}
	}
	snap, err := handler.snapshot.ReadSnapshot(ctx)
	if err != nil || snap == nil || len(snap.Labels) == 0 {
		return map[string]map[string]string{}
	}
	return snap.Labels
}

func (handler *Handler) loadRefTableBestEffort(ctx context.Context) accountrefmap.Table {
	if handler.refMapper == nil {
		return accountrefmap.Table{}
	}
	table, err := handler.refMapper.LoadTable(ctx)
	if err != nil {
		return accountrefmap.Table{}
	}
	return table
}

func (handler *Handler) loadAliasesBestEffort(ctx context.Context) []modelalias.Record {
	records, _, err := handler.store.ListModelAliases(ctx)
	if err != nil {
		return nil
	}
	return records
}

func (handler *Handler) loadAccountRowsMap(ctx context.Context) map[string]webuiaccountsapi.Row {
	if handler.accountRows == nil {
		return nil
	}
	out := make(map[string]webuiaccountsapi.Row)
	afterRef := ""
	for {
		res, err := handler.accountRows.ListAccountRows(ctx, webuiaccountsapi.Query{
			AfterRef: afterRef,
			Limit:    200,
		})
		if err != nil || len(res.Rows) == 0 {
			break
		}
		for _, row := range res.Rows {
			if row.AccountRef != "" {
				out[row.AccountRef] = row
			}
		}
		if len(res.Rows) < 200 {
			break
		}
		afterRef = res.Rows[len(res.Rows)-1].AccountRef
	}
	return out
}

func parseOptionalCustomPricing(raw json.RawMessage) (bool, *modelcatalogsettings.CustomPricing, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false, nil, nil
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return true, nil, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil || obj == nil {
		return true, nil, errInvalidCustomPricing
	}
	parseDim := func(keys ...string) (*float64, error) {
		for _, k := range keys {
			rawVal, ok := obj[k]
			if !ok {
				continue
			}
			valTrimmed := bytes.TrimSpace(rawVal)
			if len(valTrimmed) == 0 || bytes.Equal(valTrimmed, []byte("null")) {
				return nil, nil
			}
			var num float64
			if err := json.Unmarshal(valTrimmed, &num); err != nil || math.IsNaN(num) || math.IsInf(num, 0) || num < 0 {
				return nil, errInvalidCustomPricing
			}
			v := num
			return &v, nil
		}
		return nil, nil
	}
	input, err := parseDim("input")
	if err != nil {
		return true, nil, err
	}
	output, err := parseDim("output")
	if err != nil {
		return true, nil, err
	}
	cacheRead, err := parseDim("cacheRead", "cache_read")
	if err != nil {
		return true, nil, err
	}
	cacheWrite, err := parseDim("cacheWrite", "cache_write")
	if err != nil {
		return true, nil, err
	}
	if input == nil && output == nil && cacheRead == nil && cacheWrite == nil {
		return true, nil, nil
	}
	return true, &modelcatalogsettings.CustomPricing{
		Input:      input,
		Output:     output,
		CacheRead:  cacheRead,
		CacheWrite: cacheWrite,
	}, nil
}

func sameAccountRef(storedRef, canonicalGoRef string, refTable accountrefmap.Table) bool {
	if storedRef == canonicalGoRef {
		return true
	}
	if mapped := refTable.GoRef(storedRef); mapped != "" && mapped == canonicalGoRef {
		return true
	}
	return false
}

func findExistingAccountModel(
	settings modelcatalogsettings.Settings,
	accountRef, modelID string,
	refTable accountrefmap.Table,
) *modelcatalogsettings.AccountModel {
	for i := range settings.AccountModels {
		item := settings.AccountModels[i]
		if sameAccountRef(item.AccountRef, accountRef, refTable) && strings.EqualFold(strings.TrimSpace(item.ID), modelID) {
			copyItem := item
			return &copyItem
		}
	}
	return nil
}

func findSavedAccountModel(
	settings modelcatalogsettings.Settings,
	accountRef, modelID string,
	fallback *modelcatalogsettings.AccountModel,
) *modelcatalogsettings.AccountModel {
	for i := range settings.AccountModels {
		item := settings.AccountModels[i]
		if item.AccountRef == accountRef && strings.EqualFold(strings.TrimSpace(item.ID), modelID) {
			copyItem := item
			return &copyItem
		}
	}
	return fallback
}

func decodeJSONPayload(response http.ResponseWriter, request *http.Request) (modelMutationPayload, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || int64(len(body)) > maxBodyBytes {
		writeError(response, http.StatusBadRequest, "invalid_request_body", "请求体无效")
		return modelMutationPayload{}, false
	}
	var payload modelMutationPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_json", "请求体不是合法 JSON")
		return modelMutationPayload{}, false
	}
	return payload, true
}

func writeSSEEvent(response http.ResponseWriter, flusher http.Flusher, payload any) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return true
	}
	if _, err := io.WriteString(response, "data: "+string(encoded)+"\n\n"); err != nil {
		return false
	}
	flusher.Flush()
	return true
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

func mustParseAccountRef(raw string) accountcore.AccountRef {
	parsed, _ := accountcore.ParseAccountRef(raw)
	return parsed
}

func cloneAccountScope(scope *AccountScope) *AccountScope {
	if scope == nil {
		return nil
	}
	return &AccountScope{AccountRef: scope.AccountRef}
}

func cloneJob(job ModelCatalogJob) ModelCatalogJob {
	out := job
	out.AccountScope = cloneAccountScope(job.AccountScope)
	return out
}

func truncateJobError(message string) string {
	trimmed := strings.TrimSpace(message)
	runes := []rune(trimmed)
	if len(runes) > maxRefreshErrorLen {
		return string(runes[:maxRefreshErrorLen])
	}
	return trimmed
}
