// Package webuiaccountauthapi 承接 WebUI 账号认证与导入的高频写入契约：
// ZCode 自定义协议回调、静态 API Key / Auth Token / Vertex AI 配置落库，
// 本机客户端登录态直接导入，以及 Kiro OAuth 作业的本机 IDE 导入端口。
package webuiaccountauthapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/accountauth"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kirooauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountaddapi"
)

const (
	// ZCodeURLCallbackPath 接收桌面协议转发的 zcode:// 回调并按 state 认领在途作业。
	ZCodeURLCallbackPath = "/v1/management/webui/accounts/zcode/url-callback"
	// StaticAccountPath 同步创建 API Key / Auth Token / Vertex AI 静态账号。
	StaticAccountPath = "/v1/management/webui/accounts/static"
	// LocalImportPath 从宿主客户端登录态直接读取、解码并注册账号。
	LocalImportPath = "/v1/management/webui/accounts/local-import"

	hostLocalSourceSuffix = "-host-local"
	maxAuthRouteJSONBytes = 256 * 1024
	kiroHTTPTimeout       = 15 * time.Second
)

var (
	// ErrInvalidDependencies 表示装配 Handler 缺少必需依赖。
	ErrInvalidDependencies  = errors.New("webuiaccountauthapi 依赖无效")
	errHostKeychainDisabled = errors.New("host keychain disabled for local import")
)

type kiroLocalLoginClient interface {
	ImportIDELocal(ctx context.Context, hostHomeDir string) (kirooauth.ImportResult, error)
}

type kiroJobLocalImporter struct {
	authJobs    *accountauth.Service
	hostHomeDir string
	login       kiroLocalLoginClient
}

// NewKiroJobLocalImporter 创建 Kiro OAuth 作业的本机 IDE 登录态导入端口。
func NewKiroJobLocalImporter(authJobs *accountauth.Service, hostHomeDir string) webuiaccountaddapi.JobLocalImporter {
	return newKiroJobLocalImporterWithLogin(authJobs, hostHomeDir, nil)
}

func newKiroJobLocalImporterWithLogin(
	authJobs *accountauth.Service,
	hostHomeDir string,
	login kiroLocalLoginClient,
) webuiaccountaddapi.JobLocalImporter {
	return &kiroJobLocalImporter{
		authJobs:    authJobs,
		hostHomeDir: strings.TrimSpace(hostHomeDir),
		login:       login,
	}
}

func (importer *kiroJobLocalImporter) CompleteLocalImport(
	ctx context.Context,
	job webuiaccountaddapi.JobSnapshot,
	sourceID string,
) (webuiaccountaddapi.JobSnapshot, error) {
	if importer == nil || importer.authJobs == nil {
		return webuiaccountaddapi.JobSnapshot{}, accountauth.ErrInvalidDependencies
	}
	if strings.ToLower(strings.TrimSpace(job.Provider)) != "kiro" ||
		strings.TrimSpace(sourceID) != "kiro-ide-local" {
		return webuiaccountaddapi.JobSnapshot{}, webuiaccountaddapi.ErrUnsupportedLocalSource
	}
	if importer.hostHomeDir == "" {
		return webuiaccountaddapi.JobSnapshot{}, webuiaccountaddapi.ErrLocalSourceUnavailable
	}
	login := importer.login
	if login == nil {
		var err error
		login, err = kirooauth.NewLogin(&http.Client{Timeout: kiroHTTPTimeout}, time.Now)
		if err != nil {
			return webuiaccountaddapi.JobSnapshot{}, err
		}
	}
	imported, err := login.ImportIDELocal(ctx, importer.hostHomeDir)
	if err != nil {
		if errors.Is(err, kirooauth.ErrLocalSourceUnavailable) {
			return webuiaccountaddapi.JobSnapshot{}, webuiaccountaddapi.ErrLocalSourceUnavailable
		}
		return webuiaccountaddapi.JobSnapshot{}, err
	}
	completed, err := importer.authJobs.CompleteWithArtifacts(ctx, job.ID, imported.Artifacts, imported.Account)
	if err != nil {
		return webuiaccountaddapi.JobSnapshot{}, err
	}
	return webuiaccountaddapi.NewJobView(completed), nil
}

