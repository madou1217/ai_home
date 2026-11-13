package managementapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
)

// mobileAccountPath 是 Codex App 账号绑定的管理契约前缀。
const mobileAccountPath = "/v1/management/webui/accounts"

// MobileBinding 是 set-mobile / clear-mobile 的结果。
type MobileBinding struct {
	Provider          string
	AccountRef        string
	DesktopAccountRef string
	Changed           bool
}

// SetMobile 把账号写成 Codex App 当前账号。
func (client *Client) SetMobile(
	ctx context.Context,
	providerID string,
	accountRef string,
) (MobileBinding, error) {
	return client.mobileAction(ctx, providerID, accountRef, "set-mobile")
}

// ClearMobile 解除绑定；调用方负责给出当前绑定的账号引用。
func (client *Client) ClearMobile(
	ctx context.Context,
	providerID string,
	accountRef string,
) (MobileBinding, error) {
	return client.mobileAction(ctx, providerID, accountRef, "clear-mobile")
}

func (client *Client) mobileAction(
	ctx context.Context,
	providerID string,
	accountRef string,
	action string,
) (MobileBinding, error) {
	if !client.isValid() {
		return MobileBinding{}, ErrInvalidConfig
	}
	if ctx == nil || providerID == "" || accountRef == "" {
		return MobileBinding{}, ErrInvalidRequest
	}
	requestURL := client.baseURL + mobileAccountPath + "/" +
		url.PathEscape(providerID) + "/" + url.PathEscape(accountRef) + "/" + action
	body, err := client.doDocumentRequest(ctx, http.MethodPost, requestURL, nil)
	if err != nil {
		return MobileBinding{}, err
	}
	var response struct {
		OK                bool   "json:\"ok\""
		Provider          string "json:\"provider\""
		AccountRef        string "json:\"accountRef\""
		DesktopAccountRef string "json:\"desktopAccountRef\""
		Changed           bool   "json:\"changed\""
	}
	if err := json.Unmarshal(body, &response); err != nil || !response.OK {
		return MobileBinding{}, errors.Join(ErrInvalidResponse, err)
	}
	return MobileBinding{
		Provider:          response.Provider,
		AccountRef:        response.AccountRef,
		DesktopAccountRef: response.DesktopAccountRef,
		Changed:           response.Changed,
	}, nil
}
