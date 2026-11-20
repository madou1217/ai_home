package managementapi

import (
	"context"
	"encoding/json"
	"net/http"

	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// createStaticAccountRequest 是静态账号集合 POST 的私有传输 DTO。
type createStaticAccountRequest struct {
	ProviderID string               `json:"provider_id"`
	Auth       staticCredentialAuth `json:"auth"`
}

// CreateStaticAccount 向目标 Go Server 注册 Codex 或 Claude 静态账号。
func (client *Client) CreateStaticAccount(
	ctx context.Context,
	providerID string,
	input StaticCredentialInput,
) (AccountSnapshot, error) {
	if !client.isValid() {
		return AccountSnapshot{}, ErrInvalidConfig
	}
	if ctx == nil || !input.isValidForProvider(providerID) {
		return AccountSnapshot{}, ErrInvalidRequest
	}
	payload, err := json.Marshal(createStaticAccountRequest{
		ProviderID: providerID,
		Auth: staticCredentialAuth{
			Kind:      input.Kind,
			APIKey:    input.APIKey,
			AuthToken: input.AuthToken,
			BaseURL:   input.BaseURL,
		},
	})
	if err != nil {
		return AccountSnapshot{}, ErrInvalidRequest
	}
	defer clear(payload)

	result, err := client.doResponseRequest(
		ctx,
		http.MethodPost,
		client.baseURL+accountcontract.AccountsPath,
		payload,
	)
	if err != nil {
		return AccountSnapshot{}, err
	}
	if result.statusCode != http.StatusCreated || !isJSONResponse(result.header) {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	snapshot, err := decodeAccountSnapshot(result.body)
	if err != nil || snapshot.ProviderID != providerID {
		return AccountSnapshot{}, ErrInvalidResponse
	}
	return snapshot, nil
}

// isValidForProvider 按账号 HTTP 契约校验 Provider 与凭据类型的组合。
//
// 可接受的组合只在契约里声明一次，客户端不再复制服务端的 Provider 名单：
// 新增 Provider 时改契约即可，不需要同时修改 CLI、客户端和服务端三处分支。
func (input StaticCredentialInput) isValidForProvider(providerID string) bool {
	return input.isValid() &&
		accountcontract.SupportsStaticCredential(providerID, accountcontract.StaticCredentialKind(input.Kind))
}