// Dependencies 定义构建认证与本机导入 HTTP 端点的全部依赖。
type Dependencies struct {
	Authorizer  interface{ Authorized(*http.Request) bool }
	Catalog     *providers.Catalog
	Store       *sqliteaccount.Store
	AuthJobs    *accountauth.Service
	HostHomeDir string
	NodeBaseURL string
	Clock       func() time.Time
}

// Handler 聚合 ZCode 协议回调、静态账号与本机导入三条路由。
type Handler struct {
	authorizer  interface{ Authorized(*http.Request) bool }
	catalog     *providers.Catalog
	store       *sqliteaccount.Store
	authJobs    *accountauth.Service
	importer    *accountapp.AccountImporter
	hostHomeDir string
	nodeBaseURL string
	decoder     *nativeaccount.Decoder
	static      accountsapi.StaticCredentialFactory
	now         func() time.Time
}

// NewHandler 校验并构造 WebUI 账号认证与本机导入处理器。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	catalog := dependencies.Catalog
	if catalog == nil {
		var err error
		catalog, err = providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return nil, fmt.Errorf("初始化内置 Provider 目录失败: %w", err)
		}
	}
	clock := dependencies.Clock
	if clock == nil {
		clock = time.Now
	}
	var importer *accountapp.AccountImporter
	if dependencies.Store != nil {
		var err error
		importer, err = buildAccountImporter(catalog, dependencies.Store, clock)
		if err != nil {
			return nil, fmt.Errorf("装配账号导入用例失败: %w", err)
		}
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		catalog:     catalog,
		store:       dependencies.Store,
		authJobs:    dependencies.AuthJobs,
		importer:    importer,
		hostHomeDir: strings.TrimSpace(dependencies.HostHomeDir),
		nodeBaseURL: strings.TrimSpace(dependencies.NodeBaseURL),
		decoder:     nativeaccount.NewDecoder(),
		static:      accountsapi.NewBuiltinStaticCredentialFactory(),
		now:         clock,
	}, nil
}

func buildAccountImporter(
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
	clock func() time.Time,
) (*accountapp.AccountImporter, error) {
	registrar, err := accountapp.NewRegistrar(catalog, store, clock)
	if err != nil {
		return nil, err
	}
	reauthenticator, err := accountapp.NewReauthenticator(catalog, store, clock)
	if err != nil {
		return nil, err
	}
	return accountapp.NewAccountImporter(registrar, store, reauthenticator)
}

// ServeHTTP 按精确路径分发请求到对应认证处理函数。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case ZCodeURLCallbackPath:
		handler.HandleZCodeURLCallback(response, request)
	case StaticAccountPath:
		handler.HandleStaticAccount(response, request)
	case LocalImportPath:
		handler.HandleLocalImport(response, request)
	default:
		writeAuthRouteError(response, http.StatusNotFound, "not_found", "路由不存在。")
	}
}

type zcodeURLCallbackRequest struct {
	URL         string `json:"url"`
	CallbackURL string `json:"callbackUrl"`
	State       string `json:"state"`
}

// HandleZCodeURLCallback 按 state 认领在途 ZCode OAuth 作业并完成建档。
func (handler *Handler) HandleZCodeURLCallback(response http.ResponseWriter, request *http.Request) {
	if !handler.requireAuthorizedPOST(response, request) {
		return
	}
	if handler.authJobs == nil {
		writeAuthRouteError(response, http.StatusServiceUnavailable, "auth_jobs_unavailable", "认证作业服务未装配。")
		return
	}
	var body zcodeURLCallbackRequest
	if err := decodeStrictJSONBody(response, request, &body); err != nil {
		writeAuthJSONDecodeError(response, err)
		return
	}
	callbackURL := strings.TrimSpace(firstNonEmptyString(body.URL, body.CallbackURL))
	state := strings.TrimSpace(body.State)
	if state == "" && callbackURL != "" {
		if parsed, err := url.Parse(callbackURL); err == nil {
			state = strings.TrimSpace(parsed.Query().Get("state"))
		}
	}
	if callbackURL == "" || state == "" {
		writeAuthRouteError(response, http.StatusBadRequest, "invalid_callback_payload", "ZCode 协议回调缺少 url 或 state。")
		return
	}
	job, err := handler.authJobs.CompleteByState(request.Context(), "zcode", state, callbackURL)
	if err != nil {
		switch {
		case errors.Is(err, accountauth.ErrJobNotFound):
			writeAuthJSON(response, http.StatusNotFound, map[string]any{
				"ok":      false,
				"handled": false,
				"error":   "no_matching_auth_job",
			})
		case errors.Is(err, accountauth.ErrJobNotPending):
			view := webuiaccountaddapi.NewJobView(job)
			writeAuthJSON(response, http.StatusConflict, map[string]any{
				"ok":      false,
				"handled": true,
				"error":   "job_not_pending",
				"code":    "job_not_pending",
				"job":     view,
			})
		default:
			code := classifyAuthCallbackFailure(job, err)
			payload := map[string]any{
				"ok":      false,
				"handled": true,
				"error":   code,
				"code":    code,
				"message": callbackErrorMessage(code),
			}
			if job.ID() != "" {
				payload["job"] = webuiaccountaddapi.NewJobView(job)
			}
			writeAuthJSON(response, http.StatusBadRequest, payload)
		}
		return
	}
	writeAuthJSON(response, http.StatusOK, map[string]any{
		"ok":      true,
		"handled": true,
		"job":     webuiaccountaddapi.NewJobView(job),
	})
}

