package managementapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// UsageDocument 是账号最近一次 Provider 快照文档的只读投影。
type UsageDocument struct {
	Kind    string
	Source  string
	Payload json.RawMessage
}

// GetUsageDocument 读取账号的完整额度快照文档；文档不存在时返回 ErrInvalidResponse。
func (client *Client) GetUsageDocument(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (UsageDocument, error) {
	if !client.isValid() {
		return UsageDocument{}, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return UsageDocument{}, ErrInvalidRequest
	}
	requestURL := client.baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String()) + "/usage-document"
	document, err := client.doDocumentRequest(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return UsageDocument{}, err
	}
	var response struct {
		Data struct {
			Kind    string          `json:"kind"`
			Source  string          `json:"source"`
			Payload json.RawMessage `json:"payload"`
		} `json:"data"`
	}
	if err := json.Unmarshal(document, &response); err != nil ||
		len(response.Data.Payload) == 0 ||
		!json.Valid(response.Data.Payload) {
		return UsageDocument{}, errors.Join(ErrInvalidResponse, err)
	}
	return UsageDocument{
		Kind:    response.Data.Kind,
		Source:  response.Data.Source,
		Payload: response.Data.Payload,
	}, nil
}
