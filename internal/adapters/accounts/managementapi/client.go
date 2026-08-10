// Package managementapi 提供 AIH Go Server 账号管理 API 的出站适配器。
package managementapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

const (
	minManagementKeyLength = 32
	maxManagementKeyLength = 8192
	maxResponseBytes       = 1024 * 1024
)

var (
	// ErrInvalidConfig 表示 Server 根地址、Management Key 或 HTTP 端口无效。
	ErrInvalidConfig = errors.New("账号管理 API 配置无效")
	// ErrInvalidRequest 表示账号目标或调用上下文无效。
	ErrInvalidRequest = errors.New("账号管理 API 请求无效")
	// ErrInvalidResponse 表示 Server 返回了不符合公开合同的响应。
	ErrInvalidResponse = errors.New("账号管理 API 响应无效")
)

// HTTPClient 是账号管理出站适配器需要的最小传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Config 是连接一个 AIH Go Server 管理面的敏感配置。
type Config struct {
	BaseURL       string
	ManagementKey string
}

// String 返回不泄露 Management Key 的配置摘要。
func (config Config) String() string {
	return fmt.Sprintf(
		"managementapi.Config{base_url=%s,management_key=<redacted>}",
		config.BaseURL,
	)
}

// GoString 确保 %#v 不会反射 Management Key。
func (config Config) GoString() string {
	return config.String()
}

// Format 覆盖全部 fmt verb，避免格式化绕过密钥脱敏。
func (config Config) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(config.String()))
}

// AccountSnapshot 是启停命令允许返回的最小无敏感账号快照。
type AccountSnapshot struct {
	AccountRef   accountcore.AccountRef
	ProviderID   string
	CLIAccountID accountcore.CLIAccountID
	Enabled      bool
	UpdatedAt    time.Time
}

// RemoteError 是 Server 返回的稳定 HTTP 错误，不包含请求或凭据正文。
type RemoteError struct {
	StatusCode int
	Code       string
	Message    string
}

// Error 返回适合 CLI 展示的稳定失败摘要。
func (remote RemoteError) Error() string {
	return fmt.Sprintf(
		"账号管理 API 返回 %d %s: %s",
		remote.StatusCode,
		remote.Code,
		remote.Message,
	)
}

// Client 持有一个经过校验的 Server 根地址与管理凭据。
type Client struct {
	httpClient    HTTPClient
	baseURL       string
	managementKey string
}

// New 创建不会把 Management Key 放入 URL、日志或错误文本的客户端。
func New(httpClient HTTPClient, config Config) (*Client, error) {
	baseURL, err := normalizeBaseURL(config.BaseURL)
	if httpClient == nil || err != nil || !validManagementKey(config.ManagementKey) {
		return nil, ErrInvalidConfig
	}
	return &Client{
		httpClient:    httpClient,
		baseURL:       baseURL,
		managementKey: config.ManagementKey,
	}, nil
}

// String 返回不泄露 Management Key 的客户端摘要。
func (client *Client) String() string {
	if client == nil {
		return "managementapi.Client<nil>"
	}
	return fmt.Sprintf(
		"managementapi.Client{base_url=%s,management_key=<redacted>}",
		client.baseURL,
	)
}

// GoString 确保 %#v 不会反射 Management Key。
func (client *Client) GoString() string {
	return client.String()
}

// Format 覆盖全部 fmt verb，避免格式化绕过密钥脱敏。
func (client *Client) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(client.String()))
}

