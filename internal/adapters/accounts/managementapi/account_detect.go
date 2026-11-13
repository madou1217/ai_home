package managementapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// accountDetectPath 是 WebUI「扫描本机账号」的管理契约；扫描由 Go 原生检测器执行。
const accountDetectPath = "/v1/management/webui/accounts/detect"

// DetectedAccount 是一次扫描中新登记/更新的账号明细。
type DetectedAccount struct {
	AccountRef   string `json:"accountRef"`
	CLIAccountID string `json:"cliAccountId"`
	Created      bool   `json:"created"`
	Provider     string `json:"provider,omitempty"`
	Source       string `json:"source,omitempty"`
}

// SkippedAccount 是被跳过来源的原因。
type SkippedAccount struct {
	Reason     string `json:"reason"`
	Provider   string `json:"provider,omitempty"`
	Source     string `json:"source,omitempty"`
	AccountRef string `json:"accountRef,omitempty"`
}

// DetectResult 与 WebUI 扫描接口同形。
type DetectResult struct {
	OK         bool              `json:"ok"`
	Scanned    int               `json:"scanned"`
	Updated    int               `json:"updated"`
	Reloaded   bool              `json:"reloaded"`
	Registered []DetectedAccount `json:"registered"`
	Skipped    []SkippedAccount  `json:"skipped"`
	Accounts   map[string]int    `json:"accounts"`
}

// DetectHostAccounts 触发一次本机账号扫描并返回与 WebUI 相同的统计。
func (client *Client) DetectHostAccounts(ctx context.Context) (DetectResult, error) {
	if !client.isValid() {
		return DetectResult{}, ErrInvalidConfig
	}
	if ctx == nil {
		return DetectResult{}, ErrInvalidRequest
	}
	body, err := client.doDocumentRequest(
		ctx,
		http.MethodPost,
		client.baseURL+accountDetectPath,
		[]byte("{}"),
	)
	if err != nil {
		return DetectResult{}, err
	}
	var result DetectResult
	if err := json.Unmarshal(body, &result); err != nil {
		return DetectResult{}, errors.Join(ErrInvalidResponse, err)
	}
	return result, nil
}
