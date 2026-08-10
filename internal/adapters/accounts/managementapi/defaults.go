package managementapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// ProviderDefaultSnapshot 是 Provider 默认启动账号的无敏感公开关系。
type ProviderDefaultSnapshot struct {
	ProviderID string
	AccountRef accountcore.AccountRef
	UpdatedAt  time.Time
}

// GetProviderDefault 读取目标 Server 当前 Provider 默认启动账号。
func (client *Client) GetProviderDefault(
	ctx context.Context,
	providerID string,
) (ProviderDefaultSnapshot, error) {
	if !client.isValid() {
		return ProviderDefaultSnapshot{}, ErrInvalidConfig
	}
	if ctx == nil || !validProviderID(providerID) {
		return ProviderDefaultSnapshot{}, ErrInvalidRequest
	}
	requestURL := providerDefaultURL(client.baseURL, providerID)
	document, err := client.doDocumentRequest(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return ProviderDefaultSnapshot{}, err
	}
	result, err := decodeProviderDefault(document)
	if err != nil || result.ProviderID != providerID {
		return ProviderDefaultSnapshot{}, ErrInvalidResponse
	}
	return result, nil
}

// SetProviderDefault 原子替换目标 Server 的 Provider 默认启动账号。
func (client *Client) SetProviderDefault(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
) (ProviderDefaultSnapshot, error) {
	if !client.isValid() {
		return ProviderDefaultSnapshot{}, ErrInvalidConfig
	}
	if ctx == nil || !validProviderID(providerID) || !accountRef.IsValid() {
		return ProviderDefaultSnapshot{}, ErrInvalidRequest
	}
	payload, err := json.Marshal(struct {
		AccountRef string `json:"account_ref"`
	}{AccountRef: accountRef.String()})
	if err != nil {
		return ProviderDefaultSnapshot{}, ErrInvalidConfig
	}
	requestURL := providerDefaultURL(client.baseURL, providerID)
	document, err := client.doDocumentRequest(ctx, http.MethodPut, requestURL, payload)
	if err != nil {
		return ProviderDefaultSnapshot{}, err
	}
	result, err := decodeProviderDefault(document)
	if err != nil || result.ProviderID != providerID || result.AccountRef != accountRef {
		return ProviderDefaultSnapshot{}, ErrInvalidResponse
	}
	return result, nil
}

// ClearProviderDefault 幂等清除目标 Server 的 Provider 默认启动账号。
func (client *Client) ClearProviderDefault(
	ctx context.Context,
	providerID string,
) error {
	if !client.isValid() {
		return ErrInvalidConfig
	}
	if ctx == nil || !validProviderID(providerID) {
		return ErrInvalidRequest
	}
	return client.doNoContentRequest(
		ctx,
		http.MethodDelete,
		providerDefaultURL(client.baseURL, providerID),
	)
}

// providerDefaultURL 构造经过路径段转义的默认关系成员地址。
func providerDefaultURL(baseURL string, providerID string) string {
	return baseURL + accountcontract.ProviderDefaultsPath + "/" +
		url.PathEscape(providerID)
}

// decodeProviderDefault 校验默认关系公开响应的身份和时间不变量。
func decodeProviderDefault(document []byte) (ProviderDefaultSnapshot, error) {
	var response struct {
		Data struct {
			ProviderID string `json:"provider_id"`
			AccountRef string `json:"account_ref"`
			UpdatedAt  string `json:"updated_at"`
		} `json:"data"`
	}
	if err := json.Unmarshal(document, &response); err != nil {
		return ProviderDefaultSnapshot{}, ErrInvalidResponse
	}
	accountRef, refErr := accountcore.ParseAccountRef(response.Data.AccountRef)
	updatedAt, timeErr := time.Parse(time.RFC3339Nano, response.Data.UpdatedAt)
	if refErr != nil || timeErr != nil || !validProviderID(response.Data.ProviderID) {
		return ProviderDefaultSnapshot{}, ErrInvalidResponse
	}
	return ProviderDefaultSnapshot{
		ProviderID: response.Data.ProviderID,
		AccountRef: accountRef,
		UpdatedAt:  updatedAt.UTC(),
	}, nil
}

// validProviderID 接受规范小写 Provider 路径段，并拒绝空白和控制字符。
func validProviderID(providerID string) bool {
	if len(providerID) == 0 || len(providerID) > 64 ||
		providerID != strings.TrimSpace(providerID) ||
		providerID != strings.ToLower(providerID) ||
		providerID[0] == '-' || providerID[0] == '_' ||
		providerID[len(providerID)-1] == '-' ||
		providerID[len(providerID)-1] == '_' {
		return false
	}
	for _, character := range providerID {
		if (character < 'a' || character > 'z') &&
			(character < '0' || character > '9') &&
			character != '_' && character != '-' {
			return false
		}
	}
	return true
}