// ResolveAlias 通过 Server 单库把 Provider 数字别名解析为稳定账号身份。
func (client *Client) ResolveAlias(
	ctx context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (AccountSnapshot, error) {
	if !client.isValid() {
		return AccountSnapshot{}, ErrInvalidConfig
	}
	if ctx == nil ||
		providerID == "" ||
		providerID != strings.TrimSpace(providerID) ||
		providerID != strings.ToLower(providerID) ||
		!cliAccountID.IsValid() {
		return AccountSnapshot{}, ErrInvalidRequest
	}
	requestURL := client.baseURL + accountcontract.AccountAliasesPath + "/" +
		url.PathEscape(providerID) + "/" + cliAccountID.String()
	snapshot, err := client.doAccountRequest(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return AccountSnapshot{}, err
	}
	if snapshot.ProviderID != providerID || snapshot.CLIAccountID != cliAccountID {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	return snapshot, nil
}

// GetAccount 读取一个稳定账号的最小公开快照，不返回凭据或派生状态。
func (client *Client) GetAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (AccountSnapshot, error) {
	if !client.isValid() {
		return AccountSnapshot{}, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return AccountSnapshot{}, ErrInvalidRequest
	}
	requestURL := client.baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String())
	snapshot, err := client.doAccountRequest(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return AccountSnapshot{}, err
	}
	if snapshot.AccountRef != accountRef {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	return snapshot, nil
}

// SetEnabled 通过 Server 原子修改账号启停状态并返回提交后的公开快照。
func (client *Client) SetEnabled(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	enabled bool,
) (AccountSnapshot, error) {
	if !client.isValid() {
		return AccountSnapshot{}, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return AccountSnapshot{}, ErrInvalidRequest
	}
	payload, err := json.Marshal(struct {
		Enabled bool `json:"enabled"`
	}{Enabled: enabled})
	if err != nil {
		return AccountSnapshot{}, ErrInvalidConfig
	}
	requestURL := client.baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String())
	snapshot, err := client.doAccountRequest(
		ctx,
		http.MethodPatch,
		requestURL,
		payload,
	)
	if err != nil {
		return AccountSnapshot{}, err
	}
	if snapshot.AccountRef != accountRef || snapshot.Enabled != enabled {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	return snapshot, nil
}

// DeleteAccount 删除一个稳定账号，只接受标准 204 空响应合同。
func (client *Client) DeleteAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if !client.isValid() {
		return ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return ErrInvalidRequest
	}
	requestURL := client.baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String())
	return client.doNoContentRequest(
		ctx,
		http.MethodDelete,
		requestURL,
	)
}

// doNoContentRequest 只接受标准 204 和空响应体的成功合同。
func (client *Client) doNoContentRequest(
	ctx context.Context,
	method string,
	requestURL string,
) error {
	statusCode, body, err := client.doRequest(ctx, method, requestURL, nil)
	if err != nil {
		return err
	}
	if statusCode != http.StatusNoContent || len(body) != 0 {
		return ErrInvalidResponse
	}
	return nil
}

// doAccountRequest 统一认证、响应上限、错误合同和快照校验。
func (client *Client) doAccountRequest(
	ctx context.Context,
	method string,
	requestURL string,
	payload []byte,
) (AccountSnapshot, error) {
	body, err := client.doDocumentRequest(ctx, method, requestURL, payload)
	if err != nil {
		return AccountSnapshot{}, err
	}
	return decodeAccountSnapshot(body)
}

// doDocumentRequest 统一认证、响应上限和稳定远端错误合同。
func (client *Client) doDocumentRequest(
	ctx context.Context,
	method string,
	requestURL string,
	payload []byte,
) ([]byte, error) {
	_, body, err := client.doRequest(ctx, method, requestURL, payload)
	return body, err
}

// doRequest 统一认证、响应读取上限和稳定远端错误合同，并保留成功状态码。
func (client *Client) doRequest(
	ctx context.Context,
	method string,
	requestURL string,
	payload []byte,
) (_ int, _ []byte, resultErr error) {
	request, err := http.NewRequestWithContext(
		ctx,
		method,
		requestURL,
		bytes.NewReader(payload),
	)
	if err != nil {
		return 0, nil, fmt.Errorf("创建账号管理请求失败: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.managementKey)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("执行账号管理请求失败: %w", err)
	}
	if response == nil || response.Body == nil {
		return 0, nil, ErrInvalidResponse
	}
	defer func() {
		resultErr = errors.Join(resultErr, response.Body.Close())
	}()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return 0, nil, fmt.Errorf("读取账号管理响应失败: %w", err)
	}
	if len(body) > maxResponseBytes {
		return 0, nil, ErrInvalidResponse
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return 0, nil, newRemoteError(response.StatusCode, body)
	}
	return response.StatusCode, body, nil
}

