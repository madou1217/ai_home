package tuningress

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"sync"
	"unicode/utf8"
)

const (
	maxCheckOutputBytes    = 64 << 10
	maxReportedOutputBytes = 8 << 10
	redactedValue          = "[redacted]"
)

// boundedBuffer keeps child output bounded while still reporting the full
// number of bytes written so os/exec does not fail with short writes.
type boundedBuffer struct {
	mu        sync.Mutex
	limit     int
	buf       []byte
	truncated bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	written := len(p)
	remaining := b.limit - len(b.buf)
	if remaining <= 0 {
		b.truncated = true
		return written, nil
	}
	if len(p) > remaining {
		p = p[:remaining]
		b.truncated = true
	}
	b.buf = append(b.buf, p...)
	return written, nil
}

func (b *boundedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	text := string(b.buf)
	if b.truncated {
		text += "\n...[output truncated]"
	}
	return text
}

// redactSecrets removes credentials from sing-box output before it can reach
// an error value. Raw, JSON-escaped, URL-escaped, and Basic-auth-encoded forms
// are all covered.
func redactSecrets(text string, config *settings) string {
	if config == nil {
		return text
	}
	combined := config.upstreamUser + ":" + config.upstreamPass
	replacements := make([]string, 0, 8)
	if config.upstreamUser != "" && config.upstreamPass != "" {
		replacements = append(replacements, combined)
		replacements = append(replacements, base64.StdEncoding.EncodeToString([]byte(combined)))
	}
	if config.upstreamUser != "" {
		replacements = append(replacements, config.upstreamUser)
	}
	if config.upstreamPass != "" {
		replacements = append(replacements, config.upstreamPass)
	}
	for _, value := range replacements {
		if value == "" {
			continue
		}
		text = strings.ReplaceAll(text, value, redactedValue)
		if escaped := jsonEscaped(value); escaped != "" {
			text = strings.ReplaceAll(text, escaped, redactedValue)
		}
		if escaped := url.QueryEscape(value); escaped != "" {
			text = strings.ReplaceAll(text, escaped, redactedValue)
		}
	}
	return text
}

func jsonEscaped(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) < 2 {
		return value
	}
	return string(encoded[1 : len(encoded)-1])
}

func truncateText(text string, limit int) string {
	if limit <= 0 || len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "\n...[output truncated]"
}
