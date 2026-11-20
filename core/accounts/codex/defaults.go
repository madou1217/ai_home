package codex

import "sync"

// ChatGPTBackendBaseURL 是 ChatGPT 后端根；/wham/* 额度端点与 Codex OAuth
// 推理面都挂在它下面，只是前缀不同。
const ChatGPTBackendBaseURL = "https://chatgpt.com/backend-api"

// DefaultOAuthBaseURL 是 Codex OAuth 账号未配置过程级兜底时使用的官方地址。
//
// 与 API Key 的 DefaultAPIBaseURL 刻意分开：OAuth 的推理面挂在 chatgpt.com
// 的 backend-api/codex 前缀下，而 API Key 走 api.openai.com/v1。
const DefaultOAuthBaseURL = ChatGPTBackendBaseURL + "/codex"

var (
	defaultBaseURLMu      sync.RWMutex
	defaultBaseURL        string
	defaultOAuthBaseURLMu sync.RWMutex
	defaultOAuthBaseURL   string
)

// ConfigureDefaultAPIBaseURL overrides the fallback for API Key accounts that
// do not carry an explicit base URL. Empty restores the official default.
func ConfigureDefaultAPIBaseURL(raw string) error {
	if raw == "" {
		defaultBaseURLMu.Lock()
		defaultBaseURL = ""
		defaultBaseURLMu.Unlock()
		return nil
	}
	normalized, err := normalizeAPIBaseURL(raw)
	if err != nil {
		return err
	}
	defaultBaseURLMu.Lock()
	defaultBaseURL = normalized
	defaultBaseURLMu.Unlock()
	return nil
}

// EffectiveDefaultAPIBaseURL returns the process fallback or the official one.
func EffectiveDefaultAPIBaseURL() string {
	defaultBaseURLMu.RLock()
	configured := defaultBaseURL
	defaultBaseURLMu.RUnlock()
	if configured != "" {
		return configured
	}
	return DefaultAPIBaseURL
}

// ConfigureDefaultOAuthBaseURL overrides the fallback for OAuth accounts that
// have no account-level upstream. Empty restores the official endpoint.
func ConfigureDefaultOAuthBaseURL(raw string) error {
	if raw == "" {
		defaultOAuthBaseURLMu.Lock()
		defaultOAuthBaseURL = ""
		defaultOAuthBaseURLMu.Unlock()
		return nil
	}
	normalized, err := normalizeAPIBaseURL(raw)
	if err != nil {
		return err
	}
	defaultOAuthBaseURLMu.Lock()
	defaultOAuthBaseURL = normalized
	defaultOAuthBaseURLMu.Unlock()
	return nil
}

// EffectiveDefaultOAuthBaseURL returns the process OAuth fallback or the
// official chatgpt.com backend-api/codex prefix.
func EffectiveDefaultOAuthBaseURL() string {
	defaultOAuthBaseURLMu.RLock()
	configured := defaultOAuthBaseURL
	defaultOAuthBaseURLMu.RUnlock()
	if configured != "" {
		return configured
	}
	return DefaultOAuthBaseURL
}