type staticConfigPayload struct {
	APIKey         string `json:"apiKey"`
	AuthToken      string `json:"authToken"`
	BaseURL        string `json:"baseUrl"`
	DisplayName    string `json:"displayName"`
	CredentialType string `json:"credentialType"`
	AuthType       string `json:"authType"`
	ProjectID      string `json:"projectId"`
	Location       string `json:"location"`
	Placeholder    *bool  `json:"placeholder"`
}

type staticAccountRequest struct {
	Provider              string              `json:"provider"`
	AuthMode              string              `json:"authMode"`
	Config                staticConfigPayload `json:"config"`
	APIKey                string              `json:"apiKey"`
	AuthToken             string              `json:"authToken"`
	BaseURL               string              `json:"baseUrl"`
	DisplayName           string              `json:"displayName"`
	ProjectID             string              `json:"projectId"`
	Location              string              `json:"location"`
	Placeholder           *bool               `json:"placeholder"`
	ServerPort            int                 `json:"serverPort"`
	AliasPoolParticipates *bool               `json:"aliasPoolParticipates"`
}

// HandleStaticAccount 同步创建或幂等更新 API Key / Auth Token / Vertex AI 静态账号。
func (handler *Handler) HandleStaticAccount(response http.ResponseWriter, request *http.Request) {
	if !handler.requireAuthorizedPOST(response, request) {
		return
	}
	if handler.store == nil || handler.importer == nil {
		writeAuthRouteError(response, http.StatusServiceUnavailable, "account_store_unavailable", "账号存储未装配。")
		return
	}
	var body staticAccountRequest
	if err := decodeStrictJSONBody(response, request, &body); err != nil {
		writeAuthJSONDecodeError(response, err)
		return
	}
	canonical, ok := handler.catalog.CanonicalID(strings.ToLower(strings.TrimSpace(body.Provider)))
	if !ok {
		writeAuthRouteError(response, http.StatusBadRequest, "unsupported_provider", "不支持的 Provider。")
		return
	}
	apiKey := strings.TrimSpace(firstNonEmptyString(body.APIKey, body.Config.APIKey))
	authToken := strings.TrimSpace(firstNonEmptyString(body.AuthToken, body.Config.AuthToken))
	baseURL := strings.TrimSpace(firstNonEmptyString(body.BaseURL, body.Config.BaseURL))
	displayName := strings.TrimSpace(firstNonEmptyString(body.DisplayName, body.Config.DisplayName))
	projectID := strings.TrimSpace(firstNonEmptyString(body.ProjectID, body.Config.ProjectID))
	location := strings.TrimSpace(firstNonEmptyString(body.Location, body.Config.Location))
	authMode := normalizeStaticAuthMode(body.AuthMode, apiKey, authToken)
	if !handler.providerSupportsStaticMode(canonical, authMode) {
		writeAuthRouteError(response, http.StatusBadRequest, "unsupported_auth_mode", "该 Provider 不支持此认证方式。")
		return
	}
	if isSelfRelayBaseURL(handler.catalog, canonical, baseURL, handler.nodeBaseURL, body.ServerPort) {
		writeAuthJSON(response, http.StatusBadRequest, map[string]any{
			"ok":     false,
			"error":  "self_relay_account_not_allowed",
			"detail": fmt.Sprintf("local AIH server is built in; use aih %s without adding a numeric account", canonical),
		})
		return
	}
	credential, resolvedDisplayName, errCode, errMsg := handler.buildStaticCredential(
		canonical,
		authMode,
		apiKey,
		authToken,
		baseURL,
		displayName,
		projectID,
		location,
		resolvePlaceholderFlag(body.Placeholder, body.Config.Placeholder),
	)
	if errCode != "" {
		writeAuthRouteError(response, http.StatusBadRequest, errCode, errMsg)
		return
	}
	result, err := handler.importer.Import(request.Context(), credential, nil)
	if err != nil {
		status := http.StatusInternalServerError
		code := "account_import_failed"
		if errors.Is(err, accountapp.ErrAccountConflict) {
			status = http.StatusConflict
			code = "account_conflict"
		} else if errors.Is(err, accountapp.ErrInvalidAccountImport) || errors.Is(err, accountapp.ErrInvalidRegistration) {
			status = http.StatusBadRequest
			code = "invalid_static_credential"
		}
		writeAuthRouteError(response, status, code, "保存静态账号失败。")
		return
	}
	account := result.Account()
	now := handler.now().UTC()
	normalizedBaseURL := baseURL
	if normalized, normErr := accountcore.NormalizeStaticBaseURL(baseURL); normErr == nil {
		normalizedBaseURL = normalized
	}
	if uiState, uiErr := accountcore.NewUIState(accountcore.UIStateInput{
		AccountRef:  account.Ref(),
		Status:      "up",
		DisplayName: resolvedDisplayName,
		AuthMode:    authMode,
		APIKeyMode:  true,
		Configured:  true,
		BaseURL:     normalizedBaseURL,
		UpdatedAt:   now,
	}); uiErr == nil {
		if saveErr := handler.store.ReplaceAccountUIState(request.Context(), uiState); saveErr != nil {
			writeAuthRouteError(response, http.StatusInternalServerError, "ui_state_write_failed", "写入账号展示状态失败。")
			return
		}
	}
	if body.AliasPoolParticipates != nil && !*body.AliasPoolParticipates {
		if exErr := handler.store.SetRoutingExclusion(request.Context(), account.Ref(), true, "", now); exErr != nil {
			writeAuthRouteError(response, http.StatusInternalServerError, "alias_pool_preference_failed", "保存别名池偏好失败。")
			return
		}
	}
	payload := map[string]any{
		"ok":           true,
		"provider":     canonical,
		"accountRef":   account.Ref().String(),
		"cliAccountId": account.CLIAccountID().Int64(),
		"authMode":     authMode,
		"status":       "configured",
		"created":      result.Created(),
	}
	if authMode == string(providers.AuthModeVertexAI) {
		payload["placeholder"] = true
	}
	writeAuthJSON(response, http.StatusOK, payload)
}

