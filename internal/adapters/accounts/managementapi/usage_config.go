package managementapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// usageConfigPath 是 WebUI 用量配置的只读/整份写回管理契约；与 WebUI 设置页同源。
const usageConfigPath = "/v1/management/webui/config"

// UsageConfig 是全局用量/自动换号配置（字段与 Node config:usage 同名）。
type UsageConfig struct {
	ActiveRefreshInterval     string `json:"active_refresh_interval"`
	BackgroundRefreshInterval string `json:"background_refresh_interval"`
	ThresholdPct              int    `json:"threshold_pct"`
	AutoSwitch                bool   `json:"auto_switch"`
	AutoSwitchRemainingPct    *int   `json:"auto_switch_remaining_pct"`
}

// GetUsageConfig 读取 Server 规范化后的全局用量配置。
func (client *Client) GetUsageConfig(ctx context.Context) (UsageConfig, error) {
	if !client.isValid() {
		return UsageConfig{}, ErrInvalidConfig
	}
	if ctx == nil {
		return UsageConfig{}, ErrInvalidRequest
	}
	body, err := client.doDocumentRequest(
		ctx,
		http.MethodGet,
		client.baseURL+usageConfigPath,
		nil,
	)
	if err != nil {
		return UsageConfig{}, err
	}
	var response struct {
		OK     bool        `json:"ok"`
		Config UsageConfig `json:"config"`
	}
	if err := json.Unmarshal(body, &response); err != nil || !response.OK {
		return UsageConfig{}, errors.Join(ErrInvalidResponse, err)
	}
	return response.Config, nil
}

// SetUsageConfig 整份写回配置；调用方必须先读再改，避免覆盖其它字段。
func (client *Client) SetUsageConfig(ctx context.Context, config UsageConfig) error {
	if !client.isValid() {
		return ErrInvalidConfig
	}
	if ctx == nil {
		return ErrInvalidRequest
	}
	payload, err := json.Marshal(map[string]any{"config": config})
	if err != nil {
		return ErrInvalidRequest
	}
	_, err = client.doDocumentRequest(
		ctx,
		http.MethodPost,
		client.baseURL+usageConfigPath,
		payload,
	)
	return err
}
