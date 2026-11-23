package inferencegateway

import (
	"errors"
	"strings"

	"github.com/madou1217/ai_home/application/admission"
)

// DefaultProviderQueueLimit 与 Node serve 的 queueLimit 默认值一致。
const DefaultProviderQueueLimit = 200

// ConfigureProviderLimits 兼容旧的 Provider 并发/队列环境变量。
//
// 第二轮起真正的准入由 application/admission 统一执行；这里不再维护第二套
// 信号量，只把旧环境变量转换为准入控制器的初始 Provider 默认值与队列上限
// （server 配置 concurrency 存在时以 server 配置为准）。
func ConfigureProviderLimits(limits map[string]int, queueLimit int) error {
	normalized := make(map[string]int, len(limits))
	for provider, limit := range limits {
		name := strings.ToLower(strings.TrimSpace(provider))
		if name == "" || limit < 1 || limit > 32 {
			return errors.New("Provider 并发数必须在 1 到 32 之间")
		}
		normalized[name] = limit
	}
	if queueLimit < 0 || queueLimit > 5000 {
		return errors.New("Provider 队列上限必须在 0 到 5000 之间")
	}
	admission.SetLegacyDefaults(normalized, queueLimit)
	return nil
}