// decodeAccountSnapshot 校验公开响应没有错账号、非法别名或非规范时间。
func decodeAccountSnapshot(document []byte) (AccountSnapshot, error) {
	var response struct {
		Data struct {
			AccountRef   string `json:"account_ref"`
			ProviderID   string `json:"provider_id"`
			CLIAccountID int64  `json:"cli_account_id"`
			Enabled      bool   `json:"enabled"`
			UpdatedAt    string `json:"updated_at"`
		} `json:"data"`
	}
	if err := json.Unmarshal(document, &response); err != nil {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	accountRef, refErr := accountcore.ParseAccountRef(response.Data.AccountRef)
	cliAccountID, aliasErr := accountcore.NewCLIAccountID(response.Data.CLIAccountID)
	updatedAt, timeErr := time.Parse(time.RFC3339Nano, response.Data.UpdatedAt)
	if refErr != nil ||
		aliasErr != nil ||
		timeErr != nil ||
		response.Data.ProviderID == "" ||
		response.Data.ProviderID != strings.TrimSpace(response.Data.ProviderID) ||
		response.Data.ProviderID != strings.ToLower(response.Data.ProviderID) {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	return AccountSnapshot{
		AccountRef:   accountRef,
		ProviderID:   response.Data.ProviderID,
		CLIAccountID: cliAccountID,
		Enabled:      response.Data.Enabled,
		UpdatedAt:    updatedAt.UTC(),
	}, nil
}

// newRemoteError 只接收受限长度的稳定错误字段，拒绝回显任意响应正文。
func newRemoteError(statusCode int, document []byte) error {
	var response struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(document, &response) == nil &&
		validRemoteText(response.Error.Code, 128) &&
		validRemoteText(response.Error.Message, 1024) {
		return RemoteError{
			StatusCode: statusCode,
			Code:       response.Error.Code,
			Message:    response.Error.Message,
		}
	}
	return RemoteError{
		StatusCode: statusCode,
		Code:       "remote_error",
		Message:    http.StatusText(statusCode),
	}
}

// normalizeBaseURL 只接受无凭据、查询、fragment 和路径的 HTTP(S) 根地址。
func normalizeBaseURL(value string) (string, error) {
	if value == "" || value != strings.TrimSpace(value) || strings.ContainsRune(value, '\x00') {
		return "", ErrInvalidConfig
	}
	parsed, err := url.Parse(value)
	if err != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" ||
		parsed.User != nil ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" ||
		(parsed.Path != "" && parsed.Path != "/") {
		return "", ErrInvalidConfig
	}
	parsed.Path = ""
	return strings.TrimSuffix(parsed.String(), "/"), nil
}

// validManagementKey 复核 Bearer Header 的长度、空白和控制字符约束。
func validManagementKey(value string) bool {
	if len(value) < minManagementKeyLength || len(value) > maxManagementKeyLength {
		return false
	}
	for _, character := range value {
		if character <= ' ' || character == 0x7f {
			return false
		}
	}
	return true
}

// validRemoteText 防止上游错误文本携带空值、控制字符或无界内容。
func validRemoteText(value string, maximum int) bool {
	if value == "" || len(value) > maximum || value != strings.TrimSpace(value) {
		return false
	}
	for _, character := range value {
		if character < ' ' || character == 0x7f {
			return false
		}
	}
	return true
}

// isValid 复核 Client 没有被零值构造或跨层改写。
func (client *Client) isValid() bool {
	if client == nil || client.httpClient == nil {
		return false
	}
	baseURL, err := normalizeBaseURL(client.baseURL)
	return err == nil &&
		baseURL == client.baseURL &&
		validManagementKey(client.managementKey)
}
