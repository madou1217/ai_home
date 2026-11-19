// Package upstreamdefaults holds process-level fallback endpoints for the four
// core providers. Account-level base URLs always win; these values are only
// used when an account has no explicit upstream.
package upstreamdefaults

import (
	"errors"
	"net/url"
	"strings"
	"sync"
)

// Defaults is the process-level fallback set.
type Defaults struct {
	CodexBaseURL  string
	ClaudeBaseURL string
	AgyBaseURL    string
	GeminiBaseURL string
}

var (
	mu      sync.RWMutex
	current Defaults
)

// Configure validates and stores the process defaults. Empty fields keep the
// built-in official endpoint; explicit values must be absolute HTTP(S) URLs.
func Configure(input Defaults) error {
	normalized := Defaults{
		CodexBaseURL:  strings.TrimRight(strings.TrimSpace(input.CodexBaseURL), "/"),
		ClaudeBaseURL: strings.TrimRight(strings.TrimSpace(input.ClaudeBaseURL), "/"),
		AgyBaseURL:    strings.TrimRight(strings.TrimSpace(input.AgyBaseURL), "/"),
		GeminiBaseURL: strings.TrimRight(strings.TrimSpace(input.GeminiBaseURL), "/"),
	}
	for _, value := range []string{
		normalized.CodexBaseURL,
		normalized.ClaudeBaseURL,
		normalized.AgyBaseURL,
		normalized.GeminiBaseURL,
	} {
		if value == "" {
			continue
		}
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return errors.New("上游默认地址必须是绝对 http/https URL")
		}
		if strings.ContainsAny(value, "\r\n\t") {
			return errors.New("上游默认地址包含空白字符")
		}
	}
	mu.Lock()
	current = normalized
	mu.Unlock()
	return nil
}

// Current returns a copy of the configured defaults.
func Current() Defaults {
	mu.RLock()
	defer mu.RUnlock()
	return current
}
