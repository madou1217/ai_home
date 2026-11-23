// Package concurrency 定义网关并发/速率的配置与解析规则（纯领域）。
//
// 并发天花板由 application/admission 执行；速率窗口的只读契约见 windows.go。
// 解析顺序：全局上限 → Key 上限 → (账号,模型) 覆盖 → 账号总量 → Provider 默认 →
// 全局账号默认。层级只是上限，不是预留：例如 5 个账号 × 2 = 10 容量，key1 已占 8
// 时，key2 即使配置 4 也只能拿到剩余 2。
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

// Default 返回内置默认值：并发上限默认**关闭**（0=不限）。
//
// 只有运营方显式配置 concurrency（或设置旧 AIH_SERVER_*_MAX_CONCURRENCY）
// 时才启用限流，避免部署后无意中把既有流量掐到 2 并发。
func Default() Config {
	return Config{
		SystemMax:          0,
		QueueLimit:         200,
		QueueWaitTimeoutMS: 30000,
		RetryAfterSeconds:  1,
		AccountDefault:     0,
		ProviderDefaults:   map[string]int{},
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
	if value := config.AccountModelConcurrency(accountRef, model, limits); value > 0 {
		return value
	}
	return config.AccountTotal(provider, accountRef, limits)
}

// AccountTotal 返回账号总量的并发上限：显式账号总量 → Provider 默认 → 全局账号默认。
//
// 账号+模型覆盖是另一层天花板，见 AccountModelConcurrency；两者都生效时取更小者。
func (config Config) AccountTotal(
	provider string,
	accountRef string,
	limits []AccountLimit,
) int {
	provider = strings.ToLower(strings.TrimSpace(provider))
	accountRef = strings.TrimSpace(accountRef)
	for _, limit := range limits {
		if strings.TrimSpace(limit.AccountRef) != accountRef {
			continue
		}
		if strings.TrimSpace(limit.ModelID) == "" && limit.MaxConcurrency > 0 {
			return limit.MaxConcurrency
		}
	}
	if value := config.ProviderDefaults[provider]; value > 0 {
		return value
	}
	if config.AccountDefault > 0 {
		return config.AccountDefault
	}
	return 0
}

// AccountModelConcurrency 返回显式的 (账号, 模型) 覆盖；0 表示没有单独覆盖。
func (config Config) AccountModelConcurrency(
	accountRef string,
	model string,
	limits []AccountLimit,
) int {
	accountRef = strings.TrimSpace(accountRef)
	model = strings.TrimSpace(model)
	if accountRef == "" || model == "" {
		return 0
	}
	for _, limit := range limits {
		if strings.TrimSpace(limit.AccountRef) == accountRef &&
			strings.TrimSpace(limit.ModelID) == model &&
			limit.MaxConcurrency > 0 {
			return limit.MaxConcurrency
		}
	}
	return 0
}

// AccountRPM 返回账号级每分钟请求上限；0 表示不限。
//
// 只读取账号总量覆盖（model_id 为空）：速率限制没有模型维度，账号+模型行里的
// rpm/tpm 仍只作为存储字段保留，不参与准入。
func (config Config) AccountRPM(accountRef string, limits []AccountLimit) int {
	return accountRateLimit(accountRef, limits, func(limit AccountLimit) int { return limit.RPMLimit })
}

// AccountTPM 返回账号级每分钟 token 上限；0 表示不限。
func (config Config) AccountTPM(accountRef string, limits []AccountLimit) int {
	return accountRateLimit(accountRef, limits, func(limit AccountLimit) int { return limit.TPMLimit })
}

func accountRateLimit(
	accountRef string,
	limits []AccountLimit,
	value func(AccountLimit) int,
) int {
	accountRef = strings.TrimSpace(accountRef)
	if accountRef == "" {
		return 0
	}
	for _, limit := range limits {
		if strings.TrimSpace(limit.AccountRef) != accountRef {
			continue
		}
		if strings.TrimSpace(limit.ModelID) != "" {
			continue
		}
		if resolved := value(limit); resolved > 0 {
			return resolved
		}
	}
	return 0
}

// Equal 判断两份配置在生效字段上是否相同（用于热更新的无变化短路）。
func (config Config) Equal(other Config) bool {
	if config.SystemMax != other.SystemMax ||
		config.QueueLimit != other.QueueLimit ||
		config.QueueWaitTimeoutMS != other.QueueWaitTimeoutMS ||
		config.RetryAfterSeconds != other.RetryAfterSeconds ||
		config.AccountDefault != other.AccountDefault {
		return false
	}
	if len(config.ProviderDefaults) != len(other.ProviderDefaults) {
		return false
	}
	for provider, value := range config.ProviderDefaults {
		if other.ProviderDefaults[provider] != value {
			return false
		}
	}
	return true
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
