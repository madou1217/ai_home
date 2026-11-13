package managementapi

import (
	"context"
	"encoding/json"
	"net/http"
)

// AccountUIState 是账号页展示状态的只读投影。
type AccountUIState struct {
	AccountRef  string
	DisplayName string
}

// ListAccountUIStates 批量读取账号展示状态；只用于补展示名，不影响账号事实。
func (client *Client) ListAccountUIStates(ctx context.Context) ([]AccountUIState, error) {
	if !client.isValid() {
		return nil, ErrInvalidConfig
	}
	if ctx == nil {
		return nil, ErrInvalidRequest
	}
	document, err := client.doDocumentRequest(
		ctx,
		http.MethodGet,
		client.baseURL+"/v1/management/account-ui-states",
		nil,
	)
	if err != nil {
		return nil, err
	}
	var response struct {
		Data []struct {
			AccountRef  string `json:"account_ref"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	if err := json.Unmarshal(document, &response); err != nil {
		return nil, ErrInvalidResponse
	}
	states := make([]AccountUIState, 0, len(response.Data))
	for _, item := range response.Data {
		states = append(states, AccountUIState{
			AccountRef:  item.AccountRef,
			DisplayName: item.DisplayName,
		})
	}
	return states, nil
}