func (handler *Handler) buildStaticCredential(
	canonical string,
	authMode string,
	apiKey string,
	authToken string,
	baseURL string,
	displayName string,
	projectID string,
	location string,
	placeholder bool,
) (accountapp.Credential, string, string, string) {
	switch authMode {
	case string(providers.AuthModeVertexAI):
		if canonical != "gemini" {
			return nil, "", "unsupported_auth_mode", "只有 Gemini 支持 Vertex AI。"
		}
		if !placeholder && projectID == "" && apiKey == "" {
			return nil, "", "invalid_static_credential", "Vertex AI 需要 projectId 或 apiKey。"
		}
		cred, err := handler.static.BuildVertex("gemini", projectID, location, apiKey, baseURL, placeholder)
		if err != nil {
			return nil, "", "invalid_static_credential", "Vertex AI 配置无效。"
		}
		if displayName == "" {
			labelProject := projectID
			if labelProject == "" {
				labelProject = "占位"
			}
			displayName = fmt.Sprintf("Vertex AI (%s)", labelProject)
		}
		return cred, displayName, "", ""
	case string(providers.AuthModeAuthToken):
		if canonical != "claude" {
			return nil, "", "unsupported_auth_mode", "只有 Claude 支持 auth-token。"
		}
		secret := firstNonEmptyString(authToken, apiKey)
		if secret == "" {
			return nil, "", "auth_token_required", "Claude auth-token 不能为空。"
		}
		cred, err := handler.static.BuildStatic("claude", "auth_token", "", secret, baseURL)
		if err != nil {
			return nil, "", classifyStaticCredentialError(err, baseURL, false), "Claude auth-token 或 Base URL 无效。"
		}
		return cred, displayName, "", ""
	case string(providers.AuthModeAPIKey):
		if apiKey == "" {
			return nil, "", "api_key_required", "API Key 不能为空。"
		}
		if canonical == "gemini" && baseURL != "" {
			return nil, "", "base_url_unsupported", "Gemini API Key 模式不支持自定义 Base URL。"
		}
		if canonical == "codex" || canonical == "claude" {
			cred, err := handler.static.BuildStatic(canonical, "api_key", apiKey, "", baseURL)
			if err != nil {
				return nil, "", classifyStaticCredentialError(err, baseURL, true), "静态凭据或 Base URL 无效。"
			}
			return cred, displayName, "", ""
		}
		cred, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
			ProviderID: canonical,
			APIKey:     apiKey,
			BaseURL:    baseURL,
		})
		if err != nil {
			return nil, "", classifyStaticCredentialError(err, baseURL, true), "静态 API Key 或 Base URL 无效。"
		}
		return cred, displayName, "", ""
	default:
		return nil, "", "unsupported_auth_mode", "不支持通过静态配置创建该认证方式。"
	}
}

