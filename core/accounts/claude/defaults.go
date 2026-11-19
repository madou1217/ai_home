package claude

import "sync"

var (
	defaultBaseURLMu sync.RWMutex
	defaultBaseURL   string
)

// ConfigureDefaultAPIBaseURL overrides the fallback for static credentials
// that do not carry an explicit base URL. Empty restores the official default.
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
