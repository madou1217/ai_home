package managementapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

const (
	// DefaultListLimit 是 Management API 账号列表的默认可见行数。
	DefaultListLimit = 50
	// MaxListLimit 是 API 允许的最大可见行数；服务端会额外多取一行。
	MaxListLimit = 255
	// maxNativeImportDocumentBytes 与 Server 原生导入请求体上限保持一致。
	maxNativeImportDocumentBytes = 1 << 20
)

// ListOptions 是远端账号列表使用的稳定 AccountRef 游标输入。
type ListOptions struct {
	// AfterRef 是上一页最后一个账号引用；空值表示第一页。
	AfterRef string
	// Limit 是本页可见行数；零值使用 DefaultListLimit。
	Limit int
}

// AccountView 是 Management API 返回的完整无敏感账号投影。
type AccountView struct {
	AccountRef       accountcore.AccountRef
	ProviderID       string
	CLIAccountID     accountcore.CLIAccountID
	Enabled          bool
	HasCredential    bool
	AuthKind         string
	AuthMode         string
	HasProfile       bool
	DisplayName      string
	Email            string
	SubscriptionKind string
	SubscriptionRaw  string
	ProfileUpdatedAt time.Time
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

// AccountImportResult 把统一账号公开投影与本次是否首次创建一起返回。
type AccountImportResult struct {
	Account AccountView
	Created bool
}

// AccountListResult 是远端账号列表及其下一页游标。
type AccountListResult struct {
	Accounts     []AccountView
	Limit        int
	HasMore      bool
	NextAfterRef string
}

// AccountModelsResult 是一个账号的完整物化模型关系快照。
type AccountModelsResult struct {
	AccountRef string
	Models     []AccountModelView
}

// AccountModelView 是 Management API 返回的单条无敏感模型关系。
type AccountModelView struct {
	ModelID           string
	UpstreamAvailable bool
	ManualPolicy      string
	Effective         bool
	UpdatedAt         time.Time
}

// ListAccounts 从目标 Server 读取有界 keyset 分页，不打开本地 SQLite。
func (client *Client) ListAccounts(
	ctx context.Context,
	options ListOptions,
) (AccountListResult, error) {
	if !client.isValid() {
		return AccountListResult{}, ErrInvalidConfig
	}
	if ctx == nil {
		return AccountListResult{}, ErrInvalidRequest
	}
	limit := options.Limit
	if limit == 0 {
		limit = DefaultListLimit
	}
	if limit < 1 || limit > MaxListLimit {
		return AccountListResult{}, ErrInvalidRequest
	}
	values := url.Values{}
	values.Set("limit", strconv.Itoa(limit))
	if options.AfterRef != "" {
		afterRef, err := accountcore.ParseAccountRef(options.AfterRef)
		if err != nil {
			return AccountListResult{}, ErrInvalidRequest
		}
		values.Set("after_ref", afterRef.String())
	}
	result, err := client.doResponseRequest(
		ctx,
		http.MethodGet,
		client.baseURL+accountcontract.AccountsPath+"?"+values.Encode(),
		nil,
	)
	if err != nil {
		return AccountListResult{}, err
	}
	if result.statusCode != http.StatusOK || !isJSONResponse(result.header) {
		return AccountListResult{}, ErrInvalidResponse
	}
	return decodeAccountList(result.body, limit)
}

// GetAccountView 读取一个稳定账号的完整公开投影。
func (client *Client) GetAccountView(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (AccountView, error) {
	if !client.isValid() {
		return AccountView{}, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return AccountView{}, ErrInvalidRequest
	}
	result, err := client.doResponseRequest(
		ctx,
		http.MethodGet,
		accountURL(client.baseURL, accountRef),
		nil,
	)
	if err != nil {
		return AccountView{}, err
	}
	if result.statusCode != http.StatusOK || !isJSONResponse(result.header) {
		return AccountView{}, ErrInvalidResponse
	}
	view, err := decodeAccountView(result.body)
	if err != nil || view.AccountRef != accountRef {
		return AccountView{}, ErrInvalidResponse
	}
	return view, nil
}

// ListAccountModels 读取目标 Server 已物化的账号模型快照。
func (client *Client) ListAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (AccountModelsResult, error) {
	return client.requestAccountModels(ctx, http.MethodGet, accountRef, nil)
}

// RefreshAccountModels 请求目标 Server 使用规范凭据刷新一次完整模型目录。
func (client *Client) RefreshAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (AccountModelsResult, error) {
	return client.requestAccountModels(
		ctx,
		http.MethodPost,
		accountRef,
		nil,
	)
}

// SetAccountModelPolicy 原子更新一个账号模型的人工策略。
func (client *Client) SetAccountModelPolicy(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelID string,
	manualPolicy string,
) (AccountModelsResult, error) {
	if !validModelID(modelID) || !validManualPolicy(manualPolicy) {
		return AccountModelsResult{}, ErrInvalidRequest
	}
	payload, err := json.Marshal(struct {
		ModelID      string `json:"model_id"`
		ManualPolicy string `json:"manual_policy"`
	}{ModelID: modelID, ManualPolicy: manualPolicy})
	if err != nil {
		return AccountModelsResult{}, ErrInvalidRequest
	}
	return client.requestAccountModels(ctx, http.MethodPatch, accountRef, payload)
}

// ImportNative 把本机官方 artifact 提交给目标 Server，并区分首建与原地更新。
func (client *Client) ImportNative(
	ctx context.Context,
	providerID string,
	artifacts []byte,
) (AccountImportResult, error) {
	if !client.isValid() {
		return AccountImportResult{}, ErrInvalidConfig
	}
	if ctx == nil || !validNativeProviderID(providerID) ||
		len(artifacts) == 0 || len(artifacts) > maxNativeImportDocumentBytes ||
		!validJSONObject(artifacts) {
		return AccountImportResult{}, ErrInvalidRequest
	}
	payload, err := json.Marshal(struct {
		ProviderID string          `json:"provider_id"`
		Artifacts  json.RawMessage `json:"artifacts"`
	}{ProviderID: providerID, Artifacts: json.RawMessage(artifacts)})
	if err != nil || len(payload) > maxNativeImportDocumentBytes {
		return AccountImportResult{}, ErrInvalidRequest
	}
	result, err := client.doResponseRequest(
		ctx,
		http.MethodPost,
		client.baseURL+accountcontract.NativeImportsPath,
		payload,
	)
	if err != nil {
		return AccountImportResult{}, err
	}
	return decodeAccountImportResult(result)
}

// decodeAccountImportResult 统一解释两个导入资源的 200/201 成功合同。
func decodeAccountImportResult(
	result responseResult,
) (AccountImportResult, error) {
	if !isAccountImportSuccess(result.statusCode) ||
		!isJSONResponse(result.header) {
		return AccountImportResult{}, ErrInvalidResponse
	}
	account, err := decodeAccountView(result.body)
	if err != nil {
		return AccountImportResult{}, err
	}
	return AccountImportResult{
		Account: account,
		Created: result.statusCode == http.StatusCreated,
	}, nil
}

// isAccountImportSuccess 只接受冻结合同中的首次创建与同身份命中状态。
func isAccountImportSuccess(statusCode int) bool {
	return statusCode == http.StatusCreated || statusCode == http.StatusOK
}

// requestAccountModels 统一模型列表、刷新和策略写入的 HTTP 合同。
func (client *Client) requestAccountModels(
	ctx context.Context,
	method string,
	accountRef accountcore.AccountRef,
	payload []byte,
) (AccountModelsResult, error) {
	if !client.isValid() {
		return AccountModelsResult{}, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return AccountModelsResult{}, ErrInvalidRequest
	}
	suffix := accountcontract.AccountModelsSuffix
	if method == http.MethodPost {
		suffix = accountcontract.AccountModelsRefreshSuffix
	} else if method != http.MethodGet && method != http.MethodPatch {
		return AccountModelsResult{}, ErrInvalidRequest
	}
	result, err := client.doResponseRequest(
		ctx,
		method,
		accountURL(client.baseURL, accountRef)+suffix,
		payload,
	)
	if err != nil {
		return AccountModelsResult{}, err
	}
	if result.statusCode != http.StatusOK || !isJSONResponse(result.header) {
		return AccountModelsResult{}, ErrInvalidResponse
	}
	return decodeAccountModels(result.body, accountRef)
}

// decodeAccountList 校验分页元数据、稳定排序和每条账号公开投影。
func decodeAccountList(document []byte, expectedLimit int) (AccountListResult, error) {
	var response struct {
		Data []accountViewDTO `json:"data"`
		Page struct {
			Limit        int    `json:"limit"`
			HasMore      bool   `json:"has_more"`
			NextAfterRef string `json:"next_after_ref"`
		} `json:"page"`
	}
	if err := json.Unmarshal(document, &response); err != nil ||
		response.Data == nil ||
		response.Page.Limit != expectedLimit ||
		len(response.Data) > expectedLimit {
		return AccountListResult{}, ErrInvalidResponse
	}
	accounts := make([]AccountView, 0, len(response.Data))
	previousRef := accountcore.AccountRef("")
	for _, dto := range response.Data {
		view, err := dto.decode()
		if err != nil || previousRef != "" && view.AccountRef.String() <= previousRef.String() {
			return AccountListResult{}, ErrInvalidResponse
		}
		accounts = append(accounts, view)
		previousRef = view.AccountRef
	}
	if response.Page.HasMore {
		cursor, err := accountcore.ParseAccountRef(response.Page.NextAfterRef)
		if err != nil || len(accounts) == 0 || cursor != accounts[len(accounts)-1].AccountRef {
			return AccountListResult{}, ErrInvalidResponse
		}
	} else if response.Page.NextAfterRef != "" {
		return AccountListResult{}, ErrInvalidResponse
	}
	return AccountListResult{
		Accounts:     accounts,
		Limit:        expectedLimit,
		HasMore:      response.Page.HasMore,
		NextAfterRef: response.Page.NextAfterRef,
	}, nil
}

// decodeAccountView 校验详情、创建和导入共享的账号公开投影。
func decodeAccountView(document []byte) (AccountView, error) {
	var response struct {
		Data accountViewDTO `json:"data"`
	}
	if err := json.Unmarshal(document, &response); err != nil {
		return AccountView{}, ErrInvalidResponse
	}
	return response.Data.decode()
}

// decodeAccountModels 校验模型顺序、唯一性、策略和规范时间。
func decodeAccountModels(
	document []byte,
	accountRef accountcore.AccountRef,
) (AccountModelsResult, error) {
	var response struct {
		Data []accountModelDTO `json:"data"`
	}
	if err := json.Unmarshal(document, &response); err != nil || response.Data == nil {
		return AccountModelsResult{}, ErrInvalidResponse
	}
	models := make([]AccountModelView, 0, len(response.Data))
	previousID := ""
	for _, dto := range response.Data {
		model, err := dto.decode()
		if err != nil || previousID != "" && model.ModelID <= previousID {
			return AccountModelsResult{}, ErrInvalidResponse
		}
		models = append(models, model)
		previousID = model.ModelID
	}
	return AccountModelsResult{AccountRef: accountRef.String(), Models: models}, nil
}

// accountViewDTO 是服务端 JSON 投影的私有反序列化结构。
type accountViewDTO struct {
	AccountRef       string `json:"account_ref"`
	ProviderID       string `json:"provider_id"`
	CLIAccountID     int64  `json:"cli_account_id"`
	Enabled          bool   `json:"enabled"`
	HasCredential    bool   `json:"has_credential"`
	AuthKind         string `json:"auth_kind"`
	AuthMode         string `json:"auth_mode"`
	HasProfile       bool   `json:"has_profile"`
	DisplayName      string `json:"display_name"`
	Email            string `json:"email"`
	SubscriptionKind string `json:"subscription_kind"`
	SubscriptionRaw  string `json:"subscription_raw"`
	ProfileUpdatedAt string `json:"profile_updated_at"`
	CreatedAt        string `json:"created_at"`
	UpdatedAt        string `json:"updated_at"`
}

// decode 把 JSON 标量转换成经过领域校验的远端账号投影。
func (dto accountViewDTO) decode() (AccountView, error) {
	accountRef, refErr := accountcore.ParseAccountRef(dto.AccountRef)
	cliAccountID, aliasErr := accountcore.NewCLIAccountID(dto.CLIAccountID)
	createdAt, createdErr := parseRequiredTime(dto.CreatedAt)
	updatedAt, updatedErr := parseRequiredTime(dto.UpdatedAt)
	profileUpdatedAt, profileErr := parseOptionalTime(dto.ProfileUpdatedAt)
	if refErr != nil || aliasErr != nil || createdErr != nil || updatedErr != nil ||
		profileErr != nil || !validProviderID(dto.ProviderID) ||
		!validAccountMetadata(dto) {
		return AccountView{}, ErrInvalidResponse
	}
	return AccountView{
		AccountRef:       accountRef,
		ProviderID:       dto.ProviderID,
		CLIAccountID:     cliAccountID,
		Enabled:          dto.Enabled,
		HasCredential:    dto.HasCredential,
		AuthKind:         dto.AuthKind,
		AuthMode:         dto.AuthMode,
		HasProfile:       dto.HasProfile,
		DisplayName:      dto.DisplayName,
		Email:            dto.Email,
		SubscriptionKind: dto.SubscriptionKind,
		SubscriptionRaw:  dto.SubscriptionRaw,
		ProfileUpdatedAt: profileUpdatedAt,
		CreatedAt:        createdAt,
		UpdatedAt:        updatedAt,
	}, nil
}

// accountModelDTO 是服务端模型投影的私有反序列化结构。
type accountModelDTO struct {
	ModelID           string `json:"model_id"`
	UpstreamAvailable bool   `json:"upstream_available"`
	ManualPolicy      string `json:"manual_policy"`
	Effective         bool   `json:"effective"`
	UpdatedAt         string `json:"updated_at"`
}

// decode 把模型 JSON 转换成经过边界校验的模型视图。
func (dto accountModelDTO) decode() (AccountModelView, error) {
	modelID, modelErr := runtimecore.NewModelID(dto.ModelID)
	updatedAt, timeErr := parseRequiredTime(dto.UpdatedAt)
	if modelErr != nil || timeErr != nil || !validManualPolicy(dto.ManualPolicy) {
		return AccountModelView{}, ErrInvalidResponse
	}
	return AccountModelView{
		ModelID:           modelID.String(),
		UpstreamAvailable: dto.UpstreamAvailable,
		ManualPolicy:      dto.ManualPolicy,
		Effective:         dto.Effective,
		UpdatedAt:         updatedAt,
	}, nil
}

// validAccountMetadata 检查公开字段的大小、空白和凭据/资料存在性不变量。
func validAccountMetadata(dto accountViewDTO) bool {
	if dto.HasCredential {
		if !validPublicToken(dto.AuthKind, 32) ||
			(dto.AuthMode != "" && !validPublicToken(dto.AuthMode, 32)) {
			return false
		}
	} else if dto.AuthKind != "" || dto.AuthMode != "" {
		return false
	}
	if !dto.HasProfile {
		return dto.DisplayName == "" && dto.Email == "" &&
			dto.SubscriptionKind == "" && dto.SubscriptionRaw == "" &&
			dto.ProfileUpdatedAt == ""
	}
	return validPublicText(dto.DisplayName, 256) &&
		validPublicText(dto.Email, 320) &&
		validPublicToken(dto.SubscriptionKind, 64) &&
		validPublicText(dto.SubscriptionRaw, 128) &&
		dto.ProfileUpdatedAt != ""
}

// validNativeProviderID 限制官方 artifact 导入在当前实现的 Codex、Claude 边界内。
func validNativeProviderID(value string) bool {
	return value == "codex" || value == "claude"
}

// validJSONObject 限制原生 artifact 顶层为 JSON 对象，不把 null 或数组上传到 Server。
func validJSONObject(document []byte) bool {
	var object map[string]json.RawMessage
	return json.Unmarshal(document, &object) == nil && object != nil
}

// validModelID 复用运行态模型标识的边界规则。
func validModelID(value string) bool {
	_, err := runtimecore.NewModelID(value)
	return err == nil
}

// validManualPolicy 限制策略为公开合同中的三个值。
func validManualPolicy(value string) bool {
	switch value {
	case "inherit", "force_enable", "force_disable":
		return true
	default:
		return false
	}
}

// validPublicToken 校验小型公开枚举字段。
func validPublicToken(value string, maximum int) bool {
	if value == "" || len(value) > maximum || value != strings.TrimSpace(value) {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' || character == '_' {
			continue
		}
		return false
	}
	return true
}

// validPublicText 校验公开资料不会携带控制字符或无界文本。
func validPublicText(value string, maximum int) bool {
	if len(value) > maximum || !utf8.ValidString(value) || value != strings.TrimSpace(value) {
		return false
	}
	for _, character := range value {
		if character < ' ' || character == 0x7f {
			return false
		}
	}
	return true
}

// parseRequiredTime 只接受服务端规范的 RFC3339 时间。
func parseRequiredTime(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, ErrInvalidResponse
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, ErrInvalidResponse
	}
	return parsed.UTC(), nil
}

// parseOptionalTime 允许服务端省略没有公开资料采集时间的字段。
func parseOptionalTime(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	return parseRequiredTime(value)
}