func classifyStaticCredentialError(err error, baseURL string, requireAPIKey bool) string {
	if errors.Is(err, accountcore.ErrInvalidStaticBaseURL) {
		return "invalid_base_url"
	}
	if baseURL != "" {
		if _, baseErr := accountcore.NormalizeStaticBaseURL(baseURL); baseErr != nil {
			return "invalid_base_url"
		}
	}
	if requireAPIKey {
		return "invalid_api_key"
	}
	return "invalid_static_credential"
}

func (handler *Handler) providerSupportsStaticMode(canonical, authMode string) bool {
	definition, found := handler.catalog.Get(canonical)
	if !found {
		return false
	}
	for _, option := range definition.AuthOptions {
		if string(option.Value) == authMode && !option.Disabled {
			return true
		}
	}
	return false
}

type localImportRequest struct {
	Provider              string `json:"provider"`
	SourceID              string `json:"sourceId"`
	AliasPoolParticipates *bool  `json:"aliasPoolParticipates"`
}

// HandleLocalImport 从宿主本机客户端登录态直接导入并去重注册账号。
func (handler *Handler) HandleLocalImport(response http.ResponseWriter, request *http.Request) {
	if !handler.requireAuthorizedPOST(response, request) {
		return
	}
	if handler.store == nil || handler.importer == nil {
		writeAuthRouteError(response, http.StatusServiceUnavailable, "account_store_unavailable", "账号存储未装配。")
		return
	}
	var body localImportRequest
	if err := decodeStrictJSONBody(response, request, &body); err != nil {
		writeAuthJSONDecodeError(response, err)
		return
	}
	canonical, ok := handler.catalog.CanonicalID(strings.ToLower(strings.TrimSpace(body.Provider)))
	sourceID := strings.TrimSpace(body.SourceID)
	if strings.TrimSpace(body.Provider) == "" || sourceID == "" {
		writeAuthRouteError(response, http.StatusBadRequest, "invalid_payload", "provider 和 sourceId 必填。")
		return
	}
	if !ok {
		writeAuthRouteError(response, http.StatusBadRequest, "auth_source_unknown", "未知的 Provider。")
		return
	}
	if requiresLoginJobForLocalSource(canonical, sourceID) {
		writeAuthRouteError(response, http.StatusForbidden, "auth_source_requires_login_job", "该本机登录态需要通过登录任务完成身份核验。")
		return
	}
	if sourceID != canonical+hostLocalSourceSuffix {
		writeAuthRouteError(response, http.StatusBadRequest, "auth_source_unknown", "未知的本机认证来源。")
		return
	}
	policy := storagepolicy.Get(canonical)
	if policy == nil || len(policy.AuthArtifacts) == 0 || hasExplicitAuthSourcesWithoutHostLocal(canonical) {
		writeAuthRouteError(response, http.StatusBadRequest, "auth_source_unknown", "该 Provider 不支持本机直接导入。")
		return
	}
	if handler.hostHomeDir == "" {
		writeAuthRouteError(response, http.StatusConflict, "auth_source_unavailable:host_home_missing", "宿主 HOME 未配置。")
		return
	}
	credential, profile, errCode, errMsg := handler.readAndDecodeHostArtifacts(canonical, policy)
	if errCode != "" {
		writeAuthRouteError(response, http.StatusConflict, errCode, errMsg)
		return
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		writeAuthRouteError(response, http.StatusConflict, "auth_source_unavailable:invalid_identity", "无法从本机登录态派生账号身份。")
		return
	}
	if _, getErr := handler.store.GetAccountOverview(request.Context(), accountRef); getErr == nil {
		writeAuthRouteError(response, http.StatusConflict, "auth_source_already_imported", "该本机登录态对应的账号已在账号池中。")
		return
	}
	imported, err := handler.importer.Import(request.Context(), credential, profile)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountConflict) {
			writeAuthRouteError(response, http.StatusConflict, "auth_source_already_imported", "该本机登录态对应的账号已在账号池中。")
			return
		}
		writeAuthRouteError(response, http.StatusConflict, "local_auth_register_failed", "注册本机导入账号失败。")
		return
	}
	if !imported.Created() {
		writeAuthRouteError(response, http.StatusConflict, "auth_source_already_imported", "该本机登录态对应的账号已在账号池中。")
		return
	}
	account := imported.Account()
	now := handler.now().UTC()
	authMode := handler.defaultHostAuthMode(canonical)
	displayName := profileDisplayName(profile)
	if uiState, uiErr := accountcore.NewUIState(accountcore.UIStateInput{
		AccountRef:  account.Ref(),
		Status:      "up",
		DisplayName: displayName,
		AuthMode:    authMode,
		APIKeyMode:  false,
		Configured:  true,
		UpdatedAt:   now,
	}); uiErr == nil {
		if saveErr := handler.store.ReplaceAccountUIState(request.Context(), uiState); saveErr != nil {
			writeAuthRouteError(response, http.StatusInternalServerError, "ui_state_write_failed", "写入账号展示状态失败。")
			return
		}
	}
	if body.AliasPoolParticipates != nil && !*body.AliasPoolParticipates {
		if exErr := handler.store.SetRoutingExclusion(request.Context(), account.Ref(), true, "", now); exErr != nil {
			writeAuthRouteError(response, http.StatusInternalServerError, "alias_pool_preference_failed", "保存别名池偏好失败。")
			return
		}
	}
	writeAuthJSON(response, http.StatusOK, map[string]any{
		"ok":           true,
		"provider":     canonical,
		"accountRef":   account.Ref().String(),
		"cliAccountId": account.CLIAccountID().Int64(),
		"sourceId":     sourceID,
	})
}

