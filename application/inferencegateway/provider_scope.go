package inferencegateway

import (
	"errors"
	"strings"
	"sync/atomic"
)

var configuredProviderScope atomic.Value // string

// ConfigureProviderScope 限制本进程只路由到一个 Provider。
//
// 空串或 auto 表示不限制；其它值必须是 Node serve 支持的 Provider 名单。
// 显式范围只过滤候选，不改变账号资格或失败策略。
func ConfigureProviderScope(provider string) error {
	scope := strings.ToLower(strings.TrimSpace(provider))
	switch scope {
	case "", "auto", "codex", "gemini", "claude", "agy", "opencode":
	default:
		return errors.New("Provider 范围必须是 auto/codex/gemini/claude/agy/opencode")
	}
	configuredProviderScope.Store(scope)
	return nil
}

func currentProviderScope() string {
	value, _ := configuredProviderScope.Load().(string)
	return value
}
