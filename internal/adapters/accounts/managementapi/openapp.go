package managementapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
)

// openAppSuffix 是账号打开/关闭桌面或 CLI 的管理契约后缀。
const openAppSuffix = "/open-app"

// OpenAppResult 是 open-app 的业务结果（与 Node launchAccountApp 同义）。
type OpenAppResult struct {
	OK              bool
	Status          string
	LaunchMode      string
	Executable      string
	PIDs            []int
	Error           string
	Message         string
	Reason          string
	InstallRequired bool
}

// OpenApp 触发一次 desktop/cli 的 open 或 close。
func (client *Client) OpenApp(
	ctx context.Context,
	providerID string,
	accountRef string,
	kind string,
	action string,
) (OpenAppResult, error) {
	if !client.isValid() {
		return OpenAppResult{}, ErrInvalidConfig
	}
	if ctx == nil || providerID == "" || accountRef == "" || kind == "" || action == "" {
		return OpenAppResult{}, ErrInvalidRequest
	}
	payload, err := json.Marshal(map[string]string{"kind": kind, "action": action})
	if err != nil {
		return OpenAppResult{}, ErrInvalidRequest
	}
	requestURL := client.baseURL + mobileAccountPath + "/" +
		url.PathEscape(providerID) + "/" + url.PathEscape(accountRef) + openAppSuffix
	body, err := client.doDocumentRequest(ctx, http.MethodPost, requestURL, payload)
	if err != nil {
		return OpenAppResult{}, err
	}
	var response struct {
		OK              bool   "json:\"ok\""
		Status          string "json:\"status\""
		LaunchMode      string "json:\"launchMode\""
		Executable      string "json:\"executable\""
		PIDs            []int  "json:\"pids\""
		Error           string "json:\"error\""
		Message         string "json:\"message\""
		Reason          string "json:\"reason\""
		InstallRequired bool   "json:\"installRequired\""
	}
	if err := json.Unmarshal(body, &response); err != nil {
		return OpenAppResult{}, errors.Join(ErrInvalidResponse, err)
	}
	return OpenAppResult{
		OK:              response.OK,
		Status:          response.Status,
		LaunchMode:      response.LaunchMode,
		Executable:      response.Executable,
		PIDs:            response.PIDs,
		Error:           response.Error,
		Message:         response.Message,
		Reason:          response.Reason,
		InstallRequired: response.InstallRequired,
	}, nil
}