func (handler *Handler) readAndDecodeHostArtifacts(
	canonical string,
	policy *storagepolicy.Policy,
) (accountapp.Credential, accountapp.PublicProfile, string, string) {
	if canonical == "claude" || canonical == "codex" {
		reader := newLocalImportArtifactReader(handler.hostHomeDir)
		artifacts, err := reader.Read(canonical)
		if err != nil {
			return nil, nil, "auth_source_unavailable:host_login_state_missing", "未检测到有效的本机登录态。"
		}
		defer clear(artifacts.Envelope)
		credential, profile, err := handler.decoder.Decode(canonical, artifacts.Envelope)
		if err != nil || credential == nil {
			return nil, nil, "auth_source_unavailable:host_login_state_invalid", "本机登录态格式无效或身份缺失。"
		}
		return credential, profile, "", ""
	}
	baseDir := handler.hostHomeDir
	if len(policy.HostAuthRoot) > 0 {
		baseDir = filepath.Join(append([]string{handler.hostHomeDir}, policy.HostAuthRoot...)...)
	}
	nativeAuth := make(map[string]any, len(policy.AuthArtifacts))
	for _, artifact := range policy.AuthArtifacts {
		targetPath := filepath.Join(append([]string{baseDir}, artifact.Path...)...)
		raw, err := os.ReadFile(targetPath)
		if err != nil {
			if artifact.Optional && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, nil, "auth_source_unavailable:host_login_state_missing", "未检测到有效的本机登录态文件。"
		}
		value, parseErr := parseStoragePolicyArtifactValue(artifact.Format, raw)
		if parseErr != nil {
			return nil, nil, "auth_source_unavailable:host_login_state_invalid", "本机登录态文件内容无法解析。"
		}
		if artifact.Field != "" {
			nativeAuth[artifact.Field] = value
		}
	}
	if len(nativeAuth) == 0 {
		return nil, nil, "auth_source_unavailable:host_login_state_missing", "未检测到有效的本机登录态文件。"
	}
	rawNative, err := json.Marshal(nativeAuth)
	if err != nil {
		return nil, nil, "auth_source_unavailable:host_login_state_invalid", "构造本机登录态快照失败。"
	}
	envelope, err := json.Marshal(map[string]json.RawMessage{
		"native_auth_json": rawNative,
	})
	if err != nil {
		return nil, nil, "auth_source_unavailable:host_login_state_invalid", "构造本机登录态信封失败。"
	}
	defer clear(envelope)
	credential, profile, err := handler.decoder.Decode(canonical, envelope)
	if err != nil || credential == nil {
		return nil, nil, "auth_source_unavailable:host_login_state_invalid", "本机登录态不可解码或缺少身份声明。"
	}
	return credential, profile, "", ""
}

