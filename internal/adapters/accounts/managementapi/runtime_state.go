package managementapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// AccountRuntimeState 是 Server 对账号运行态的公开派生视图。
type AccountRuntimeState struct {
	AccountRef string
	Status     string
	Reason     string
	UntilMS    int64
}

// GetAccountRuntimeState 读取账号级运行态；auth_invalid/token_expired 表示
// 当前登录态不可用，CLI 启动前据此提示重新登录。
func (client *Client) GetAccountRuntimeState(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (AccountRuntimeState, error) {
	if !client.isValid() {
		return AccountRuntimeState{}, ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return AccountRuntimeState{}, ErrInvalidRequest
	}
	requestURL := client.baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String()) + "/runtime-state"
	document, err := client.doDocumentRequest(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return AccountRuntimeState{}, err
	}
	var response struct {
		Data struct {
			AccountRef string `json:"account_ref"`
			Status     string `json:"status"`
			Reason     string `json:"reason"`
			UntilMS    int64  `json:"until_ms"`
		} `json:"data"`
	}
	if err := json.Unmarshal(document, &response); err != nil {
		return AccountRuntimeState{}, ErrInvalidResponse
	}
	if response.Data.AccountRef != accountRef.String() {
		return AccountRuntimeState{}, ErrInvalidResponse
	}
	return AccountRuntimeState{
		AccountRef: response.Data.AccountRef,
		Status:     response.Data.Status,
		Reason:     response.Data.Reason,
		UntilMS:    response.Data.UntilMS,
	}, nil
}

const accountsWatchSnapshotPath = "/v1/management/webui/accounts/watch/snapshot"

// PublishAccountsSnapshot 请求 Server 重建并广播账号页快照。
//
// CLI 登录是跨进程写入；文件 watcher 可能合并/延迟，显式事件能让已打开的
// WebUI 立即收到新行，而不是等用户手动刷新。
func (client *Client) PublishAccountsSnapshot(ctx context.Context) error {
	if !client.isValid() {
		return ErrInvalidConfig
	}
	if ctx == nil {
		return ErrInvalidRequest
	}
	_, err := client.doDocumentRequest(
		ctx,
		http.MethodPost,
		client.baseURL+accountsWatchSnapshotPath,
		nil,
	)
	return err
}

// ClearAccountRuntimeState 删除账号运行态；用于同账号登录成功后立即解除
// auth_invalid，避免 WebUI/CLI 仍显示“需要重新登录”。
func (client *Client) ClearAccountRuntimeState(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if !client.isValid() {
		return ErrInvalidConfig
	}
	if ctx == nil || !accountRef.IsValid() {
		return ErrInvalidRequest
	}
	payload, err := json.Marshal(struct {
		State     any    `json:"state"`
		UpdatedAt string `json:"updated_at"`
	}{
		State:     nil,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	})
	if err != nil {
		return ErrInvalidRequest
	}
	requestURL := client.baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String()) + "/runtime-state"
	_, err = client.doDocumentRequest(ctx, http.MethodPut, requestURL, payload)
	// 状态文档与独立块表是两份事实；只清 state 会让 openapp/AuthInvalid 继续为 true。
	blockURL := client.baseURL + accountcontract.AccountsPath + "/" +
		url.PathEscape(accountRef.String()) + "/runtime-block?kind=reauthentication_required"
	_, blockErr := client.doDocumentRequest(ctx, http.MethodDelete, blockURL, nil)
	return errors.Join(err, blockErr)
}
