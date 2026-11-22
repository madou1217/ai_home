// Package concurrency 定义网关并发/速率的配置与解析规则（纯领域）。
//
// 本轮只用于字段、预览和统计；真正拦截在下一轮实现。解析顺序：
// 全局上限 → Key 上限 → (账号,模型) 覆盖 → 账号总量 → Provider 默认 → 全局账号默认。
// 层级只是上限，不是预留：例如 5 个账号 × 2 = 10 容量，key1 已占 8 时，
// key2 即使配置 4 也只能拿到剩余 2。
package concurrency

import (
	"encoding/json"
	"strings"
)

// Config 是 server 配置里的 concurrency 对象。
type Config struct {
	SystemMax          int            `json:"systemMax"`
	QueueLimit         int            `json:"queueLimit"`
	QueueWaitTimeoutMS int64          `json:"queueWaitTimeoutMs"`
	RetryAfterSeconds  int            `json:"retryAfterSeconds"`
	AccountDefault     int            `json:"accountDefault"`
	ProviderDefaults   map[string]int `json:"providerDefaults"`
}

// AccountLimit 是单个账号或账号+模型的覆盖值；0 表示未配置。
type AccountLimit struct {
	AccountRef     string
	ModelID        string // "" = 账号总量
	MaxConcurrency int
	RPMLimit       int
	TPMLimit       int
}

// Default 返回内置默认值（与现有 provider gate 的默认并发一致）。
func Default() Config {
	return Config{
		SystemMax:          0,
		QueueLimit:         200,
		QueueWaitTimeoutMS: 30000,
		RetryAfterSeconds:  1,
		AccountDefault:     2,
		ProviderDefaults: map[string]int{
			"codex": 2, "gemini": 1, "claude": 2, "agy": 1, "opencode": 1,
		},
	}
}

// ParseConfig 解析配置对象；缺省字段回落默认值，非法值由调用方判为 400。
func ParseConfig(raw any) (Config, error) {
	config := Default()
	if raw == nil {
		return config, nil
	}
	encoded, err := configBytes(raw)
	if err != nil {
		return Config{}, err
	}
	if len(encoded) == 0 {
		return config, nil
	}
	if err := json.Unmarshal(encoded, &config); err != nil {
		return Config{}, err
	}
	if config.QueueLimit <= 0 {
		config.QueueLimit = 200
	}
	if config.QueueWaitTimeoutMS <= 0 {
		config.QueueWaitTimeoutMS = 30000
	}
	if config.RetryAfterSeconds <= 0 {
		config.RetryAfterSeconds = 1
	}
	if config.ProviderDefaults == nil {
		config.ProviderDefaults = Default().ProviderDefaults
	}
	return config, nil
}

// AccountConcurrency 按层级解析某账号/模型的并发上限。
func (config Config) AccountConcurrency(
	provider string,
	accountRef string,
	model string,
	limits []AccountLimit,
) int {
	provider = strings.ToLower(strings.TrimSpace(provider))
	accountRef = strings.TrimSpace(accountRef)
	model = strings.TrimSpace(model)
	var accountTotal, accountModel int
	for _, limit := range limits {
		if strings.TrimSpace(limit.AccountRef) != accountRef {
			continue
		}
		if strings.TrimSpace(limit.ModelID) == model && model != "" {
			accountModel = limit.MaxConcurrency
		}
		if strings.TrimSpace(limit.ModelID) == "" {
			accountTotal = limit.MaxConcurrency
		}
	}
	if accountModel > 0 {
		return accountModel
	}
	if accountTotal > 0 {
		return accountTotal
	}
	if value := config.ProviderDefaults[provider]; value > 0 {
		return value
	}
	return config.AccountDefault
}

// KeyConcurrency 返回 Key 的并发上限；0 表示不限（仍受全局/账号上限约束）。
func (config Config) KeyConcurrency(keyLimit int) int {
	if keyLimit < 0 {
		return 0
	}
	return keyLimit
}

// ClampToSystem 把账号/Key 上限收窄到全局上限。
func (config Config) ClampToSystem(value int) int {
	if config.SystemMax <= 0 || value <= 0 {
		return value
	}
	if value > config.SystemMax {
		return config.SystemMax
	}
	return value
}

func configBytes(raw any) ([]byte, error) {
	switch value := raw.(type) {
	case string:
		return []byte(strings.TrimSpace(value)), nil
	case json.RawMessage:
		return value, nil
	case map[string]any:
		if value == nil {
			return nil, nil
		}
		return json.Marshal(value)
	default:
		return json.Marshal(value)
	}
}