func newLocalImportArtifactReader(hostHomeDir string) *nativeartifact.Reader {
	options := nativeartifact.Options{
		UserHomeDir: func() (string, error) { return hostHomeDir, nil },
		LookupEnv:   func(string) (string, bool) { return "", false },
	}
	// 仅当宿主目录就是当前真实用户 HOME 时允许读 macOS Keychain，测试隔离临时目录不接触外部钥匙串。
	realHome, err := os.UserHomeDir()
	if err != nil || filepath.Clean(hostHomeDir) != filepath.Clean(realHome) {
		options.ReadClaudeSecureStorage = func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
			return nativeartifact.ClaudeSecureStorageRecord{}, errHostKeychainDisabled
		}
	}
	return nativeartifact.New(options)
}

func parseStoragePolicyArtifactValue(format string, raw []byte) (any, error) {
	switch format {
	case "text":
		return strings.TrimSpace(string(raw)), nil
	case "binary-base64":
		return base64.StdEncoding.EncodeToString(raw), nil
	default:
		var decoded any
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return nil, err
		}
		return decoded, nil
	}
}

func requiresLoginJobForLocalSource(canonical, sourceID string) bool {
	if canonical == "kiro" {
		switch sourceID {
		case "kiro-ide-local", "kiro-device-code", "kiro-social-device-code", "kiro-paste-token":
			return true
		}
	}
	if sourceID == canonical+"-host-scan" {
		switch canonical {
		case "cline", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
			return true
		}
	}
	return false
}

func hasExplicitAuthSourcesWithoutHostLocal(canonical string) bool {
	switch canonical {
	case "kiro", "cline", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		return true
	default:
		return false
	}
}

func (handler *Handler) defaultHostAuthMode(canonical string) string {
	definition, found := handler.catalog.Get(canonical)
	if !found || len(definition.AuthOptions) == 0 {
		return string(providers.AuthModeOAuthBrowser)
	}
	for _, option := range definition.AuthOptions {
		if option.Value == providers.AuthModeOAuthBrowser {
			return string(option.Value)
		}
	}
	return string(definition.AuthOptions[0].Value)
}

func profileDisplayName(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	if named, ok := profile.(interface{ Email() string }); ok {
		if email := strings.TrimSpace(named.Email()); email != "" {
			return email
		}
	}
	return ""
}

func (handler *Handler) requireAuthorizedPOST(response http.ResponseWriter, request *http.Request) bool {
	if handler.authorizer == nil || !handler.authorizer.Authorized(request) {
		writeAuthRouteError(response, http.StatusUnauthorized, "unauthorized", "需要有效的管理密钥。")
		return false
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeAuthRouteError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST 请求。")
		return false
	}
	return true
}

func decodeStrictJSONBody(response http.ResponseWriter, request *http.Request, target any) error {
	contentType := strings.ToLower(strings.TrimSpace(request.Header.Get("Content-Type")))
	if !strings.HasPrefix(contentType, "application/json") {
		return httpjson.ErrUnsupportedMediaType
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxAuthRouteJSONBytes)
	document, err := io.ReadAll(request.Body)
	if err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return httpjson.ErrBodyTooLarge
		}
		return httpjson.ErrInvalidDocument
	}
	if err := httpjson.ValidateDocument(document); err != nil {
		return httpjson.ErrInvalidDocument
	}
	decoder := json.NewDecoder(bytes.NewReader(document))
	if err := decoder.Decode(target); err != nil {
		return httpjson.ErrInvalidDocument
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return httpjson.ErrInvalidDocument
	}
	return nil
}

func writeAuthJSONDecodeError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, httpjson.ErrUnsupportedMediaType):
		writeAuthRouteError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "请求 Content-Type 必须是 application/json。")
	case errors.Is(err, httpjson.ErrBodyTooLarge):
		writeAuthRouteError(response, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体过大。")
	default:
		writeAuthRouteError(response, http.StatusBadRequest, "invalid_payload", "请求 JSON 无效。")
	}
}

func writeAuthRouteError(response http.ResponseWriter, status int, code, message string) {
	writeAuthJSON(response, status, map[string]any{
		"ok":      false,
		"error":   code,
		"code":    code,
		"message": message,
	})
}

func writeAuthJSON(response http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(response, `{"ok":false,"error":"internal_encode_error"}`, http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(encoded)
}

func normalizeStaticAuthMode(raw, apiKey, authToken string) string {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	switch normalized {
	case "api_key":
		return string(providers.AuthModeAPIKey)
	case "auth_token":
		return string(providers.AuthModeAuthToken)
	case "vertex_ai":
		return string(providers.AuthModeVertexAI)
	case "":
		if authToken != "" {
			return string(providers.AuthModeAuthToken)
		}
		if apiKey != "" {
			return string(providers.AuthModeAPIKey)
		}
		return ""
	default:
		return normalized
	}
}

func resolvePlaceholderFlag(primary, secondary *bool) bool {
	if primary != nil {
		return *primary
	}
	if secondary != nil {
		return *secondary
	}
	return true
}

func isSelfRelayBaseURL(
	catalog *providers.Catalog,
	canonical string,
	rawBaseURL string,
	nodeBaseURL string,
	requestPort int,
) bool {
	if rawBaseURL == "" || catalog == nil || !catalog.Supports(canonical, providers.CapabilityGatewayProfile) {
		return false
	}
	parsed, err := url.Parse(rawBaseURL)
	if err != nil {
		return false
	}
	host := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	if host != "localhost" && host != "::1" && !strings.HasPrefix(host, "127.") {
		return false
	}
	port := parsedURLPort(parsed)
	if port <= 0 {
		return false
	}
	for _, selfPort := range collectSelfRelayPorts(nodeBaseURL, requestPort) {
		if port == selfPort {
			return true
		}
	}
	return false
}

func collectSelfRelayPorts(nodeBaseURL string, requestPort int) []int {
	var ports []int
	if requestPort > 0 {
		ports = append(ports, requestPort)
	}
	if nodeBaseURL != "" {
		if parsed, err := url.Parse(nodeBaseURL); err == nil {
			if p := parsedURLPort(parsed); p > 0 {
				ports = append(ports, p)
			}
		}
	}
	return ports
}

func parsedURLPort(parsed *url.URL) int {
	if parsed == nil {
		return 0
	}
	if raw := parsed.Port(); raw != "" {
		p, err := strconv.Atoi(raw)
		if err == nil && p > 0 {
			return p
		}
		return 0
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http":
		return 80
	case "https":
		return 443
	default:
		return 0
	}
}

func classifyAuthCallbackFailure(job accountauth.Job, err error) string {
	if code := strings.TrimSpace(job.FailureCode()); code != "" {
		return code
	}
	switch {
	case errors.Is(err, accountauth.ErrStateMismatch):
		return "oauth_state_mismatch"
	case errors.Is(err, accountauth.ErrInvalidCallback):
		return "invalid_callback"
	case errors.Is(err, accountauth.ErrJobExpired):
		return "oauth_job_expired"
	case errors.Is(err, accountauth.ErrProviderRejected):
		return "provider_rejected"
	case errors.Is(err, accountauth.ErrProviderUnavailable):
		return "provider_unavailable"
	case errors.Is(err, accountauth.ErrInvalidArtifacts):
		return "invalid_artifacts"
	default:
		return "callback_exchange_failed"
	}
}

func callbackErrorMessage(code string) string {
	switch code {
	case "oauth_state_mismatch":
		return "OAuth state 不匹配，请重新发起授权。"
	case "invalid_callback":
		return "回调地址中缺少有效授权参数。"
	case "job_not_pending":
		return "登录任务已结束或已被取消。"
	default:
		return "OAuth 回调处理失败: " + code
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
